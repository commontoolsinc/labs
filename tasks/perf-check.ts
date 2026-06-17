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
  type Artifact,
  type BaselineOverrides,
  computeBaseline,
  computeCiWallTimeRevisitSignals,
  COVERAGE_BASELINE_RESET_MARKER,
  coverageGroupsForChangedFiles,
  coverageMetricGroupName,
  downloadAndExtractArtifact,
  downloadAndParseJUnit,
  downloadAndParsePerfMetrics,
  downloadAndParsePerfMetricsBackfill,
  extractMetrics,
  extractTestFileMetrics,
  fetchArtifactsForRun,
  fetchCurrentPRBody,
  fetchJobsForRun,
  fetchPRFiles,
  fetchPRForCommit,
  formatMetricValue,
  formatOverrideSuggestion,
  githubGet,
  isCoverageDebtMetric,
  mapConcurrent,
  type MetricTimeline,
  MIN_ABSOLUTE_DELTA,
  MIN_REGRESSION_PCT,
  MIN_SAMPLES,
  newestArtifactsByName,
  parseBaselineOverrides,
  PERF_METRICS_ARTIFACT_NAME,
  PERF_METRICS_BACKFILL_ARTIFACT_NAME,
  PERF_METRICS_BACKFILL_FILE,
  PERF_METRICS_FILE,
  type PRInfo,
  readAndParseEvent,
  REPO,
  shouldGateCoverageDebtMetric,
  STDDEV_FACTOR,
  timingArtifactLabel,
  type TimingSample,
  TOKEN,
  walkFiles,
  WORKFLOW_FILE,
  type WorkflowRun,
  writePerfMetricsBackfillFile,
  writePerfMetricsFile,
} from "./perf-lib.ts";
import * as path from "@std/path";
import {
  collectCoverageDebtMetrics,
  collectCoverageDebtMetricsFromLcov,
  COVERAGE_PROFILE_ARTIFACT_PREFIX,
} from "./coverage-metrics.ts";

/** How many recent main-branch runs to use for baseline. */
const BASELINE_RUNS = 20;

/** Recent completed workflow runs to scan for fallback backfill artifacts. */
const BACKFILL_SOURCE_RUNS = 20;

function currentWorkflowRunFromEvent(
  event: object | undefined,
  runId: number,
): WorkflowRun {
  const payload = event as {
    after?: unknown;
    pull_request?: {
      head?: { sha?: unknown };
    };
  } | undefined;

  const headSha = typeof payload?.pull_request?.head?.sha === "string"
    ? payload.pull_request.head.sha
    : typeof payload?.after === "string"
    ? payload.after
    : Deno.env.get("GITHUB_SHA") ?? "";

  return {
    id: runId,
    html_url: `https://github.com/${REPO}/actions/runs/${runId}`,
    head_sha: headSha,
    created_at: new Date().toISOString(),
    conclusion: "",
    event: Deno.env.get("GITHUB_EVENT_NAME") ?? "",
  };
}

function isGitHubRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(rate limit|rate-limited|ratelimit)\b/i.test(message);
}

async function githubApiOrSkip<T>(
  description: string,
  operation: () => Promise<T>,
  metricsForArtifact: Map<string, TimingSample>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isGitHubRateLimitError(error)) throw error;

    console.warn(
      `  Warning: GitHub API rate limit while ${description}: ${error}`,
    );
    await writePerfMetricsFile(PERF_METRICS_FILE, metricsForArtifact);
    console.log(
      `Wrote ${PERF_METRICS_FILE} with ${metricsForArtifact.size} metrics.`,
    );
    console.log(
      "Skipping performance regression check because GitHub API rate limits prevent collecting required CI timing data.",
    );
    Deno.exit(0);
  }
}

export function parseMergedBaselineOverrides(
  pr: Pick<PRInfo, "number" | "body">,
  warn: (message: string) => void = console.warn,
): BaselineOverrides | null {
  try {
    return parseBaselineOverrides(pr.body ?? "");
  } catch (error) {
    warn(
      `  Warning: ignoring invalid baseline override in merged PR #${pr.number}: ${error}`,
    );
    return null;
  }
}

