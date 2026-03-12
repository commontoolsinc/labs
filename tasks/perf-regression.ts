#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run --allow-write

/**
 * CI Performance Regression Detector
 *
 * Fetches recent "Deno Workflow" runs from GitHub API, extracts job/step/test
 * durations, computes rolling baselines, and flags regressions via a GitHub
 * Issue.
 *
 * Usage:
 *   GITHUB_TOKEN=... deno run --allow-net --allow-env --allow-read --allow-run --allow-write tasks/perf-regression.ts
 *
 * Environment:
 *   GITHUB_TOKEN    - Required. GitHub token with actions:read and issues:write.
 *   GITHUB_REPOSITORY - Optional. Defaults to "commontoolsinc/labs".
 *   DRY_RUN         - If "1", print results but don't create/update issues.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO = Deno.env.get("GITHUB_REPOSITORY") ?? "commontoolsinc/labs";
const TOKEN = Deno.env.get("GITHUB_TOKEN");
const DRY_RUN = Deno.env.get("DRY_RUN") === "1";
const WORKFLOW_FILE = "deno.yml";

/** Minimum number of historical samples before we compute a baseline. */
const MIN_SAMPLES = 5;

/** Number of recent runs to compare against the baseline. */
const RECENT_WINDOW = 3;

/** How many of the recent runs must exceed the threshold to flag a regression. */
const RECENT_THRESHOLD = 2;

/** Standard deviations above the median to flag a regression. */
const STDDEV_FACTOR = 2;

/** Multiplier on the median as an alternative threshold. */
const MEDIAN_MULTIPLIER = 2;

/** Baseline window: at least this many runs. */
const MIN_BASELINE_RUNS = 20;

/** Baseline window: at least this many days back. */
const MIN_BASELINE_DAYS = 7;

/** Maximum workflow runs to fetch from API. */
const MAX_RUNS_TO_FETCH = 100;

/** Concurrency limit for API calls. */
const API_CONCURRENCY = 5;

/** Label applied to regression issues. */
const ISSUE_LABEL = "perf-regression";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowRun {
  id: number;
  html_url: string;
  head_sha: string;
  created_at: string;
  conclusion: string;
}

interface Job {
  id: number;
  name: string;
  started_at: string | null;
  completed_at: string | null;
  steps: Step[];
}

interface Step {
  name: string;
  started_at: string | null;
  completed_at: string | null;
}

interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

interface TimingSample {
  runId: number;
  runUrl: string;
  sha: string;
  createdAt: string;
  durationSeconds: number;
}

interface MetricTimeline {
  name: string;
  samples: TimingSample[];
}

interface Baseline {
  median: number;
  stddev: number;
  count: number;
  threshold: number;
}

interface Regression {
  metric: string;
  recentValues: number[];
  baseline: Baseline;
  avgRecent: number;
  pctIncrease: number;
}

interface JUnitTestSuite {
  name: string;
  time: number;
  tests: { name: string; time: number }[];
}

/** Structured output from `deno bench --json`. */
interface DenoBenchResult {
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

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function apiHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubGet<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const resp = await fetch(url, { headers: apiHeaders() });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${path}\n${body}`);
  }
  return resp.json();
}

async function githubPost<T>(
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

async function githubPatch<T>(
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

async function mapConcurrent<T, R>(
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
// Step 1: Fetch recent successful workflow runs
// ---------------------------------------------------------------------------

async function fetchRecentRuns(): Promise<WorkflowRun[]> {
  const data = await githubGet<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&status=success&per_page=${MAX_RUNS_TO_FETCH}`,
  );
  return data.workflow_runs;
}

// ---------------------------------------------------------------------------
// Step 2: Fetch jobs for each run
// ---------------------------------------------------------------------------

