import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import * as path from "@std/path";
import {
  type Artifact,
  COVERAGE_SUGGESTION_MARKER,
  type CoverageCommentPayload,
  PERF_METRICS_ARTIFACT_NAME,
  type PRInfo,
  type TimingSample,
  type WorkflowRun,
} from "./ci-check-lib.ts";
import {
  addCoverageBaselineFromArtifacts,
  type BaselineRunContext,
  buildBaselineRunContexts,
  buildCoverageRows,
  collectCurrentCacheStates,
  copyCoverageArtifactFiles,
  currentWorkflowRunFromEvent,
  fetchAncestorRanks,
  fetchArtifactsForRunBestEffort,
  fetchBaselineRunsForCheck,
  fetchCommitsBehindMain,
  fetchGroupsChangedOnBase,
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
  isComparableBaseline,
  logBaselineSourceRuns,
  main,
  metricDisplayParts,
  metricTableRows,
  nearestUsableBaseline,
  newestArtifactNamed,
  parseCoverageBaselineFromArtifacts,
  parseMergedBaselineOverrides,
  printMetricTable,
  readBaseBranchSha,
  readHeadCommitObject,
  reportBaselineContextResults,
  reportBaselineDistance,
  reportBaselineRunAvailability,
  reportPRLookupResults,
  reportUngatedGroups,
  resolveMetricBaselines,
  type Row,
  selectBaselines,
  selectMergedPRForCommit,
  summarizeBaselinePRLookups,
  validateBaselineRunsForMainHead,
  workflowRunsPathForBaseline,
  writeCoverageComment,
  writeCoverageDebtSuggestion,
  writeCoverageResolved,
} from "./coverage-check.ts";

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

