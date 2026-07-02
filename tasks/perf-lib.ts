/**
 * Shared library for CI performance regression detection.
 *
 * Used by:
 *   - perf-regression.ts  (scheduled 4-hourly checker)
 *   - perf-check.ts       (per-PR CI gate)
 */

// ---------------------------------------------------------------------------
// Config (from environment)
// ---------------------------------------------------------------------------

export const REPO = Deno.env.get("GITHUB_REPOSITORY") ?? "commontoolsinc/labs";
export const TOKEN = Deno.env.get("GITHUB_TOKEN");
export const WORKFLOW_FILE = "deno.yml";
export const PERF_METRICS_ARTIFACT_NAME = "perf-metrics";
export const PERF_METRICS_FILE = "perf-metrics.json";
export const PERF_METRICS_BACKFILL_ARTIFACT_NAME = "perf-metrics-backfill";
export const PERF_METRICS_BACKFILL_FILE = "perf-metrics-backfill.json";
export const COVERAGE_METRIC_PREFIX = "coverage-debt:";
export const COVERAGE_BASELINE_RESET_MARKER = "NEW_COVERAGE_BASELINE";

/**
 * Hidden marker placed at the top of the coverage-debt suggestion comment so
 * the gate posts it at most once per PR.
 */
export const COVERAGE_SUGGESTION_MARKER = "<!-- coverage-debt-suggestion -->";

/**
 * Artifact and file the coverage gate writes a pending PR comment to. The gate
 * runs on `pull_request`, where fork PRs only get a read-only token, so it
 * cannot comment directly. A separate `workflow_run` workflow picks this file
 * up and posts it with a write token from the base-repo context.
 */
export const COVERAGE_COMMENT_ARTIFACT_NAME = "coverage-comment";
export const COVERAGE_COMMENT_FILE = "coverage-comment.json";

/**
 * Pending coverage-debt comment handed from the gate to the posting workflow.
 *
 * - `state: "regressed"` carries the full comment `body`. The poster posts it as
 *   a new comment, or updates an existing coverage comment in place.
 * - `state: "resolved"` carries `improvedLines`, the net reduction in uncovered
 *   lines versus baseline across the changed, gated coverage groups, and
 *   `groups`, the per-group baseline-versus-this-PR breakdown. When the gate
 *   passed only because the debt was accepted, `overridden` is set. The poster
 *   rebuilds an existing comment into a collapsed summary of where the PR left
 *   coverage; it does nothing when there is no existing comment to update.
 */
export interface CoverageCommentPayload {
  prNumber: number;
  state: "regressed" | "resolved";
  /** Present when `state` is "regressed". */
  body?: string;
  /** Present when `state` is "resolved". */
  improvedLines?: number;
  /** Present when `state` is "resolved": the changed source groups and where
   * this PR left each one's uncovered-line count. */
  groups?: CoverageResolvedGroup[];
  /** Present when `state` is "resolved": true when the gate passed because a
   * changed group's debt was accepted with a per-metric override or the reset
   * marker, not because the new code is covered. */
  overridden?: boolean;
}

/**
 * Command an author (or an LLM) runs locally to reproduce the coverage gate.
 * Collects coverage from the unit-test suites and prints the per-group
 * uncovered-line counts as JSON. The integration suites are omitted, so the
 * local counts are conservative: meeting the target locally also clears CI.
 */
export const COVERAGE_LOCAL_CHECK_COMMAND = [
  "rm -rf coverage/raw/local",
  'DENO_COVERAGE_DIR="$(pwd)/coverage/raw/local" deno task test',
  "deno run --allow-read --allow-write --allow-run tasks/coverage-metrics.ts \\",
  '  --profile-dir="$(pwd)/coverage/raw/local" --root="$(pwd)"',
].join("\n");

/** Minimum number of historical samples before we compute a baseline. */
export const MIN_SAMPLES = 5;

/** Number of recent runs to compare against the baseline. */
export const RECENT_WINDOW = 3;

/** How many of the recent runs must exceed the threshold to flag a regression. */
export const RECENT_THRESHOLD = 2;

/** Standard deviations above the median to flag a regression. */
export const STDDEV_FACTOR = 3;

/** Minimum percentage increase over median to flag a regression. */
export const MIN_REGRESSION_PCT = 0.50;

/** Minimum absolute increase (in seconds) over median for non-bench metrics. */
export const MIN_ABSOLUTE_DELTA = 2;

/** Baseline window: at least this many runs. */
export const MIN_BASELINE_RUNS = 20;

/** Baseline window: at least this many days back. */
export const MIN_BASELINE_DAYS = 7;

/** Maximum workflow runs to fetch from API. */
export const MAX_RUNS_TO_FETCH = 100;

/** Concurrency limit for API calls. */
export const API_CONCURRENCY = 5;

/** Label applied to regression issues. */
export const ISSUE_LABEL = "perf-regression";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowRun {
  id: number;
  html_url: string;
  head_sha: string;
  created_at: string;
  conclusion: string;
  event: string;
}

export interface Job {
  id: number;
  name: string;
  started_at: string | null;
  completed_at: string | null;
  steps: Step[];
}