/**
 * Metrics to exclude from regression checks because their aggregate values
 * naturally grow as new tests are added.  Per-test timings from JUnit
 * artifacts are tracked instead.
 */
const EXCLUDED_METRIC_PATTERNS = [
  /^job: Pattern Unit Tests/,
  /^step: pattern unit tests$/,
];

const EXPECTED_COVERAGE_ARTIFACT_NAMES = [
  "coverage-profile-workspace",
  ...[1, 2, 3, 4].map((shard) => `coverage-profile-runner-${shard}`),
  ...[1, 2, 3, 4].map((shard) =>
    `coverage-profile-generated-patterns-${shard}`
  ),
  "coverage-profile-package-runner",
  "coverage-profile-package-runtime-client",
  "coverage-profile-package-shell",
  ...[1, 2, 3, 4].map((shard) =>
    `coverage-profile-pattern-integration-${shard}`
  ),
  "coverage-profile-pattern-reload",
  ...[1, 2, 3, 4, 5].map((chunk) => `coverage-profile-pattern-unit-${chunk}`),
];

function sampleForRun(run: WorkflowRun, value: number): TimingSample {
  return {
    runId: run.id,
    runUrl: run.html_url,
    sha: run.head_sha,
    createdAt: run.created_at,
    durationSeconds: value,
  };
}

