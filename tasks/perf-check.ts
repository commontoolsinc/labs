#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run --allow-write

/**
 * PR Performance Check
 *
 * Runs as part of PR CI after all test jobs complete. Compares the current
 * run's job/step timings against a baseline computed from recent main-branch
 * push runs.  Fails (exit 1) if any metric exceeds the baseline threshold,
 * unless the PR description contains an override.
 *
 * Environment:
 *   GITHUB_TOKEN        - Required.
 *   GITHUB_REPOSITORY   - Optional, defaults to "commontoolsinc/labs".
 *   GITHUB_RUN_ID       - Required. Current workflow run ID.
 *   PR_NUMBER           - Required. Pull request number.
 */

import {
  addSample,
  API_CONCURRENCY,
  applyBaselineOverrides,
  type BaselineOverrides,
  computeBaseline,
  downloadAndParseJUnit,
  extractMetrics,
  extractTestFileMetrics,
  fetchArtifactsForRun,
  fetchJobsForRun,
  fetchPRBody,
  fetchPRForCommit,
  formatMetricValue,
  formatOverrideSuggestion,
  githubGet,
  mapConcurrent,
  type MetricTimeline,
  MIN_ABSOLUTE_DELTA,
  MIN_REGRESSION_PCT,
  MIN_SAMPLES,
  parseBaselineOverrides,
  type PRInfo,
  REPO,
  STDDEV_FACTOR,
  type TimingSample,
  TOKEN,
  WORKFLOW_FILE,
  type WorkflowRun,
} from "./perf-lib.ts";

/** How many recent main-branch runs to use for baseline. */
const BASELINE_RUNS = 20;

/**
 * Metrics to exclude from regression checks because their aggregate values
 * naturally grow as new tests are added.  Per-test timings from JUnit
 * artifacts are tracked instead.
 */