async function fetchJobsForRun(
  runId: number,
): Promise<Job[]> {
  const data = await githubGet<{ jobs: Job[] }>(
    `/repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return data.jobs;
}

// ---------------------------------------------------------------------------
// Step 3: Fetch and parse JUnit artifacts
// ---------------------------------------------------------------------------

async function fetchArtifactsForRun(runId: number): Promise<Artifact[]> {
  const data = await githubGet<{ artifacts: Artifact[] }>(
    `/repos/${REPO}/actions/runs/${runId}/artifacts`,
  );
  return data.artifacts;
}

async function downloadAndParseJUnit(
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

    // Find all XML files in the extracted directory
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

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkFiles(full);
    else yield full;
  }
}

function parseJUnitXml(xml: string): JUnitTestSuite[] {
  const suites: JUnitTestSuite[] = [];

  // Match <testsuite> elements
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
// Step 3b: Log parsing fallback (for runs without JUnit artifacts)
// ---------------------------------------------------------------------------

/**
 * Downloads the raw log for a job and parses deno test output to extract
 * per-file timing. This is a brittle fallback for historical runs that
 * predate JUnit artifact uploads. Remove after 2026-03-19.
 */
async function fetchJobLog(jobId: number): Promise<string> {
  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/actions/jobs/${jobId}/logs`,
    { headers: apiHeaders(), redirect: "follow" },
  );
  if (!resp.ok) return "";
  return resp.text();
}

/**
 * Parse deno test log output for per-file timing.
 *
 * Looks for patterns like:
 *   running N tests from ./integration/foo.test.ts
 *   ...
 *   ok | N passed ... (Nms)
 *
 * And also the per-file summary line that deno emits when multiple test files
 * are run:
 *   ./integration/foo.test.ts ... ok (1234ms)
 *
 * Returns synthetic JUnitTestSuite entries so we can reuse the same pipeline.
 */
function parseDenoTestLog(log: string): JUnitTestSuite[] {
  const suites: JUnitTestSuite[] = [];

  // GitHub Actions logs have timestamp prefixes like:
  //   2024-01-15T10:30:00.1234567Z <content>
  // Strip those and ANSI escape codes.
  const cleanLine = (s: string) =>
    s
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\[[\d;]*m/g, "")
      .trim();

  const lines = log.split("\n").map(cleanLine);

  let currentFile: string | null = null;
  let currentTests: { name: string; time: number }[] = [];

  /** Helper to parse "(Nms)" or "(Ns)" or "(NmNs)" duration suffixes. */
  function parseDuration(timeStr: string, unit: string): number {
    let d = parseFloat(timeStr);
    if (unit === "ms") d /= 1000;
    return d;
  }

  function parseDurationFull(s: string): number | null {
    // Match "1m5s", "45s", "311ms", "1s", "2m 26s"
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
    // "running N tests from ./path/to/file.test.ts"
    const runningMatch = line.match(
      /^running \d+ tests? from (.+\.test\.tsx?)$/,
    );
    if (runningMatch) {
      // Flush previous file if it never got a summary line (e.g., all.test.ts
      // which only gets its subtests flushed, not an overall ok|failed line
      // before the next "running" block starts).
      if (currentFile && currentTests.length > 0) {
        const totalTime = currentTests.reduce((s, t) => s + t.time, 0);
        flushFile(totalTime);
      }
      currentFile = runningMatch[1];
      currentTests = [];
      continue;
    }

    // Subtest results: "TestName ... ok (Nms)" or "Executes: foo.tsx ... ok (1s)"
    // These are individual test cases within a file.
    const subtestMatch = line.match(
      /^(.+?) \.{3} ok \((\d+(?:\.\d+)?(?:m\s*\d+)?)(ms|s)\)$/,
    );
    if (subtestMatch && currentFile) {
      const testName = subtestMatch[1];
      const dur = parseDuration(subtestMatch[2], subtestMatch[3]);
      currentTests.push({ name: testName, time: dur });
      continue;
    }

    // Subtest with "NmNs" format: "Compile all patterns ... ok (1m5s)"
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

    // Overall summary: "ok | N passed ... | N failed (Nms)" or with steps
    const summaryMatch = line.match(
      /^ok \| \d+ passed.*\((\d+(?:\.\d+)?(?:m\s*\d+)?)(ms|s)\)/,
    );
    if (summaryMatch) {
      const dur = parseDuration(summaryMatch[1], summaryMatch[2]);
      flushFile(dur);
      continue;
    }

    // Summary with "NmNs" format: "ok | 9 passed (63 steps) | 0 failed ... (1m53s)"
    const summaryMinMatch = line.match(
      /^ok \| \d+ passed.*\((\d+m\s*\d+s)\)/,
    );
    if (summaryMinMatch) {
      const dur = parseDurationFull(summaryMinMatch[1]);
      if (dur !== null) flushFile(dur);
      continue;
    }

    // FAIL line also ends a file block: "FAILED | ... (Nms)"
    const failMatch = line.match(
      /^FAILED \|.*\((\d+(?:\.\d+)?)(ms|s)\)/,
    );
    if (failMatch) {
      const dur = parseDuration(failMatch[1], failMatch[2]);
      flushFile(dur);
      continue;
    }
  }

  // Flush final file if it never got a summary
  if (currentFile && currentTests.length > 0) {
    const totalTime = currentTests.reduce((s, t) => s + t.time, 0);
    flushFile(totalTime);
  }

  return suites;
}