export interface Step {
  name: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

interface ArtifactsResponse {
  total_count?: number;
  artifacts: Artifact[];
}

export interface TimingSample {
  runId: number;
  runUrl: string;
  sha: string;
  createdAt: string;
  durationSeconds: number;
}

export interface PerfMetricRecord extends TimingSample {
  name: string;
}

export interface PerfMetricsFile {
  version: 1;
  generatedAt: string;
  metrics: PerfMetricRecord[];
}

export interface PerfMetricsBackfillRun {
  runId: number;
  metrics: PerfMetricRecord[];
}

export interface PerfMetricsBackfillFile {
  version: 1;
  generatedAt: string;
  runs: PerfMetricsBackfillRun[];
}

export interface MetricTimeline {
  name: string;
  samples: TimingSample[];
}

export interface Baseline {
  median: number;
  stddev: number;
  variance: number;
  count: number;
  threshold: number;
}

export interface Regression {
  metric: string;
  recentValues: number[];
  baseline: Baseline;
  avgRecent: number;
  pctIncrease: number;
}

export interface JUnitTestSuite {
  name: string;
  time: number;
  tests: { name: string; time: number }[];
}

/** Structured output from `deno bench --json`. */
export interface DenoBenchResult {
  version: number;
  runtime: string;
  cpu: string;
  benches: {
    origin: string;
    group: string | null;
    name: string;
    baseline: boolean;
    results: {
      ok?: {
        n: number;
        min: number;
        max: number;
        avg: number;
        p75: number;
        p99: number;
        p995: number;
      };
    }[];
  }[];
}

export interface PRInfo {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  merged_at: string | null;
}

export interface PRFile {
  filename: string;
  /** Unified diff for this file. Absent for binary or oversized changes. */
  patch?: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface CurrentPRBody {
  body: string;
  source: "live" | "event-fallback" | "empty-fallback";
  errorMessage?: string;
}

export interface BaselineOverrides {
  /** Metric name -> value in the metric's native unit. */
  metrics: Map<string, number>;
  /** Reset all coverage-debt metrics at the commit carrying this marker. */
  coverageBaselineReset: boolean;
}

export type CiWallTimeRevisitSignalKind =
  | "slow-job"
  | "job-imbalance"
  | "required-wall-time";

export interface CiWallTimeRevisitSignal {
  kind: CiWallTimeRevisitSignalKind;
  title: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

export function apiHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

const GITHUB_GET_MAX_ATTEMPTS = 4;
const GITHUB_GET_RETRY_BASE_DELAY_MS = 250;
const GITHUB_GET_RETRY_MAX_DELAY_MS = 5_000;
const RETRYABLE_GITHUB_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ARTIFACT_DOWNLOAD_STATUSES = new Set([
  ...RETRYABLE_GITHUB_STATUSES,
  403,
  404,
]);

function retryAfterDelayMs(value: string | null): number | undefined {
  if (value == null) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

function githubRetryDelayMs(resp: Response, attempt: number): number {
  return Math.min(
    retryAfterDelayMs(resp.headers.get("retry-after")) ??
      GITHUB_GET_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    GITHUB_GET_RETRY_MAX_DELAY_MS,
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseBodySnippet(resp: Response): Promise<string> {
  try {
    const body = await resp.text();
    return body.length > 1_000 ? `${body.slice(0, 1_000)}...` : body;
  } catch (error) {
    return `Could not read response body: ${error}`;
  }
}

export async function githubGet<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  for (let attempt = 1; attempt <= GITHUB_GET_MAX_ATTEMPTS; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { headers: apiHeaders() });
    } catch (error) {
      if (attempt === GITHUB_GET_MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(
        Math.min(
          GITHUB_GET_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          GITHUB_GET_RETRY_MAX_DELAY_MS,
        ),
      );
      continue;
    }

    if (resp.ok) {
      return resp.json();
    }

    if (
      !RETRYABLE_GITHUB_STATUSES.has(resp.status) ||
      attempt === GITHUB_GET_MAX_ATTEMPTS
    ) {
      const body = await resp.text();
      throw new Error(`GitHub API ${resp.status}: ${path}\n${body}`);
    }

    await resp.body?.cancel();
    await sleep(githubRetryDelayMs(resp, attempt));
  }

  throw new Error(`GitHub API GET retry loop exhausted unexpectedly: ${path}`);
}

export async function githubPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(`https://api.github.com${path}`, {
    method: "POST",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API POST ${resp.status}: ${path}\n${text}`);
  }
  return resp.json();
}

export async function githubPatch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(`https://api.github.com${path}`, {
    method: "PATCH",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API PATCH ${resp.status}: ${path}\n${text}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Fetch jobs / artifacts
// ---------------------------------------------------------------------------

export async function fetchJobsForRun(runId: number): Promise<Job[]> {
  const data = await githubGet<{ jobs: Job[] }>(
    `/repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return data.jobs;
}

export async function fetchArtifactsForRun(
  runId: number,
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  const perPage = 100;

  for (let page = 1;; page++) {
    const data = await githubGet<ArtifactsResponse>(
      `/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=${perPage}&page=${page}`,
    );
    artifacts.push(...data.artifacts);

    if (data.artifacts.length === 0) break;
    if (
      typeof data.total_count === "number" &&
      artifacts.length >= data.total_count
    ) {
      break;
    }
    if (
      typeof data.total_count !== "number" && data.artifacts.length < perPage
    ) {
      break;
    }
  }

  return artifacts;
}

/**
 * Newest artifact per name. Re-running a single job uploads a same-named
 * artifact alongside the original attempt's, and the API lists newest first —
 * naive iteration lets the stale one win. Artifact ids are monotonic.
 */
export function newestArtifactsByName(artifacts: Artifact[]): Artifact[] {
  const byName = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    const existing = byName.get(artifact.name);
    if (!existing || artifact.id > existing.id) {
      byName.set(artifact.name, artifact);
    }
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// JUnit artifact parsing
// ---------------------------------------------------------------------------

export async function downloadAndParseJUnit(
  artifactId: number,
): Promise<JUnitTestSuite[]> {
  const tmpDir = await downloadAndExtractArtifact(artifactId, "perf-junit-");
  if (!tmpDir) return [];
  try {
    const suites: JUnitTestSuite[] = [];
    for await (const entry of walkFiles(tmpDir)) {
      if (entry.endsWith(".xml")) {
        const content = await Deno.readTextFile(entry);
        suites.push(...parseJUnitXml(content));
      }
    }
    return suites;
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

export function serializePerfMetrics(
  metrics: Map<string, TimingSample>,
): PerfMetricsFile {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    metrics: metricsToRecords(metrics),
  };
}

function metricsToRecords(
  metrics: Map<string, TimingSample>,
): PerfMetricRecord[] {
  return [...metrics.entries()]
    .map(([name, sample]) => ({ name, ...sample }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function parsePerfMetricsFile(
  content: string,
): Map<string, TimingSample> {
  const parsed = JSON.parse(content) as Partial<PerfMetricsFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.metrics)) {
    throw new Error("Unsupported perf metrics file format.");
  }

  const metrics = new Map<string, TimingSample>();
  for (const metric of parsed.metrics) {
    if (
      typeof metric.name !== "string" ||
      typeof metric.runId !== "number" ||
      typeof metric.runUrl !== "string" ||
      typeof metric.sha !== "string" ||
      typeof metric.createdAt !== "string" ||
      typeof metric.durationSeconds !== "number"
    ) {
      throw new Error("Invalid perf metric record.");
    }

    metrics.set(metric.name, {
      runId: metric.runId,
      runUrl: metric.runUrl,
      sha: metric.sha,
      createdAt: metric.createdAt,
      durationSeconds: metric.durationSeconds,
    });
  }
  return metrics;
}

export function serializePerfMetricsBackfill(
  metricsByRunId: Map<number, Map<string, TimingSample>>,
): PerfMetricsBackfillFile {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    runs: [...metricsByRunId.entries()]
      .map(([runId, metrics]) => ({
        runId,
        metrics: metricsToRecords(metrics),
      }))
      .sort((a, b) => a.runId - b.runId),
  };
}

export function parsePerfMetricsBackfillFile(
  content: string,
): Map<number, Map<string, TimingSample>> {
  const parsed = JSON.parse(content) as Partial<PerfMetricsBackfillFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
    throw new Error("Unsupported perf metrics backfill file format.");
  }

  const metricsByRunId = new Map<number, Map<string, TimingSample>>();
  for (const run of parsed.runs) {
    if (typeof run.runId !== "number" || !Array.isArray(run.metrics)) {
      throw new Error("Invalid perf metrics backfill run.");
    }

    metricsByRunId.set(
      run.runId,
      parsePerfMetricsFile(JSON.stringify({
        version: 1,
        generatedAt: parsed.generatedAt ?? "",
        metrics: run.metrics,
      })),
    );
  }
  return metricsByRunId;
}

export async function writePerfMetricsFile(
  path: string,
  metrics: Map<string, TimingSample>,
): Promise<void> {
  await Deno.writeTextFile(
    path,
    `${JSON.stringify(serializePerfMetrics(metrics), null, 2)}\n`,
  );
}

export async function writePerfMetricsBackfillFile(
  path: string,
  metricsByRunId: Map<number, Map<string, TimingSample>>,
): Promise<void> {
  await Deno.writeTextFile(
    path,
    `${
      JSON.stringify(serializePerfMetricsBackfill(metricsByRunId), null, 2)
    }\n`,
  );
}

export async function downloadAndExtractArtifact(
  artifactId: number,
  tmpPrefix: string,
): Promise<string | null> {
  const artifactPath = `/repos/${REPO}/actions/artifacts/${artifactId}/zip`;
  const url = `https://api.github.com${artifactPath}`;
  let lastError = "unknown error";
  const attemptErrors: string[] = [];

  for (let attempt = 1; attempt <= GITHUB_GET_MAX_ATTEMPTS; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { headers: apiHeaders() });
    } catch (error) {
      lastError = `fetch failed: ${error}`;
      attemptErrors.push(`attempt ${attempt}: ${lastError}`);
      if (attempt < GITHUB_GET_MAX_ATTEMPTS) {
        await sleep(
          Math.min(
            GITHUB_GET_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
            GITHUB_GET_RETRY_MAX_DELAY_MS,
          ),
        );
        continue;
      }
      break;
    }

    if (!resp.ok) {
      const body = await responseBodySnippet(resp);
      lastError =
        `GitHub artifact download ${resp.status} ${resp.statusText}: ${body}`;
      attemptErrors.push(`attempt ${attempt}: ${lastError}`);
      if (
        attempt < GITHUB_GET_MAX_ATTEMPTS &&
        RETRYABLE_ARTIFACT_DOWNLOAD_STATUSES.has(resp.status)
      ) {
        await sleep(githubRetryDelayMs(resp, attempt));
        continue;
      }
      break;
    }

    const tmpDir = await Deno.makeTempDir({ prefix: tmpPrefix });
    const zipPath = `${tmpDir}/artifact.zip`;

    try {
      const data = new Uint8Array(await resp.arrayBuffer());
      await Deno.writeFile(zipPath, data);

      const unzip = new Deno.Command("unzip", {
        args: ["-o", zipPath, "-d", tmpDir],
        stdout: "null",
        stderr: "piped",
      });
      const result = await unzip.output();
      if (result.success) {
        return tmpDir;
      }

      const stderr = new TextDecoder().decode(result.stderr).trim();
      lastError = `unzip failed with exit code ${result.code}${
        stderr ? `: ${stderr}` : ""
      }`;
    } catch (error) {
      lastError = `${error}`;
    }
    attemptErrors.push(`attempt ${attempt}: ${lastError}`);

    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }

    if (attempt < GITHUB_GET_MAX_ATTEMPTS) {
      await sleep(
        Math.min(
          GITHUB_GET_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          GITHUB_GET_RETRY_MAX_DELAY_MS,
        ),
      );
    }
  }

  console.warn(
    `  Warning: could not download/extract artifact ${artifactId} (${artifactPath}) after ${GITHUB_GET_MAX_ATTEMPTS} attempt(s): ${lastError}`,
  );
  console.warn(
    `  Artifact download attempts: ${attemptErrors.join(" | ")}`,
  );
  return null;
}

export async function downloadAndParsePerfMetrics(
  artifactId: number,
): Promise<Map<string, TimingSample> | null> {
  const tmpDir = await downloadAndExtractArtifact(
    artifactId,
    "perf-metrics-",
  );
  if (!tmpDir) return null;
  try {
    const jsonPath = `${tmpDir}/${PERF_METRICS_FILE}`;
    const content = await Deno.readTextFile(jsonPath);
    return parsePerfMetricsFile(content);
  } catch {
    return null;
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

export async function downloadAndParsePerfMetricsBackfill(
  artifactId: number,
): Promise<Map<number, Map<string, TimingSample>> | null> {
  const tmpDir = await downloadAndExtractArtifact(
    artifactId,
    "perf-metrics-backfill-",
  );
  if (!tmpDir) return null;
  try {
    const jsonPath = `${tmpDir}/${PERF_METRICS_BACKFILL_FILE}`;
    const content = await Deno.readTextFile(jsonPath);
    return parsePerfMetricsBackfillFile(content);
  } catch {
    return null;
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

export async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkFiles(full);
    else yield full;
  }
}

export function parseJUnitXml(xml: string): JUnitTestSuite[] {
  const suites: JUnitTestSuite[] = [];

  const suiteRegex =
    /<testsuite\s[^>]*?name="([^"]*)"[^>]*?time="([^"]*)"[^>]*?>([\s\S]*?)<\/testsuite>/g;
  const caseRegex =
    /<testcase\s[^>]*?name="([^"]*)"[^>]*?time="([^"]*)"[^>]*?\/?>(?:<\/testcase>)?/g;

  let suiteMatch;
  while ((suiteMatch = suiteRegex.exec(xml)) !== null) {
    const [, suiteName, suiteTime, suiteBody] = suiteMatch;
    const tests: { name: string; time: number }[] = [];

    let caseMatch;
    while ((caseMatch = caseRegex.exec(suiteBody)) !== null) {
      tests.push({
        name: caseMatch[1],
        time: parseFloat(caseMatch[2]) || 0,
      });
    }

    suites.push({
      name: suiteName,
      time: parseFloat(suiteTime) || 0,
      tests,
    });
  }

  return suites;
}

// ---------------------------------------------------------------------------
// Log parsing fallback (for runs without JUnit artifacts)
// ---------------------------------------------------------------------------

/**
 * Downloads the raw log for a job and parses deno test output to extract
 * per-file timing. This is a brittle fallback for historical runs that
 * predate JUnit artifact uploads. Remove after 2026-03-19.
 */
export async function fetchJobLog(jobId: number): Promise<string> {
  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/actions/jobs/${jobId}/logs`,
    { headers: apiHeaders(), redirect: "follow" },
  );
  if (!resp.ok) return "";
  return resp.text();
}

export function parseDenoTestLog(log: string): JUnitTestSuite[] {
  const suites: JUnitTestSuite[] = [];

  const cleanLine = (s: string) =>
    s
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
      // deno-lint-ignore no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\[[\d;]*m/g, "")
      .trim();

  const lines = log.split("\n").map(cleanLine);

  let currentFile: string | null = null;
  let currentTests: { name: string; time: number }[] = [];

  function parseDuration(timeStr: string, unit: string): number {
    let d = parseFloat(timeStr);
    if (unit === "ms") d /= 1000;
    return d;
  }

  function parseDurationFull(s: string): number | null {
    const full = s.match(/(\d+)m\s*(\d+)s/);
    if (full) return parseInt(full[1]) * 60 + parseInt(full[2]);
    const sec = s.match(/^(\d+(?:\.\d+)?)s$/);
    if (sec) return parseFloat(sec[1]);
    const ms = s.match(/^(\d+(?:\.\d+)?)ms$/);
    if (ms) return parseFloat(ms[1]) / 1000;
    return null;
  }

  function flushFile(duration: number) {
    if (currentFile) {
      suites.push({ name: currentFile, time: duration, tests: currentTests });
      currentFile = null;
      currentTests = [];
    }
  }

  for (const line of lines) {
    const runningMatch = line.match(
      /^running \d+ tests? from (.+\.test\.tsx?)$/,
    );
    if (runningMatch) {
      if (currentFile && currentTests.length > 0) {
        const totalTime = currentTests.reduce((s, t) => s + t.time, 0);
        flushFile(totalTime);
      }
      currentFile = runningMatch[1];
      currentTests = [];
      continue;
    }

    const subtestMatch = line.match(
      /^(.+?) \.{3} ok \((\d+(?:\.\d+)?)(ms|s)\)$/,
    );
    if (subtestMatch && currentFile) {
      const testName = subtestMatch[1];
      const dur = parseDuration(subtestMatch[2], subtestMatch[3]);
      currentTests.push({ name: testName, time: dur });
      continue;
    }

    const subtestMinMatch = line.match(
      /^(.+?) \.{3} ok \((\d+m\s*\d+s)\)$/,
    );
    if (subtestMinMatch && currentFile) {
      const testName = subtestMinMatch[1];
      const dur = parseDurationFull(subtestMinMatch[2]);
      if (dur !== null) {
        currentTests.push({ name: testName, time: dur });
      }
      continue;
    }

    const summaryMatch = line.match(
      /^ok \| \d+ passed.*\((\d+(?:\.\d+)?)(ms|s)\)/,
    );
    if (summaryMatch) {
      const dur = parseDuration(summaryMatch[1], summaryMatch[2]);
      flushFile(dur);
      continue;
    }

    const summaryMinMatch = line.match(
      /^ok \| \d+ passed.*\((\d+m\s*\d+s)\)/,
    );
    if (summaryMinMatch) {
      const dur = parseDurationFull(summaryMinMatch[1]);
      if (dur !== null) flushFile(dur);
      continue;
    }

    const failMatch = line.match(
      /^FAILED \|.*\((\d+(?:\.\d+)?)(ms|s)\)/,
    );
    if (failMatch) {
      const dur = parseDuration(failMatch[1], failMatch[2]);
      flushFile(dur);
      continue;
    }
  }

  if (currentFile && currentTests.length > 0) {
    const totalTime = currentTests.reduce((s, t) => s + t.time, 0);
    flushFile(totalTime);
  }

  return suites;
}

/** Map from job name substring to the artifact-style label for test metrics. */
export const JOB_TO_LABEL: Record<string, string> = {
  "Package Integration Tests": "package-integration",
  "Pattern Integration Tests": "pattern-integration",
  "Pattern Integration Test (Lunch Poll contention)":
    "pattern-integration-lunch-poll-contention",
  "Pattern Reload Integration Tests": "pattern-reload-integration",
  "Generated Patterns Integration Tests": "generated-patterns",
};

export function timingArtifactLabel(artifactName: string): string {
  const label = artifactName.replace(/^test-timing-/, "");
  return label
    .replace(/^package-integration-.+$/, "package-integration")
    .replace(/^pattern-integration-\d+$/, "pattern-integration")
    .replace(/^generated-patterns-\d+$/, "generated-patterns");
}

// ---------------------------------------------------------------------------
// Benchmark results parsing
// ---------------------------------------------------------------------------

export function extractBenchMetrics(
  run: WorkflowRun,
  benchData: DenoBenchResult,
): Map<string, TimingSample> {
  const metrics = new Map<string, TimingSample>();

  for (const bench of benchData.benches) {
    const result = bench.results[0]?.ok;
    if (!result) continue;

    const originFile = bench.origin.replace(
      /^file:\/\/.*\/packages\//,
      "packages/",
    );
    const group = bench.group ? `${bench.group}/` : "";
    const key = `bench: ${originFile} > ${group}${bench.name}`;

    metrics.set(key, {
      runId: run.id,
      runUrl: run.html_url,
      sha: run.head_sha,
      createdAt: run.created_at,
      durationSeconds: result.avg, // nanoseconds — formatted appropriately
    });
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Metric extraction from jobs/steps
// ---------------------------------------------------------------------------

export function durationSeconds(
  start: string | null,
  end: string | null,
): number {
  if (!start || !end) return 0;
  return (new Date(end).getTime() - new Date(start).getTime()) / 1000;
}

export function normalizeName(name: string): string {
  return name
    .replace(
      /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}]/gu,
      "",
    )
    .trim();
}

const JOB_METRIC_NAMES: Record<string, string> = {
  "Package Integration Tests": "job: Package Integration Tests",
  "CLI Integration Tests (core)": "job: CLI Integration Tests (core)",
  "CLI Integration Tests (core-piece-basics)":
    "job: CLI Integration Tests (core-piece-basics)",
  "CLI Integration Tests (core-piece-values)":
    "job: CLI Integration Tests (core-piece-values)",
  "CLI Integration Tests (core-piece-links)":
    "job: CLI Integration Tests (core-piece-links)",
  "CLI Integration Tests (core-piece-call)":
    "job: CLI Integration Tests (core-piece-call)",
  "CLI Integration Tests (fuse)": "job: CLI Integration Tests (fuse)",
  // Legacy pre-matrix job name retained for older baselines and overrides.
  "CLI Integration Tests": "job: CLI Integration Tests",
  "Pattern Integration Tests": "job: Pattern Integration Tests",
  "Pattern Integration Test (Lunch Poll contention)":
    "job: Pattern Integration Test (Lunch Poll contention)",
  "Pattern Reload Integration Tests": "job: Pattern Reload Integration Tests",
  "Generated Patterns Integration Tests":
    "job: Generated Patterns Integration Tests",
  "Runner Tests": "job: Runner Tests",
  "Build Binaries": "job: Build Binaries",
  "Test": "job: Test",
  "Check": "job: Check",
  "Test and Build": "job: Test and Build",
};

/** Pattern for matrix jobs like "Pattern Unit Tests (1/5)". */
export const PACKAGE_INTEGRATION_RE = /Package Integration Tests\s*\(([^)]+)\)/;
export const PATTERN_UNIT_RE = /Pattern Unit Tests\s*\((\d+)\/(\d+)\)/;
export const PATTERN_INTEGRATION_RE =
  /Pattern Integration Tests\s*\((\d+)\/(\d+)\)/;
export const GENERATED_PATTERNS_RE =
  /Generated Patterns Integration Tests\s*\((\d+)\/(\d+)\)/;
export const RUNNER_TEST_RE = /Runner Tests\s*\((\d+)\/(\d+)\)/;
export const CLI_CORE_SPLIT_RE = /CLI Integration Tests\s*\((core-[^)]+)\)/;

interface StepMetricMatcher {
  jobName: string;
  stepKeyword: string;
  metricName: string;
}

const STEP_METRIC_MATCHERS: StepMetricMatcher[] = [
  {
    jobName: "Package Integration Tests",
    stepKeyword: "runner integration",
    metricName: "step: runner integration",
  },
  {
    jobName: "Package Integration Tests",
    stepKeyword: "runtime-client integration",
    metricName: "step: runtime-client integration",
  },
  {
    jobName: "Package Integration Tests",
    stepKeyword: "shell integration",
    metricName: "step: shell integration",
  },
  {
    jobName: "Package Integration Tests",
    stepKeyword: "background worker integration",
    metricName: "step: background worker integration",
  },
  {
    jobName: "Pattern Integration Tests",
    stepKeyword: "patterns integration",
    metricName: "step: patterns integration",
  },
  {
    jobName: "Pattern Integration Test (Lunch Poll contention)",
    stepKeyword: "lunch poll contention integration test",
    metricName: "step: lunch poll contention integration",
  },
  {
    jobName: "Pattern Reload Integration Tests",
    stepKeyword: "pattern reload integration",
    metricName: "step: pattern reload integration",
  },
  {
    jobName: "Generated Patterns Integration Tests",
    stepKeyword: "generated patterns integration",
    metricName: "step: generated patterns integration",
  },
  {
    jobName: "Runner Tests",
    stepKeyword: "runner tests",
    metricName: "step: runner tests",
  },
  {
    jobName: "CLI Integration Tests (core)",
    stepKeyword: "cli integration suite",
    metricName: "step: CLI integration (core)",
  },
  {
    jobName: "CLI Integration Tests (fuse)",
    stepKeyword: "cli fuse integration suite",
    metricName: "step: CLI integration (fuse)",
  },
  {
    jobName: "CLI Integration Tests",
    stepKeyword: "cli integration suite",
    metricName: "step: CLI integration",
  },
  {
    jobName: "Pattern Unit Tests",
    stepKeyword: "pattern unit tests",
    metricName: "step: pattern unit tests",
  },
  {
    jobName: "Check",
    stepKeyword: "type check",
    metricName: "step: Type check",
  },
  {
    jobName: "Test",
    stepKeyword: "workspace tests",
    metricName: "step: workspace tests",
  },
  {
    jobName: "Build Binaries",
    stepKeyword: "build application",
    metricName: "step: Build application",
  },
];

export function extractMetrics(
  run: WorkflowRun,
  jobs: Job[],
): Map<string, TimingSample> {
  const metrics = new Map<string, TimingSample>();

  const makeSample = (duration: number): TimingSample => ({
    runId: run.id,
    runUrl: run.html_url,
    sha: run.head_sha,
    createdAt: run.created_at,
    durationSeconds: duration,
  });

  const setMaxMetric = (name: string, sample: TimingSample) => {
    const existing = metrics.get(name);
    if (!existing || sample.durationSeconds > existing.durationSeconds) {
      metrics.set(name, sample);
    }
  };

  for (const job of jobs) {
    const jobDuration = durationSeconds(job.started_at, job.completed_at);
    if (jobDuration <= 0) continue;

    const normalizedJobName = normalizeName(job.name);

    const jobMetricName = JOB_METRIC_NAMES[normalizedJobName];
    if (jobMetricName) {
      metrics.set(jobMetricName, makeSample(jobDuration));
    }

    const packageIntegrationMatch = PACKAGE_INTEGRATION_RE.exec(
      normalizedJobName,
    );
    const unitMatch = PATTERN_UNIT_RE.exec(normalizedJobName);
    const patternIntegrationMatch = PATTERN_INTEGRATION_RE.exec(
      normalizedJobName,
    );
    const generatedPatternsMatch = GENERATED_PATTERNS_RE.exec(
      normalizedJobName,
    );
    const runnerTestMatch = RUNNER_TEST_RE.exec(normalizedJobName);
    const cliCoreSplitMatch = CLI_CORE_SPLIT_RE.exec(normalizedJobName);

    const matcherJobName = packageIntegrationMatch
      ? "Package Integration Tests"
      : unitMatch
      ? "Pattern Unit Tests"
      : patternIntegrationMatch
      ? "Pattern Integration Tests"
      : generatedPatternsMatch
      ? "Generated Patterns Integration Tests"
      : runnerTestMatch
      ? "Runner Tests"
      : cliCoreSplitMatch
      ? "CLI Integration Tests (core)"
      : normalizedJobName;

    if (packageIntegrationMatch) {
      const sample = makeSample(jobDuration);
      metrics.set(
        `job: Package Integration Tests (${packageIntegrationMatch[1]})`,
        sample,
      );
      setMaxMetric("job: Package Integration Tests", sample);
    }

    if (unitMatch) {
      metrics.set(
        `job: Pattern Unit Tests (${unitMatch[1]}/${unitMatch[2]})`,
        makeSample(jobDuration),
      );
    }

    if (patternIntegrationMatch) {
      const sample = makeSample(jobDuration);
      metrics.set(
        `job: Pattern Integration Tests (${patternIntegrationMatch[1]}/${
          patternIntegrationMatch[2]
        })`,
        sample,
      );
      setMaxMetric("job: Pattern Integration Tests", sample);
    }

    if (generatedPatternsMatch) {
      const sample = makeSample(jobDuration);
      metrics.set(
        `job: Generated Patterns Integration Tests (${
          generatedPatternsMatch[1]
        }/${generatedPatternsMatch[2]})`,
        sample,
      );
      setMaxMetric("job: Generated Patterns Integration Tests", sample);
    }

    if (runnerTestMatch) {
      const sample = makeSample(jobDuration);
      metrics.set(
        `job: Runner Tests (${runnerTestMatch[1]}/${runnerTestMatch[2]})`,
        sample,
      );
      setMaxMetric("job: Runner Tests", sample);
    }

    if (cliCoreSplitMatch) {
      const sample = makeSample(jobDuration);
      metrics.set(
        `job: CLI Integration Tests (${cliCoreSplitMatch[1]})`,
        sample,
      );
      setMaxMetric("job: CLI Integration Tests (core)", sample);
    }

    if (normalizedJobName.includes("Test and Build")) {
      metrics.set("job: Test and Build", makeSample(jobDuration));
    }

    for (const step of job.steps) {
      const stepDuration = durationSeconds(step.started_at, step.completed_at);
      if (stepDuration <= 0) continue;

      const normalizedStepName = normalizeName(step.name).toLowerCase();
      for (const matcher of STEP_METRIC_MATCHERS) {
        if (
          matcher.jobName === matcherJobName &&
          normalizedStepName.includes(matcher.stepKeyword)
        ) {
          const sample = makeSample(stepDuration);
          if (
            packageIntegrationMatch || patternIntegrationMatch ||
            generatedPatternsMatch || runnerTestMatch || cliCoreSplitMatch
          ) {
            setMaxMetric(matcher.metricName, sample);
          } else {
            metrics.set(matcher.metricName, sample);
          }
        }
      }
    }
  }

  return metrics;
}

export function extractTestFileMetrics(
  run: WorkflowRun,
  artifactName: string,
  suites: JUnitTestSuite[],
): Map<string, TimingSample> {
  const metrics = new Map<string, TimingSample>();

  const makeSample = (duration: number): TimingSample => ({
    runId: run.id,
    runUrl: run.html_url,
    sha: run.head_sha,
    createdAt: run.created_at,
    durationSeconds: duration,
  });

  for (const suite of suites) {
    if (suite.time <= 0) continue;
    const key = `test: ${artifactName}/${suite.name}`;
    metrics.set(key, makeSample(suite.time));

    for (const test of suite.tests) {
      if (test.time <= 0) continue;
      const testKey = `subtest: ${artifactName}/${suite.name} > ${test.name}`;
      metrics.set(testKey, makeSample(test.time));
    }
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// CI wall-time revisit signals
// ---------------------------------------------------------------------------

export const CI_WALL_TIME_SLOW_JOB_SECONDS = 180;
export const CI_WALL_TIME_REQUIRED_CHECK_SECONDS = 8 * 60;
export const CI_WALL_TIME_IMBALANCE_RATIO = 1.5;
export const CI_WALL_TIME_IMBALANCE_MIN_DELTA_SECONDS = 30;
export const CI_WALL_TIME_COMPARABLE_JOB_COUNT = 5;

const CI_WALL_TIME_EXCLUDED_JOB_PATTERNS = [
  /^Deploy /,
  /^Attest and Upload Binaries$/,
  /^Toolshed Post-Deploy Patterns Test$/,
];

function medianNumber(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function shouldIncludeCiWallTimeJob(name: string): boolean {
  return !CI_WALL_TIME_EXCLUDED_JOB_PATTERNS.some((re) => re.test(name));
}

export function computeCiWallTimeRevisitSignals(
  jobs: Job[],
): CiWallTimeRevisitSignal[] {
  const measuredJobs = jobs
    .map((job) => {
      const name = normalizeName(job.name);
      const startMs = job.started_at ? Date.parse(job.started_at) : NaN;
      const endMs = job.completed_at ? Date.parse(job.completed_at) : NaN;
      return {
        name,
        startMs,
        endMs,
        durationSeconds: durationSeconds(job.started_at, job.completed_at),
      };
    })
    .filter((job) =>
      shouldIncludeCiWallTimeJob(job.name) &&
      Number.isFinite(job.startMs) &&
      Number.isFinite(job.endMs) &&
      job.durationSeconds > 0
    );

  if (measuredJobs.length === 0) return [];

  const signals: CiWallTimeRevisitSignal[] = [];
  const sortedByDuration = [...measuredJobs].sort((a, b) =>
    b.durationSeconds - a.durationSeconds
  );
  const slowest = sortedByDuration[0];

  if (slowest.durationSeconds >= CI_WALL_TIME_SLOW_JOB_SECONDS) {
    signals.push({
      kind: "slow-job",
      title: "Slowest required CI job is over 3m",
      detail: `${slowest.name} took ${formatDuration(slowest.durationSeconds)}`,
    });
  }

  const comparableJobs = sortedByDuration.slice(
    0,
    Math.min(CI_WALL_TIME_COMPARABLE_JOB_COUNT, sortedByDuration.length),
  );
  const comparableMedian = medianNumber(
    comparableJobs.map((job) => job.durationSeconds),
  );
  if (
    slowest.durationSeconds >=
      comparableMedian * CI_WALL_TIME_IMBALANCE_RATIO &&
    slowest.durationSeconds - comparableMedian >=
      CI_WALL_TIME_IMBALANCE_MIN_DELTA_SECONDS
  ) {
    signals.push({
      kind: "job-imbalance",
      title: "One required CI job is much slower than nearby jobs",
      detail: `${slowest.name} took ${
        formatDuration(slowest.durationSeconds)
      }; top-${comparableJobs.length} median is ${
        formatDuration(comparableMedian)
      }`,
    });
  }

  const requiredStartMs = Math.min(...measuredJobs.map((job) => job.startMs));
  const requiredEndMs = Math.max(...measuredJobs.map((job) => job.endMs));
  const requiredWallTimeSeconds = (requiredEndMs - requiredStartMs) / 1000;
  if (requiredWallTimeSeconds >= CI_WALL_TIME_REQUIRED_CHECK_SECONDS) {
    signals.push({
      kind: "required-wall-time",
      title: "Required CI checks are over the wall-time budget",
      detail: `Required non-deploy jobs took ${
        formatDuration(requiredWallTimeSeconds)
      } from first start to last completion`,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function computeBaseline(
  samples: number[],
  minAbsoluteDelta = 0,
): Baseline | null {
  if (samples.length < MIN_SAMPLES) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
    samples.length;
  const stddev = Math.sqrt(variance);

  const threshold = Math.max(
    median + STDDEV_FACTOR * stddev,
    median * (1 + MIN_REGRESSION_PCT),
    median + minAbsoluteDelta,
  );

  return { median, stddev, variance, count: samples.length, threshold };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function isCoverageDebtMetric(name: string): boolean {
  return name.startsWith(COVERAGE_METRIC_PREFIX);
}

export function coverageMetricGroupName(metric: string): string | null {
  if (!isCoverageDebtMetric(metric)) return null;

  const prefix = `${COVERAGE_METRIC_PREFIX} `;
  const suffix = " uncovered lines";
  if (!metric.startsWith(prefix) || !metric.endsWith(suffix)) return null;

  return metric.slice(prefix.length, -suffix.length);
}

export function coverageGroupForChangedFile(filename: string): string | null {
  const normalized = filename.replaceAll("\\", "/");
  if (!/\.[jt]sx?$/.test(normalized)) return null;

  const parts = normalized.split("/");
  if (parts[0] === "packages" && parts[1]) {
    return `packages/${parts[1]}`;
  }
  if (parts[0] === "tasks" || parts[0] === "scripts") {
    return parts[0];
  }
  return null;
}

export function coverageGroupsForChangedFiles(
  filenames: Iterable<string>,
): Set<string> {
  const groups = new Set<string>();
  for (const filename of filenames) {
    const group = coverageGroupForChangedFile(filename);
    if (group) groups.add(group);
  }
  return groups;
}

export function shouldGateCoverageDebtMetric(
  metric: string,
  changedCoverageGroups: Set<string> | undefined,
): boolean {
  if (!isCoverageDebtMetric(metric)) return true;
  if (!changedCoverageGroups) return true;

  const group = coverageMetricGroupName(metric);
  if (!group || group === "workspace") return false;
  return changedCoverageGroups.has(group);
}

/**
 * Parse a unified diff (the per-file `patch` from the GitHub PR files API) and
 * return the lines this PR adds, keyed by their line number in the new file
 * and mapped to the added source text (without the leading `+`).
 */
export function parseAddedLinesFromPatch(patch: string): Map<number, string> {
  const added = new Map<number, string>();
  let newLineNumber = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        newLineNumber = parseInt(match[1], 10);
        inHunk = true;
      }
      continue;
    }

    // Skip the file-header section (e.g. `--- a/...`, `+++ b/...`) that precedes
    // the first hunk. Inside a hunk every line is content, so a `+`/`-` is the
    // diff marker and the rest — even another `+` or `-` — is source text.
    if (!inHunk) continue;

    if (line.startsWith("+")) {
      added.set(newLineNumber, line.slice(1));
      newLineNumber++;
      continue;
    }

    if (line.startsWith("-")) {
      // Deletion: present only in the old file, so the new-file cursor holds.
      continue;
    }

    // "\ No newline at end of file" markers and the trailing empty element
    // from splitting do not advance the new-file cursor.
    if (line.startsWith("\\") || line === "") continue;

    // Context line: present in both files.
    newLineNumber++;
  }

  return added;
}

/** A changed source group whose uncovered-line count regressed. */
export interface CoverageSuggestionGroup {
  group: string;
  /** Uncovered-line count from latest `main`; the PR must not exceed it. */
  target: number;
  /** Uncovered-line count this PR produced. */
  current: number;
}

/** Count of lines a PR added that no test executes, for one file. */
export interface CoverageSuggestionFileLines {
  relativePath: string;
  group: string;
  uncoveredCount: number;
}

/** A changed source group and where this PR left its uncovered-line count. */
export interface CoverageResolvedGroup {
  group: string;
  /** Uncovered-line count from latest `main`. */
  baseline: number;
  /** Uncovered-line count this PR produced. */
  current: number;
}

export interface CoverageDebtSuggestionInput {
  groups: CoverageSuggestionGroup[];
  files: CoverageSuggestionFileLines[];
}

const MAX_SUGGESTION_FILES = 50;

/**
 * Cap the file listing so a large PR does not produce an enormous comment.
 * Returns the files trimmed to the budget and how many were dropped.
 */
function limitSuggestionFiles(
  files: CoverageSuggestionFileLines[],
): { files: CoverageSuggestionFileLines[]; omitted: number } {
  if (files.length <= MAX_SUGGESTION_FILES) {
    return { files, omitted: 0 };
  }
  return {
    files: files.slice(0, MAX_SUGGESTION_FILES),
    omitted: files.length - MAX_SUGGESTION_FILES,
  };
}

function uncoveredLineCount(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

/**
 * Render the disclosure `<summary>`, leading with the detective emoji. The
 * regression comment wraps the line in an `<h3>` so it stands out while the
 * details are open; the resolved comment uses `<strong>`, a quieter weight that
 * suits a collapsed, already-handled note.
 */
function coverageSummary(
  text: string,
  emphasis: "h3" | "strong" = "h3",
): string {
  return `<summary><${emphasis}>🕵🏻‍♀️ ${text}</${emphasis}></summary>`;
}

function formatTargetList(groups: CoverageSuggestionGroup[]): string[] {
  return groups.map((group) =>
    `  ${COVERAGE_METRIC_PREFIX} ${group.group} uncovered lines  <=  ${group.target}   (this PR: ${group.current})`
  );
}

/**
 * Build the plain-text prompt an author can paste into an AI coding agent. It
 * is self-contained: the files holding the new uncovered code, the command to
 * reproduce the gate, and the target thresholds it must reach.
 */
function buildCoverageSuggestionPrompt(
  input: CoverageDebtSuggestionInput,
  limitedFiles: CoverageSuggestionFileLines[],
  omitted: number,
): string[] {
  const lines: string[] = [
    "Test coverage for this branch regressed: it adds source lines that no",
    "test executes, and the CI coverage gate is failing. Add or extend tests so",
    "the new code in the files below is executed. Write real tests that exercise",
    "the code paths; do not delete assertions, mark lines ignored, or weaken the",
    "gate.",
    "",
  ];

  if (limitedFiles.length > 0) {
    lines.push("Files with new uncovered lines (count in parentheses):");
    lines.push("");
    for (const file of limitedFiles) {
      lines.push(`  ${file.relativePath} (${file.uncoveredCount})`);
    }
    if (omitted > 0) {
      lines.push(`  ...and ${omitted} more file(s).`);
    }
    lines.push("");
  } else {
    lines.push(
      "The uncovered lines could not be tied to specific files from the diff.",
      "Run the command below to measure each group.",
      "",
    );
  }

  lines.push("After adding tests, verify from the repository root:");
  lines.push("");
  for (const command of COVERAGE_LOCAL_CHECK_COMMAND.split("\n")) {
    lines.push(`  ${command}`);
  }
  lines.push("");
  lines.push(
    "That prints one JSON object of coverage-debt metrics. The gate passes when",
    "each of these metrics is at or below its target:",
    "",
  );
  lines.push(...formatTargetList(input.groups));
  lines.push("");
  lines.push(
    "The local run omits the integration suites, so its counts are conservative:",
    "if every metric meets its target locally, CI will pass too.",
  );

  return lines;
}

/**
 * Build the Markdown body of the once-per-PR coverage-regression comment. Leads
 * with the hidden marker so a later run can detect that it was already posted.
 */
export function buildCoverageDebtSuggestionComment(
  input: CoverageDebtSuggestionInput,
): string {
  const { files, omitted } = limitSuggestionFiles(input.files);
  const overBy = input.groups.reduce(
    (sum, group) => sum + (group.current - group.target),
    0,
  );
  const out: string[] = [COVERAGE_SUGGESTION_MARKER];

  out.push("<details open>");
  out.push(
    coverageSummary(`Test coverage regressed by ${uncoveredLineCount(overBy)}`),
  );
  out.push("");
  out.push(
    "This PR adds source lines that no test exercises, so the coverage gate in " +
      "the **Performance Check** job is failing. The gate ratchets each changed " +
      "source group against its uncovered-line count on `main`: the group must " +
      "not end up with more uncovered lines than that baseline.",
  );
  out.push("");

  out.push("| Source group | Baseline (target) | This PR | Over by |");
  out.push("| --- | ---: | ---: | ---: |");
  for (const group of input.groups) {
    out.push(
      `| \`${group.group}\` | ${group.target} | ${group.current} | +${
        group.current - group.target
      } |`,
    );
  }
  out.push("");

  out.push("### Files with new uncovered lines");
  out.push("");
  if (files.length > 0) {
    for (const file of files) {
      out.push(
        `- \`${file.relativePath}\` — ${
          uncoveredLineCount(file.uncoveredCount)
        }`,
      );
    }
    if (omitted > 0) {
      out.push(`- _…and ${omitted} more file(s)._`);
    }
  } else {
    out.push(
      "Could not tie the regression to specific files from the diff (the " +
        "uncovered code may be in modified rather than newly-added lines). " +
        "Use the command below to measure each group.",
    );
  }
  out.push("");

  out.push("### Prompt for an AI coding agent");
  out.push("");
  out.push(
    "Copy the block below into an AI coding agent to add the missing tests:",
  );
  out.push("");
  out.push("````text");
  out.push(...buildCoverageSuggestionPrompt(input, files, omitted));
  out.push("````");
  out.push("");
  out.push("</details>");

  return out.join("\n");
}

/**
 * Describe how a group's uncovered-line count moved between its `main` baseline
 * and this PR, for the "Change" column of the resolved comment's table.
 */
function coverageChangeText(baseline: number, current: number): string {
  const delta = baseline - current;
  if (delta === 0) return "no change";
  const magnitude = uncoveredLineCount(Math.abs(delta));
  return delta > 0 ? `${magnitude} fewer` : `${magnitude} more`;
}

/**
 * Build the Markdown body of the coverage comment once the gate passes again
 * after an earlier regression. Leads with the same hidden marker so the poster
 * keeps finding the one comment, keeps the disclosure collapsed (no `open`), and
 * replaces the regression body with a short summary of where the PR left
 * coverage.
 *
 * `improvedLines` is the net reduction in the overall (workspace) uncovered-line
 * count versus its `main` baseline: when positive the summary reports the
 * reduction, otherwise it just notes the regression is resolved. `groups` lists
 * the changed source groups the gate ratchets, each with its `main` baseline and
 * the count this PR produced, rendered as a before-and-after table. When
 * `overridden` is set the gate passed only because the debt was accepted with an
 * override or the reset marker, so the summary says the metric was overridden
 * rather than implying the new code is covered.
 */
export function buildCoverageResolvedComment(
  improvedLines: number,
  groups: CoverageResolvedGroup[],
  overridden = false,
): string {
  const summary = overridden
    ? "Code coverage debt accepted with an override."
    : improvedLines > 0
    ? `Code coverage debt reduced by ${uncoveredLineCount(improvedLines)}!`
    : "Code coverage regression resolved.";

  const out: string[] = [COVERAGE_SUGGESTION_MARKER];
  out.push("<details>");
  out.push(coverageSummary(summary, "strong"));
  out.push("");
  out.push(
    overridden
      ? "The coverage gate in the **Performance Check** job passes because this " +
        "PR's coverage debt was accepted with an override rather than covered " +
        "by new tests. Here is where it left each changed source group:"
      : improvedLines > 0
      ? "The coverage gate in the **Performance Check** job passes again. This " +
        `PR now covers ${uncoveredLineCount(improvedLines)} that no test ` +
        "reached on `main`. Here is where it left each changed source group:"
      : "The coverage gate in the **Performance Check** job passes again. Here " +
        "is where this PR left each changed source group:",
  );
  out.push("");

  if (groups.length > 0) {
    out.push("| Source group | Baseline (`main`) | This PR | Change |");
    out.push("| --- | ---: | ---: | ---: |");
    for (const group of groups) {
      out.push(
        `| \`${group.group}\` | ${group.baseline} | ${group.current} | ${
          coverageChangeText(group.baseline, group.current)
        } |`,
      );
    }
  } else {
    out.push(
      "Every changed source group is at or below its `main` baseline for " +
        "uncovered lines.",
    );
  }
  out.push("");
  out.push("</details>");

  return out.join("\n");
}

/** Escape a string for use inside a Markdown table cell. */
export function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toFixed(0)}s`;
}

export function formatNanos(ns: number): string {
  if (ns < 1_000) return `${ns.toFixed(1)}ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)}us`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`;
  return `${(ns / 1_000_000_000).toFixed(2)}s`;
}

