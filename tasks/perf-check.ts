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
  aggregateCacheStates,
  API_CONCURRENCY,
  applyBaselineOverrides,
  type Artifact,
  type BaselineOverrides,
  buildCoverageDebtSuggestionComment,
  CACHE_STATE_ARTIFACT_PREFIX,
  COMPILE_CACHE_FAMILIES,
  type CompileCacheFamily,
  compileCacheFamilyForMetric,
  type CompileCacheState,
  type CompileCacheStates,
  computeBaseline,
  computeCiWallTimeRevisitSignals,
  COVERAGE_BASELINE_RESET_MARKER,
  COVERAGE_COMMENT_FILE,
  type CoverageCommentPayload,
  coverageGroupForChangedFile,
  coverageGroupsForChangedFiles,
  coverageMetricGroupName,
  type CoverageResolvedGroup,
  type CoverageSuggestionFileLines,
  type CoverageSuggestionGroup,
  downloadAndExtractArtifact,
  downloadAndParseJUnit,
  downloadAndParsePerfMetricsBackfill,
  downloadAndParsePerfMetricsDetailed,
  dropColdSamples,
  extractMetrics,
  extractTestFileMetrics,
  fetchArtifactsForRun,
  fetchCurrentPRBody,
  fetchJobsForRun,
  fetchPRFiles,
  formatMetricValue,
  formatOverrideSuggestion,
  githubGet,
  isCoverageDebtMetric,
  latestNonColdSample,
  mapConcurrent,
  type MetricTimeline,
  MIN_ABSOLUTE_DELTA,
  MIN_REGRESSION_PCT,
  MIN_SAMPLES,
  newestArtifactsByName,
  parseAddedLinesFromPatch,
  parseBaselineOverrides,
  parseCacheStateFiles,
  PERF_METRICS_ARTIFACT_NAME,
  PERF_METRICS_BACKFILL_ARTIFACT_NAME,
  PERF_METRICS_BACKFILL_FILE,
  PERF_METRICS_FILE,
  type PerfMetricsDetailed,
  type PRFile,
  type PRInfo,
  readAndParseEvent,
  REPO,
  shouldGateCoverageDebtMetric,
  STDDEV_FACTOR,
  timingArtifactLabel,
  type TimingSample,
  walkFiles,
  WORKFLOW_FILE,
  type WorkflowRun,
  writePerfMetricsBackfillFile,
  writePerfMetricsFile,
} from "./perf-lib.ts";
import * as path from "@std/path";
import {
  collectCoverageDebtMetricsFromLcov,
  collectUncoveredLinesForFiles,
  COVERAGE_PROFILE_ARTIFACT_PREFIX,
  lcovFromCoverageProfile,
} from "./coverage-metrics.ts";

/** How many recent main-branch runs to use for baseline. */
const BASELINE_RUNS = 20;

/** Recent completed workflow runs to scan for fallback backfill artifacts. */
const BACKFILL_SOURCE_RUNS = 20;

