import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import type { PRInfo } from "./perf-lib.ts";
import {
  formatBaselineSourceRunAge,
  formatCommitDistance,
  formatRelativeAge,
  formatRelativeDuration,
  parseMergedBaselineOverrides,
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

function coverageRow(metric: string, current: number, median?: number): Row {
  return {
    metric,
    status: median === undefined ? "n/a" : "OK",
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

Deno.test("writeCoverageComment writes a resolved payload when coverage is acceptable", async () => {
  const rows = [
    coverageRow("coverage-debt: workspace uncovered lines", 2948, 2953),
    coverageRow("coverage-debt: tasks uncovered lines", 4, 4),
  ];
  const payload = await payloadFrom(() =>
    writeCoverageComment(4211, [], rows, [], "")
  );

  assertEquals(payload?.state, "resolved");
  // Net reduction in the overall metric: 2953 - 2948 = 5 lines.
  assertEquals(payload?.improvedLines, 5);
});

Deno.test("writeCoverageResolved reports zero improvement without a workspace baseline", async () => {
  const rows = [coverageRow("coverage-debt: workspace uncovered lines", 100)];
  const payload = await payloadFrom(() => writeCoverageResolved(4211, rows));

  assertEquals(payload?.state, "resolved");
  assertEquals(payload?.improvedLines, 0);
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