/** Map from job name substring to the artifact-style label for test metrics. */
const JOB_TO_LABEL: Record<string, string> = {
  "Package Integration Tests": "package-integration",
  "Pattern Integration Tests": "pattern-integration",
  "Generated Patterns Integration Tests": "generated-patterns",
};

// ---------------------------------------------------------------------------
// Step 3c: Benchmark results parsing
// ---------------------------------------------------------------------------

/**
 * Parse `deno bench --json` output and return per-benchmark timing samples.
 * Values are in nanoseconds from the JSON; we convert to microseconds for
 * readability (benchmarks measure µs-scale operations, not seconds).
 */
function extractBenchMetrics(
  run: WorkflowRun,
  benchData: DenoBenchResult,
): Map<string, TimingSample> {
  const metrics = new Map<string, TimingSample>();

  for (const bench of benchData.benches) {
    const result = bench.results[0]?.ok;
    if (!result) continue;

    // Extract file name from origin URL
    const originFile = bench.origin.replace(
      /^file:\/\/.*\/packages\//,
      "packages/",
    );
    const group = bench.group ? `${bench.group}/` : "";
    const key = `bench: ${originFile} > ${group}${bench.name}`;

    // Store avg time in nanoseconds (the raw unit from deno bench)
    metrics.set(key, {
      runId: run.id,
      runUrl: run.html_url,
      sha: run.head_sha,
      createdAt: run.created_at,
      durationSeconds: result.avg, // nanoseconds — we'll format appropriately
    });
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Step 4: Extract timing metrics
// ---------------------------------------------------------------------------

function durationSeconds(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  return (new Date(end).getTime() - new Date(start).getTime()) / 1000;
}

/** Normalize a step/job name by stripping emoji and extra whitespace. */
function normalizeName(name: string): string {
  // Remove emoji (unicode ranges for common emoji)
  return name
    .replace(
      /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}]/gu,
      "",
    )
    .trim();
}

/** Integration-test job name patterns to track. */
const INTEGRATION_JOB_PATTERNS = [
  "Package Integration Tests",
  "CLI Integration Tests",
  "Pattern Integration Tests",
  "Generated Patterns Integration Tests",
];

/** Pattern for matrix jobs like "Pattern Unit Tests (1/5)". */
const PATTERN_UNIT_RE = /Pattern Unit Tests\s*\((\d+)\/(\d+)\)/;

/** Step name substrings to track within jobs. */
const STEP_KEYWORDS = [
  "runner integration",
  "runtime-client integration",
  "shell integration",
  "background worker integration",
  "patterns integration",
  "CLI integration",
  "generated patterns integration",
  "pattern unit tests",
  "Type check",
  "workspace tests",
  "Build application",
];

