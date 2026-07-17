import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  type Artifact,
  type BaselineOverrides,
  type CompileCacheState,
  type MetricTimeline,
  PERF_METRICS_ARTIFACT_NAME,
  PERF_METRICS_BACKFILL_ARTIFACT_NAME,
  type PRInfo,
  type TimingSample,
  type WorkflowRun,
} from "./perf-lib.ts";
import {
  addPerfMetricsFromArtifacts,
  type BaselineRunContext,
  buildBaselineRunContexts,
  buildExtraBackfillContexts,
  collectCurrentCacheStates,
  currentWorkflowRunFromEvent,
  evaluateTimingMetric,
  fetchArtifactsForRunBestEffort,
  fetchBaselineRunsForCheck,
  fetchCommitsBehindMain,
  fetchLatestBaselineRunSha,
  fetchMainHeadSha,
  fetchPRForCommitWithError,
  formatBaselineSourceRunAge,
  formatCommitDistance,
  formatCompileCacheStates,
  formatErrorForLog,
  formatMetricDelta,
  formatMetricValueForTable,
  formatRelativeAge,
  formatRelativeDuration,
  githubApiOrSkip,
  logBaselineSourceRuns,
  main,
  metricDisplayParts,
  metricTableRows,
  newestArtifactNamed,
  parseMergedBaselineOverrides,
  parsePerfMetricBackfillFromArtifacts,
  parsePerfMetricsFromArtifacts,
  printMetricTable,
  reportBaselineContextResults,
  reportBaselineRunAvailability,
  reportPRLookupResults,
  type Row,
  selectMergedPRForCommit,
  summarizeBaselinePRLookups,
  validateBaselineRunsForMainHead,
  workflowRunsPathForBaseline,
  writeCoverageComment,
  writeCoverageDebtSuggestion,
  writeCoverageResolved,
} from "./perf-check.ts";
import {
  COVERAGE_SUGGESTION_MARKER,
  type CoverageCommentPayload,
} from "./perf-lib.ts";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";

function makeRun(
  id: number,
  headSha = SHA_A,
  createdAt = "2026-06-18T10:00:00Z",
): WorkflowRun {
  return {
    id,
    html_url: `https://github.com/commontoolsinc/labs/actions/runs/${id}`,
    head_sha: headSha,
    created_at: createdAt,
    conclusion: "success",
    event: "push",
  };
}

function makeArtifact(
  id: number,
  name: string,
  expired = false,
): Artifact {
  return {
    id,
    name,
    size_in_bytes: 12,
    expired,
  };
}

function makeSample(run = makeRun(1)): TimingSample {
  return {
    runId: run.id,
    runUrl: run.html_url,
    sha: run.head_sha,
    createdAt: run.created_at,
    durationSeconds: 1.5,
  };
}

