#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run --allow-write

/**
 * CI Performance Regression Detector (scheduled)
 *
 * Fetches recent "Deno Workflow" runs from GitHub API (main branch push
 * events only), extracts job/step/test durations, computes rolling baselines,
 * and flags regressions via a GitHub Issue.
 *
 * Changes from in-progress PR runs are excluded to avoid false positives.
 *
 * Usage:
 *   GITHUB_TOKEN=... deno run --allow-net --allow-env --allow-read --allow-run --allow-write tasks/perf-regression.ts
 *
 * Environment:
 *   GITHUB_TOKEN        - Required. GitHub token with actions:read and issues:write.
 *   GITHUB_REPOSITORY   - Optional. Defaults to "commontoolsinc/labs".
 *   DRY_RUN             - If "1", print results but don't create/update issues.
 */

import {
  addSample,
  API_CONCURRENCY,
  apiHeaders,
  applyBaselineOverrides,
  type BaselineOverrides,
  computeBaseline,
  type DenoBenchResult,
  downloadAndParseJUnit,
  escapeTableCell,
  extractBenchMetrics,
  extractMetrics,
  extractTestFileMetrics,
  fetchArtifactsForRun,
  fetchJobLog,
  fetchJobsForRun,
  fetchPRForCommit,
  formatMetricValue,
  formatOverrideSuggestion,
  githubGet,
  githubPatch,
  githubPost,
  ISSUE_LABEL,
  JOB_TO_LABEL,
  mapConcurrent,
  MAX_RUNS_TO_FETCH,
  type MetricTimeline,
  MIN_ABSOLUTE_DELTA,
  MIN_BASELINE_DAYS,
  MIN_BASELINE_RUNS,
  MIN_REGRESSION_PCT,
  MIN_SAMPLES,
  normalizeName,
  parseBaselineOverrides,
  parseDenoTestLog,
  type PRInfo,
  RECENT_THRESHOLD,
  RECENT_WINDOW,
  type Regression,
  REPO,
  STDDEV_FACTOR,
  TOKEN,
  WORKFLOW_FILE,
  type WorkflowRun,
} from "./perf-lib.ts";

const DRY_RUN = Deno.env.get("DRY_RUN") === "1";

// ---------------------------------------------------------------------------
// Step 1: Fetch recent successful workflow runs (main branch pushes only)
// ---------------------------------------------------------------------------

