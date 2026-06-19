import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  parseMergedBaselineOverrides,
  type Row,
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