export function formatMetricValue(name: string, value: number): string {
  if (isCoverageDebtMetric(name)) {
    const rounded = Math.round(value);
    return `${rounded} ${rounded === 1 ? "line" : "lines"}`;
  }
  return name.startsWith("bench:") ? formatNanos(value) : formatDuration(value);
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/**
 * Reads and parses the GHA event. Returns `undefined` if it can't be done.
 */
export async function readAndParseEvent(
  eventPath?: string,
): Promise<object | undefined> {
  eventPath ??= Deno.env.get("GITHUB_EVENT_PATH");

  if (!eventPath) {
    return undefined;
  }

  try {
    const result = JSON.parse(await Deno.readTextFile(eventPath));
    return (typeof result === "object") ? result : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// PR helpers
// ---------------------------------------------------------------------------

/**
 * Look up the merged PR that introduced a given commit on main.
 * Returns null if no associated PR is found or if the API call fails.
 */
export async function fetchPRForCommit(
  sha: string,
): Promise<PRInfo | null> {
  try {
    const prs = await githubGet<PRInfo[]>(
      `/repos/${REPO}/commits/${sha}/pulls`,
    );
    return prs.find((pr) => pr.merged_at !== null) ?? prs[0] ?? null;
  } catch {
    return null;
  }
}

/** Fetch the full body of a PR by number. */
export async function fetchPRBody(prNumber: number): Promise<string> {
  const pr = await githubGet<{ body: string | null }>(
    `/repos/${REPO}/pulls/${prNumber}`,
  );
  return pr.body ?? "";
}

export async function fetchPRFiles(prNumber: number): Promise<PRFile[]> {
  const files: PRFile[] = [];
  const perPage = 100;

  for (let page = 1;; page++) {
    const data = await githubGet<PRFile[]>(
      `/repos/${REPO}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`,
    );
    files.push(...data);
    if (data.length < perPage) break;
  }

  return files;
}

/** Fetch every issue comment on a PR (PR conversation comments). */
export async function fetchIssueComments(
  issueNumber: number,
): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  const perPage = 100;

  for (let page = 1;; page++) {
    const data = await githubGet<{ id: number; body: string | null }[]>(
      `/repos/${REPO}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`,
    );
    for (const comment of data) {
      comments.push({ id: comment.id, body: comment.body ?? "" });
    }
    if (data.length < perPage) break;
  }

  return comments;
}

export function pullRequestBodyFromEvent(
  event: object | undefined,
): string | undefined {
  const pullRequest =
    (event as { pull_request?: { body?: unknown } } | undefined)
      ?.pull_request;
  if (!pullRequest || !("body" in pullRequest)) return undefined;
  return typeof pullRequest.body === "string" ? pullRequest.body : "";
}

export async function fetchCurrentPRBody(
  prNumber: number,
  event: object | undefined,
): Promise<CurrentPRBody> {
  try {
    return { body: await fetchPRBody(prNumber), source: "live" };
  } catch (error) {
    const eventBody = pullRequestBodyFromEvent(event);
    return {
      body: eventBody ?? "",
      source: eventBody === undefined ? "empty-fallback" : "event-fallback",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Baseline override parsing
// ---------------------------------------------------------------------------

/**
 * Parse a PR body for performance baseline overrides.
 *
 * Format (visible markdown, one per line):
 *   NEW_PERF_BASELINE: job: Package Integration Tests = 300s
 *   NEW_PERF_BASELINE: bench: foo > bar = 500us
 *   NEW_COVERAGE_BASELINE
 *
 * Values require a unit suffix: s, ms, us/µs, ns, line, or lines.
 * The value is stored in the metric's native unit.
 * Coverage-debt metrics must use line units; non-coverage metrics must use
 * time units.
 * `NEW_COVERAGE_BASELINE` is a whole-coverage ratchet reset marker; it has no
 * value and lets the PR's/main run's coverage metrics become the next baseline.
 */
export function parseBaselineOverrides(body: string): BaselineOverrides {
  const result: BaselineOverrides = {
    metrics: new Map(),
    coverageBaselineReset: new RegExp(
      `^\\s*${COVERAGE_BASELINE_RESET_MARKER}(?::\\s*.*)?\\s*$`,
      "m",
    ).test(body),
  };

  const re =
    /NEW_PERF_BASELINE:\s*(.+?)\s*=\s*(\d+(?:\.\d+)?)\s*(ns|µs|us|ms|s|lines?)/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const metric = match[1].trim();
    let value = parseFloat(match[2]);
    const unit = match[3];
    const isLineUnit = unit === "line" || unit === "lines";
    const isCoverageMetric = isCoverageDebtMetric(metric);

    if (isLineUnit && !isCoverageMetric) {
      throw new Error(
        `Invalid NEW_PERF_BASELINE override for "${metric}": line units are only valid for coverage-debt metrics.`,
      );
    }
    if (!isLineUnit && isCoverageMetric) {
      throw new Error(
        `Invalid NEW_PERF_BASELINE override for "${metric}": coverage-debt metrics must use line units.`,
      );
    }

    if (isLineUnit) {
      result.metrics.set(metric, value);
      continue;
    }

    switch (unit) {
      case "ns":
        value /= 1e9;
        break;
      case "us":
      case "µs":
        value /= 1e6;
        break;
      case "ms":
        value /= 1e3;
        break;
      case "s":
        break;
    }

    if (metric.startsWith("bench:")) {
      value *= 1e9;
    }

    result.metrics.set(metric, value);
  }

  return result;
}

/**
 * Format a metric value as a suggested override string for PR descriptions.
 * Uses a human-friendly unit.
 */
export function formatOverrideSuggestion(
  metric: string,
  value: number,
): string {
  if (isCoverageDebtMetric(metric)) {
    const rounded = Math.ceil(value);
    return `${rounded} ${rounded === 1 ? "line" : "lines"}`;
  }
  if (metric.startsWith("bench:")) {
    // value is in nanoseconds
    if (value < 1_000) return `${value.toFixed(0)}ns`;
    if (value < 1_000_000) return `${(value / 1_000).toFixed(0)}us`;
    if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(0)}ms`;
    return `${(value / 1_000_000_000).toFixed(1)}s`;
  }
  // value is in seconds
  return `${Math.ceil(value)}s`;
}

// ---------------------------------------------------------------------------
// Timeline helpers
// ---------------------------------------------------------------------------

/** Add a sample to a timeline map, creating the timeline if necessary. */
export function addSample(
  timelines: Map<string, MetricTimeline>,
  name: string,
  sample: TimingSample,
): void {
  let timeline = timelines.get(name);
  if (!timeline) {
    timeline = { name, samples: [] };
    timelines.set(name, timeline);
  }
  timeline.samples.push(sample);
}

/**
 * Apply baseline overrides to timelines by truncating samples before the
 * latest override point.
 *
 * `overridesBySha` maps commit SHA -> BaselineOverrides parsed from the
 * merged PR for that commit.  When a commit has a per-metric override, or a
 * whole-coverage reset for coverage-debt metrics, we discard all samples for
 * the affected metrics that precede that commit (keeping the override commit's
 * sample and everything after).
 */
export function applyBaselineOverrides(
  timelines: Map<string, MetricTimeline>,
  overridesBySha: Map<string, BaselineOverrides>,
): void {
  // Find the latest override commit index for each metric
  for (const [metricName, timeline] of timelines) {
    let latestOverrideIdx = -1;

    for (let i = 0; i < timeline.samples.length; i++) {
      const sha = timeline.samples[i].sha;
      const overrides = overridesBySha.get(sha);
      if (!overrides) continue;

      if (
        overrides.metrics.has(metricName) ||
        (overrides.coverageBaselineReset &&
          isCoverageDebtMetric(metricName))
      ) {
        latestOverrideIdx = i;
      }
    }

    if (latestOverrideIdx > 0) {
      timeline.samples = timeline.samples.slice(latestOverrideIdx);
    }
  }
}