async function fetchRecentRuns(): Promise<WorkflowRun[]> {
  const data = await githubGet<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&status=success&event=push&per_page=${MAX_RUNS_TO_FETCH}`,
  );
  return data.workflow_runs;
}

// ---------------------------------------------------------------------------
// Regression detection (with baseline override support)
// ---------------------------------------------------------------------------

function detectRegressions(
  timelines: Map<string, MetricTimeline>,
): Regression[] {
  const regressions: Regression[] = [];

  for (const [name, timeline] of timelines) {
    const samples = timeline.samples;
    if (samples.length < MIN_SAMPLES + RECENT_WINDOW) continue;

    const recentSamples = samples.slice(-RECENT_WINDOW);
    const baselineSamples = samples.slice(0, -RECENT_WINDOW);

    const baseline = computeBaseline(
      baselineSamples.map((s) => s.durationSeconds),
      name.startsWith("bench:") ? 0 : MIN_ABSOLUTE_DELTA,
    );
    if (!baseline) continue;

    const exceeding = recentSamples.filter(
      (s) => s.durationSeconds > baseline.threshold,
    );
    if (exceeding.length >= RECENT_THRESHOLD) {
      const avgRecent = recentSamples.reduce((s, v) =>
        s + v.durationSeconds, 0) /
        recentSamples.length;
      const pctIncrease = ((avgRecent - baseline.median) / baseline.median) *
        100;

      regressions.push({
        metric: name,
        recentValues: recentSamples.map((s) => s.durationSeconds),
        baseline,
        avgRecent,
        pctIncrease,
      });
    }
  }

  regressions.sort((a, b) => b.pctIncrease - a.pctIncrease);
  return regressions;
}

// ---------------------------------------------------------------------------
// GitHub Issue reporting
// ---------------------------------------------------------------------------

function buildIssueBody(
  regressions: Regression[],
  baselineInfo: string,
  prInfoBySha: Map<string, PRInfo>,
  timelines: Map<string, MetricTimeline>,
): string {
  const lines: string[] = [
    "## CI Performance Regression Detected\n",
    `**Detected:** ${new Date().toISOString().slice(0, 16)}Z\n`,
    "| Metric | Recent (avg) | Baseline (median) | Threshold | Change |",
    "|--------|-------------|-------------------|-----------|--------|",
  ];

  for (const r of regressions) {
    const fmt = (v: number) => formatMetricValue(r.metric, v);
    lines.push(
      `| ${r.metric} | ${fmt(r.avgRecent)} | ${fmt(r.baseline.median)} | ${
        fmt(r.baseline.threshold)
      } | **+${r.pctIncrease.toFixed(0)}%** |`,
    );
  }

  lines.push("");
  lines.push(baselineInfo);

  // Identify PRs that may have caused regressions
  lines.push("");
  lines.push("### Potentially causal PRs\n");

  const recentShas = new Set<string>();
  for (const r of regressions) {
    const timeline = timelines.get(r.metric);
    if (!timeline) continue;
    for (const sample of timeline.samples.slice(-RECENT_WINDOW)) {
      recentShas.add(sample.sha);
    }
  }

  const listedPrs = new Set<number>();
  for (const sha of recentShas) {
    const pr = prInfoBySha.get(sha);
    if (pr && !listedPrs.has(pr.number)) {
      listedPrs.add(pr.number);
      lines.push(`- [#${pr.number}](${pr.html_url}) — ${pr.title}`);
    } else if (!pr) {
      lines.push(`- Commit \`${sha.slice(0, 8)}\` (no associated PR found)`);
    }
  }

  if (listedPrs.size === 0 && recentShas.size === 0) {
    lines.push("_No recent commits identified._");
  }

  lines.push("");
  lines.push("### Sample breakdown\n");

  for (const r of regressions) {
    const timeline = timelines.get(r.metric);
    if (!timeline) continue;

    const samples = timeline.samples;
    if (samples.length < MIN_SAMPLES + RECENT_WINDOW) continue;

    const recentSamples = samples.slice(-RECENT_WINDOW);
    const baselineSamples = samples.slice(0, -RECENT_WINDOW);

    const fmt = (v: number) => formatMetricValue(r.metric, v);

    lines.push(`<details>`);
    lines.push(
      `<summary><b>${r.metric}</b> — baseline median ${
        fmt(r.baseline.median)
      }, recent avg ${fmt(r.avgRecent)} (+${
        r.pctIncrease.toFixed(0)
      }%)</summary>\n`,
    );

    lines.push(
      `**Baseline samples** (n=${baselineSamples.length}, median=${
        fmt(r.baseline.median)
      }, variance=${fmt(r.baseline.variance)}, stddev=${
        fmt(r.baseline.stddev)
      })\n`,
    );
    lines.push("| # | Value | Commit | PR | Date |");
    lines.push("|---|-------|--------|-----|------|");

    for (let i = 0; i < baselineSamples.length; i++) {
      const s = baselineSamples[i];
      const pr = prInfoBySha.get(s.sha);
      const prStr = pr
        ? `[#${pr.number}](${pr.html_url}) — ${escapeTableCell(pr.title)}`
        : "—";
      lines.push(
        `| ${i + 1} | ${fmt(s.durationSeconds)} | \`${
          s.sha.slice(0, 8)
        }\` | ${prStr} | ${s.createdAt.slice(0, 10)} |`,
      );
    }

    lines.push("");
    lines.push(`**Recent samples** (avg=${fmt(r.avgRecent)})\n`);
    lines.push("| # | Value | Commit | PR | Date |");
    lines.push("|---|-------|--------|-----|------|");

    for (let i = 0; i < recentSamples.length; i++) {
      const s = recentSamples[i];
      const pr = prInfoBySha.get(s.sha);
      const prStr = pr
        ? `[#${pr.number}](${pr.html_url}) — ${escapeTableCell(pr.title)}`
        : "—";
      lines.push(
        `| ${i + 1} | ${fmt(s.durationSeconds)} | \`${
          s.sha.slice(0, 8)
        }\` | ${prStr} | ${s.createdAt.slice(0, 10)} |`,
      );
    }

    lines.push("\n</details>\n");
  }

  lines.push("");
  lines.push("### How to set a new baseline\n");
  lines.push(
    "If a regression is intentional (e.g. a new feature added cost), " +
      "add the following to the PR description to set new baselines:\n",
  );
  lines.push("```");
  for (const r of regressions) {
    const suggested = formatOverrideSuggestion(r.metric, r.avgRecent);
    lines.push(`NEW_PERF_BASELINE: ${r.metric} = ${suggested}`);
  }
  lines.push("```");

  lines.push("");
  lines.push(
    "---\n*Auto-generated by [perf-regression](../blob/main/tasks/perf-regression.ts). Updated on each scheduled run.*",
  );

  return lines.join("\n");
}