export function currentWorkflowRunFromEvent(
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

export async function githubApiOrSkip<T>(
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

export function workflowRunsPathForBaseline(
  perPage: number,
): string {
  const params = new URLSearchParams({
    branch: "main",
    status: "success",
    event: "push",
    per_page: String(perPage),
  });
  return `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?${params}`;
}

export interface BaselineMainHeadValidation {
  ok: boolean;
  issues: string[];
}

export function validateBaselineRunsForMainHead(
  runs: Pick<WorkflowRun, "id" | "head_sha" | "created_at">[],
  mainHeadSha: string,
): BaselineMainHeadValidation {
  const issues: string[] = [];

  if (runs.length === 0) {
    issues.push("No successful main-branch runs were returned.");
    return { ok: false, issues };
  }

  if (!/^[0-9a-f]{40}$/i.test(mainHeadSha)) {
    issues.push(`Current main head SHA is invalid: ${mainHeadSha}`);
    return { ok: false, issues };
  }

  const newest = runs[0];
  if (newest.head_sha !== mainHeadSha) {
    issues.push(
      `Newest successful baseline run ${newest.id} (${newest.created_at}) is for ${newest.head_sha}, but current main is ${mainHeadSha}.`,
    );
  }

  return { ok: issues.length === 0, issues };
}

export async function fetchMainHeadSha(): Promise<string> {
  const branch = await githubGet<{ commit: { sha: string } }>(
    `/repos/${REPO}/branches/main`,
  );
  return branch.commit.sha;
}

function pluralize(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

export function formatRelativeDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";

  let remaining = Math.max(0, Math.floor(seconds));
  const parts: string[] = [];
  const units = [
    { seconds: 24 * 60 * 60, unit: "day" },
    { seconds: 60 * 60, unit: "hour" },
    { seconds: 60, unit: "minute" },
    { seconds: 1, unit: "second" },
  ];

  for (const unit of units) {
    const value = Math.floor(remaining / unit.seconds);
    if (value > 0) {
      parts.push(pluralize(value, unit.unit));
      remaining -= value * unit.seconds;
    }
    if (parts.length === 2) break;
  }

  return parts.length > 0 ? parts.join(" ") : "0 seconds";
}

export function formatRelativeAge(fromIso: string, toIso: string): string {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return "unknown";

  return formatRelativeDuration((toMs - fromMs) / 1_000);
}

export function formatCommitDistance(commitsBehindMain: number | null): string {
  return commitsBehindMain === null
    ? "an unknown number of commits"
    : pluralize(commitsBehindMain, "commit");
}

export function formatBaselineSourceRunAge(
  runCreatedAt: string,
  currentCreatedAt: string,
  commitsBehindMain: number | null,
): string {
  const age = formatRelativeAge(runCreatedAt, currentCreatedAt);
  const timePart = age === "unknown" ? "age unknown" : `created ${age} ago`;
  return `${timePart}; ${
    formatCommitDistance(commitsBehindMain)
  } behind current main`;
}

interface GitHubCompareResponse {
  ahead_by?: unknown;
}

export async function fetchCommitsBehindMain(
  baselineSha: string,
  mainHeadSha: string,
): Promise<number | null> {
  if (baselineSha === mainHeadSha) return 0;

  try {
    const comparison = await githubGet<GitHubCompareResponse>(
      `/repos/${REPO}/compare/${encodeURIComponent(baselineSha)}...${
        encodeURIComponent(mainHeadSha)
      }`,
    );
    return typeof comparison.ahead_by === "number" ? comparison.ahead_by : null;
  } catch (error) {
    console.warn(
      `  Warning: could not compare baseline ${baselineSha.slice(0, 8)} ` +
        `to current main ${mainHeadSha.slice(0, 8)}: ${
          formatErrorForLog(error)
        }`,
    );
    return null;
  }
}

export function selectMergedPRForCommit(prs: PRInfo[]): PRInfo | null {
  return prs.find((pr) => pr.merged_at !== null) ?? prs[0] ?? null;
}

export interface PRLookupResult {
  pr: PRInfo | null;
  error: unknown | null;
}

export interface BaselineRunContext {
  run: WorkflowRun;
  artifacts: Artifact[];
  pr: PRInfo | null;
  prLookupError: unknown | null;
  commitsBehindMain: number | null;
}

export async function fetchPRForCommitWithError(
  sha: string,
): Promise<PRLookupResult> {
  try {
    const prs = await githubGet<PRInfo[]>(
      `/repos/${REPO}/commits/${sha}/pulls`,
    );
    return { pr: selectMergedPRForCommit(prs), error: null };
  } catch (error) {
    return { pr: null, error };
  }
}

export function newestArtifactNamed(
  artifacts: Artifact[],
  name: string,
): Artifact | null {
  return newestArtifactsByName(
    artifacts.filter((artifact) => artifact.name === name && !artifact.expired),
  )[0] ?? null;
}

export function formatErrorForLog(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

export function logBaselineSourceRuns(
  contexts: BaselineRunContext[],
  currentRunCreatedAt: string,
): void {
  console.log("\n::group::Baseline source runs:\n");
  for (
    const { run, artifacts, pr, prLookupError, commitsBehindMain } of contexts
  ) {
    const perfMetricsArtifact = newestArtifactNamed(
      artifacts,
      PERF_METRICS_ARTIFACT_NAME,
    );
    const prLabel = pr
      ? `PR #${pr.number}`
      : prLookupError
      ? "PR lookup failed"
      : "no PR found";
    const artifactLabel = perfMetricsArtifact
      ? `perf-metrics artifact ${perfMetricsArtifact.id}`
      : "no perf-metrics artifact";
    const ageLabel = formatBaselineSourceRunAge(
      run.created_at,
      currentRunCreatedAt,
      commitsBehindMain,
    );
    console.log(
      `  ${run.created_at} run ${run.id} ${run.head_sha.slice(0, 8)} ` +
        `${ageLabel}; ${prLabel}; ${artifactLabel}`,
    );
  }
  console.log("\n::endgroup::\n");
}

export interface BaselinePRLookupSummary {
  found: number;
  noPR: number;
  failed: number;
}

export function summarizeBaselinePRLookups(
  contexts: { pr: PRInfo | null; prLookupError: unknown | null }[],
): BaselinePRLookupSummary {
  const failed = contexts.filter((context) => context.prLookupError).length;
  const found = contexts.filter((context) => context.pr).length;
  return {
    found,
    noPR: contexts.length - found - failed,
    failed,
  };
}

export function reportPRLookupResults(
  contexts: BaselineRunContext[],
): number {
  const summary = summarizeBaselinePRLookups(contexts);
  const failures = contexts.filter((context) => context.prLookupError);

  console.log(
    `Baseline PR lookup: found ${summary.found}/${contexts.length}; ` +
      `${summary.noPR} had no associated PR; ${summary.failed} failed.`,
  );

  if (summary.failed === 0) return 0;

  console.warn(
    `  Warning: failed to fetch PR metadata for ${summary.failed} baseline run(s).`,
  );
  for (const { run, prLookupError } of failures) {
    console.warn(
      `  Warning: run ${run.id} (${
        run.head_sha.slice(0, 8)
      }) PR lookup failed: ${formatErrorForLog(prLookupError)}`,
    );
  }

  return summary.failed;
}

export async function fetchArtifactsForRunBestEffort(
  run: WorkflowRun,
  fetchArtifacts: (runId: number) => Promise<Artifact[]> = fetchArtifactsForRun,
  warn: (message: string) => void = console.warn,
): Promise<Artifact[]> {
  try {
    return await fetchArtifacts(run.id);
  } catch (error) {
    warn(`  Warning: could not fetch artifacts for run ${run.id}: ${error}`);
    return [];
  }
}

export async function fetchBaselineRunsForCheck(
  metricsForArtifact: Map<string, TimingSample>,
  baselineRunCount = BASELINE_RUNS,
  log: (message: string) => void = console.log,
): Promise<{ mainHeadSha: string; baselineRuns: WorkflowRun[] }> {
  log("Fetching current main branch head...");
  const mainHeadSha = await githubApiOrSkip(
    "fetching current main branch head",
    () => fetchMainHeadSha(),
    metricsForArtifact,
  );
  log(`Current main head is ${mainHeadSha}.`);
  log("Fetching recent main-branch runs for baseline...");
  const baselineData = await githubApiOrSkip(
    "fetching recent main-branch runs for baseline",
    () =>
      githubGet<{ workflow_runs: WorkflowRun[] }>(
        workflowRunsPathForBaseline(baselineRunCount),
      ),
    metricsForArtifact,
  );
  return { mainHeadSha, baselineRuns: baselineData.workflow_runs };
}

export function reportBaselineRunAvailability(
  baselineRuns: WorkflowRun[],
  mainHeadSha: string,
  minSamples = MIN_SAMPLES,
  warn: (message: string) => void = console.warn,
): BaselineMainHeadValidation {
  const baselineMainHead = validateBaselineRunsForMainHead(
    baselineRuns,
    mainHeadSha,
  );
  if (!baselineMainHead.ok) {
    warn(
      "Warning: newest successful baseline run is not for the current main head.",
    );
    for (const issue of baselineMainHead.issues) {
      warn(`  Warning: ${issue}`);
    }
  }

  if (baselineRuns.length < minSamples) {
    warn(
      `  Warning: only ${baselineRuns.length} baseline runs available (need ${minSamples}). Metrics with too few samples will be reported as n/a.`,
    );
  }

  return baselineMainHead;
}

export interface BuildBaselineRunContextsOptions {
  baselineRuns: WorkflowRun[];
  mainHeadSha: string;
  fetchArtifactsForRun?: (run: WorkflowRun) => Promise<Artifact[]>;
  fetchPRForCommit?: (sha: string) => Promise<PRLookupResult>;
  fetchCommitsBehindMain?: (
    baselineSha: string,
    mainHeadSha: string,
  ) => Promise<number | null>;
  concurrency?: number;
}

export async function buildBaselineRunContexts(
  options: BuildBaselineRunContextsOptions,
): Promise<BaselineRunContext[]> {
  const fetchArtifacts = options.fetchArtifactsForRun ??
    fetchArtifactsForRunBestEffort;
  const fetchPR = options.fetchPRForCommit ?? fetchPRForCommitWithError;
  const fetchCommitDistance = options.fetchCommitsBehindMain ??
    fetchCommitsBehindMain;

  return await mapConcurrent(
    options.baselineRuns,
    options.concurrency ?? API_CONCURRENCY,
    async (run): Promise<BaselineRunContext> => {
      const [artifacts, prLookup, commitsBehindMain] = await Promise.all([
        fetchArtifacts(run),
        fetchPR(run.head_sha),
        fetchCommitDistance(run.head_sha, options.mainHeadSha),
      ]);
      return {
        run,
        artifacts,
        pr: prLookup.pr,
        prLookupError: prLookup.error,
        commitsBehindMain,
      };
    },
  );
}

export async function buildExtraBackfillContexts(
  runs: WorkflowRun[],
  fetchArtifactsForRun: (run: WorkflowRun) => Promise<Artifact[]> =
    fetchArtifactsForRunBestEffort,
  concurrency = API_CONCURRENCY,
): Promise<BaselineRunContext[]> {
  return await mapConcurrent(
    runs,
    concurrency,
    async (run): Promise<BaselineRunContext> => ({
      run,
      artifacts: await fetchArtifactsForRun(run),
      pr: null,
      prLookupError: null,
      commitsBehindMain: null,
    }),
  );
}

export function reportBaselineContextResults(
  contexts: BaselineRunContext[],
  currentRunCreatedAt: string,
): number {
  logBaselineSourceRuns(contexts, currentRunCreatedAt);
  const prLookupFailures = reportPRLookupResults(contexts);
  if (prLookupFailures > 0) {
    console.warn(
      "  Warning: running performance regression check with incomplete PR metadata. Some merged baseline overrides may be missing.",
    );
  }
  return prLookupFailures;
}

export async function parsePerfMetricBackfillFromArtifacts(
  artifacts: Artifact[],
  parseBackfill: (
    artifactId: number,
  ) => Promise<Map<number, Map<string, TimingSample>> | null> =
    downloadAndParsePerfMetricsBackfill,
): Promise<Map<number, Map<string, TimingSample>> | null> {
  const artifact = newestArtifactNamed(
    artifacts,
    PERF_METRICS_BACKFILL_ARTIFACT_NAME,
  );
  if (!artifact) return null;

  return await parseBackfill(artifact.id);
}

export async function parsePerfMetricsFromArtifacts(
  artifacts: Artifact[],
  parseMetrics: (
    artifactId: number,
  ) => Promise<PerfMetricsDetailed | null> =
    downloadAndParsePerfMetricsDetailed,
): Promise<PerfMetricsDetailed | null> {
  const artifact = newestArtifactNamed(
    artifacts,
    PERF_METRICS_ARTIFACT_NAME,
  );
  if (!artifact) return null;

  return await parseMetrics(artifact.id);
}

export interface AddPerfMetricsResult {
  added: boolean;
  /** Null when the run has no perf-metrics artifact or an untagged one. */
  compileCacheStates: CompileCacheStates | null;
}

export async function addPerfMetricsFromArtifacts(
  timelines: Map<string, MetricTimeline>,
  artifacts: Artifact[],
  parseMetrics: (
    artifacts: Artifact[],
  ) => Promise<PerfMetricsDetailed | null> = parsePerfMetricsFromArtifacts,
): Promise<AddPerfMetricsResult> {
  const detailed = await parseMetrics(artifacts);
  if (!detailed) return { added: false, compileCacheStates: null };

  for (const [name, sample] of detailed.metrics) {
    addSample(timelines, name, sample);
  }
  return { added: true, compileCacheStates: detailed.compileCacheStates };
}

/**
 * Download the JSON file(s) inside one cache-state artifact. Returns null
 * when the download or extraction fails.
 */
async function downloadCacheStateFiles(
  artifactId: number,
): Promise<string[] | null> {
  const tmpDir = await downloadAndExtractArtifact(artifactId, "cache-state-");
  if (!tmpDir) return null;
  try {
    const contents: string[] = [];
    for await (const file of walkFiles(tmpDir)) {
      if (file.endsWith(".json")) {
        contents.push(await Deno.readTextFile(file));
      }
    }
    return contents;
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/** `family=state` pairs for every cache family, absent shown as unknown. */
export function formatCompileCacheStates(states: CompileCacheStates): string {
  return COMPILE_CACHE_FAMILIES
    .map((family) => `${family}=${states[family] ?? "unknown"}`)
    .join(", ");
}

/**
 * Aggregate the current run's per-shard cache-state artifacts into per-family
 * compile cache states. Re-run duplicates are deduped newest-first — a re-run
 * restores the cache the first (cold) attempt saved, so it is genuinely warm.
 * Best-effort: any failure degrades to `{}` (all unknown) with a warning, so
 * a broken tag behaves like a pre-rollout run instead of failing the gate.
 */
export async function collectCurrentCacheStates(
  artifacts: Artifact[],
  download: (artifactId: number) => Promise<string[] | null> =
    downloadCacheStateFiles,
): Promise<CompileCacheStates> {
  try {
    const cacheStateArtifacts = newestArtifactsByName(artifacts.filter(
      (artifact) =>
        artifact.name.startsWith(CACHE_STATE_ARTIFACT_PREFIX) &&
        !artifact.expired,
    ));

    const contents: string[] = [];
    for (const artifact of cacheStateArtifacts) {
      const files = await download(artifact.id);
      if (!files) {
        throw new Error(
          `could not download cache-state artifact ${artifact.name} (${artifact.id})`,
        );
      }
      contents.push(...files);
    }
    const records = parseCacheStateFiles(contents);
    if (!records) {
      throw new Error(
        "one or more cache-state records failed to parse; a missing shard " +
          "could mislabel its family warm",
      );
    }
    return aggregateCacheStates(records);
  } catch (error) {
    console.warn(
      `  Warning: could not collect compile cache states; treating them as unknown: ${error}`,
    );
    return {};
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
  ...[1, 2, 3, 4, 5, 6].map((shard) => `coverage-profile-workspace-${shard}`),
  ...[1, 2, 3, 4, 5].map((shard) => `coverage-profile-runner-${shard}`),
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
export type Status =
  | "OVER"
  | "CLOSE"
  | "OK"
  | "ovrd"
  | "COLD"
  | "excl"
  | "n/a";

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

export function formatMetricValueForTable(
  metric: string,
  value: number | undefined,
): string {
  if (value === undefined) return "-";
  if (isCoverageDebtMetric(metric)) return `${Math.round(value)}`;
  return trimTrailingZero(formatMetricValue(metric, value));
}

export function formatMetricDelta(metric: string, row: Row): string {
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

export function metricDisplayParts(
  metric: string,
): { task: string; metric: string } {
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

export interface Row {
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

export function metricTableRows(
  rows: Row[],
  includeStatus: boolean,
): string[][] {
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

export function printMetricTable(rows: Row[], includeStatus = false): void {
  const headers = includeStatus
    ? ["Status", "Baseline", "Current", "Change", "Task", "Metric"]
    : ["Baseline", "Current", "Change", "Task", "Metric"];
  const align = includeStatus
    ? ["left", "right", "right", "right", "left", "left"] as TableAlign[]
    : ["right", "right", "right", "left", "left"] as TableAlign[];
  printTextTable(headers, metricTableRows(rows, includeStatus), align);
}

export interface EvaluateTimingMetricOptions {
  metric: string;
  current: number;
  timeline: MetricTimeline | undefined;
  prOverrides: BaselineOverrides;
  /** The current run's per-family compile cache states. */
  currentCacheStates: CompileCacheStates;
  /** Baseline-run cache state lookup, per family. */
  stateOfRunForFamily: (
    family: CompileCacheFamily,
  ) => (runId: number) => CompileCacheState | undefined;
}

export interface TimingMetricEvaluation {
  row: Row;
  failure: boolean;
}

/**
 * Evaluate one timing (non-coverage) metric against its baseline timeline.
 *
 * Compile-cache handling: when the metric maps to a cache family whose cache
 * is cold this run, the metric gets a non-blocking `COLD` status — a full
 * recompile inflates it, and cold baselines essentially never reach
 * MIN_SAMPLES, so there is no cold-vs-cold gating. When the current run is
 * warm or unknown, known-cold baseline samples are dropped before computing
 * the baseline; too few remaining samples fall back to the `n/a` path.
 * Metrics excluded via EXCLUDED_METRIC_PATTERNS stay `excl` even when cold.
 */
export function evaluateTimingMetric(
  options: EvaluateTimingMetricOptions,
): TimingMetricEvaluation {
  const { metric, current, timeline, prOverrides } = options;

  const family = compileCacheFamilyForMetric(metric);
  const currentIsCold = family !== null &&
    options.currentCacheStates[family] === "cold";
  const samples = family !== null && !currentIsCold
    ? dropColdSamples(
      timeline?.samples ?? [],
      options.stateOfRunForFamily(family),
    )
    : timeline?.samples ?? [];
  const n = samples.length;

  const baseline = computeBaseline(
    samples.map((s) => s.durationSeconds),
    MIN_ABSOLUTE_DELTA,
  );

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
  // but still shown so the log has full context. Takes precedence over COLD.
  if (EXCLUDED_METRIC_PATTERNS.some((re) => re.test(metric))) {
    return {
      row: { metric, status: "excl", current, n, ...(stats ?? {}) },
      failure: false,
    };
  }

  // Cold compile cache for this metric's job family — report without gating.
  if (currentIsCold) {
    return { row: { metric, status: "COLD", current, n }, failure: false };
  }

  // Not enough baseline data — show anyway.
  if (!baseline) {
    return { row: { metric, status: "n/a", current, n }, failure: false };
  }

  // PR has an override saving this metric.
  if (prOverrides.metrics.has(metric)) {
    const override = prOverrides.metrics.get(metric)!;
    if (current <= override) {
      return {
        row: { metric, status: "ovrd", current, n, ...stats! },
        failure: false,
      };
    }
  }

  if (current > baseline.threshold) {
    return {
      row: { metric, status: "OVER", current, n, ...stats! },
      failure: true,
    };
  }
  if ((stats!.headroomPct ?? 0) >= 50) {
    return {
      row: { metric, status: "CLOSE", current, n, ...stats! },
      failure: false,
    };
  }
  return {
    row: { metric, status: "OK", current, n, ...stats! },
    failure: false,
  };
}

async function extractCoverageDebtSamples(
  run: WorkflowRun,
  artifacts: Artifact[],
): Promise<{ samples: Map<string, TimingSample>; lcov: string }> {
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
  let lcov = "";
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

    lcov = lcovFileCount > 0
      ? await readCombinedLcov(lcovDir)
      : await lcovFromCoverageProfile(profileDir);

    const coverageMetrics = await collectCoverageDebtMetricsFromLcov({
      rootDir: Deno.cwd(),
      lcov,
    });
    for (const metric of coverageMetrics) {
      metrics.set(metric.name, sampleForRun(run, metric.uncoveredLines));
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

  return { samples: metrics, lcov };
}

/** File the coverage-comment payload is written to; tests override via env. */
function coverageCommentOutputPath(): string {
  return Deno.env.get("COVERAGE_COMMENT_FILE") ?? COVERAGE_COMMENT_FILE;
}

/**
 * Decide and write the coverage-debt comment payload for a PR. A coverage
 * regression writes a "regressed" body; an acceptable run writes a "resolved"
 * payload so the poster can collapse any earlier comment. Done for every real PR
 * run, pass or fail, so a fixed regression is reflected even when the run still
 * fails for other reasons.
 */
export async function writeCoverageComment(
  prNumber: number,
  coverageFailures: Row[],
  coverageRows: Row[],
  prFiles: PRFile[],
  lcov: string,
): Promise<void> {
  if (coverageFailures.length > 0) {
    await writeCoverageDebtSuggestion(
      prNumber,
      coverageFailures,
      prFiles,
      lcov,
    );
  } else {
    await writeCoverageResolved(prNumber, coverageRows, prFiles);
  }
}

/**
 * Write the coverage-debt regression comment to a file for a later workflow to
 * post. The gate runs on `pull_request`, where fork PRs get a read-only token
 * and cannot comment, so the `coverage-comment` workflow_run job posts this from
 * the base-repo context instead. Never throws — this is best-effort so it cannot
 * mask the regression failure itself.
 */
export async function writeCoverageDebtSuggestion(
  prNumber: number,
  coverageFailures: Row[],
  prFiles: PRFile[],
  lcov: string,
): Promise<void> {
  const groups = coverageFailures
    .map((failure) => ({
      group: coverageMetricGroupName(failure.metric),
      target: Math.round(failure.median ?? 0),
      current: Math.round(failure.current),
    }))
    .filter((group): group is CoverageSuggestionGroup => group.group !== null);

  if (groups.length === 0) return;

  const failingGroups = new Set(groups.map((group) => group.group));

  // Resolve uncovered line numbers only for changed files in the regressed
  // groups, so we never materialize per-line data for the whole workspace.
  const changedInFailingGroups = prFiles
    .map((prFile) => prFile.filename.replaceAll("\\", "/"))
    .filter((relativePath) => {
      const group = coverageGroupForChangedFile(relativePath);
      return group !== null && failingGroups.has(group);
    });
  const uncoveredByPath = await collectUncoveredLinesForFiles({
    rootDir: Deno.cwd(),
    lcov,
    files: changedInFailingGroups,
  });

  // Count, per changed file, the lines this PR added that coverage marks
  // uncovered.
  const files: CoverageSuggestionFileLines[] = [];
  for (const prFile of prFiles) {
    const relativePath = prFile.filename.replaceAll("\\", "/");
    const group = coverageGroupForChangedFile(relativePath);
    if (!group || !failingGroups.has(group)) continue;

    const uncoveredLines = uncoveredByPath.get(relativePath);
    if (!uncoveredLines || !prFile.patch) continue;

    const addedLines = parseAddedLinesFromPatch(prFile.patch);
    const uncoveredCount = uncoveredLines.filter((line) =>
      addedLines.has(line)
    ).length;
    if (uncoveredCount > 0) files.push({ relativePath, group, uncoveredCount });
  }

  try {
    const body = buildCoverageDebtSuggestionComment({ groups, files });
    const payload: CoverageCommentPayload = {
      prNumber,
      state: "regressed",
      body,
    };
    const outputFile = coverageCommentOutputPath();
    await Deno.writeTextFile(outputFile, JSON.stringify(payload, null, 2));
    console.log(
      `Wrote ${outputFile} for PR #${prNumber}; the coverage-comment workflow will post or update it.`,
    );
  } catch (error) {
    console.warn(
      `  Warning: could not write coverage suggestion comment for PR #${prNumber}: ${error}`,
    );
  }
}

/**
 * Write a "resolved" coverage-comment payload so the coverage-comment workflow
 * can collapse and rewrite an earlier regression comment on the PR. The payload
 * is always written when coverage is acceptable: a run cannot tell whether a
 * comment exists, nor what files earlier commits on the PR changed, so it defers
 * that to the poster, which no-ops when there is nothing to update.
 *
 * `improvedLines` is the reduction this PR makes to the coverage debt it is
 * gated on: summed across the per-package groups whose files it changed, how far
 * each now sits below its `main` ratchet baseline. A passing gated group has
 * status "OK"; the workspace aggregate and untouched groups are "excl" and
 * overridden groups are "ovrd", so leaving everything but "OK" out keeps the
 * number to the debt this PR removed in the code it actually touched — not the
 * whole-workspace drift the gate never attributes to the PR. `groups` is the
 * per-group baseline-versus-this-PR breakdown for the source groups this PR
 * changed, the same groups the gate ratchets, so the collapsed comment can show
 * where the PR left coverage. Never throws —
 * best-effort, like the regression path.
 */
export async function writeCoverageResolved(
  prNumber: number,
  coverageRows: Row[],
  prFiles: PRFile[],
): Promise<void> {
  const improvedLines = coverageRows.reduce((sum, row) => {
    if (row.status !== "OK" || row.median === undefined) return sum;
    return sum + Math.max(0, Math.round(row.median - row.current));
  }, 0);

  // Summarize the source groups this PR changed — the per-group ratchet the
  // gate evaluates. Workspace is the aggregate behind `improvedLines`, so it
  // stays out of the per-group breakdown.
  const changedGroups = coverageGroupsForChangedFiles(
    prFiles.map((prFile) => prFile.filename),
  );
  const groups: CoverageResolvedGroup[] = coverageRows
    .map((row) => ({
      group: coverageMetricGroupName(row.metric),
      baseline: Math.round(row.median ?? 0),
      current: Math.round(row.current),
    }))
    .filter((group): group is CoverageResolvedGroup =>
      group.group !== null &&
      group.group !== "workspace" &&
      changedGroups.has(group.group)
    );

  // The gate passed because a changed group's debt was accepted with a
  // per-metric override or the reset marker (status "ovrd"), not because the
  // new code is covered.
  const overridden = coverageRows.some((row) => {
    if (row.status !== "ovrd") return false;
    const group = coverageMetricGroupName(row.metric);
    return group !== null && group !== "workspace" && changedGroups.has(group);
  });

  try {
    const payload: CoverageCommentPayload = {
      prNumber,
      state: "resolved",
      improvedLines,
      groups,
      overridden,
    };
    const outputFile = coverageCommentOutputPath();
    await Deno.writeTextFile(outputFile, JSON.stringify(payload, null, 2));
    console.log(
      `Wrote ${outputFile} (resolved, net ${improvedLines} line(s) covered) for PR #${prNumber}; the coverage-comment workflow will update any existing comment.`,
    );
  } catch (error) {
    console.warn(
      `  Warning: could not write resolved coverage comment for PR #${prNumber}: ${error}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main() {
  const runId = Deno.env.get("GITHUB_RUN_ID");
  const rawPrNumber = Deno.env.get("PR_NUMBER");
  const prNumber = (rawPrNumber === "") ? null : rawPrNumber;
  const informationalOnly = prNumber === null;

  if (!Deno.env.get("GITHUB_TOKEN")) {
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
  let prFiles: PRFile[] = [];

  if (prNumber) {
    try {
      prFiles = await fetchPRFiles(parseInt(prNumber));
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

  // Aggregate the current run's compile cache states so this run's
  // perf-metrics artifact is tagged (main-push runs included — future
  // baselines must know whether this run was cold).
  const currentCacheStates = await collectCurrentCacheStates(currentArtifacts);
  console.log(
    `Compile cache states: ${formatCompileCacheStates(currentCacheStates)}`,
  );

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
  let coverageLcov = "";
  try {
    if (currentArtifactsError) {
      throw new Error(
        `Could not fetch current run artifacts: ${currentArtifactsError}`,
      );
    }
    const coverage = await extractCoverageDebtSamples(
      currentRunInfo,
      currentArtifacts,
    );
    for (const [name, sample] of coverage.samples) {
      currentMetrics.set(name, sample);
    }
    coverageLcov = coverage.lcov;
  } catch (e) {
    coverageDataError = e;
    console.error(
      `  Error: could not extract coverage debt metrics for current run: ${e}`,
    );
  }

  await writePerfMetricsFile(
    PERF_METRICS_FILE,
    currentMetrics,
    currentCacheStates,
  );
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
  const { mainHeadSha, baselineRuns } = await fetchBaselineRunsForCheck(
    currentMetrics,
  );
  reportBaselineRunAvailability(baselineRuns, mainHeadSha);

  console.log(`Using ${baselineRuns.length} main-branch runs as baseline.`);

  // 4. Fetch job/step metrics for baseline runs + check for baseline overrides
  const timelines = new Map<string, MetricTimeline>();
  const overridesBySha = new Map<string, BaselineOverrides>();
  const prInfoBySha = new Map<string, PRInfo>();
  const newBackfills = new Map<number, Map<string, TimingSample>>();
  // Compile cache states per baseline run, from tagged perf-metrics
  // artifacts. Backfill and jobs-API fallback runs stay absent (unknown).
  const cacheStatesByRunId = new Map<number, CompileCacheStates>();

  const baselineContexts = await githubApiOrSkip(
    "fetching baseline run context",
    () => buildBaselineRunContexts({ baselineRuns, mainHeadSha }),
    currentMetrics,
  );

  reportBaselineContextResults(baselineContexts, currentRunInfo.created_at);

  console.log("Fetching recent perf metric backfills...");
  const backfillSourceData = await githubApiOrSkip(
    "fetching recent perf metric backfill sources",
    () =>
      githubGet<{ workflow_runs: WorkflowRun[] }>(
        workflowRunsPathForBaseline(BACKFILL_SOURCE_RUNS),
      ),
    currentMetrics,
  );
  const baselineRunIds = new Set(baselineRuns.map((run) => run.id));
  const backfillSourceRuns = backfillSourceData.workflow_runs.filter((run) =>
    !baselineRunIds.has(run.id) && run.id !== runIdNum
  );
  const extraBackfillContexts = await githubApiOrSkip(
    "fetching extra perf metric backfill context",
    () => buildExtraBackfillContexts(backfillSourceRuns),
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
        ({ artifacts }) => parsePerfMetricBackfillFromArtifacts(artifacts),
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

        const artifactResult = await addPerfMetricsFromArtifacts(
          timelines,
          artifacts,
        );
        if (artifactResult.added) {
          if (artifactResult.compileCacheStates) {
            cacheStatesByRunId.set(run.id, artifactResult.compileCacheStates);
          }
          return;
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

  const stateOfRunForFamily =
    (family: CompileCacheFamily) =>
    (runId: number): CompileCacheState | undefined =>
      cacheStatesByRunId.get(runId)?.[family];
  const isRunCold = (runId: number): boolean => {
    const states = cacheStatesByRunId.get(runId);
    return states !== undefined && Object.values(states).includes("cold");
  };

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
    const isCoverageMetric = isCoverageDebtMetric(metric);

    if (isCoverageMetric) {
      const n = timeline?.samples.length ?? 0;
      // Ratchet against the latest run that was not known-cold: a cold main
      // run covers rare cold-compile-only branches, and ratcheting against
      // its lower debt would fail later warm PRs with phantom regressions.
      const latestBaseline = timeline
        ? latestNonColdSample(timeline.samples, isRunCold)?.durationSeconds
        : undefined;
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

    const { row, failure } = evaluateTimingMetric({
      metric,
      current,
      timeline,
      prOverrides,
      currentCacheStates,
      stateOfRunForFamily,
    });
    rows.push(row);
    if (failure) failures.push(row);
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

  // 6c. Cold compile cache callout — the affected timing metrics are shown
  // as COLD and not gated this run.
  const coldFamilies = COMPILE_CACHE_FAMILIES.filter(
    (family) => currentCacheStates[family] === "cold",
  );
  if (coldFamilies.length > 0) {
    console.log("\n## Cold compile cache");
    console.log(
      `The pattern compile byte cache missed for: ${coldFamilies.join(", ")}.`,
    );
    console.log(
      "Timing metrics for these job families run a full recompile (~1.7-2x slower per test),",
    );
    console.log(
      "so they are reported as COLD and not gated — comparing them against warm baselines",
    );
    console.log(
      "would flag phantom regressions, and cold baselines are too rare to gate against.",
    );
    console.log(
      "To get a warm, fully gated run, re-run the pattern jobs: this cold run already saved the new compile cache.",
    );
  }

  // 6d. Full metric table — always emitted, grouped by metric kind.
  console.log(
    "\n::group::All collected metrics:" +
      `\nThresholds: median + ${STDDEV_FACTOR}σ or +${
        MIN_REGRESSION_PCT * 100
      }% (whichever is higher), and at least +${MIN_ABSOLUTE_DELTA}s.`,
  );
  console.log(
    "Coverage debt metrics use a latest-main ratchet for changed source groups.",
  );
  console.log(
    "Status key: OVER = over threshold (fails); CLOSE = ≥50% of margin consumed;",
  );
  console.log(
    "  OK = <50% consumed; ovrd = saved by a PR override/reset;",
  );
  console.log(
    "  COLD = compile cache cold for this metric's job family; not gated (rerun to go warm);",
  );
  console.log(
    "  excl = metric excluded from the check;",
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
    "Coverage Debt",
  ];
  // Sort order within each kind: most at-risk of failing the check first.
  // `ovrd` sits below `OK` because an override-protected metric is at strictly
  // lower risk of tripping the check than an unguarded OK metric — the author
  // has already authorized its current level. `COLD` sits below `ovrd`: a
  // cold metric is not gated this run at all.
  const STATUS_ORDER: Record<Status, number> = {
    OVER: 6,
    CLOSE: 5,
    OK: 4,
    ovrd: 3,
    COLD: 2,
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
    COLD: 0,
    excl: 0,
    "n/a": 0,
  } as Record<Status, number>;
  for (const r of rows) counts[r.status]++;

  console.log(
    `\n## All metrics checked  (${rows.length} total — OVER: ${counts.OVER}, CLOSE: ${counts.CLOSE}, OK: ${counts.OK}, ovrd: ${counts.ovrd}, COLD: ${counts.COLD}, excl: ${counts.excl}, n/a: ${
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

  // 6e. Failure metric details.
  if (failures.length > 0) {
    failures.sort((a, b) => (b.pctIncrease ?? 0) - (a.pctIncrease ?? 0));

    console.log("\n## Performance regression details:\n");
    printMetricTable(failures);

    console.log("\n::group::Baseline sample breakdown:\n");
    for (const f of failures) {
      const timeline = timelines.get(f.metric);
      if (!timeline) continue;

      // Show the samples the gate actually used: for cache-family metrics
      // that is the timeline minus known-cold runs (a failing metric was
      // gated warm — cold current runs never fail). Runs cold in any family
      // keep a [cold] suffix so the warm-run stats stay auditable.
      const family = compileCacheFamilyForMetric(f.metric);
      const samples = family !== null
        ? dropColdSamples(timeline.samples, stateOfRunForFamily(family))
        : timeline.samples;

      const fmt = (v: number) => formatMetricValue(f.metric, v);
      console.log(
        `  ${f.metric} (n=${samples.length}, median=${
          fmt(f.median!)
        }, variance=${fmt(f.variance!)}, stddev=${fmt(f.stddev!)}):`,
      );
      for (const s of samples) {
        const pr = prInfoBySha.get(s.sha);
        const prStr = pr ? `PR #${pr.number}` : s.sha.slice(0, 8);
        const coldSuffix = isRunCold(s.runId) ? " [cold]" : "";
        console.log(
          `    ${fmt(s.durationSeconds)} — ${prStr} (${
            s.createdAt.slice(0, 10)
          })${coldSuffix}`,
        );
      }
    }

    console.log("::endgroup::");
  }

  // 6f. Pass/fail outcome + override copy-paste block pinned at the bottom.
  if (informationalOnly) {
    console.log("\nInformational Only:");
  }

  const coverageFailures = failures.filter((f) =>
    isCoverageDebtMetric(f.metric)
  );
  const perMetricFailures = failures.filter((f) =>
    !isCoverageDebtMetric(f.metric)
  );

  // Coverage-debt PR comment, written for the coverage-comment workflow to post
  // (fork PRs get a read-only token on pull_request and cannot comment here).
  // Done before the exit branches so it runs whether the run passes or fails for
  // other reasons.
  if (prNumber) {
    await writeCoverageComment(
      parseInt(prNumber),
      coverageFailures,
      rows.filter((row) => isCoverageDebtMetric(row.metric)),
      prFiles,
      coverageLcov,
    );
  }

  if (failures.length === 0) {
    console.log("\nAll metrics within normal range.");
    Deno.exit(0);
  } else if (informationalOnly) {
    console.log("\nOne or more metrics are out-of-range.");
    console.log("This build would fail if it were a PR.");
    Deno.exit(0);
  }

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
