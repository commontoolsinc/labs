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

/** Minimum number of historical samples before we compute a baseline. */
export const MIN_SAMPLES = 5;

/** Number of recent runs to compare against the baseline. */
export const RECENT_WINDOW = 3;

/** How many of the recent runs must exceed the threshold to flag a regression. */
export const RECENT_THRESHOLD = 2;

/** Standard deviations above the median to flag a regression. */
export const STDDEV_FACTOR = 2;

/** Minimum percentage increase over median to flag a regression. */
export const MIN_REGRESSION_PCT = 0.10;

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

export interface TimingSample {
  runId: number;
  runUrl: string;
  sha: string;
  createdAt: string;
  durationSeconds: number;
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

export interface BaselineOverrides {
  /** Metric name -> value in the metric's native unit (seconds or nanoseconds). */
  metrics: Map<string, number>;
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

export async function githubGet<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const resp = await fetch(url, { headers: apiHeaders() });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${path}\n${body}`);
  }
  return resp.json();
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
  const data = await githubGet<{ artifacts: Artifact[] }>(
    `/repos/${REPO}/actions/runs/${runId}/artifacts`,
  );
  return data.artifacts;
}

// ---------------------------------------------------------------------------
// JUnit artifact parsing
// ---------------------------------------------------------------------------

export async function downloadAndParseJUnit(
  artifactId: number,
): Promise<JUnitTestSuite[]> {
  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/actions/artifacts/${artifactId}/zip`,
    { headers: apiHeaders() },
  );
  if (!resp.ok) return [];

  const tmpDir = await Deno.makeTempDir({ prefix: "perf-junit-" });
  const zipPath = `${tmpDir}/artifact.zip`;

  try {
    const data = new Uint8Array(await resp.arrayBuffer());
    await Deno.writeFile(zipPath, data);

    const unzip = new Deno.Command("unzip", {
      args: ["-o", zipPath, "-d", tmpDir],
      stdout: "null",
      stderr: "null",
    });
    const result = await unzip.output();
    if (!result.success) return [];

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
  "Generated Patterns Integration Tests": "generated-patterns",
};

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
  "CLI Integration Tests (fuse)": "job: CLI Integration Tests (fuse)",
  // Legacy pre-matrix job name retained for older baselines and overrides.
  "CLI Integration Tests": "job: CLI Integration Tests",
  "Pattern Integration Tests": "job: Pattern Integration Tests",
  "Generated Patterns Integration Tests":
    "job: Generated Patterns Integration Tests",
  "Build Binaries": "job: Build Binaries",
  "Test": "job: Test",
  "Check": "job: Check",
  "Test and Build": "job: Test and Build",
};

/** Pattern for matrix jobs like "Pattern Unit Tests (1/5)". */
export const PATTERN_UNIT_RE = /Pattern Unit Tests\s*\((\d+)\/(\d+)\)/;

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
    jobName: "Generated Patterns Integration Tests",
    stepKeyword: "generated patterns integration",
    metricName: "step: generated patterns integration",
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

  for (const job of jobs) {
    const jobDuration = durationSeconds(job.started_at, job.completed_at);
    if (jobDuration <= 0) continue;

    const normalizedJobName = normalizeName(job.name);

    const jobMetricName = JOB_METRIC_NAMES[normalizedJobName];
    if (jobMetricName) {
      metrics.set(jobMetricName, makeSample(jobDuration));
    }

    const matcherJobName = normalizedJobName.startsWith("Pattern Unit Tests")
      ? "Pattern Unit Tests"
      : normalizedJobName;

    const unitMatch = PATTERN_UNIT_RE.exec(normalizedJobName);
    if (unitMatch) {
      metrics.set(
        `job: Pattern Unit Tests (${unitMatch[1]}/${unitMatch[2]})`,
        makeSample(jobDuration),
      );
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
          metrics.set(matcher.metricName, makeSample(stepDuration));
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
  return name.startsWith("bench:") ? formatNanos(value) : formatDuration(value);
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

// ---------------------------------------------------------------------------
// Baseline override parsing
// ---------------------------------------------------------------------------

/**
 * Parse a PR body for performance baseline overrides.
 *
 * Format (visible markdown, one per line):
 *   NEW_PERF_BASELINE: job: Package Integration Tests = 300s
 *   NEW_PERF_BASELINE: bench: foo > bar = 500us
 *
 * Values require a unit suffix: s, ms, us/µs, ns.
 * The value is stored in the metric's native unit (seconds for
 * job/step/test, nanoseconds for bench).
 */
export function parseBaselineOverrides(body: string): BaselineOverrides {
  const result: BaselineOverrides = { metrics: new Map() };

  const re =
    /NEW_PERF_BASELINE:\s*(.+?)\s*=\s*(\d+(?:\.\d+)?)\s*(ns|µs|us|ms|s)/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const metric = match[1].trim();
    let value = parseFloat(match[2]);
    const unit = match[3];

    // Convert to seconds first
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

    // For bench metrics, convert seconds to nanoseconds (native unit)
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
 * merged PR for that commit.  When a commit has a per-metric override, we
 * discard all samples for the affected metrics that precede that commit
 * (keeping the override commit's sample and everything after).
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

      if (overrides.metrics.has(metricName)) {
        latestOverrideIdx = i;
      }
    }

    if (latestOverrideIdx > 0) {
      timeline.samples = timeline.samples.slice(latestOverrideIdx);
    }
  }
}