function makePR(number: number, mergedAt: string | null = null): PRInfo {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/commontoolsinc/labs/pull/${number}`,
    body: null,
    merged_at: mergedAt,
  };
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

async function withMockFetch<T>(
  handler: (input: FetchInput, init: FetchInit) => Response | Promise<Response>,
  callback: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    ((input: FetchInput, init?: FetchInit) =>
      Promise.resolve(handler(input, init))) as typeof fetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function captureConsole<T>(
  callback: () => T,
): { result: T; logs: string[]; warnings: string[]; errors: string[] } {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) =>
    warnings.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) =>
    errors.push(args.map(String).join(" "));
  try {
    return { result: callback(), logs, warnings, errors };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function captureConsoleAsync<T>(
  callback: () => Promise<T>,
): Promise<
  { result: T; logs: string[]; warnings: string[]; errors: string[] }
> {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) =>
    warnings.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) =>
    errors.push(args.map(String).join(" "));
  try {
    return { result: await callback(), logs, warnings, errors };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function withEnv<T>(
  values: Record<string, string | undefined>,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    previous.set(key, Deno.env.get(key));
    const value = values[key];
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`Deno.exit(${code})`);
  }
}

async function withMockExit(
  callback: () => Promise<void>,
): Promise<number | null> {
  const originalExit = Deno.exit;
  Deno.exit = ((code?: number): never => {
    throw new ExitError(code ?? 0);
  }) as typeof Deno.exit;
  try {
    await callback();
    return null;
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  } finally {
    Deno.exit = originalExit;
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

Deno.test("invalid merged PR baseline override metadata is ignored", () => {
  const warnings: string[] = [];
  const overrides = parseMergedBaselineOverrides(
    {
      number: 123,
      body: "NEW_PERF_BASELINE: job: Check = 7 lines",
    },
    (message) => warnings.push(message),
  );

  assertEquals(overrides, null);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "merged PR #123");
  assertStringIncludes(
    warnings[0],
    "line units are only valid for coverage-debt metrics",
  );
});

Deno.test("valid merged PR baseline override metadata is parsed", () => {
  const overrides = parseMergedBaselineOverrides({
    number: 124,
    body: "NEW_PERF_BASELINE: job: Check = 7s",
  });

  assertEquals(overrides?.metrics.get("job: Check"), 7);
});

function coverageRow(
  metric: string,
  current: number,
  median?: number,
  status: Row["status"] = median === undefined ? "n/a" : "OK",
): Row {
  return {
    metric,
    status,
    current,
    median,
    n: 1,
  };
}

/**
 * Run a writer with the coverage-comment output redirected to a temp file, then
 * return the parsed payload (or null when the writer produced no file).
 */
async function payloadFrom(
  write: () => Promise<void>,
): Promise<CoverageCommentPayload | null> {
  const dir = await Deno.makeTempDir({ prefix: "perf-check-comment-" });
  const file = path.join(dir, "coverage-comment.json");
  Deno.env.set("COVERAGE_COMMENT_FILE", file);
  try {
    await write();
    try {
      return JSON.parse(await Deno.readTextFile(file));
    } catch {
      return null;
    }
  } finally {
    Deno.env.delete("COVERAGE_COMMENT_FILE");
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("writeCoverageComment writes a regression payload when coverage fails", async () => {
  const failures = [
    coverageRow("coverage-debt: tasks uncovered lines", 8, 4),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageComment(4211, failures, failures, [], "")
  );

  assertEquals(payload?.state, "regressed");
  assertStringIncludes(payload?.body ?? "", COVERAGE_SUGGESTION_MARKER);
  // Over by 8 - 4 = 4 lines.
  assertStringIncludes(
    payload?.body ?? "",
    "<summary><h3>🕵🏻‍♀️ Test coverage regressed by 4 lines</h3></summary>",
  );
});

Deno.test("writeCoverageComment writes a resolved payload reporting the gated reduction", async () => {
  const rows = [
    // The workspace aggregate is never gated (status "excl"), so its large
    // delta must not count toward the PR's reported reduction.
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953, "excl"),
    // A gated group the PR touched, now 5 lines below its baseline.
    coverageRow("coverage-debt: tasks uncovered lines", 4, 9),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageComment(4211, [], rows, [{ filename: "tasks/foo.ts" }], "")
  );

  assertEquals(payload?.state, "resolved");
  // Only the gated group counts: 9 - 4 = 5 lines; the workspace delta is excluded.
  assertEquals(payload?.improvedLines, 5);
  // The changed `tasks` group is summarized; workspace stays out of it.
  assertEquals(payload?.groups, [
    { group: "tasks", baseline: 9, current: 4 },
  ]);
});

Deno.test("writeCoverageResolved omits groups the PR did not change", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953, "excl"),
    coverageRow("coverage-debt: tasks uncovered lines", 4, 6),
  ];
  // No changed files map to a coverage group, so there is no per-group summary.
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [{ filename: "README.md" }])
  );

  assertEquals(payload?.state, "resolved");
  // Only the gated `tasks` group counts: 6 - 4 = 2 lines.
  assertEquals(payload?.improvedLines, 2);
  assertEquals(payload?.groups, []);
});

Deno.test("writeCoverageResolved flags a changed group whose debt was overridden", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953, "excl"),
    // The PR changed `tasks` and accepted its regression with an override.
    coverageRow("coverage-debt: tasks uncovered lines", 15, 12, "ovrd"),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [{ filename: "tasks/foo.ts" }])
  );

  assertEquals(payload?.state, "resolved");
  assertEquals(payload?.overridden, true);
  // An override contributes no reduction, but the group still appears.
  assertEquals(payload?.improvedLines, 0);
  assertEquals(payload?.groups, [
    { group: "tasks", baseline: 12, current: 15 },
  ]);
});

Deno.test("writeCoverageResolved sums gated groups and ignores workspace and overrides", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 1000, 2000, "excl"),
    coverageRow("coverage-debt: memory uncovered lines", 1680, 1686), // -6
    coverageRow("coverage-debt: runner uncovered lines", 8860, 8868), // -8
    // An overridden group accepted its debt, so it does not count as a reduction.
    coverageRow("coverage-debt: identity uncovered lines", 50, 60, "ovrd"),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [])
  );

  assertEquals(payload?.state, "resolved");
  assertEquals(payload?.improvedLines, 14); // 6 + 8
  assertEquals(payload?.groups, []);
  // The overridden group is not one this PR changed, so it is not flagged.
  assertEquals(payload?.overridden, false);
});

Deno.test("writeCoverageResolved reports zero improvement when gated groups sit at baseline", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953, "excl"),
    coverageRow("coverage-debt: tasks uncovered lines", 4, 4),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [])
  );

  assertEquals(payload?.state, "resolved");
  assertEquals(payload?.improvedLines, 0);
  assertEquals(payload?.groups, []);
});

Deno.test("writeCoverageResolved reports zero improvement without a workspace baseline", async () => {
  const rows = [coverageRow("coverage-debt: workspace uncovered lines", 100)];
  const payload = await payloadFrom(() =>
    writeCoverageResolved(4211, rows, [])
  );

  assertEquals(payload?.state, "resolved");
  assertEquals(payload?.improvedLines, 0);
  assertEquals(payload?.groups, []);
});

Deno.test("writeCoverageDebtSuggestion writes nothing when no coverage group resolves", async () => {
  const failures: Row[] = [
    { metric: "job: Check", status: "OVER", current: 5, median: 3, n: 1 },
  ];
  const payload = await payloadFrom(() =>
    writeCoverageDebtSuggestion(4211, failures, [], "")
  );

  assertEquals(payload, null);
});

Deno.test("baseline workflow path fetches successful main push runs", () => {
  const path = workflowRunsPathForBaseline(20);
  const query = new URLSearchParams(path.split("?")[1]);

  assertStringIncludes(path, "/actions/workflows/deno.yml/runs?");
  assertEquals(query.get("branch"), "main");
  assertEquals(query.get("status"), "success");
  assertEquals(query.get("event"), "push");
  assertEquals(query.get("per_page"), "20");
  assertEquals(query.get("created"), null);
});

Deno.test("fetchMainHeadSha reads the main branch commit", async () => {
  const result = await withMockFetch(
    (input) => {
      assertStringIncludes(
        String(input),
        "/repos/commontoolsinc/labs/branches/main",
      );
      return new Response(JSON.stringify({ commit: { sha: SHA_A } }));
    },
    () => fetchMainHeadSha(),
  );

  assertEquals(result, SHA_A);
});

Deno.test("fetchLatestBaselineRunSha reads the newest baseline run's head", async () => {
  const result = await withMockFetch(
    (input) => {
      // The one-run baseline query against the workflow's successful main pushes.
      assertStringIncludes(String(input), "/actions/workflows/");
      assertStringIncludes(String(input), "per_page=1");
      return new Response(
        JSON.stringify({ workflow_runs: [{ head_sha: SHA_A }] }),
      );
    },
    () => fetchLatestBaselineRunSha(),
  );

  assertEquals(result, SHA_A);
});

Deno.test("fetchLatestBaselineRunSha is undefined when no baseline run exists", async () => {
  const result = await withMockFetch(
    () => new Response(JSON.stringify({ workflow_runs: [] })),
    () => fetchLatestBaselineRunSha(),
  );

  assertEquals(result, undefined);
});

Deno.test("fetchBaselineRunsForCheck fetches main head and baseline runs", async () => {
  const logs: string[] = [];
  const requests: string[] = [];
  const run = makeRun(101, SHA_A);
  const result = await withMockFetch(
    (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/branches/main")) {
        return new Response(JSON.stringify({ commit: { sha: SHA_A } }));
      }
      if (url.includes("/actions/workflows/deno.yml/runs?")) {
        return new Response(JSON.stringify({ workflow_runs: [run] }));
      }
      return new Response("unexpected request", { status: 404 });
    },
    () =>
      fetchBaselineRunsForCheck(new Map(), 1, (message) => logs.push(message)),
  );

  assertEquals(result, { mainHeadSha: SHA_A, baselineRuns: [run] });
  assertEquals(requests.length, 2);
  assertStringIncludes(requests[1], "branch=main");
  assertStringIncludes(requests[1], "status=success");
  assertStringIncludes(requests[1], "event=push");
  assertStringIncludes(requests[1], "per_page=1");
  assertStringIncludes(logs.join("\n"), "Current main head");
});

Deno.test("relative duration formatting uses two readable parts", () => {
  assertEquals(formatRelativeDuration(45), "45 seconds");
  assertEquals(formatRelativeDuration(65), "1 minute 5 seconds");
  assertEquals(
    formatRelativeDuration(2 * 60 * 60 + 3 * 60 + 4),
    "2 hours 3 minutes",
  );
  assertEquals(
    formatRelativeDuration(3 * 24 * 60 * 60 + 2 * 60 * 60),
    "3 days 2 hours",
  );
  assertEquals(formatRelativeDuration(Number.NaN), "unknown");
});

Deno.test("relative age formatting compares two timestamps", () => {
  assertEquals(
    formatRelativeAge(
      "2026-06-18T10:00:00Z",
      "2026-06-18T12:03:04Z",
    ),
    "2 hours 3 minutes",
  );
  assertEquals(
    formatRelativeAge("not a date", "2026-06-18T12:03:04Z"),
    "unknown",
  );
});

Deno.test("commit distance formatting handles known and unknown values", () => {
  assertEquals(formatCommitDistance(0), "0 commits");
  assertEquals(formatCommitDistance(1), "1 commit");
  assertEquals(formatCommitDistance(12), "12 commits");
  assertEquals(formatCommitDistance(null), "an unknown number of commits");
});

Deno.test("baseline source run age combines time and commit distance", () => {
  assertEquals(
    formatBaselineSourceRunAge(
      "2026-06-18T10:00:00Z",
      "2026-06-18T12:03:04Z",
      7,
    ),
    "created 2 hours 3 minutes ago; 7 commits behind current main",
  );
  assertEquals(
    formatBaselineSourceRunAge("not a date", "2026-06-18T12:03:04Z", null),
    "age unknown; an unknown number of commits behind current main",
  );
});

Deno.test("fetchCommitsBehindMain reports zero for the current main commit", async () => {
  assertEquals(await fetchCommitsBehindMain(SHA_A, SHA_A), 0);
});

Deno.test("fetchCommitsBehindMain reads GitHub compare distance", async () => {
  const result = await withMockFetch(
    (input) => {
      assertStringIncludes(String(input), `/compare/${SHA_A}...${SHA_B}`);
      return new Response(JSON.stringify({ ahead_by: 3 }));
    },
    () => fetchCommitsBehindMain(SHA_A, SHA_B),
  );

  assertEquals(result, 3);
});

Deno.test("fetchCommitsBehindMain treats malformed compare data as unknown", async () => {
  const result = await withMockFetch(
    () => new Response(JSON.stringify({ ahead_by: "3" })),
    () => fetchCommitsBehindMain(SHA_A, SHA_B),
  );

  assertEquals(result, null);
});

Deno.test("fetchCommitsBehindMain warns and continues after compare failure", async () => {
  const captured = await captureConsoleAsync(() =>
    withMockFetch(
      () => new Response("missing", { status: 404 }),
      () => fetchCommitsBehindMain(SHA_A, SHA_B),
    )
  );

  assertEquals(captured.result, null);
  assertStringIncludes(
    captured.warnings.join("\n"),
    "could not compare baseline",
  );
  assertStringIncludes(captured.warnings.join("\n"), SHA_A.slice(0, 8));
});

Deno.test("fetchPRForCommitWithError returns selected PR metadata", async () => {
  const pr = makePR(42, "2026-06-18T00:00:00Z");
  const result = await withMockFetch(
    (input) => {
      assertStringIncludes(String(input), `/commits/${SHA_A}/pulls`);
      return new Response(JSON.stringify([pr]));
    },
    () => fetchPRForCommitWithError(SHA_A),
  );

  assertEquals(result, { pr, error: null });
});

Deno.test("fetchPRForCommitWithError captures lookup errors", async () => {
  const result = await withMockFetch(
    () => new Response("missing", { status: 404 }),
    () => fetchPRForCommitWithError(SHA_A),
  );

  assertEquals(result.pr, null);
  assertStringIncludes(String(result.error), "GitHub API GET 404");
});

Deno.test("newestArtifactNamed filters expired artifacts and keeps newest id", () => {
  assertEquals(
    newestArtifactNamed(
      [
        makeArtifact(1, PERF_METRICS_ARTIFACT_NAME),
        makeArtifact(3, PERF_METRICS_ARTIFACT_NAME, true),
        makeArtifact(2, PERF_METRICS_ARTIFACT_NAME),
        makeArtifact(4, "other"),
      ],
      PERF_METRICS_ARTIFACT_NAME,
    )?.id,
    2,
  );
  assertEquals(newestArtifactNamed([], PERF_METRICS_ARTIFACT_NAME), null);
});

Deno.test("formatErrorForLog keeps the first line only", () => {
  assertEquals(formatErrorForLog(new Error("first\nsecond")), "first");
  assertEquals(formatErrorForLog("plain\nsecond"), "plain");
});

Deno.test("githubApiOrSkip writes metrics and exits on rate limits", async () => {
  const metrics = new Map<string, TimingSample>([["job: Check", makeSample()]]);

  try {
    const captured = await captureConsoleAsync(() =>
      withMockExit(() =>
        githubApiOrSkip(
          "collecting test data",
          () => Promise.reject(new Error("rate limit exceeded")),
          metrics,
        ).then(() => {})
      )
    );

    assertEquals(captured.result, 0);
    assertStringIncludes(captured.warnings.join("\n"), "rate limit");
    assertStringIncludes(captured.logs.join("\n"), "Wrote perf-metrics.json");
    const file = JSON.parse(await Deno.readTextFile("perf-metrics.json"));
    assertEquals(file.metrics[0].name, "job: Check");
  } finally {
    await Deno.remove("perf-metrics.json").catch(() => {});
  }
});

Deno.test("githubApiOrSkip rethrows non-rate-limit errors", async () => {
  await assertRejects(
    () =>
      githubApiOrSkip(
        "collecting test data",
        () => Promise.reject(new Error("plain failure")),
        new Map(),
      ),
    Error,
    "plain failure",
  );
});

Deno.test("metric table helpers format task and metric details", () => {
  const coverageRow = {
    metric: "coverage-debt: tasks uncovered lines",
    status: "OK" as const,
    current: 12.4,
    median: 10,
    variance: 0,
    stddev: 0,
    threshold: 10,
    n: 5,
    pctIncrease: 24,
  };
  const pendingRow = {
    metric: "job: Check",
    status: "n/a" as const,
    current: 9,
    n: 0,
  };

  assertEquals(
    formatMetricValueForTable(coverageRow.metric, coverageRow.current),
    "12",
  );
  assertEquals(formatMetricValueForTable("job: Check", undefined), "-");
  assertEquals(formatMetricDelta("job: Check", pendingRow), "-");
  assertEquals(
    formatMetricDelta(coverageRow.metric, coverageRow),
    "+2 (+24%)",
  );
  assertEquals(metricDisplayParts("test: runner > file.test.ts"), {
    task: "runner",
    metric: "file.test.ts",
  });
  assertEquals(metricDisplayParts("coverage-debt: tasks uncovered lines"), {
    task: "coverage-debt",
    metric: "tasks",
  });
  assertEquals(metricDisplayParts("coverage-debt: custom metric"), {
    task: "coverage-debt",
    metric: "custom metric",
  });
  assertEquals(metricDisplayParts("uncategorized"), {
    task: "other",
    metric: "uncategorized",
  });
  assertEquals(metricDisplayParts("job: Check"), {
    task: "job",
    metric: "Check",
  });
  assertEquals(metricTableRows([coverageRow], true)[0][0], "OK");
  assertEquals(metricTableRows([coverageRow], false)[0][0], "10");
});

Deno.test("printMetricTable renders status and non-status tables", () => {
  const row = {
    metric: "job: Check",
    status: "OK" as const,
    current: 9,
    median: 8,
    variance: 0,
    stddev: 0,
    threshold: 10,
    n: 5,
    pctIncrease: 12.5,
  };

  const withStatus = captureConsole(() => printMetricTable([row], true));
  assertStringIncludes(withStatus.logs.join("\n"), "Status");
  assertStringIncludes(withStatus.logs.join("\n"), "OK");

  const withoutStatus = captureConsole(() => printMetricTable([row], false));
  assertStringIncludes(withoutStatus.logs.join("\n"), "Baseline");
  assertEquals(withoutStatus.logs.join("\n").includes("Status"), false);
});

Deno.test("currentWorkflowRunFromEvent reads event and environment metadata", () => {
  const previousSha = Deno.env.get("GITHUB_SHA");
  const previousEventName = Deno.env.get("GITHUB_EVENT_NAME");
  try {
    Deno.env.set("GITHUB_SHA", SHA_B);
    Deno.env.set("GITHUB_EVENT_NAME", "push");
    assertEquals(
      currentWorkflowRunFromEvent(
        { pull_request: { head: { sha: SHA_A } } },
        7,
      ).head_sha,
      SHA_A,
    );
    const fallback = currentWorkflowRunFromEvent(undefined, 8);
    assertEquals(fallback.head_sha, SHA_B);
    assertEquals(fallback.event, "push");
    Deno.env.delete("GITHUB_EVENT_NAME");
    assertEquals(currentWorkflowRunFromEvent(undefined, 9).event, "");
  } finally {
    if (previousSha === undefined) Deno.env.delete("GITHUB_SHA");
    else Deno.env.set("GITHUB_SHA", previousSha);
    if (previousEventName === undefined) Deno.env.delete("GITHUB_EVENT_NAME");
    else Deno.env.set("GITHUB_EVENT_NAME", previousEventName);
  }
});

Deno.test("logBaselineSourceRuns prints age, PR, lookup, and artifact details", () => {
  const contexts: BaselineRunContext[] = [
    {
      run: makeRun(1, SHA_A, "2026-06-18T10:00:00Z"),
      artifacts: [
        makeArtifact(1, PERF_METRICS_ARTIFACT_NAME),
        makeArtifact(3, PERF_METRICS_ARTIFACT_NAME, true),
        makeArtifact(2, PERF_METRICS_ARTIFACT_NAME),
      ],
      pr: makePR(10, "2026-06-18T00:00:00Z"),
      prLookupError: null,
      commitsBehindMain: 0,
    },
    {
      run: makeRun(2, SHA_B, "2026-06-18T11:00:00Z"),
      artifacts: [],
      pr: null,
      prLookupError: new Error("lookup failed\nsecond line"),
      commitsBehindMain: null,
    },
    {
      run: makeRun(3, SHA_C, "2026-06-18T11:30:00Z"),
      artifacts: [],
      pr: null,
      prLookupError: null,
      commitsBehindMain: 5,
    },
  ];

  const captured = captureConsole(() =>
    logBaselineSourceRuns(contexts, "2026-06-18T12:00:00Z")
  );
  const output = captured.logs.join("\n");

  assertStringIncludes(output, "Baseline source runs:");
  assertStringIncludes(
    output,
    "created 2 hours ago; 0 commits behind current main",
  );
  assertStringIncludes(output, "PR #10");
  assertStringIncludes(output, "perf-metrics artifact 2");
  assertStringIncludes(output, "PR lookup failed");
  assertStringIncludes(
    output,
    "an unknown number of commits behind current main",
  );
  assertStringIncludes(output, "no PR found");
  assertStringIncludes(output, "no perf-metrics artifact");
});

Deno.test("reportPRLookupResults logs clean and failed lookup summaries", () => {
  const clean = captureConsole(() =>
    reportPRLookupResults([
      {
        run: makeRun(1),
        artifacts: [],
        pr: makePR(1),
        prLookupError: null,
        commitsBehindMain: 0,
      },
    ])
  );
  assertEquals(clean.result, 0);
  assertStringIncludes(clean.logs.join("\n"), "0 failed");

  const failed = captureConsole(() =>
    reportPRLookupResults([
      {
        run: makeRun(2, SHA_B),
        artifacts: [],
        pr: null,
        prLookupError: new Error("boom\nsecond line"),
        commitsBehindMain: null,
      },
    ])
  );
  assertEquals(failed.result, 1);
  assertStringIncludes(
    failed.warnings.join("\n"),
    "failed to fetch PR metadata",
  );
  assertStringIncludes(failed.warnings.join("\n"), "boom");
});

Deno.test("reportBaselineContextResults logs incomplete PR metadata warning", () => {
  const context: BaselineRunContext = {
    run: makeRun(1),
    artifacts: [],
    pr: null,
    prLookupError: new Error("lookup failed"),
    commitsBehindMain: null,
  };

  const captured = captureConsole(() =>
    reportBaselineContextResults([context], "2026-06-18T12:00:00Z")
  );

  assertEquals(captured.result, 1);
  assertStringIncludes(captured.warnings.join("\n"), "incomplete PR metadata");
});

Deno.test("baseline main validation reports stale newest run", () => {
  const result = validateBaselineRunsForMainHead(
    [
      {
        id: 1,
        head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        created_at: "2026-06-18T00:00:00Z",
      },
      {
        id: 2,
        head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        created_at: "2026-06-17T00:00:00Z",
      },
    ],
    "cccccccccccccccccccccccccccccccccccccccc",
  );

  assertEquals(result.ok, false);
  assertStringIncludes(result.issues.join("\n"), "current main");
  assertStringIncludes(
    result.issues.join("\n"),
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
});

Deno.test("baseline main validation reports invalid main head SHA", () => {
  const result = validateBaselineRunsForMainHead(
    [
      {
        id: 1,
        head_sha: SHA_A,
        created_at: "2026-06-18T00:00:00Z",
      },
    ],
    "not-a-sha",
  );

  assertEquals(result.ok, false);
  assertStringIncludes(result.issues.join("\n"), "invalid");
});

Deno.test("baseline main validation reports empty run data", () => {
  const result = validateBaselineRunsForMainHead(
    [],
    "cccccccccccccccccccccccccccccccccccccccc",
  );

  assertEquals(result.ok, false);
  assertStringIncludes(result.issues.join("\n"), "No successful main-branch");
});

Deno.test("baseline main validation accepts current main as newest run", () => {
  const result = validateBaselineRunsForMainHead(
    [
      {
        id: 1,
        head_sha: "cccccccccccccccccccccccccccccccccccccccc",
        created_at: "2026-06-18T00:00:00Z",
      },
      {
        id: 2,
        head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        created_at: "2026-06-17T00:00:00Z",
      },
    ],
    "cccccccccccccccccccccccccccccccccccccccc",
  );

  assertEquals(result, { ok: true, issues: [] });
});

Deno.test("reportBaselineRunAvailability warns for stale and sparse baselines", () => {
  const warnings: string[] = [];
  const result = reportBaselineRunAvailability(
    [makeRun(1, SHA_A)],
    SHA_B,
    5,
    (message) => warnings.push(message),
  );

  assertEquals(result.ok, false);
  assertStringIncludes(warnings.join("\n"), "current main head");
  assertStringIncludes(warnings.join("\n"), "only 1 baseline runs available");
});

Deno.test("fetchArtifactsForRunBestEffort returns artifacts or an empty fallback", async () => {
  const run = makeRun(99);
  const artifact = makeArtifact(1, PERF_METRICS_ARTIFACT_NAME);
  const warnings: string[] = [];

  assertEquals(
    await fetchArtifactsForRunBestEffort(run, (runId) => {
      assertEquals(runId, 99);
      return Promise.resolve([artifact]);
    }, (message) => warnings.push(message)),
    [artifact],
  );
  assertEquals(warnings, []);

  assertEquals(
    await fetchArtifactsForRunBestEffort(
      run,
      () => {
        throw new Error("artifact API failed");
      },
      (message) => warnings.push(message),
    ),
    [],
  );
  assertStringIncludes(warnings.join("\n"), "artifact API failed");
});

Deno.test("buildBaselineRunContexts collects artifacts, PRs, and commit distance", async () => {
  const run = makeRun(11, SHA_A);
  const artifact = makeArtifact(5, PERF_METRICS_ARTIFACT_NAME);
  const pr = makePR(11, "2026-06-18T00:00:00Z");

  const contexts = await buildBaselineRunContexts({
    baselineRuns: [run],
    mainHeadSha: SHA_B,
    concurrency: 1,
    fetchArtifactsForRun: (requestedRun) => {
      assertEquals(requestedRun, run);
      return Promise.resolve([artifact]);
    },
    fetchPRForCommit: (sha) => {
      assertEquals(sha, SHA_A);
      return Promise.resolve({ pr, error: null });
    },
    fetchCommitsBehindMain: (baselineSha, mainHeadSha) => {
      assertEquals(baselineSha, SHA_A);
      assertEquals(mainHeadSha, SHA_B);
      return Promise.resolve(4);
    },
  });

  assertEquals(contexts, [
    {
      run,
      artifacts: [artifact],
      pr,
      prLookupError: null,
      commitsBehindMain: 4,
    },
  ]);
});

Deno.test("buildExtraBackfillContexts creates context shells", async () => {
  const run = makeRun(12, SHA_B);
  const artifact = makeArtifact(6, PERF_METRICS_BACKFILL_ARTIFACT_NAME);

  const contexts = await buildExtraBackfillContexts(
    [run],
    (requestedRun) => {
      assertEquals(requestedRun, run);
      return Promise.resolve([artifact]);
    },
    1,
  );

  assertEquals(contexts, [
    {
      run,
      artifacts: [artifact],
      pr: null,
      prLookupError: null,
      commitsBehindMain: null,
    },
  ]);
});

Deno.test("parsePerfMetricBackfillFromArtifacts uses newest backfill artifact", async () => {
  const parsed = new Map<number, Map<string, TimingSample>>([[1, new Map()]]);
  let parsedArtifactId = 0;

  const result = await parsePerfMetricBackfillFromArtifacts(
    [
      makeArtifact(1, PERF_METRICS_BACKFILL_ARTIFACT_NAME),
      makeArtifact(3, PERF_METRICS_BACKFILL_ARTIFACT_NAME),
      makeArtifact(4, PERF_METRICS_BACKFILL_ARTIFACT_NAME, true),
    ],
    (artifactId) => {
      parsedArtifactId = artifactId;
      return Promise.resolve(parsed);
    },
  );

  assertEquals(result, parsed);
  assertEquals(parsedArtifactId, 3);
  assertEquals(
    await parsePerfMetricBackfillFromArtifacts([], () => {
      throw new Error("should not parse without an artifact");
    }),
    null,
  );
});

Deno.test("parsePerfMetricsFromArtifacts uses newest perf metrics artifact", async () => {
  const parsed = {
    metrics: new Map<string, TimingSample>([["job: Check", makeSample()]]),
    compileCacheStates: { "pattern-unit": "warm" as const },
  };
  let parsedArtifactId = 0;

  const result = await parsePerfMetricsFromArtifacts(
    [
      makeArtifact(1, PERF_METRICS_ARTIFACT_NAME),
      makeArtifact(3, PERF_METRICS_ARTIFACT_NAME),
      makeArtifact(4, PERF_METRICS_ARTIFACT_NAME, true),
    ],
    (artifactId) => {
      parsedArtifactId = artifactId;
      return Promise.resolve(parsed);
    },
  );

  assertEquals(result, parsed);
  assertEquals(parsedArtifactId, 3);
  assertEquals(
    await parsePerfMetricsFromArtifacts([], () => {
      throw new Error("should not parse without an artifact");
    }),
    null,
  );
});

Deno.test("addPerfMetricsFromArtifacts adds parsed samples to timelines", async () => {
  const artifacts = [makeArtifact(1, PERF_METRICS_ARTIFACT_NAME)];
  const sample = makeSample();
  const timelines = new Map();

  assertEquals(
    await addPerfMetricsFromArtifacts(timelines, artifacts, (requested) => {
      assertEquals(requested, artifacts);
      return Promise.resolve({
        metrics: new Map([["job: Check", sample]]),
        compileCacheStates: { "generated-patterns": "cold" as const },
      });
    }),
    { added: true, compileCacheStates: { "generated-patterns": "cold" } },
  );
  assertEquals(timelines.get("job: Check")?.samples, [sample]);

  // An untagged (pre-rollout) artifact still adds samples, with null states.
  assertEquals(
    await addPerfMetricsFromArtifacts(
      timelines,
      artifacts,
      () =>
        Promise.resolve({
          metrics: new Map([["job: Check", sample]]),
          compileCacheStates: null,
        }),
    ),
    { added: true, compileCacheStates: null },
  );

  assertEquals(
    await addPerfMetricsFromArtifacts(
      timelines,
      [],
      () => Promise.resolve(null),
    ),
    { added: false, compileCacheStates: null },
  );
});

function cacheStateJson(
  family: string,
  shard: string,
  matchedKey: string,
): string {
  return JSON.stringify({
    family,
    shard,
    matchedKey,
    exactHit: matchedKey !== "",
  });
}

Deno.test("collectCurrentCacheStates aggregates shard records per family", async () => {
  const contentsById: Record<number, string[]> = {
    1: [cacheStateJson("generated-patterns", "1", "")],
    2: [cacheStateJson("generated-patterns", "2", "compile-abc")],
    3: [cacheStateJson("pattern-integration", "1", "compile-abc")],
  };
  const downloaded: number[] = [];

  const states = await collectCurrentCacheStates(
    [
      makeArtifact(1, "cache-state-generated-patterns-1"),
      makeArtifact(2, "cache-state-generated-patterns-2"),
      makeArtifact(3, "cache-state-pattern-integration-1"),
      // Not cache-state artifacts, or expired — never downloaded.
      makeArtifact(4, "test-timing-pattern-unit-1"),
      makeArtifact(5, "cache-state-pattern-unit-1", true),
    ],
    (artifactId) => {
      downloaded.push(artifactId);
      return Promise.resolve(contentsById[artifactId] ?? []);
    },
  );

  // One full-miss shard makes generated-patterns cold; pattern-integration is
  // warm; pattern-unit has no usable records and stays unknown.
  assertEquals(states, {
    "generated-patterns": "cold",
    "pattern-integration": "warm",
  });
  assertEquals(downloaded.sort((a, b) => a - b), [1, 2, 3]);
});

Deno.test("collectCurrentCacheStates keeps only the newest re-run duplicate", async () => {
  const downloaded: number[] = [];

  const states = await collectCurrentCacheStates(
    [
      // A re-run uploads a same-named artifact; the newest one wins, and a
      // re-run is genuinely warm (the cold first attempt saved the cache).
      makeArtifact(1, "cache-state-pattern-unit-1"),
      makeArtifact(9, "cache-state-pattern-unit-1"),
    ],
    (artifactId) => {
      downloaded.push(artifactId);
      return Promise.resolve([
        cacheStateJson(
          "pattern-unit",
          "1",
          artifactId === 9 ? "compile-abc" : "",
        ),
      ]);
    },
  );

  assertEquals(states, { "pattern-unit": "warm" });
  assertEquals(downloaded, [9]);
});

Deno.test("collectCurrentCacheStates degrades to unknown on download failure", async () => {
  const captured = await captureConsoleAsync(() =>
    collectCurrentCacheStates(
      [
        makeArtifact(1, "cache-state-generated-patterns-1"),
        makeArtifact(2, "cache-state-pattern-integration-1"),
      ],
      (artifactId) =>
        Promise.resolve(
          artifactId === 1
            ? [cacheStateJson("generated-patterns", "1", "compile-abc")]
            : null,
        ),
    )
  );

  // Partial data could mislabel a family, so any failure drops everything.
  assertEquals(captured.result, {});
  assertStringIncludes(
    captured.warnings.join("\n"),
    "could not collect compile cache states",
  );
});

Deno.test("collectCurrentCacheStates degrades to unknown on a malformed record", async () => {
  const captured = await captureConsoleAsync(() =>
    collectCurrentCacheStates(
      [
        makeArtifact(1, "cache-state-generated-patterns-1"),
        makeArtifact(2, "cache-state-generated-patterns-2"),
      ],
      (artifactId) =>
        Promise.resolve(
          artifactId === 1
            ? [cacheStateJson("generated-patterns", "1", "compile-abc")]
            : ["not json {"],
        ),
    )
  );

  // The unreadable record could be the cold shard; the surviving warm record
  // must not tag the family warm, so everything degrades to unknown.
  assertEquals(captured.result, {});
  assertStringIncludes(
    captured.warnings.join("\n"),
    "could not collect compile cache states",
  );
});

Deno.test("formatCompileCacheStates shows every family, absent as unknown", () => {
  assertEquals(
    formatCompileCacheStates({ "generated-patterns": "cold" }),
    "generated-patterns=cold, pattern-integration=unknown, pattern-unit=unknown",
  );
});

const NO_OVERRIDES: BaselineOverrides = {
  metrics: new Map(),
  coverageBaselineReset: false,
};

function timingSampleAt(runId: number, durationSeconds: number): TimingSample {
  return {
    runId,
    runUrl: `https://github.com/commontoolsinc/labs/actions/runs/${runId}`,
    sha: SHA_A,
    createdAt: `2026-06-18T10:00:${String(runId).padStart(2, "0")}Z`,
    durationSeconds,
  };
}