async function copyCoverageArtifactFiles(
  artifact: Artifact,
  profileDir: string,
  lcovDir: string,
): Promise<{ profileFiles: number; lcovFiles: number }> {
  const extractedDir = await downloadAndExtractArtifact(
    artifact.id,
    "coverage-profile-",
  );
  if (!extractedDir) {
    throw new Error(
      `Failed to download or extract coverage profile artifact ${artifact.name} (${artifact.id}).`,
    );
  }

  let profileFiles = 0;
  let lcovFiles = 0;
  try {
    for await (const file of walkFiles(extractedDir)) {
      const isProfile = file.endsWith(".json");
      const isLcov = file.endsWith(".lcov");
      if (!isProfile && !isLcov) continue;
      const count = isLcov ? lcovFiles : profileFiles;
      const destDir = isLcov ? lcovDir : profileDir;
      const dest = path.join(
        destDir,
        `${artifact.id}-${count}-${path.basename(file)}`,
      );
      await Deno.copyFile(file, dest);
      if (isLcov) lcovFiles++;
      else profileFiles++;
    }

    if (profileFiles === 0 && lcovFiles === 0) {
      throw new Error(
        `Coverage profile artifact ${artifact.name} (${artifact.id}) contained no profile or LCOV files.`,
      );
    }
  } finally {
    try {
      await Deno.remove(extractedDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }

  return { profileFiles, lcovFiles };
}

async function readCombinedLcov(lcovDir: string): Promise<string> {
  const chunks: string[] = [];
  for await (const file of walkFiles(lcovDir)) {
    if (!file.endsWith(".lcov")) continue;
    chunks.push(await Deno.readTextFile(file));
  }
  return chunks.join("\n");
}

type TableAlign = "left" | "right";
type Status = "OVER" | "CLOSE" | "OK" | "ovrd" | "excl" | "n/a";

function printTextTable(
  headers: string[],
  rows: string[][],
  align: TableAlign[] = [],
): void {
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[column]?.length ?? 0),
    )
  );

  const formatCell = (cell: string, column: number) =>
    align[column] === "right"
      ? cell.padStart(widths[column])
      : cell.padEnd(widths[column]);
  const formatRow = (cells: string[]) =>
    cells.map((cell, column) => formatCell(cell, column)).join("  ");

  console.log(formatRow(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

function trimTrailingZero(value: string): string {
  return value.replace(/\.0(?=[a-z])/g, "");
}

function formatMetricValueForTable(
  metric: string,
  value: number | undefined,
): string {
  if (value === undefined) return "-";
  if (isCoverageDebtMetric(metric)) return `${Math.round(value)}`;
  return trimTrailingZero(formatMetricValue(metric, value));
}

function formatMetricDelta(metric: string, row: Row): string {
  if (row.median === undefined || row.pctIncrease === undefined) return "-";

  const delta = row.current - row.median;
  const sign = delta >= 0 ? "+" : "-";
  const absolute = Math.abs(delta);
  const formattedAbsolute = isCoverageDebtMetric(metric)
    ? `${Math.round(absolute)}`
    : trimTrailingZero(formatMetricValue(metric, absolute));
  const pctSign = row.pctIncrease >= 0 ? "+" : "";
  const pctDigits = row.pctIncrease !== 0 && Math.abs(row.pctIncrease) < 1
    ? 1
    : 0;
  return `${sign}${formattedAbsolute} (${pctSign}${
    row.pctIncrease.toFixed(pctDigits)
  }%)`;
}

function metricDisplayParts(metric: string): { task: string; metric: string } {
  const colon = metric.indexOf(":");
  if (colon < 0) return { task: "other", metric };

  const kind = metric.slice(0, colon);
  const rest = metric.slice(colon + 1).trim();
  const subtaskSeparator = " > ";

  if (
    (kind === "test" || kind === "subtest") &&
    rest.includes(subtaskSeparator)
  ) {
    const [task, ...metricParts] = rest.split(subtaskSeparator);
    return { task, metric: metricParts.join(subtaskSeparator) };
  }

  if (kind === "coverage-debt") {
    return {
      task: kind,
      metric: coverageMetricGroupName(metric) ?? rest,
    };
  }

  return { task: kind, metric: rest };
}

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
   * How much of the median-to-threshold margin the current value has consumed,
   * as a percentage. 0 percent means the current value is at the median.
   * 100 percent means the current value is at the threshold.
   */
  headroomPct?: number;
}

function metricTableRows(rows: Row[], includeStatus: boolean): string[][] {
  return rows.map((row) => {
    const display = metricDisplayParts(row.metric);
    const cells = [
      formatMetricValueForTable(row.metric, row.median),
      formatMetricValueForTable(row.metric, row.current),
      formatMetricDelta(row.metric, row),
      display.task,
      display.metric,
    ];
    return includeStatus ? [row.status, ...cells] : cells;
  });
}

function printMetricTable(rows: Row[], includeStatus = false): void {
  const headers = includeStatus
    ? ["Status", "Baseline", "Current", "Change", "Task", "Metric"]
    : ["Baseline", "Current", "Change", "Task", "Metric"];
  const align = includeStatus
    ? ["left", "right", "right", "right", "left", "left"] as TableAlign[]
    : ["right", "right", "right", "left", "left"] as TableAlign[];
  printTextTable(headers, metricTableRows(rows, includeStatus), align);
}

async function extractCoverageDebtSamples(
  run: WorkflowRun,
  artifacts: Artifact[],
): Promise<Map<string, TimingSample>> {
  const metrics = new Map<string, TimingSample>();
  const coverageArtifacts = newestArtifactsByName(artifacts.filter(
    (artifact) =>
      artifact.name.startsWith(COVERAGE_PROFILE_ARTIFACT_PREFIX) &&
      !artifact.expired,
  ));
  const coverageArtifactNames = new Set(
    coverageArtifacts.map((artifact) => artifact.name),
  );
  const missingArtifacts = EXPECTED_COVERAGE_ARTIFACT_NAMES.filter((name) =>
    !coverageArtifactNames.has(name)
  );

  if (missingArtifacts.length > 0) {
    throw new Error(
      `Missing coverage profile artifact(s): ${missingArtifacts.join(", ")}`,
    );
  }

  const profileDir = await Deno.makeTempDir({ prefix: "coverage-profiles-" });
  const lcovDir = await Deno.makeTempDir({ prefix: "coverage-lcov-" });
  try {
    let profileFileCount = 0;
    let lcovFileCount = 0;
    for (const artifact of coverageArtifacts) {
      const copied = await copyCoverageArtifactFiles(
        artifact,
        profileDir,
        lcovDir,
      );
      profileFileCount += copied.profileFiles;
      lcovFileCount += copied.lcovFiles;
    }

    if (profileFileCount === 0 && lcovFileCount === 0) {
      throw new Error(
        "Coverage profile artifacts contained no profile or LCOV files.",
      );
    }

    const coverageMetrics = lcovFileCount > 0
      ? await collectCoverageDebtMetricsFromLcov({
        rootDir: Deno.cwd(),
        lcov: await readCombinedLcov(lcovDir),
      })
      : await collectCoverageDebtMetrics({
        rootDir: Deno.cwd(),
        coverageProfileDir: profileDir,
      });

    for (const metric of coverageMetrics) {
      metrics.set(
        metric.name,
        sampleForRun(run, metric.uncoveredLines),
      );
    }

    console.log(
      `Extracted ${coverageMetrics.length} coverage debt metrics from ${
        lcovFileCount > 0
          ? `${lcovFileCount} LCOV report files`
          : `${profileFileCount} coverage profile files`
      }.`,
    );
  } finally {
    try {
      await Deno.remove(profileDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
    try {
      await Deno.remove(lcovDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runId = Deno.env.get("GITHUB_RUN_ID");
  const rawPrNumber = Deno.env.get("PR_NUMBER");
  const prNumber = (rawPrNumber === "") ? null : rawPrNumber;
  const informationalOnly = prNumber === null;

  if (!TOKEN) {
    console.error("GITHUB_TOKEN is required.");
    Deno.exit(1);
  }
  if (!runId) {
    console.error("GITHUB_RUN_ID is required.");
    Deno.exit(1);
  }

  const event = await readAndParseEvent();
  console.log("::group::Triggered by event:\n%o\n::endgroup::", event);

  // 1. Check PR description for overrides, if there's a PR to check.
  let prOverrides;
  if (prNumber) {
    console.log(`Fetching live PR #${prNumber} description...`);
    const prBody = await fetchCurrentPRBody(parseInt(prNumber), event);
    if (prBody.source === "live") {
      console.log("Using live PR description from GitHub API.");
    } else if (prBody.source === "event-fallback") {
      console.warn(
        `  Warning: could not fetch live PR body; using pull_request event payload: ${prBody.errorMessage}`,
      );
    } else {
      console.warn(
        `  Warning: could not fetch live PR body and no pull_request event body was available: ${prBody.errorMessage}`,
      );
    }
    try {
      prOverrides = parseBaselineOverrides(prBody.body);
    } catch (error) {
      console.error(
        `Invalid performance baseline override in PR description: ${error}`,
      );
      Deno.exit(1);
    }
  } else {
    prOverrides = { metrics: new Map(), coverageBaselineReset: false };
  }

  if (prOverrides.metrics.size > 0) {
    console.log(
      `PR description contains ${prOverrides.metrics.size} NEW_PERF_BASELINE override(s).`,
    );
  }
  if (prOverrides.coverageBaselineReset) {
    console.log(
      `PR description contains ${COVERAGE_BASELINE_RESET_MARKER}; coverage debt ratchet failures will be treated as an intentional baseline reset.`,
    );
  }

  // 2. Get current run's job/step metrics and per-test timing artifacts
  console.log(`Fetching jobs for current run ${runId}...`);
  const runIdNum = parseInt(runId);
  const currentMetrics = new Map<string, TimingSample>();
  const currentJobs = await githubApiOrSkip(
    `fetching jobs for current run ${runId}`,
    () => fetchJobsForRun(runIdNum),
    currentMetrics,
  );

  // The event payload has the metadata needed for samples, so avoid spending
  // another API request on the current workflow run.
  const currentRunInfo = currentWorkflowRunFromEvent(event, runIdNum);
  let changedCoverageGroups: Set<string> | undefined;

  if (prNumber) {
    try {
      const prFiles = await fetchPRFiles(parseInt(prNumber));
      changedCoverageGroups = coverageGroupsForChangedFiles(
        prFiles.map((file) => file.filename),
      );
      const groups = [...changedCoverageGroups].sort();
      if (groups.length > 0) {
        console.log(
          `Coverage debt gating applies to changed source group(s): ${
            groups.join(", ")
          }.`,
        );
      } else {
        console.log(
          "PR changes no coverage source groups; coverage debt metrics will be reported but not blocking.",
        );
      }
    } catch (error) {
      console.warn(
        `  Warning: could not fetch PR changed files; coverage debt metrics will use strict gating: ${error}`,
      );
    }
  }

  // Extract job/step metrics
  for (const [name, sample] of extractMetrics(currentRunInfo, currentJobs)) {
    currentMetrics.set(name, sample);
  }

  let currentArtifacts: Artifact[] = [];
  let currentArtifactsError: unknown;

  // Fetch artifacts once; coverage extraction depends on this, while timing
  // artifact parsing below is best-effort.
  try {
    currentArtifacts = await fetchArtifactsForRun(runIdNum);
    console.log(
      `Fetched ${currentArtifacts.length} artifacts for current run.`,
    );
  } catch (e) {
    currentArtifactsError = e;
    console.warn(`  Warning: could not fetch artifacts for current run: ${e}`);
  }

  // Extract per-test metrics from JUnit artifacts
  try {
    // Newest per name: a re-run of a flagged test job must refresh its metric.
    const timingArtifacts = newestArtifactsByName(currentArtifacts.filter(
      (a) => a.name.startsWith("test-timing-") && !a.expired,
    ));
    for (const artifact of timingArtifacts) {
      const suites = await downloadAndParseJUnit(artifact.id);
      const testMetrics = extractTestFileMetrics(
        currentRunInfo,
        timingArtifactLabel(artifact.name),
        suites,
      );
      for (const [name, sample] of testMetrics) {
        currentMetrics.set(name, sample);
      }
    }
  } catch (e) {
    console.warn(
      `  Warning: could not extract timing metrics from current run artifacts: ${e}`,
    );
  }

  // Extract coverage debt metrics from coverage profile artifacts.
  let coverageDataError: unknown;
  try {
    if (currentArtifactsError) {
      throw new Error(
        `Could not fetch current run artifacts: ${currentArtifactsError}`,
      );
    }
    const coverageMetrics = await extractCoverageDebtSamples(
      currentRunInfo,
      currentArtifacts,
    );
    for (const [name, sample] of coverageMetrics) {
      currentMetrics.set(name, sample);
    }
  } catch (e) {
    coverageDataError = e;
    console.error(
      `  Error: could not extract coverage debt metrics for current run: ${e}`,
    );
  }

  await writePerfMetricsFile(PERF_METRICS_FILE, currentMetrics);
  console.log(
    `Wrote ${PERF_METRICS_FILE} with ${currentMetrics.size} metrics.`,
  );

  if (coverageDataError && !informationalOnly) {
    console.error(
      "Failing because coverage debt data is required for pull request checks.",
    );
    Deno.exit(1);
  }

  if (currentMetrics.size === 0) {
    console.log("No metrics extracted from current run. Nothing to check.");
    Deno.exit(0);
  }

  console.log(`Extracted ${currentMetrics.size} metrics from current run.`);
  const wallTimeSignals = computeCiWallTimeRevisitSignals(currentJobs);

  // 3. Fetch recent main-branch push runs for baseline
  console.log("Fetching recent main-branch runs for baseline...");
  const baselineData = await githubApiOrSkip(
    "fetching recent main-branch runs for baseline",
    () =>
      githubGet<{ workflow_runs: WorkflowRun[] }>(
        `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&status=success&event=push&per_page=${BASELINE_RUNS}`,
      ),
    currentMetrics,
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
  const newBackfills = new Map<number, Map<string, TimingSample>>();

  interface BaselineRunContext {
    run: WorkflowRun;
    artifacts: Artifact[];
    pr: PRInfo | null;
  }

  async function fetchArtifactsForRunBestEffort(
    run: WorkflowRun,
  ): Promise<Artifact[]> {
    try {
      return await fetchArtifactsForRun(run.id);
    } catch (error) {
      console.warn(
        `  Warning: could not fetch artifacts for run ${run.id}: ${error}`,
      );
      return [];
    }
  }

  const baselineContexts = await githubApiOrSkip(
    "fetching baseline run context",
    () =>
      mapConcurrent(
        baselineRuns,
        API_CONCURRENCY,
        async (run): Promise<BaselineRunContext> => {
          const [artifacts, pr] = await Promise.all([
            fetchArtifactsForRunBestEffort(run),
            fetchPRForCommit(run.head_sha),
          ]);
          return { run, artifacts, pr };
        },
      ),
    currentMetrics,
  );

  console.log("Fetching recent perf metric backfills...");
  const backfillSourceData = await githubApiOrSkip(
    "fetching recent perf metric backfill sources",
    () =>
      githubGet<{ workflow_runs: WorkflowRun[] }>(
        `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&event=push&status=success&per_page=${BACKFILL_SOURCE_RUNS}`,
      ),
    currentMetrics,
  );
  const baselineRunIds = new Set(baselineRuns.map((run) => run.id));
  const backfillSourceRuns = backfillSourceData.workflow_runs.filter((run) =>
    !baselineRunIds.has(run.id) && run.id !== runIdNum
  );
  const extraBackfillContexts = await githubApiOrSkip(
    "fetching extra perf metric backfill context",
    () =>
      mapConcurrent(
        backfillSourceRuns,
        API_CONCURRENCY,
        async (run): Promise<BaselineRunContext> => ({
          run,
          artifacts: await fetchArtifactsForRunBestEffort(run),
          pr: null,
        }),
      ),
    currentMetrics,
  );

  const backfilledMetricsByRunId = new Map<number, Map<string, TimingSample>>();
  const backfillSourceContexts = [
    ...baselineContexts,
    ...extraBackfillContexts,
  ].sort((a, b) =>
    b.run.created_at.localeCompare(a.run.created_at) || b.run.id - a.run.id
  );
  const parsedBackfillSources = await githubApiOrSkip(
    "downloading perf metric backfills",
    () =>
      mapConcurrent(
        backfillSourceContexts,
        API_CONCURRENCY,
        async ({ artifacts }) => {
          const artifact = artifacts.find(
            (a) => a.name === PERF_METRICS_BACKFILL_ARTIFACT_NAME && !a.expired,
          );
          if (!artifact) return null;

          return await downloadAndParsePerfMetricsBackfill(artifact.id);
        },
      ),
    currentMetrics,
  );

  for (const backfills of parsedBackfillSources) {
    if (!backfills) continue;

    for (const [backfilledRunId, metrics] of backfills) {
      if (!backfilledMetricsByRunId.has(backfilledRunId)) {
        backfilledMetricsByRunId.set(backfilledRunId, metrics);
      }
    }
  }
  if (backfilledMetricsByRunId.size > 0) {
    console.log(
      `Loaded perf metric backfills for ${backfilledMetricsByRunId.size} run(s).`,
    );
  }

  await githubApiOrSkip(
    "building baseline timelines",
    () =>
      mapConcurrent(baselineContexts, API_CONCURRENCY, async (context) => {
        const { run, artifacts, pr } = context;

        if (pr) {
          prInfoBySha.set(run.head_sha, pr);
          const overrides = parseMergedBaselineOverrides(pr);
          if (
            overrides &&
            (overrides.metrics.size > 0 || overrides.coverageBaselineReset)
          ) {
            overridesBySha.set(run.head_sha, overrides);
          }
        }

        const perfMetricsArtifact = artifacts.find(
          (a) => a.name === PERF_METRICS_ARTIFACT_NAME && !a.expired,
        );
        if (perfMetricsArtifact) {
          const metrics = await downloadAndParsePerfMetrics(
            perfMetricsArtifact.id,
          );
          if (metrics) {
            for (const [name, sample] of metrics) {
              addSample(timelines, name, sample);
            }
            return;
          }
        }

        const backfilledMetrics = backfilledMetricsByRunId.get(run.id);
        if (backfilledMetrics) {
          for (const [name, sample] of backfilledMetrics) {
            addSample(timelines, name, sample);
          }
          return;
        }

        const jobs = await fetchJobsForRun(run.id);
        const metrics = new Map(extractMetrics(run, jobs));
        for (const [name, sample] of metrics) {
          addSample(timelines, name, sample);
        }

        // Fetch per-test timing artifacts
        let canBackfill = true;
        try {
          const timingArtifacts = artifacts.filter(
            (a) => a.name.startsWith("test-timing-") && !a.expired,
          );
          for (const artifact of timingArtifacts) {
            const suites = await downloadAndParseJUnit(artifact.id);
            if (suites.length === 0) {
              canBackfill = false;
              continue;
            }
            const testMetrics = extractTestFileMetrics(
              run,
              timingArtifactLabel(artifact.name),
              suites,
            );
            for (const [name, sample] of testMetrics) {
              metrics.set(name, sample);
              addSample(timelines, name, sample);
            }
          }
        } catch {
          // Artifacts may not exist for older runs
          canBackfill = false;
        }

        if (metrics.size > 0 && canBackfill) {
          newBackfills.set(run.id, metrics);
        }
      }),
    currentMetrics,
  );

  if (newBackfills.size > 0) {
    await writePerfMetricsBackfillFile(
      PERF_METRICS_BACKFILL_FILE,
      newBackfills,
    );
    console.log(
      `Wrote ${PERF_METRICS_BACKFILL_FILE} for ${newBackfills.size} fallback run(s).`,
    );
  }

  // Sort timelines chronologically
  for (const timeline of timelines.values()) {
    timeline.samples.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  const coverageBaselineAvailable = [...timelines.keys()].some(
    isCoverageDebtMetric,
  );

  // Apply baseline overrides from merged PRs
  if (overridesBySha.size > 0) {
    console.log(
      `Found ${overridesBySha.size} baseline override(s) from merged PRs.`,
    );
    applyBaselineOverrides(timelines, overridesBySha);
  }

  // 5. Compare current metrics against baseline
  const rows: Row[] = [];
  const failures: Row[] = [];

  for (const [metric, currentSample] of currentMetrics) {
    const current = currentSample.durationSeconds;
    const timeline = timelines.get(metric);
    const n = timeline?.samples.length ?? 0;
    const isCoverageMetric = isCoverageDebtMetric(metric);

    if (isCoverageMetric) {
      const latestBaseline = timeline?.samples.at(-1)?.durationSeconds;
      const override = prOverrides.metrics.get(metric);
      const coverageReset = prOverrides.coverageBaselineReset;
      const shouldGateCoverage = shouldGateCoverageDebtMetric(
        metric,
        changedCoverageGroups,
      );

      if (latestBaseline === undefined) {
        if (
          coverageReset || (override !== undefined && current <= override)
        ) {
          rows.push({ metric, status: "ovrd", current, n });
        } else if (!shouldGateCoverage) {
          rows.push({ metric, status: "excl", current, n });
        } else if (current > 0) {
          const row: Row = {
            metric,
            status: "OVER",
            current,
            median: 0,
            variance: 0,
            stddev: 0,
            threshold: 0,
            n,
            pctIncrease: 100,
          };
          rows.push(row);
          failures.push(row);
        } else {
          rows.push({ metric, status: "n/a", current, n });
        }
        continue;
      }

      const pctIncrease = latestBaseline === 0
        ? current > 0 ? 100 : 0
        : ((current - latestBaseline) / latestBaseline) * 100;
      const stats = {
        median: latestBaseline,
        variance: 0,
        stddev: 0,
        threshold: latestBaseline,
        pctIncrease,
      };

      if (coverageReset) {
        rows.push({ metric, status: "ovrd", current, n, ...stats });
        continue;
      }

      if (override !== undefined && current <= override) {
        rows.push({ metric, status: "ovrd", current, n, ...stats });
        continue;
      }

      if (!shouldGateCoverage) {
        rows.push({ metric, status: "excl", current, n, ...stats });
        continue;
      }

      if (current > latestBaseline) {
        const row: Row = { metric, status: "OVER", current, n, ...stats };
        rows.push(row);
        failures.push(row);
      } else {
        rows.push({ metric, status: "OK", current, n, ...stats });
      }
      continue;
    }

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
    console.log(
      "\n!!!" +
        `\n!!! PERFORMANCE REGRESSION DETECTED in ${failures.length} metric(s) !!!` +
        "\n!!!",
    );
  }

  // 6b. Informational CI wall-time policy signals. These are intentionally
  // non-blocking; they tell us when to consider CI split/rebalance work again.
  if (wallTimeSignals.length > 0) {
    console.log("\n## CI Wall-Time Revisit Signals");
    console.log(
      "Informational only. See docs/development/CI_PERFORMANCE.md before starting CI-splitting work.",
    );
    printTextTable(
      ["Signal", "Detail"],
      wallTimeSignals.map((signal) => [signal.title, signal.detail]),
    );
  }

  // 6c. Full metric table — always emitted, grouped by metric kind.
  console.log(
    "\n::group::All collected metrics:" +
      `\nThresholds: median + ${STDDEV_FACTOR}σ or +${
        MIN_REGRESSION_PCT * 100
      }% (whichever is higher); non-bench metrics also require at least +${MIN_ABSOLUTE_DELTA}s.`,
  );
  console.log(
    "Coverage debt metrics use a latest-main ratchet for changed source groups.",
  );
  console.log(
    "Status key: OVER = over threshold (fails); CLOSE = ≥50% of margin consumed;",
  );
  console.log(
    "  OK = <50% consumed; ovrd = saved by a PR override/reset; excl = metric excluded from the check;",
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
      case "coverage-debt":
        return "Coverage Debt";
      default:
        return prefix;
    }
  };
  const KIND_ORDER = [
    "Jobs",
    "Steps",
    "Test files",
    "Subtests",
    "Benchmarks",
    "Coverage Debt",
  ];
  // Sort order within each kind: most at-risk of failing the check first.
  // `ovrd` sits below `OK` because an override-protected metric is at strictly
  // lower risk of tripping the check than an unguarded OK metric — the author
  // has already authorized its current level.
  const STATUS_ORDER: Record<Status, number> = {
    OVER: 5,
    CLOSE: 4,
    OK: 3,
    ovrd: 2,
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
    printMetricTable(rs, true);
  }

  console.log("::endgroup::");

  // 6d. Failure metric details.
  if (failures.length > 0) {
    failures.sort((a, b) => (b.pctIncrease ?? 0) - (a.pctIncrease ?? 0));

    console.log("\n## Performance regression details:\n");
    printMetricTable(failures);

    console.log("\n::group::Baseline sample breakdown:\n");
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

    console.log("::endgroup::");
  }

  // 6e. Pass/fail outcome + override copy-paste block pinned at the bottom.
  if (informationalOnly) {
    console.log("\nInformational Only:");
  }

  if (failures.length === 0) {
    console.log("\nAll metrics within normal range.");
    Deno.exit(0);
  } else if (informationalOnly) {
    console.log("\nOne or more metrics are out-of-range.");
    console.log("This build would fail if it were a PR.");
    Deno.exit(0);
  }

  const coverageFailures = failures.filter((f) =>
    isCoverageDebtMetric(f.metric)
  );
  const perMetricFailures = failures.filter((f) =>
    !isCoverageDebtMetric(f.metric)
  );

  if (coverageFailures.length > 0) {
    const verb = coverageBaselineAvailable ? "reset" : "bootstrap";
    console.log(
      `\nTo ${verb} the coverage ratchet for one cycle, add the coverage reset marker to your PR description.`,
    );
    console.log(
      "Coverage debt can still be accepted one metric at a time with NEW_PERF_BASELINE when that is the narrower change.",
    );
  }

  console.log(
    "\nTo accept these regressions, add the following to your PR description:\n",
  );
  console.log("---BEGIN COPY-PASTE---");
  if (coverageFailures.length > 0) {
    console.log(COVERAGE_BASELINE_RESET_MARKER);
  }
  for (const f of perMetricFailures) {
    const suggested = formatOverrideSuggestion(f.metric, f.current);
    console.log(`NEW_PERF_BASELINE: ${f.metric} = ${suggested}`);
  }
  console.log("---END COPY-PASTE---");

  if (coverageFailures.length > 0) {
    console.log(
      "\nIndividual coverage override alternatives:",
    );
    console.log("---BEGIN COPY-PASTE---");
    for (const f of coverageFailures) {
      const suggested = formatOverrideSuggestion(f.metric, f.current);
      console.log(`NEW_PERF_BASELINE: ${f.metric} = ${suggested}`);
    }
    console.log("---END COPY-PASTE---");
  }

  Deno.exit(1);
}

if (import.meta.main) {
  main();
}