Deno.test("copyCoverageArtifactFiles reads a pre-downloaded artifact in place", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-coverage-artifact-" });
  const artifact = makeArtifact(17, "coverage-profile-workspace-1");
  const artifactsDir = path.join(root, "artifacts");
  const sourceDir = path.join(artifactsDir, artifact.name);
  const nestedSourceDir = path.join(sourceDir, "pattern-runtime");
  const profileDir = path.join(root, "profiles");
  const lcovDir = path.join(root, "lcov");

  try {
    await Promise.all([
      Deno.mkdir(nestedSourceDir, { recursive: true }),
      Deno.mkdir(profileDir),
      Deno.mkdir(lcovDir),
    ]);
    await Promise.all([
      Deno.writeTextFile(path.join(sourceDir, "runtime.lcov"), "runtime"),
      Deno.writeTextFile(
        path.join(nestedSourceDir, "pattern.pattern-coverage.lcov"),
        "pattern",
      ),
      Deno.writeTextFile(path.join(sourceDir, "profile.json"), "profile"),
      Deno.writeTextFile(path.join(sourceDir, "ignored.txt"), "ignored"),
    ]);

    assertEquals(
      await copyCoverageArtifactFiles(
        artifact,
        profileDir,
        lcovDir,
        artifactsDir,
      ),
      { profileFiles: 1, lcovFiles: 2 },
    );

    const copiedLcov: string[] = [];
    for await (const entry of Deno.readDir(lcovDir)) {
      copiedLcov.push(await Deno.readTextFile(path.join(lcovDir, entry.name)));
    }
    assertEquals(copiedLcov.sort(), ["pattern", "runtime"]);
    assertEquals(
      await Deno.readTextFile(path.join(profileDir, "17-0-profile.json")),
      "profile",
    );
    assert((await Deno.stat(sourceDir)).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("copyCoverageArtifactFiles rejects a missing pre-downloaded artifact", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-coverage-missing-" });
  const profileDir = path.join(root, "profiles");
  const lcovDir = path.join(root, "lcov");
  await Promise.all([Deno.mkdir(profileDir), Deno.mkdir(lcovDir)]);

  try {
    await assertRejects(
      () =>
        copyCoverageArtifactFiles(
          makeArtifact(18, "coverage-profile-workspace-2"),
          profileDir,
          lcovDir,
          path.join(root, "artifacts"),
        ),
      Error,
      "Pre-downloaded coverage profile artifact coverage-profile-workspace-2 (18) was not found",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("copyCoverageArtifactFiles rejects an empty pre-downloaded artifact", async () => {
  const root = await Deno.makeTempDir({ prefix: "perf-coverage-empty-" });
  const artifact = makeArtifact(19, "coverage-profile-workspace-3");
  const artifactsDir = path.join(root, "artifacts");
  const sourceDir = path.join(artifactsDir, artifact.name);
  const profileDir = path.join(root, "profiles");
  const lcovDir = path.join(root, "lcov");
  await Promise.all([
    Deno.mkdir(sourceDir, { recursive: true }),
    Deno.mkdir(profileDir),
    Deno.mkdir(lcovDir),
  ]);

  try {
    await assertRejects(
      () =>
        copyCoverageArtifactFiles(
          artifact,
          profileDir,
          lcovDir,
          artifactsDir,
        ),
      Error,
      "contained no profile or LCOV files",
    );
    assert((await Deno.stat(sourceDir)).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("coverage check pre-downloads coverage with strict integrity checks", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/deno.yml", import.meta.url),
  );
  const start = workflow.indexOf("  coverage-check:\n");
  const end = workflow.indexOf("\n  attest-binaries:", start);
  assert(start >= 0 && end > start, "Coverage Check job not found");

  const job = workflow.slice(start, end);
  const downloadStart = job.indexOf("- name: 📥 Download coverage reports");
  const checkStart = job.indexOf("- name: 📊 Run coverage check");
  assert(
    downloadStart >= 0 && checkStart > downloadStart,
    "coverage reports must be downloaded before Coverage Check runs",
  );

  const downloadStep = job.slice(downloadStart, checkStart);
  assertStringIncludes(downloadStep, "uses: actions/download-artifact@v8");
  assertStringIncludes(downloadStep, "pattern: coverage-profile-*");
  assertStringIncludes(downloadStep, "path: coverage-artifacts");
  assertStringIncludes(downloadStep, "merge-multiple: false");
  assertStringIncludes(downloadStep, "skip-decompress: false");
  assertStringIncludes(downloadStep, "digest-mismatch: error");
  assertEquals(downloadStep.includes("continue-on-error"), false);
  assertStringIncludes(
    job.slice(checkStart),
    "COVERAGE_ARTIFACTS_DIR: coverage-artifacts",
  );
});

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
      // "job: Check" is not a coverage-debt metric, so accepting it throws.
      body: "ACCEPT_COVERAGE_DEBT: job: Check = 7 lines",
    },
    (message) => warnings.push(message),
  );

  assertEquals(overrides, null);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "merged PR #123");
  assertStringIncludes(
    warnings[0],
    "only coverage-debt metrics can be accepted",
  );
});

Deno.test("valid merged PR baseline override metadata is parsed", () => {
  const overrides = parseMergedBaselineOverrides({
    number: 124,
    body:
      "ACCEPT_COVERAGE_DEBT: coverage-debt: packages/runner uncovered lines = 7 lines",
  });

  assertEquals(
    overrides?.metrics.get("coverage-debt: packages/runner uncovered lines"),
    7,
  );
});

Deno.test("merged PR legacy coverage-debt acceptance is honored", () => {
  // A baseline PR merged before the marker rename accepted debt with
  // NEW_PERF_BASELINE; its acceptance must still register so it truncates the
  // baseline timeline.
  const overrides = parseMergedBaselineOverrides({
    number: 125,
    body:
      "NEW_PERF_BASELINE: coverage-debt: packages/runner uncovered lines = 7 lines",
  });

  assertEquals(
    overrides?.metrics.get("coverage-debt: packages/runner uncovered lines"),
    7,
  );
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
  const dir = await Deno.makeTempDir({ prefix: "coverage-check-comment-" });
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
    assertStringIncludes(
      captured.logs.join("\n"),
      "Wrote perf-metrics.json",
    );
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
    n: 5,
    pctIncrease: 24,
  };
  const pendingRow = {
    metric: "job: Check",
    status: "n/a" as const,
    current: 9,
    n: 0,
  };

  assertEquals(formatMetricValueForTable(coverageRow.current), "12");
  assertEquals(formatMetricValueForTable(undefined), "-");
  assertEquals(formatMetricDelta(pendingRow), "-");
  assertEquals(formatMetricDelta(coverageRow), "+2 (+24%)");
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

Deno.test("reportBaselineRunAvailability warns when newest run is not current main head", () => {
  const warnings: string[] = [];
  const result = reportBaselineRunAvailability(
    [makeRun(1, SHA_A)],
    SHA_B,
    (message) => warnings.push(message),
  );

  assertEquals(result.ok, false);
  assertStringIncludes(warnings.join("\n"), "current main head");
});

Deno.test("reportBaselineRunAvailability warns when no baseline runs exist", () => {
  const warnings: string[] = [];
  const result = reportBaselineRunAvailability(
    [],
    SHA_B,
    (message) => warnings.push(message),
  );

  assertEquals(result.ok, false);
  assertStringIncludes(
    warnings.join("\n"),
    "no baseline runs available; coverage debt will bootstrap from this run.",
  );
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

Deno.test("parseCoverageBaselineFromArtifacts uses newest coverage baseline artifact", async () => {
  const parsed = {
    metrics: new Map<string, TimingSample>([["job: Check", makeSample()]]),
    compileCacheStates: { "pattern-unit": "warm" as const },
  };
  let parsedArtifactId = 0;

  const result = await parseCoverageBaselineFromArtifacts(
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
    await parseCoverageBaselineFromArtifacts([], () => {
      throw new Error("should not parse without an artifact");
    }),
    null,
  );
});

Deno.test("addCoverageBaselineFromArtifacts adds parsed samples to timelines", async () => {
  const artifacts = [makeArtifact(1, PERF_METRICS_ARTIFACT_NAME)];
  const sample = makeSample();
  const timelines = new Map();

  assertEquals(
    await addCoverageBaselineFromArtifacts(
      timelines,
      artifacts,
      (requested) => {
        assertEquals(requested, artifacts);
        return Promise.resolve({
          metrics: new Map([["job: Check", sample]]),
          compileCacheStates: { "generated-patterns": "cold" as const },
        });
      },
    ),
    { added: true, compileCacheStates: { "generated-patterns": "cold" } },
  );
  assertEquals(timelines.get("job: Check")?.samples, [sample]);

  // An untagged (pre-rollout) artifact still adds samples, with null states.
  assertEquals(
    await addCoverageBaselineFromArtifacts(
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
    await addCoverageBaselineFromArtifacts(
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

Deno.test("main reports no coverage data and exits cleanly without coverage artifacts", async () => {
  const eventPath = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(eventPath, JSON.stringify({ after: SHA_C }));

  const currentRunId = 123;
  // The newest main-push run seeds the compile-fingerprint fallback; its head
  // differs from this run's SHA, so the classifier compares them.
  const latestBaselineRun = makeRun(201, SHA_A, "2026-06-18T10:00:00Z");
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
              if (url.includes("/actions/workflows/deno.yml/runs?")) {
                return jsonResponse({ workflow_runs: [latestBaselineRun] });
              }
              if (url.includes(`/actions/runs/${currentRunId}/jobs`)) {
                return jsonResponse(jobsForRun(currentRunId));
              }
              // No coverage-profile artifacts were uploaded for this run.
              if (url.includes("/artifacts?")) {
                return jsonResponse({ total_count: 0, artifacts: [] });
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

    // With no coverage-profile artifacts, extraction fails and the run has no
    // coverage metrics to gate, so the informational run exits cleanly.
    assertEquals(captured.result, 0);
    assertStringIncludes(
      output,
      "Compile cache states: generated-patterns=unknown, pattern-integration=unknown, pattern-unit=unknown",
    );
    assertStringIncludes(
      captured.errors.join("\n"),
      "could not extract coverage debt metrics for current run",
    );
    assertStringIncludes(
      output,
      "No coverage metrics extracted from current run. Nothing to check.",
    );
  } finally {
    await Deno.remove(eventPath).catch(() => {});
    await Deno.remove("perf-metrics.json").catch(() => {});
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

Deno.test("readBaseBranchSha reads the first parent of a merge checkout", async () => {
  const commit = [
    "tree 1111111111111111111111111111111111111111",
    `parent ${SHA_A}`,
    `parent ${SHA_B}`,
    "author CI <ci@example.com> 1780000000 +0000",
    "",
    `parent ${SHA_C} looks like a header but is message text`,
  ].join("\n");

  assertEquals(await readBaseBranchSha(() => Promise.resolve(commit)), SHA_A);
});

Deno.test("readBaseBranchSha reports no base for a non-merge checkout", async () => {
  const commit = [
    "tree 1111111111111111111111111111111111111111",
    `parent ${SHA_A}`,
    "",
    "a push run checks out the commit itself",
  ].join("\n");

  assertEquals(await readBaseBranchSha(() => Promise.resolve(commit)), null);
  assertEquals(await readBaseBranchSha(() => Promise.resolve(null)), null);
});

function makeBaselineSample(
  runId: number,
  sha: string,
  createdAt: string,
  uncoveredLines: number,
): TimingSample {
  return {
    runId,
    runUrl: `https://github.com/commontoolsinc/labs/actions/runs/${runId}`,
    sha,
    createdAt,
    durationSeconds: uncoveredLines,
  };
}

const NEVER_COLD = () => false;

/** Ancestry of base-branch commit `SHA_C`, newest first. */
const RANKS = new Map([[SHA_C, 0], [SHA_B, 1], [SHA_A, 2]]);

Deno.test("nearestUsableBaseline prefers the base-branch commit's own run", () => {
  const samples = [
    makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740),
    makeBaselineSample(2, SHA_B, "2026-08-04T10:20:00Z", 5746),
    makeBaselineSample(3, SHA_C, "2026-08-04T10:40:00Z", 5760),
  ];

  assertEquals(
    nearestUsableBaseline(samples, NEVER_COLD, RANKS)?.durationSeconds,
    5760,
  );
});

Deno.test("nearestUsableBaseline falls back to the nearest ancestor with a run", () => {
  // Nothing has measured SHA_C, the base-branch commit, so its parent stands
  // in rather than the gate giving up.
  const samples = [
    makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740),
    makeBaselineSample(2, SHA_B, "2026-08-04T10:20:00Z", 5746),
  ];

  assertEquals(
    nearestUsableBaseline(samples, NEVER_COLD, RANKS)?.durationSeconds,
    5746,
  );
});

Deno.test("nearestUsableBaseline ignores a run that is not an ancestor", () => {
  const sibling = "dddddddddddddddddddddddddddddddddddddddd";
  const samples = [
    makeBaselineSample(1, SHA_B, "2026-08-04T10:20:00Z", 5746),
    // Landed after this run started, so it measured code the run lacks.
    makeBaselineSample(2, sibling, "2026-08-04T10:50:00Z", 5700),
  ];

  assertEquals(
    nearestUsableBaseline(samples, NEVER_COLD, RANKS)?.durationSeconds,
    5746,
  );
});

Deno.test("nearestUsableBaseline skips a cold ancestor for a warm one", () => {
  const samples = [
    makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740),
    makeBaselineSample(2, SHA_B, "2026-08-04T10:20:00Z", 5600),
  ];

  assertEquals(
    nearestUsableBaseline(samples, (runId) => runId === 2, RANKS)
      ?.durationSeconds,
    5740,
  );
});

Deno.test("nearestUsableBaseline takes a cold ancestor when every ancestor is cold", () => {
  const samples = [makeBaselineSample(2, SHA_B, "2026-08-04T10:20:00Z", 5600)];

  assertEquals(
    nearestUsableBaseline(samples, () => true, RANKS)?.durationSeconds,
    5600,
  );
});

Deno.test("nearestUsableBaseline falls back to the latest run without ancestry", () => {
  const samples = [
    makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740),
    makeBaselineSample(2, SHA_B, "2026-08-04T10:20:00Z", 5746),
  ];

  assertEquals(
    nearestUsableBaseline(samples, NEVER_COLD, null)?.durationSeconds,
    5746,
  );
  assertEquals(nearestUsableBaseline([], NEVER_COLD, RANKS), undefined);
});

Deno.test("fetchAncestorRanks ranks commits by distance from the base", async () => {
  const ranks = await withMockFetch(
    (input) => {
      assertStringIncludes(String(input), `/commits?sha=${SHA_C}`);
      return new Response(
        JSON.stringify([{ sha: SHA_C }, { sha: SHA_B }, { sha: SHA_A }]),
      );
    },
    () => fetchAncestorRanks(SHA_C),
  );

  assertEquals([...ranks], [[SHA_C, 0], [SHA_B, 1], [SHA_A, 2]]);
});

Deno.test("fetchGroupsChangedOnBase reports the groups the base branch moved", async () => {
  const groups = await withMockFetch(
    (input) => {
      assertStringIncludes(String(input), `/compare/${SHA_A}...${SHA_C}`);
      return new Response(JSON.stringify({
        files: [
          { filename: "packages/runner/src/runner.ts" },
          { filename: "packages/runner/test/runner.test.ts" },
          { filename: "docs/development/COVERAGE.md" },
        ],
      }));
    },
    () => fetchGroupsChangedOnBase(SHA_A, SHA_C),
  );

  assertEquals([...groups], ["packages/runner"]);
});

Deno.test("fetchGroupsChangedOnBase compares nothing against the base itself", async () => {
  const groups = await withMockFetch(
    () => {
      throw new Error("must not compare a commit against itself");
    },
    () => fetchGroupsChangedOnBase(SHA_C, SHA_C),
  );

  assertEquals(groups.size, 0);
});

const RUNNER_METRIC = "coverage-debt: packages/runner uncovered lines";
const MEMORY_METRIC = "coverage-debt: packages/memory uncovered lines";

Deno.test("isComparableBaseline withholds only the groups the base branch moved", () => {
  const sample = makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740);
  const moved = new Map([[SHA_A, new Set(["packages/runner"])]]);
  const at = (metric: string, sha: string | null = SHA_C) =>
    isComparableBaseline({
      sample,
      metric,
      baseSha: sha,
      groupsChangedByBaseline: moved,
      isPullRequest: true,
    });

  assertEquals(at(RUNNER_METRIC), false);
  assertEquals(at(MEMORY_METRIC), true);

  // No base-branch commit means no ancestry, so the baseline is whatever ran
  // last and nothing may be gated against it.
  assertEquals(at(MEMORY_METRIC, null), false);

  assertEquals(
    isComparableBaseline({
      sample: undefined,
      metric: MEMORY_METRIC,
      baseSha: SHA_C,
      groupsChangedByBaseline: moved,
      isPullRequest: true,
    }),
    false,
  );

  // A main push run has no base-branch commit and only reports.
  assertEquals(
    isComparableBaseline({
      sample,
      metric: RUNNER_METRIC,
      baseSha: null,
      groupsChangedByBaseline: moved,
      isPullRequest: false,
    }),
    true,
  );
});

Deno.test("isComparableBaseline reads the moved groups of its own baseline", () => {
  const atBase = makeBaselineSample(2, SHA_C, "2026-08-04T10:40:00Z", 5746);
  const older = makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740);
  // The base branch moved packages/runner since SHA_A but not since SHA_C, so
  // a metric baselined at SHA_C stays gated.
  const moved = new Map([
    [SHA_A, new Set(["packages/runner"])],
    [SHA_C, new Set<string>()],
  ]);
  const at = (sample: TimingSample) =>
    isComparableBaseline({
      sample,
      metric: RUNNER_METRIC,
      baseSha: SHA_C,
      groupsChangedByBaseline: moved,
      isPullRequest: true,
    });

  assertEquals(at(atBase), true);
  assertEquals(at(older), false);
});

Deno.test("resolveMetricBaselines picks a baseline and its gating for each metric", () => {
  const timelines = new Map([
    [RUNNER_METRIC, {
      name: RUNNER_METRIC,
      samples: [
        makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740),
        makeBaselineSample(3, SHA_C, "2026-08-04T10:40:00Z", 5746),
      ],
    }],
    // Only an older run measured this metric, and the base branch moved its
    // group since, so it is reported and not gated.
    [MEMORY_METRIC, {
      name: MEMORY_METRIC,
      samples: [makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 400)],
    }],
  ]);

  const resolved = resolveMetricBaselines({
    metrics: [
      RUNNER_METRIC,
      MEMORY_METRIC,
      "coverage-debt: gone uncovered lines",
    ],
    timelines,
    isRunCold: NEVER_COLD,
    ancestorRank: RANKS,
    groupsChangedByBaseline: new Map([
      [SHA_A, new Set(["packages/memory"])],
      [SHA_C, new Set<string>()],
    ]),
    baseSha: SHA_C,
    isPullRequest: true,
  });

  assertEquals(resolved.get(RUNNER_METRIC)?.sample?.durationSeconds, 5746);
  assertEquals(resolved.get(RUNNER_METRIC)?.comparable, true);
  assertEquals(resolved.get(MEMORY_METRIC)?.sample?.durationSeconds, 400);
  assertEquals(resolved.get(MEMORY_METRIC)?.comparable, false);

  // A metric with no timeline at all has nothing to be gated against.
  const missing = resolved.get("coverage-debt: gone uncovered lines");
  assertEquals(missing?.sample, undefined);
  assertEquals(missing?.comparable, false);
});

Deno.test("reportBaselineDistance names each baseline and its distance", () => {
  const captured = captureConsole(() =>
    reportBaselineDistance(
      new Set([SHA_C, SHA_A]),
      SHA_C,
      RANKS,
      (message) => console.log(message),
    )
  );

  const logs = captured.logs.join("\n");
  assertStringIncludes(
    logs,
    `measured at the base-branch commit: ${SHA_C.slice(0, 8)}`,
  );
  assertStringIncludes(
    logs,
    `measured 2 commits before the base-branch commit: ${SHA_A.slice(0, 8)}`,
  );
});

Deno.test("reportBaselineDistance reports an ancestry it could not read", () => {
  const unknown = captureConsole(() =>
    reportBaselineDistance(new Set([SHA_A]), SHA_C, null, (m) => console.log(m))
  );
  assertStringIncludes(
    unknown.logs.join("\n"),
    "at an unknown distance from the base-branch commit",
  );

  const none = captureConsole(() =>
    reportBaselineDistance(new Set(), SHA_C, RANKS, (m) => console.log(m))
  );
  assertStringIncludes(
    none.logs.join("\n"),
    `No \`main\` run has measured base-branch commit ${SHA_C.slice(0, 8)}`,
  );
});

function timelineOf(metric: string, samples: TimingSample[]) {
  return { name: metric, samples };
}

Deno.test("selectBaselines chooses each metric's baseline against the base commit", async () => {
  const timelines = new Map([
    [
      RUNNER_METRIC,
      timelineOf(RUNNER_METRIC, [
        makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740),
        makeBaselineSample(3, SHA_C, "2026-08-04T10:40:00Z", 5746),
      ]),
    ],
  ]);
  const compared: string[] = [];

  const captured = await captureConsoleAsync(() =>
    selectBaselines({
      metrics: [RUNNER_METRIC],
      timelines,
      isRunCold: NEVER_COLD,
      isPullRequest: true,
      readBaseSha: () => Promise.resolve(SHA_C),
      fetchRanks: (baseSha) => {
        assertEquals(baseSha, SHA_C);
        return Promise.resolve(RANKS);
      },
      fetchChangedGroups: (baselineSha, baseSha) => {
        compared.push(`${baselineSha}...${baseSha}`);
        return Promise.resolve(new Set<string>());
      },
    })
  );

  assertEquals(
    captured.result.get(RUNNER_METRIC)?.sample?.durationSeconds,
    5746,
  );
  assertEquals(captured.result.get(RUNNER_METRIC)?.comparable, true);
  // Only the baseline actually chosen is compared against the base commit.
  assertEquals(compared, [`${SHA_C}...${SHA_C}`]);
  assertStringIncludes(
    captured.logs.join("\n"),
    `merges the pull request into base-branch commit ${SHA_C.slice(0, 8)}`,
  );
});

Deno.test("selectBaselines gates nothing when the base commit cannot be read", async () => {
  const timelines = new Map([
    [
      RUNNER_METRIC,
      timelineOf(RUNNER_METRIC, [
        makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740),
      ]),
    ],
  ]);

  const captured = await captureConsoleAsync(() =>
    selectBaselines({
      metrics: [RUNNER_METRIC],
      timelines,
      isRunCold: NEVER_COLD,
      isPullRequest: true,
      readBaseSha: () => Promise.resolve(null),
      fetchRanks: () => {
        throw new Error("must not rank an ancestry it has no base for");
      },
      fetchChangedGroups: () => {
        throw new Error("must not compare without a base commit");
      },
    })
  );

  // The fallback still names a sample, but nothing may be failed against it.
  assertEquals(
    captured.result.get(RUNNER_METRIC)?.sample?.durationSeconds,
    5740,
  );
  assertEquals(captured.result.get(RUNNER_METRIC)?.comparable, false);
  assertStringIncludes(
    captured.warnings.join("\n"),
    "could not read the base-branch commit",
  );
});

Deno.test("selectBaselines reports against whatever it has for a push run", async () => {
  const timelines = new Map([
    [
      RUNNER_METRIC,
      timelineOf(RUNNER_METRIC, [
        makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 5740),
      ]),
    ],
  ]);

  const resolved = await selectBaselines({
    metrics: [RUNNER_METRIC],
    timelines,
    isRunCold: NEVER_COLD,
    isPullRequest: false,
    readBaseSha: () => {
      throw new Error("a push run has no base-branch commit to read");
    },
    log: () => {},
    warn: () => {},
  });

  assertEquals(resolved.get(RUNNER_METRIC)?.comparable, true);
});

Deno.test("reportUngatedGroups names the groups it withheld", () => {
  const captured = captureConsole(() =>
    reportUngatedGroups(
      new Set(["packages/runner", "packages/memory"]),
      (message) => console.log(message),
    )
  );
  assertStringIncludes(
    captured.logs.join("\n"),
    "packages/memory, packages/runner",
  );

  const quiet = captureConsole(() =>
    reportUngatedGroups(new Set(), (message) => console.log(message))
  );
  assertEquals(quiet.logs, []);
});

Deno.test("readHeadCommitObject returns the commit object of a checkout", async () => {
  const commit = await readHeadCommitObject();
  assert(commit !== null);
  assertStringIncludes(commit, "tree ");
});

Deno.test("readHeadCommitObject returns null outside a checkout", async () => {
  const outside = await Deno.makeTempDir({ prefix: "coverage-no-repo-" });
  try {
    const captured = await captureConsoleAsync(() =>
      readHeadCommitObject(outside)
    );
    assertEquals(captured.result, null);
    assertStringIncludes(
      captured.warnings.join("\n"),
      "could not read the `HEAD` commit object",
    );
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("fetchGroupsChangedOnBase warns when the compare response is capped", async () => {
  const files = Array.from({ length: 300 }, (_, index) => ({
    filename: `packages/runner/src/file-${index}.ts`,
  }));
  const warnings: string[] = [];

  const groups = await withMockFetch(
    () => new Response(JSON.stringify({ files })),
    () =>
      fetchGroupsChangedOnBase(SHA_A, SHA_C, (message) => {
        warnings.push(message);
      }),
  );

  assertEquals([...groups], ["packages/runner"]);
  assertStringIncludes(warnings.join("\n"), "300-file response cap");
});

Deno.test("isComparableBaseline gates a metric that names no coverage group", () => {
  assertEquals(
    isComparableBaseline({
      sample: makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", 1),
      metric: "some-other-metric",
      baseSha: SHA_C,
      groupsChangedByBaseline: new Map(),
      isPullRequest: true,
    }),
    true,
  );
});

Deno.test("readHeadCommitObject returns null when git cannot be run", async () => {
  const captured = await captureConsoleAsync(() =>
    readHeadCommitObject("/coverage-check-no-such-directory")
  );

  assertEquals(captured.result, null);
  assertStringIncludes(
    captured.warnings.join("\n"),
    "could not run `git` to read the `HEAD` commit object",
  );
});

Deno.test("selectBaselines routes its GitHub calls through the guard", async () => {
  const guarded: string[] = [];

  await selectBaselines({
    metrics: [RUNNER_METRIC],
    timelines: new Map([
      [
        RUNNER_METRIC,
        timelineOf(RUNNER_METRIC, [
          makeBaselineSample(1, SHA_C, "2026-08-04T10:40:00Z", 5746),
        ]),
      ],
    ]),
    isRunCold: NEVER_COLD,
    isPullRequest: true,
    readBaseSha: () => Promise.resolve(SHA_C),
    fetchRanks: () => Promise.resolve(RANKS),
    fetchChangedGroups: () => Promise.resolve(new Set<string>()),
    guard: (description, operation) => {
      guarded.push(description);
      return operation();
    },
    log: () => {},
  });

  assertEquals(guarded, [
    "listing the base-branch commit's ancestry",
    "comparing the baseline commit against the base-branch commit",
  ]);
});

const NO_OVERRIDES = { metrics: new Map(), coverageBaselineReset: false };

function rowsFor(
  metrics: Record<string, number>,
  baselines: Record<string, { value?: number; comparable: boolean }>,
  extra: Partial<Parameters<typeof buildCoverageRows>[0]> = {},
) {
  const currentMetrics = new Map(
    Object.entries(metrics).map(([metric, value]) => [
      metric,
      makeBaselineSample(9, SHA_C, "2026-08-04T11:00:00Z", value),
    ]),
  );
  const baselineByMetric = new Map(
    Object.entries(baselines).map(([metric, spec]) => [metric, {
      sample: spec.value === undefined
        ? undefined
        : makeBaselineSample(1, SHA_A, "2026-08-04T10:00:00Z", spec.value),
      comparable: spec.comparable,
    }]),
  );
  return buildCoverageRows({
    currentMetrics,
    timelines: new Map(),
    baselineByMetric,
    overrides: NO_OVERRIDES,
    changedCoverageGroups: new Set(["packages/runner", "packages/memory"]),
    ...extra,
  });
}

Deno.test("buildCoverageRows fails a gated group above its baseline", () => {
  const { rows, failures } = rowsFor(
    { [RUNNER_METRIC]: 5747 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
  );

  assertEquals(rows[0].status, "OVER");
  assertEquals(rows[0].median, 5746);
  assertEquals(rows[0].baselineSha, SHA_A);
  assertEquals(failures.length, 1);
});

Deno.test("buildCoverageRows passes a gated group at its baseline", () => {
  const { rows, failures } = rowsFor(
    { [RUNNER_METRIC]: 5746 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
  );

  assertEquals(rows[0].status, "OK");
  assertEquals(failures, []);
});

Deno.test("buildCoverageRows reports an incomparable baseline without failing it", () => {
  const { rows, failures, ungatedGroups } = rowsFor(
    { [RUNNER_METRIC]: 9999 },
    { [RUNNER_METRIC]: { value: 5746, comparable: false } },
  );

  assertEquals(rows[0].status, "excl");
  assertEquals(rows[0].median, 5746);
  assertEquals(failures, []);
  assertEquals([...ungatedGroups], ["packages/runner"]);
});

Deno.test("buildCoverageRows leaves a group the PR did not change alone", () => {
  const other = "coverage-debt: packages/toolshed uncovered lines";
  const { rows, failures, ungatedGroups } = rowsFor(
    { [other]: 9999 },
    { [other]: { value: 10, comparable: true } },
  );

  assertEquals(rows[0].status, "excl");
  assertEquals(failures, []);
  // Comparable, so nothing is withheld for want of a baseline.
  assertEquals([...ungatedGroups], []);
});

Deno.test("buildCoverageRows honors a per-metric acceptance and a reset", () => {
  const accepted = rowsFor(
    { [RUNNER_METRIC]: 5800 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
    {
      overrides: {
        metrics: new Map([[RUNNER_METRIC, 5800]]),
        coverageBaselineReset: false,
      },
    },
  );
  assertEquals(accepted.rows[0].status, "ovrd");
  assertEquals(accepted.failures, []);

  const reset = rowsFor(
    { [RUNNER_METRIC]: 5800 },
    { [RUNNER_METRIC]: { value: 5746, comparable: true } },
    {
      overrides: { metrics: new Map(), coverageBaselineReset: true },
    },
  );
  assertEquals(reset.rows[0].status, "ovrd");
  assertEquals(reset.failures, []);
});

Deno.test("buildCoverageRows bootstraps a metric with no baseline", () => {
  const fresh = rowsFor(
    { [RUNNER_METRIC]: 12 },
    { [RUNNER_METRIC]: { comparable: true } },
  );
  assertEquals(fresh.rows[0].status, "OVER");
  assertEquals(fresh.rows[0].median, 0);
  assertEquals(fresh.failures.length, 1);

  const empty = rowsFor(
    { [RUNNER_METRIC]: 0 },
    { [RUNNER_METRIC]: { comparable: true } },
  );
  assertEquals(empty.rows[0].status, "n/a");
  assertEquals(empty.failures, []);

  // With no baseline and nothing gating it, the metric is only reported.
  const ungated = rowsFor(
    { [RUNNER_METRIC]: 12 },
    { [RUNNER_METRIC]: { comparable: false } },
  );
  assertEquals(ungated.rows[0].status, "excl");
  assertEquals(ungated.failures, []);

  // A reset accepts a metric that has no baseline yet.
  const reset = rowsFor(
    { [RUNNER_METRIC]: 12 },
    { [RUNNER_METRIC]: { comparable: true } },
    { overrides: { metrics: new Map(), coverageBaselineReset: true } },
  );
  assertEquals(reset.rows[0].status, "ovrd");
});

Deno.test("buildCoverageRows reports a rise from a zero baseline as complete", () => {
  const { rows } = rowsFor(
    { [RUNNER_METRIC]: 4 },
    { [RUNNER_METRIC]: { value: 0, comparable: true } },
  );
  assertEquals(rows[0].status, "OVER");
  assertEquals(rows[0].pctIncrease, 100);

  const held = rowsFor(
    { [RUNNER_METRIC]: 0 },
    { [RUNNER_METRIC]: { value: 0, comparable: true } },
  );
  assertEquals(held.rows[0].status, "OK");
  assertEquals(held.rows[0].pctIncrease, 0);
});