function timingTimeline(name: string, samples: TimingSample[]): MetricTimeline {
  return { name, samples };
}

/** Runs 1-6 are warm at 10s; runs 7-8 are known-cold at 30s. */
const MIXED_COLD_SAMPLES = [
  ...[1, 2, 3, 4, 5, 6].map((runId) => timingSampleAt(runId, 10)),
  timingSampleAt(7, 30),
  timingSampleAt(8, 30),
];

function coldForRuns(
  coldRunIds: number[],
): (runId: number) => CompileCacheState | undefined {
  return (runId) => coldRunIds.includes(runId) ? "cold" : undefined;
}

Deno.test("evaluateTimingMetric reports a cold-family metric as COLD, never a failure", () => {
  const { row, failure } = evaluateTimingMetric({
    metric: "step: patterns integration",
    // Far over any threshold the warm baseline would allow.
    current: 25,
    timeline: timingTimeline(
      "step: patterns integration",
      [1, 2, 3, 4, 5].map((runId) => timingSampleAt(runId, 10)),
    ),
    prOverrides: NO_OVERRIDES,
    currentCacheStates: { "pattern-integration": "cold" },
    stateOfRunForFamily: () => () => undefined,
  });

  assertEquals(row.status, "COLD");
  assertEquals(failure, false);
  assertEquals(row.median, undefined);
  // A COLD row renders with a `-` baseline and no change column.
  assertEquals(metricTableRows([row], true)[0], [
    "COLD",
    "-",
    "25s",
    "-",
    "step",
    "patterns integration",
  ]);
});