const EXCLUDED_METRIC_PATTERNS = [
  /^job: Pattern Unit Tests/,
  /^step: pattern unit tests$/,
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runId = Deno.env.get("GITHUB_RUN_ID");
  const prNumber = Deno.env.get("PR_NUMBER");

  if (!TOKEN) {
    console.error("GITHUB_TOKEN is required.");
    Deno.exit(1);
  }
  if (!runId) {
    console.error("GITHUB_RUN_ID is required.");
    Deno.exit(1);
  }
  if (!prNumber) {
    console.error("PR_NUMBER is required.");
    Deno.exit(1);
  }

  // 1. Check PR description for overrides
  console.log(`Fetching PR #${prNumber} description...`);
  const prBody = await fetchPRBody(parseInt(prNumber));
  const prOverrides = parseBaselineOverrides(prBody);

  if (prOverrides.metrics.size > 0) {
    console.log(
      `PR description contains ${prOverrides.metrics.size} NEW_PERF_BASELINE override(s).`,
    );
  }

  // 2. Get current run's job/step metrics and per-test timing artifacts
  console.log(`Fetching jobs for current run ${runId}...`);
  const runIdNum = parseInt(runId);
  const currentJobs = await fetchJobsForRun(runIdNum);

  // Build a minimal WorkflowRun for the current run to extract metrics
  const currentRunInfo = await githubGet<WorkflowRun>(
    `/repos/${REPO}/actions/runs/${runId}`,
  );
  const currentMetrics = new Map<string, TimingSample>();

  // Extract job/step metrics
  for (const [name, sample] of extractMetrics(currentRunInfo, currentJobs)) {
    currentMetrics.set(name, sample);
  }

  // Extract per-test metrics from JUnit artifacts
  try {
    const artifacts = await fetchArtifactsForRun(runIdNum);
    const timingArtifacts = artifacts.filter(
      (a) => a.name.startsWith("test-timing-") && !a.expired,
    );
    for (const artifact of timingArtifacts) {
      const suites = await downloadAndParseJUnit(artifact.id);
      const testMetrics = extractTestFileMetrics(
        currentRunInfo,
        artifact.name.replace("test-timing-", ""),
        suites,
      );
      for (const [name, sample] of testMetrics) {
        currentMetrics.set(name, sample);
      }
    }
  } catch (e) {
    console.warn(`  Warning: could not fetch artifacts for current run: ${e}`);
  }

  if (currentMetrics.size === 0) {
    console.log("No metrics extracted from current run. Nothing to check.");
    Deno.exit(0);
  }

  console.log(`Extracted ${currentMetrics.size} metrics from current run.`);

  // 3. Fetch recent main-branch push runs for baseline
  console.log("Fetching recent main-branch runs for baseline...");
  const baselineData = await githubGet<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&status=success&event=push&per_page=${BASELINE_RUNS}`,
  );
  const baselineRuns = baselineData.workflow_runs;

  if (baselineRuns.length < MIN_SAMPLES) {
    console.log(
      `Only ${baselineRuns.length} baseline runs available (need ${MIN_SAMPLES}). Skipping check.`,
    );
    Deno.exit(0);
  }

  console.log(`Using ${baselineRuns.length} main-branch runs as baseline.`);

  // 4. Fetch job/step metrics for baseline runs + check for baseline overrides
  const timelines = new Map<string, MetricTimeline>();
  const overridesBySha = new Map<string, BaselineOverrides>();
  const prInfoBySha = new Map<string, PRInfo>();

  await mapConcurrent(baselineRuns, API_CONCURRENCY, async (run) => {
    const [jobs, pr] = await Promise.all([
      fetchJobsForRun(run.id),
      fetchPRForCommit(run.head_sha),
    ]);

    if (pr) {
      prInfoBySha.set(run.head_sha, pr);
    }

    const metrics = extractMetrics(run, jobs);
    for (const [name, sample] of metrics) {
      addSample(timelines, name, sample);
    }

    // Fetch per-test timing artifacts
    try {
      const artifacts = await fetchArtifactsForRun(run.id);
      const timingArtifacts = artifacts.filter(
        (a) => a.name.startsWith("test-timing-") && !a.expired,
      );
      for (const artifact of timingArtifacts) {
        const suites = await downloadAndParseJUnit(artifact.id);
        if (suites.length > 0) {
          const testMetrics = extractTestFileMetrics(
            run,
            artifact.name.replace("test-timing-", ""),
            suites,
          );
          for (const [name, sample] of testMetrics) {
            addSample(timelines, name, sample);
          }
        }
      }
    } catch {
      // Artifacts may not exist for older runs
    }

    // Check for baseline overrides in merged PRs
    if (pr?.body) {
      const overrides = parseBaselineOverrides(pr.body);
      if (overrides.metrics.size > 0) {
        overridesBySha.set(run.head_sha, overrides);
      }
    }
  });

  // Sort timelines chronologically
  for (const timeline of timelines.values()) {
    timeline.samples.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Apply baseline overrides from merged PRs
  if (overridesBySha.size > 0) {
    console.log(
      `Found ${overridesBySha.size} baseline override(s) from merged PRs.`,
    );
    applyBaselineOverrides(timelines, overridesBySha);
  }

  // 5. Compare current metrics against baseline
  const failures: {
    metric: string;
    current: number;
    median: number;
    variance: number;
    stddev: number;
    threshold: number;
    pctIncrease: number;
  }[] = [];

  for (const [metric, currentSample] of currentMetrics) {
    // Skip metrics whose aggregate values grow as tests are added
    if (EXCLUDED_METRIC_PATTERNS.some((re) => re.test(metric))) {
      continue;
    }

    // Skip if the PR has a specific override for this metric
    if (prOverrides.metrics.has(metric)) {
      const override = prOverrides.metrics.get(metric)!;
      if (currentSample.durationSeconds <= override) {
        console.log(
          `  ${metric}: ${
            formatMetricValue(metric, currentSample.durationSeconds)
          } (override: ${formatMetricValue(metric, override)}) — OK`,
        );
        continue;
      }
    }

    const timeline = timelines.get(metric);
    if (!timeline || timeline.samples.length < MIN_SAMPLES) {
      // Not enough baseline data for this metric
      continue;
    }

    const baseline = computeBaseline(
      timeline.samples.map((s) => s.durationSeconds),
      metric.startsWith("bench:") ? 0 : MIN_ABSOLUTE_DELTA,
    );
    if (!baseline) continue;

    if (currentSample.durationSeconds > baseline.threshold) {
      const pctIncrease =
        ((currentSample.durationSeconds - baseline.median) / baseline.median) *
        100;
      failures.push({
        metric,
        current: currentSample.durationSeconds,
        median: baseline.median,
        variance: baseline.variance,
        stddev: baseline.stddev,
        threshold: baseline.threshold,
        pctIncrease,
      });
    }
  }

  // 6. Report results
  if (failures.length === 0) {
    console.log("\nAll metrics within normal range.");
    Deno.exit(0);
  }

  failures.sort((a, b) => b.pctIncrease - a.pctIncrease);

  console.log(
    `\nPerformance regression detected in ${failures.length} metric(s):\n`,
  );
  console.log(
    "| Metric | Current | Baseline (median) | Threshold | Change |",
  );
  console.log(
    "|--------|---------|-------------------|-----------|--------|",
  );

  for (const f of failures) {
    const fmt = (v: number) => formatMetricValue(f.metric, v);
    console.log(
      `| ${f.metric} | ${fmt(f.current)} | ${fmt(f.median)} | ${
        fmt(f.threshold)
      } | +${f.pctIncrease.toFixed(0)}% |`,
    );
  }

  console.log("\nBaseline sample breakdown:\n");
  for (const f of failures) {
    const timeline = timelines.get(f.metric);
    if (!timeline) continue;

    const fmt = (v: number) => formatMetricValue(f.metric, v);
    console.log(
      `  ${f.metric} (n=${timeline.samples.length}, median=${
        fmt(f.median)
      }, variance=${fmt(f.variance)}, stddev=${fmt(f.stddev)}):`,
    );
    for (const s of timeline.samples) {
      const pr = prInfoBySha.get(s.sha);
      const prStr = pr ? `PR #${pr.number}` : s.sha.slice(0, 8);
      console.log(
        `    ${fmt(s.durationSeconds)} — ${prStr} (${
          s.createdAt.slice(0, 10)
        })`,
      );
    }
  }

  console.log(
    "\nTo accept these regressions, add the following to your PR description:\n",
  );
  console.log("---BEGIN COPY-PASTE---");
  for (const f of failures) {
    const suggested = formatOverrideSuggestion(f.metric, f.current);
    console.log(`NEW_PERF_BASELINE: ${f.metric} = ${suggested}`);
  }
  console.log("---END COPY-PASTE---");

  console.log(
    `\nThresholds: median + ${STDDEV_FACTOR}σ or +${
      MIN_REGRESSION_PCT * 100
    }% (whichever is higher); non-bench metrics also require at least +${MIN_ABSOLUTE_DELTA}s.`,
  );

  Deno.exit(1);
}

main();
