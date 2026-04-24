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
  type Status = "OVER" | "CLOSE" | "OK" | "ovrd" | "excl" | "n/a";
  interface Row {
    metric: string;
    status: Status;
    current: number;
    median?: number;
    variance?: number;
    stddev?: number;
    threshold?: number;
    n: number;
    pctIncrease?: number;
    /**
     * How much of the median→threshold margin the current value has consumed,
     * as a percentage. 0% = at median; 100% = at threshold; >100% = over.
     */
    headroomPct?: number;
  }

  const rows: Row[] = [];
  const failures: Row[] = [];

  for (const [metric, currentSample] of currentMetrics) {
    const current = currentSample.durationSeconds;
    const timeline = timelines.get(metric);
    const n = timeline?.samples.length ?? 0;
    const baseline = timeline && n >= MIN_SAMPLES
      ? computeBaseline(
        timeline.samples.map((s) => s.durationSeconds),
        metric.startsWith("bench:") ? 0 : MIN_ABSOLUTE_DELTA,
      )
      : null;

    const stats = baseline && {
      median: baseline.median,
      variance: baseline.variance,
      stddev: baseline.stddev,
      threshold: baseline.threshold,
      pctIncrease: ((current - baseline.median) / baseline.median) * 100,
      headroomPct: baseline.threshold > baseline.median
        ? ((current - baseline.median) /
          (baseline.threshold - baseline.median)) * 100
        : 0,
    };

    // Metrics whose aggregate values grow as tests are added — never fail,
    // but still shown so the log has full context.
    if (EXCLUDED_METRIC_PATTERNS.some((re) => re.test(metric))) {
      rows.push({ metric, status: "excl", current, n, ...(stats ?? {}) });
      continue;
    }

    // Not enough baseline data — show anyway.
    if (!baseline) {
      rows.push({ metric, status: "n/a", current, n });
      continue;
    }

    // PR has an override saving this metric.
    if (prOverrides.metrics.has(metric)) {
      const override = prOverrides.metrics.get(metric)!;
      if (current <= override) {
        rows.push({ metric, status: "ovrd", current, n, ...stats! });
        continue;
      }
    }

    if (current > baseline.threshold) {
      const row: Row = { metric, status: "OVER", current, n, ...stats! };
      rows.push(row);
      failures.push(row);
    } else if ((stats!.headroomPct ?? 0) >= 50) {
      rows.push({ metric, status: "CLOSE", current, n, ...stats! });
    } else {
      rows.push({ metric, status: "OK", current, n, ...stats! });
    }
  }

  // 6. Report results

  // 6a. Prominent failure callout up top, so it's unmissable.
  if (failures.length > 0) {
    failures.sort((a, b) => (b.pctIncrease ?? 0) - (a.pctIncrease ?? 0));

    console.log(
      `\n!!! PERFORMANCE REGRESSION DETECTED in ${failures.length} metric(s) !!!\n`,
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
        `| ${f.metric} | ${fmt(f.current)} | ${fmt(f.median!)} | ${
          fmt(f.threshold!)
        } | +${f.pctIncrease!.toFixed(0)}% |`,
      );
    }

    console.log("\nBaseline sample breakdown:\n");
    for (const f of failures) {
      const timeline = timelines.get(f.metric);
      if (!timeline) continue;

      const fmt = (v: number) => formatMetricValue(f.metric, v);
      console.log(
        `  ${f.metric} (n=${timeline.samples.length}, median=${
          fmt(f.median!)
        }, variance=${fmt(f.variance!)}, stddev=${fmt(f.stddev!)}):`,
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
  }

  // 6b. Full metric table — always emitted, grouped by metric kind.
  console.log(
    `\nThresholds: median + ${STDDEV_FACTOR}σ or +${
      MIN_REGRESSION_PCT * 100
    }% (whichever is higher); non-bench metrics also require at least +${MIN_ABSOLUTE_DELTA}s.`,
  );
  console.log(
    "Status key: OVER = over threshold (fails); CLOSE = ≥50% of margin consumed;",
  );
  console.log(
    "  OK = <50% consumed; ovrd = saved by a PR override; excl = metric excluded from the check;",
  );
  console.log(
    `  n/a = fewer than ${MIN_SAMPLES} baseline samples.`,
  );
  console.log(
    `  head% = fraction of the median→threshold margin currently consumed.`,
  );

  const kindOf = (metric: string): string => {
    const colon = metric.indexOf(":");
    if (colon < 0) return "other";
    const prefix = metric.slice(0, colon);
    switch (prefix) {
      case "job":
        return "Jobs";
      case "step":
        return "Steps";
      case "test":
        return "Test files";
      case "subtest":
        return "Subtests";
      case "bench":
        return "Benchmarks";
      default:
        return prefix;
    }
  };
  const KIND_ORDER = ["Jobs", "Steps", "Test files", "Subtests", "Benchmarks"];
  const STATUS_ORDER: Record<Status, number> = {
    OVER: 5,
    CLOSE: 4,
    ovrd: 3,
    OK: 2,
    excl: 1,
    "n/a": 0,
  };

  const byKind = new Map<string, Row[]>();
  for (const r of rows) {
    const k = kindOf(r.metric);
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(r);
  }
  const kindsSeen = [
    ...KIND_ORDER.filter((k) => byKind.has(k)),
    ...[...byKind.keys()].filter((k) => !KIND_ORDER.includes(k)).sort(),
  ];

  const counts = {
    OVER: 0,
    CLOSE: 0,
    OK: 0,
    ovrd: 0,
    excl: 0,
    "n/a": 0,
  } as Record<Status, number>;
  for (const r of rows) counts[r.status]++;

  console.log(
    `\n## All metrics checked  (${rows.length} total — OVER: ${counts.OVER}, CLOSE: ${counts.CLOSE}, OK: ${counts.OK}, ovrd: ${counts.ovrd}, excl: ${counts.excl}, n/a: ${
      counts["n/a"]
    })`,
  );

  for (const kind of kindsSeen) {
    const rs = byKind.get(kind)!;
    rs.sort((a, b) => {
      const s = STATUS_ORDER[b.status] - STATUS_ORDER[a.status];
      if (s !== 0) return s;
      return (b.headroomPct ?? -Infinity) - (a.headroomPct ?? -Infinity);
    });
    console.log(`\n### ${kind}  (${rs.length})`);
    console.log(
      "| status | head% | Δ% | current | baseline median | threshold | n | metric |",
    );
    console.log("|:---|---:|---:|---:|---:|---:|---:|:--|");
    for (const r of rs) {
      const fmt = (v: number | undefined) =>
        v === undefined ? "—" : formatMetricValue(r.metric, v);
      const pct = r.pctIncrease === undefined
        ? "—"
        : `${r.pctIncrease >= 0 ? "+" : ""}${r.pctIncrease.toFixed(1)}%`;
      const head = r.headroomPct === undefined
        ? "—"
        : `${r.headroomPct.toFixed(0)}%`;
      console.log(
        `| ${r.status} | ${head} | ${pct} | ${fmt(r.current)} | ${
          fmt(r.median)
        } | ${fmt(r.threshold)} | ${r.n} | ${r.metric} |`,
      );
    }
  }

  // 6c. Pass/fail outcome + override copy-paste block pinned at the bottom.
  if (failures.length === 0) {
    console.log("\nAll metrics within normal range.");
    Deno.exit(0);
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

  Deno.exit(1);
}

main();