Deno.test("evaluateTimingMetric reports COLD even without baseline samples", () => {
  const { row, failure } = evaluateTimingMetric({
    metric: "test: generated-patterns/foo.test.tsx",
    current: 12,
    timeline: undefined,
    prOverrides: NO_OVERRIDES,
    currentCacheStates: { "generated-patterns": "cold" },
    stateOfRunForFamily: () => () => undefined,
  });

  assertEquals(row.status, "COLD");
  assertEquals(failure, false);
});

Deno.test("evaluateTimingMetric keeps excl precedence over COLD", () => {
  const { row, failure } = evaluateTimingMetric({
    metric: "step: pattern unit tests",
    current: 100,
    timeline: undefined,
    prOverrides: NO_OVERRIDES,
    currentCacheStates: { "pattern-unit": "cold" },
    stateOfRunForFamily: () => () => undefined,
  });

  assertEquals(row.status, "excl");
  assertEquals(failure, false);
});

Deno.test("evaluateTimingMetric excludes known-cold baseline samples for a warm run", () => {
  const { row, failure } = evaluateTimingMetric({
    metric: "step: patterns integration",
    current: 20,
    timeline: timingTimeline("step: patterns integration", MIXED_COLD_SAMPLES),
    prOverrides: NO_OVERRIDES,
    currentCacheStates: { "pattern-integration": "warm" },
    stateOfRunForFamily: () => coldForRuns([7, 8]),
  });

  // Against the six warm 10s samples the threshold is 15s, so 20s fails.
  // With the two cold 30s samples included, the inflated stddev would have
  // pushed the threshold past 35s and hidden the regression.
  assertEquals(row.status, "OVER");
  assertEquals(failure, true);
  assertEquals(row.median, 10);
  assertEquals(row.n, 6);
});