async function ensureLabel(): Promise<void> {
  try {
    await githubGet(`/repos/${REPO}/labels/${ISSUE_LABEL}`);
  } catch {
    await githubPost(`/repos/${REPO}/labels`, {
      name: ISSUE_LABEL,
      color: "d93f0b",
      description: "Automated CI performance regression detection",
    });
    console.log(`Created label: ${ISSUE_LABEL}`);
  }
}

async function findOpenIssue(): Promise<{ number: number } | null> {
  const data = await githubGet<{ number: number }[]>(
    `/repos/${REPO}/issues?labels=${ISSUE_LABEL}&state=open&per_page=1`,
  );
  return data.length > 0 ? data[0] : null;
}

async function reportRegressions(
  regressions: Regression[],
  baselineInfo: string,
  prInfoBySha: Map<string, PRInfo>,
  timelines: Map<string, MetricTimeline>,
): Promise<void> {
  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would report the following regressions:\n");
    console.log(
      buildIssueBody(regressions, baselineInfo, prInfoBySha, timelines),
    );
    return;
  }

  await ensureLabel();
  const existing = await findOpenIssue();

  if (regressions.length === 0) {
    if (existing) {
      await githubPatch(`/repos/${REPO}/issues/${existing.number}`, {
        state: "closed",
        state_reason: "completed",
      });
      await githubPost(
        `/repos/${REPO}/issues/${existing.number}/comments`,
        {
          body:
            "All metrics are back within normal range. Closing automatically.",
        },
      );
      console.log(`Closed issue #${existing.number} — regressions resolved.`);
    } else {
      console.log("No regressions detected and no open issue. Nothing to do.");
    }
    return;
  }

  const body = buildIssueBody(
    regressions,
    baselineInfo,
    prInfoBySha,
    timelines,
  );

  if (existing) {
    await githubPatch(`/repos/${REPO}/issues/${existing.number}`, { body });
    console.log(
      `Updated issue #${existing.number} with ${regressions.length} regression(s).`,
    );
  } else {
    const issue = await githubPost<{ number: number; html_url: string }>(
      `/repos/${REPO}/issues`,
      {
        title: "CI Performance Regression Detected",
        body,
        labels: [ISSUE_LABEL],
      },
    );
    console.log(`Created issue #${issue.number}: ${issue.html_url}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!TOKEN) {
    console.error("GITHUB_TOKEN is required.");
    Deno.exit(1);
  }

  console.log(
    `Fetching recent workflow runs for ${REPO} (main branch pushes only)...`,
  );
  const allRuns = await fetchRecentRuns();
  if (allRuns.length === 0) {
    console.log("No successful workflow runs found.");
    return;
  }

  // Determine baseline window
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MIN_BASELINE_DAYS);

  let runs = allRuns.slice(0, MIN_BASELINE_RUNS);
  for (let i = runs.length; i < allRuns.length; i++) {
    if (new Date(allRuns[i].created_at) >= cutoffDate) {
      runs.push(allRuns[i]);
    } else {
      break;
    }
  }
  if (runs.length < MIN_BASELINE_RUNS) {
    runs = allRuns.slice(0, Math.min(MIN_BASELINE_RUNS, allRuns.length));
  }

  console.log(
    `Analyzing ${runs.length} runs (from ${
      runs[runs.length - 1].created_at.slice(0, 10)
    } to ${runs[0].created_at.slice(0, 10)}).`,
  );

  // Fetch jobs for all runs concurrently
  console.log("Fetching job data...");
  const jobsByRun = await mapConcurrent(
    runs,
    API_CONCURRENCY,
    async (run) => ({
      run,
      jobs: await fetchJobsForRun(run.id),
    }),
  );

  // Fetch PR info for all runs concurrently (for blame and baseline overrides)
  console.log("Fetching PR info for commits...");
  const prInfoBySha = new Map<string, PRInfo>();
  const overridesBySha = new Map<string, BaselineOverrides>();

  await mapConcurrent(runs, API_CONCURRENCY, async (run) => {
    const pr = await fetchPRForCommit(run.head_sha);
    if (pr) {
      prInfoBySha.set(run.head_sha, pr);
      if (pr.body) {
        const overrides = parseBaselineOverrides(pr.body);
        if (overrides.metrics.size > 0) {
          overridesBySha.set(run.head_sha, overrides);
          console.log(
            `  Found baseline override in PR #${pr.number} (${
              run.head_sha.slice(0, 8)
            }) [${overrides.metrics.size} metric(s)]`,
          );
        }
      }
    }
  });

  // Build timelines from job/step data
  const timelines = new Map<string, MetricTimeline>();

  // Process runs oldest-first so samples are in chronological order
  for (const { run, jobs } of [...jobsByRun].reverse()) {
    const metrics = extractMetrics(run, jobs);
    for (const [name, sample] of metrics) {
      addSample(timelines, name, sample);
    }
  }

  // Fetch JUnit artifacts for per-test-file timing
  // TODO(perf): Remove log-parsing fallback after 2026-03-19.
  console.log("Fetching test timing artifacts...");
  let artifactRunsProcessed = 0;
  let logParseRunsProcessed = 0;
  await mapConcurrent(
    [...jobsByRun],
    API_CONCURRENCY,
    async ({ run, jobs }) => {
      try {
        const artifacts = await fetchArtifactsForRun(run.id);
        const timingArtifacts = artifacts.filter(
          (a) => a.name.startsWith("test-timing-") && !a.expired,
        );

        if (timingArtifacts.length > 0) {
          for (const artifact of timingArtifacts) {
            const suites = await downloadAndParseJUnit(artifact.id);
            if (suites.length > 0) {
              artifactRunsProcessed++;
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
        } else {
          let parsedAny = false;
          for (const job of jobs) {
            const normalizedName = normalizeName(job.name);
            let label: string | undefined;
            for (const [pattern, l] of Object.entries(JOB_TO_LABEL)) {
              if (normalizedName.includes(pattern)) {
                label = l;
                break;
              }
            }
            if (!label) continue;

            const log = await fetchJobLog(job.id);
            if (!log) continue;

            const suites = parseDenoTestLog(log);
            if (suites.length > 0) {
              parsedAny = true;
              const testMetrics = extractTestFileMetrics(run, label, suites);
              for (const [name, sample] of testMetrics) {
                addSample(timelines, name, sample);
              }
            }
          }
          if (parsedAny) logParseRunsProcessed++;
        }
      } catch (e) {
        console.warn(
          `  Warning: could not fetch artifacts for run ${run.id}: ${e}`,
        );
      }
    },
  );

  console.log(
    `Processed ${timelines.size} metrics across ${runs.length} runs (${artifactRunsProcessed} with JUnit artifacts, ${logParseRunsProcessed} via log parsing).`,
  );

  // Fetch benchmark results from the Benchmarks workflow
  console.log("Fetching benchmark results...");
  let benchRunsProcessed = 0;
  try {
    const benchRuns = (
      await githubGet<{ workflow_runs: WorkflowRun[] }>(
        `/repos/${REPO}/actions/workflows/benchmarks.yml/runs?branch=main&status=success&event=push&per_page=${MAX_RUNS_TO_FETCH}`,
      )
    ).workflow_runs;

    if (benchRuns.length > 0) {
      await mapConcurrent(benchRuns, API_CONCURRENCY, async (run) => {
        try {
          const artifacts = await fetchArtifactsForRun(run.id);
          const benchArtifact = artifacts.find(
            (a) => a.name === "bench-results" && !a.expired,
          );
          if (!benchArtifact) return;

          const resp = await fetch(
            `https://api.github.com/repos/${REPO}/actions/artifacts/${benchArtifact.id}/zip`,
            { headers: apiHeaders() },
          );
          if (!resp.ok) return;

          const tmpDir = await Deno.makeTempDir({ prefix: "perf-bench-" });
          try {
            const data = new Uint8Array(await resp.arrayBuffer());
            await Deno.writeFile(`${tmpDir}/artifact.zip`, data);
            const unzip = new Deno.Command("unzip", {
              args: ["-o", `${tmpDir}/artifact.zip`, "-d", tmpDir],
              stdout: "null",
              stderr: "null",
            });
            if (!(await unzip.output()).success) return;

            const jsonPath = `${tmpDir}/results.json`;
            try {
              const content = await Deno.readTextFile(jsonPath);
              const benchData: DenoBenchResult = JSON.parse(content);
              const benchMetrics = extractBenchMetrics(run, benchData);
              for (const [name, sample] of benchMetrics) {
                addSample(timelines, name, sample);
              }
              benchRunsProcessed++;
            } catch { /* missing or invalid JSON */ }
          } finally {
            try {
              await Deno.remove(tmpDir, { recursive: true });
            } catch { /* ignore */ }
          }
        } catch {
          // Benchmark artifacts may not exist yet
        }
      });

      // Re-sort all timelines since concurrent artifact fetches may have
      // appended samples out of chronological order.
      for (const timeline of timelines.values()) {
        timeline.samples.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      }

      console.log(
        `  Found ${benchRuns.length} benchmark runs, ${benchRunsProcessed} with results.`,
      );
    } else {
      console.log(
        "  No benchmark runs found (workflow may not have run yet).",
      );
    }
  } catch {
    console.log("  Benchmarks workflow not found or not yet created.");
  }

  // Sort all timelines chronologically before applying overrides, since
  // concurrent artifact fetches may have appended samples out of order.
  for (const timeline of timelines.values()) {
    timeline.samples.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Apply baseline overrides (truncate timelines at override points)
  if (overridesBySha.size > 0) {
    console.log(
      `Applying ${overridesBySha.size} baseline override(s)...`,
    );
    applyBaselineOverrides(timelines, overridesBySha);
  }

  // Print a summary of all metrics
  console.log("\nMetric summary:");
  for (
    const [name, timeline] of [...timelines].sort((a, b) =>
      a[0].localeCompare(b[0])
    )
  ) {
    const durations = timeline.samples.map((s) => s.durationSeconds);
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    const latest = durations[durations.length - 1];
    const fmt = (v: number) => formatMetricValue(name, v);
    console.log(
      `  ${name}: latest=${fmt(latest)}, median=${
        fmt(median)
      }, samples=${durations.length}`,
    );
  }

  // Detect regressions
  const regressions = detectRegressions(timelines);

  if (regressions.length > 0) {
    console.log(`\n${regressions.length} regression(s) detected:`);
    for (const r of regressions) {
      const fmt = (v: number) => formatMetricValue(r.metric, v);
      console.log(
        `  ${r.metric}: ${fmt(r.avgRecent)} vs baseline ${
          fmt(r.baseline.median)
        } (+${r.pctIncrease.toFixed(0)}%)`,
      );

      // Show individual contributions
      const timeline = timelines.get(r.metric);
      if (timeline && timeline.samples.length >= MIN_SAMPLES + RECENT_WINDOW) {
        const baselineSamples = timeline.samples.slice(0, -RECENT_WINDOW);
        const recentSamples = timeline.samples.slice(-RECENT_WINDOW);

        console.log(`    Baseline samples (n=${baselineSamples.length}):`);
        for (const s of baselineSamples) {
          const pr = prInfoBySha.get(s.sha);
          const prStr = pr ? `PR #${pr.number}` : s.sha.slice(0, 8);
          console.log(
            `      ${fmt(s.durationSeconds)} — ${prStr} (${
              s.createdAt.slice(0, 10)
            })`,
          );
        }
        console.log(`    Recent samples (n=${recentSamples.length}):`);
        for (const s of recentSamples) {
          const pr = prInfoBySha.get(s.sha);
          const prStr = pr ? `PR #${pr.number}` : s.sha.slice(0, 8);
          console.log(
            `      ${fmt(s.durationSeconds)} — ${prStr} (${
              s.createdAt.slice(0, 10)
            })`,
          );
        }
      }
    }
  } else {
    console.log("\nNo regressions detected.");
  }

  const baselineInfo = `Based on ${runs.length} runs from ${
    runs[runs.length - 1]?.created_at.slice(0, 10) ?? "?"
  } to ${
    runs[0]?.created_at.slice(0, 10) ?? "?"
  }. Thresholds: median + ${STDDEV_FACTOR}σ or +${
    MIN_REGRESSION_PCT * 100
  }% (whichever is higher); non-bench metrics also require at least +${MIN_ABSOLUTE_DELTA}s. Requires ${RECENT_THRESHOLD}/${RECENT_WINDOW} recent runs to exceed threshold.`;

  await reportRegressions(regressions, baselineInfo, prInfoBySha, timelines);
}

main();