function extractMetrics(
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

    // Track integration test jobs
    for (const pattern of INTEGRATION_JOB_PATTERNS) {
      if (normalizedJobName.includes(pattern)) {
        metrics.set(`job: ${pattern}`, makeSample(jobDuration));
      }
    }

    // Track pattern unit test matrix jobs
    const unitMatch = PATTERN_UNIT_RE.exec(normalizedJobName);
    if (unitMatch) {
      metrics.set(
        `job: Pattern Unit Tests (${unitMatch[1]}/${unitMatch[2]})`,
        makeSample(jobDuration),
      );
    }

    // Track the build job
    if (normalizedJobName.includes("Test and Build")) {
      metrics.set("job: Test and Build", makeSample(jobDuration));
    }

    // Track specific steps
    for (const step of job.steps) {
      const stepDuration = durationSeconds(step.started_at, step.completed_at);
      if (stepDuration <= 0) continue;

      const normalizedStepName = normalizeName(step.name).toLowerCase();
      for (const keyword of STEP_KEYWORDS) {
        if (normalizedStepName.includes(keyword.toLowerCase())) {
          metrics.set(`step: ${keyword}`, makeSample(stepDuration));
        }
      }
    }
  }

  return metrics;
}

function extractTestFileMetrics(
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
    // Suite-level (per test file)
    const key = `test: ${artifactName}/${suite.name}`;
    metrics.set(key, makeSample(suite.time));

    // Individual test cases within the suite (for deeper granularity)
    for (const test of suite.tests) {
      if (test.time <= 0) continue;
      const testKey = `subtest: ${artifactName}/${suite.name} > ${test.name}`;
      metrics.set(testKey, makeSample(test.time));
    }
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// Step 5: Statistics and regression detection
// ---------------------------------------------------------------------------

function computeBaseline(samples: number[]): Baseline | null {
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

  const threshold = Math.min(
    median + STDDEV_FACTOR * stddev,
    median * MEDIAN_MULTIPLIER,
  );

  return { median, stddev, count: samples.length, threshold };
}

function detectRegressions(
  timelines: Map<string, MetricTimeline>,
): Regression[] {
  const regressions: Regression[] = [];

  for (const [name, timeline] of timelines) {
    const samples = timeline.samples;
    if (samples.length < MIN_SAMPLES + RECENT_WINDOW) continue;

    // Split into baseline (older) and recent
    const recentSamples = samples.slice(-RECENT_WINDOW);
    const baselineSamples = samples.slice(0, -RECENT_WINDOW);

    const baseline = computeBaseline(
      baselineSamples.map((s) => s.durationSeconds),
    );
    if (!baseline) continue;

    // Check how many recent samples exceed the threshold
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

  // Sort by severity (pct increase)
  regressions.sort((a, b) => b.pctIncrease - a.pctIncrease);
  return regressions;
}

// ---------------------------------------------------------------------------
// Step 6: GitHub Issue reporting
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toFixed(0)}s`;
}

/** Format nanosecond values from deno bench. */
function formatNanos(ns: number): string {
  if (ns < 1_000) return `${ns.toFixed(1)}ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)}µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`;
  return `${(ns / 1_000_000_000).toFixed(2)}s`;
}

/** Format a metric value, using the right unit based on the metric name. */
function formatMetricValue(name: string, value: number): string {
  return name.startsWith("bench:") ? formatNanos(value) : formatDuration(value);
}

function buildIssueBody(
  regressions: Regression[],
  baselineInfo: string,
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
  lines.push("### Recent values\n");
  for (const r of regressions) {
    const fmt = (v: number) => formatMetricValue(r.metric, v);
    lines.push(
      `- **${r.metric}**: ${r.recentValues.map(fmt).join(", ")}`,
    );
  }

  lines.push("");
  lines.push(`### Baseline\n`);
  lines.push(baselineInfo);
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
): Promise<void> {
  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would report the following regressions:\n");
    console.log(buildIssueBody(regressions, baselineInfo));
    return;
  }

  await ensureLabel();
  const existing = await findOpenIssue();

  if (regressions.length === 0) {
    if (existing) {
      // Close the existing issue
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

  const body = buildIssueBody(regressions, baselineInfo);

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
    console.log(
      `Created issue #${issue.number}: ${issue.html_url}`,
    );
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

  console.log(`Fetching recent workflow runs for ${REPO}...`);
  const allRuns = await fetchRecentRuns();
  if (allRuns.length === 0) {
    console.log("No successful workflow runs found.");
    return;
  }

  // Determine baseline window: max(last MIN_BASELINE_DAYS, last MIN_BASELINE_RUNS)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MIN_BASELINE_DAYS);

  let runs = allRuns.slice(0, MIN_BASELINE_RUNS);
  // Extend to include all runs within the date window
  for (let i = runs.length; i < allRuns.length; i++) {
    if (new Date(allRuns[i].created_at) >= cutoffDate) {
      runs.push(allRuns[i]);
    } else {
      break;
    }
  }
  // Also ensure we have at least MIN_BASELINE_RUNS even if they're older
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
  const jobsByRun = await mapConcurrent(runs, API_CONCURRENCY, async (run) => ({
    run,
    jobs: await fetchJobsForRun(run.id),
  }));

  // Build timelines from job/step data
  const timelines = new Map<string, MetricTimeline>();

  function addSample(name: string, sample: TimingSample) {
    let timeline = timelines.get(name);
    if (!timeline) {
      timeline = { name, samples: [] };
      timelines.set(name, timeline);
    }
    timeline.samples.push(sample);
  }

  // Process runs oldest-first so samples are in chronological order
  for (const { run, jobs } of jobsByRun.reverse()) {
    const metrics = extractMetrics(run, jobs);
    for (const [name, sample] of metrics) {
      addSample(name, sample);
    }
  }

  // Fetch JUnit artifacts for per-test-file timing, falling back to log
  // parsing for historical runs that predate JUnit artifact uploads.
  // TODO(perf): Remove log-parsing fallback after 2026-03-19.
  console.log("Fetching test timing artifacts...");
  let artifactRunsProcessed = 0;
  let logParseRunsProcessed = 0;
  await mapConcurrent(
    jobsByRun.map((j) => j),
    API_CONCURRENCY,
    async ({ run, jobs }) => {
      try {
        const artifacts = await fetchArtifactsForRun(run.id);
        const timingArtifacts = artifacts.filter(
          (a) => a.name.startsWith("test-timing-") && !a.expired,
        );

        if (timingArtifacts.length > 0) {
          // Preferred path: parse JUnit XML from artifacts
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
                addSample(name, sample);
              }
            }
          }
        } else {
          // Fallback: parse deno test output from job logs.
          // This is brittle but lets us backfill historical data.
          let parsedAny = false;
          for (const job of jobs) {
            const normalizedName = normalizeName(job.name);
            // Find which label this job maps to
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
                addSample(name, sample);
              }
            }
          }
          if (parsedAny) logParseRunsProcessed++;
        }
      } catch (e) {
        // Artifacts may not exist for older runs; that's fine
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
        `/repos/${REPO}/actions/workflows/benchmarks.yml/runs?branch=main&status=success&per_page=${MAX_RUNS_TO_FETCH}`,
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
                addSample(name, sample);
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
      console.log(
        `  Found ${benchRuns.length} benchmark runs, ${benchRunsProcessed} with results.`,
      );
    } else {
      console.log("  No benchmark runs found (workflow may not have run yet).");
    }
  } catch {
    console.log("  Benchmarks workflow not found or not yet created.");
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
    console.log(`\n⚠️  ${regressions.length} regression(s) detected:`);
    for (const r of regressions) {
      const fmt = (v: number) => formatMetricValue(r.metric, v);
      console.log(
        `  ${r.metric}: ${fmt(r.avgRecent)} vs baseline ${
          fmt(r.baseline.median)
        } (+${r.pctIncrease.toFixed(0)}%)`,
      );
    }
  } else {
    console.log("\n✅ No regressions detected.");
  }

  const baselineInfo = `Based on ${runs.length} runs from ${
    runs[runs.length - 1]?.created_at.slice(0, 10) ?? "?"
  } to ${
    runs[0]?.created_at.slice(0, 10) ?? "?"
  }. Thresholds: median + ${STDDEV_FACTOR}σ or ${MEDIAN_MULTIPLIER}x median (whichever is lower). Requires ${RECENT_THRESHOLD}/${RECENT_WINDOW} recent runs to exceed threshold.`;

  await reportRegressions(regressions, baselineInfo);
}

main();