Deno.test("evaluateTimingMetric falls back to n/a when too few warm samples remain", () => {
  const { row, failure } = evaluateTimingMetric({
    metric: "step: patterns integration",
    current: 20,
    timeline: timingTimeline("step: patterns integration", MIXED_COLD_SAMPLES),
    prOverrides: NO_OVERRIDES,
    currentCacheStates: {},
    stateOfRunForFamily: () => coldForRuns([3, 4, 5, 6, 7, 8]),
  });

  assertEquals(row.status, "n/a");
  assertEquals(failure, false);
  assertEquals(row.n, 2);
});

Deno.test("evaluateTimingMetric with all-unknown states matches pre-rollout behavior", () => {
  const unknownEverywhere = {
    metric: "step: patterns integration",
    current: 20,
    timeline: timingTimeline("step: patterns integration", MIXED_COLD_SAMPLES),
    prOverrides: NO_OVERRIDES,
    currentCacheStates: {},
    stateOfRunForFamily: () => () => undefined,
  };
  const { row, failure } = evaluateTimingMetric(unknownEverywhere);

  // All eight samples gate as before tagging: median 10s, stddev ~8.66s,
  // threshold ~36s, so 20s stays OK.
  assertEquals(row.status, "OK");
  assertEquals(failure, false);
  assertEquals(row.median, 10);
  assertEquals(row.n, 8);

  // A metric with no compile cache family ignores cache states entirely.
  const noFamily = evaluateTimingMetric({
    ...unknownEverywhere,
    metric: "step: runner tests",
    timeline: timingTimeline("step: runner tests", MIXED_COLD_SAMPLES),
    currentCacheStates: {
      "generated-patterns": "cold",
      "pattern-integration": "cold",
      "pattern-unit": "cold",
    },
    stateOfRunForFamily: () => coldForRuns([7, 8]),
  });
  assertEquals(noFamily.row.status, "OK");
  assertEquals(noFamily.row.n, 8);
});

Deno.test("main runs informational check with mocked latest baseline data", async () => {
  const eventPath = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(eventPath, JSON.stringify({ after: SHA_C }));

  const currentRunId = 123;
  const baselineRuns = [
    makeRun(201, SHA_A, "2026-06-18T10:00:00Z"),
    makeRun(202, SHA_B, "2026-06-18T09:00:00Z"),
    makeRun(203, SHA_C, "2026-06-18T08:00:00Z"),
    makeRun(
      204,
      "dddddddddddddddddddddddddddddddddddddddd",
      "2026-06-18T07:00:00Z",
    ),
    makeRun(
      205,
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "2026-06-18T06:00:00Z",
    ),
  ];
  const jobsForRun = (runId: number) => ({
    jobs: [
      {
        id: runId * 10,
        name: "Check",
        started_at: "2026-06-18T12:00:00Z",
        completed_at: "2026-06-18T12:00:10Z",
        steps: [
          {
            name: "Run checks",
            started_at: "2026-06-18T12:00:01Z",
            completed_at: "2026-06-18T12:00:09Z",
          },
        ],
      },
    ],
  });

  try {
    const captured = await captureConsoleAsync(() =>
      withEnv(
        {
          GITHUB_TOKEN: "test-token",
          GITHUB_RUN_ID: String(currentRunId),
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: "workflow_run",
          GITHUB_SHA: SHA_C,
          PR_NUMBER: "",
        },
        () =>
          withMockFetch(
            (input) => {
              const url = String(input);
              if (url.endsWith("/branches/main")) {
                return jsonResponse({ commit: { sha: SHA_A } });
              }
              if (url.includes("/actions/workflows/deno.yml/runs?")) {
                return jsonResponse({ workflow_runs: baselineRuns });
              }
              if (url.includes(`/actions/runs/${currentRunId}/jobs`)) {
                return jsonResponse(jobsForRun(currentRunId));
              }
              const baselineRun = baselineRuns.find((run) =>
                url.includes(`/actions/runs/${run.id}/jobs`)
              );
              if (baselineRun) return jsonResponse(jobsForRun(baselineRun.id));
              if (url.includes("/artifacts?")) {
                return jsonResponse({ total_count: 0, artifacts: [] });
              }
              if (url.includes("/commits/") && url.endsWith("/pulls")) {
                return jsonResponse([]);
              }
              if (url.includes("/compare/")) {
                return jsonResponse({ ahead_by: 1 });
              }
              return new Response(`unexpected request: ${url}`, {
                status: 404,
              });
            },
            () => withMockExit(() => main()),
          ),
      )
    );
    const output = captured.logs.join("\n");

    assertEquals(captured.result, 0);
    assertStringIncludes(output, "Current main head is");
    assertStringIncludes(
      output,
      "Compile cache states: generated-patterns=unknown, pattern-integration=unknown, pattern-unit=unknown",
    );
    assertStringIncludes(output, "Using 5 main-branch runs as baseline.");
    assertStringIncludes(output, "Baseline source runs:");
    assertStringIncludes(output, "All metrics within normal range.");
  } finally {
    await Deno.remove(eventPath).catch(() => {});
    await Deno.remove("perf-metrics.json").catch(() => {});
    await Deno.remove("perf-metrics-backfill.json").catch(() => {});
  }
});

Deno.test("selectMergedPRForCommit prefers the merged PR", () => {
  const prs = [
    { number: 1, merged_at: null },
    { number: 2, merged_at: "2026-06-18T00:00:00Z" },
  ] as unknown as PRInfo[];

  assertEquals(selectMergedPRForCommit(prs)?.number, 2);
});

Deno.test("selectMergedPRForCommit falls back to the first PR", () => {
  const prs = [
    { number: 1, merged_at: null },
    { number: 2, merged_at: null },
  ] as unknown as PRInfo[];

  assertEquals(selectMergedPRForCommit(prs)?.number, 1);
  assertEquals(selectMergedPRForCommit([]), null);
});

Deno.test("baseline PR lookup summary counts found, missing, and failed lookups", () => {
  const pr = { number: 1, merged_at: "2026-06-18T00:00:00Z" } as PRInfo;

  assertEquals(
    summarizeBaselinePRLookups([
      { pr, prLookupError: null },
      { pr: null, prLookupError: null },
      { pr: null, prLookupError: new Error("boom") },
    ]),
    { found: 1, noPR: 1, failed: 1 },
  );
});
