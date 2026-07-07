import { assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  collectCoverageDebtMetricsFromLcov,
  collectSourceFiles,
  collectUncoveredLinesForFiles,
  countTrackedSourceLines,
  countUncoveredProfileLines,
  metricGroupFor,
  parseLcov,
  shouldTrackSourceFile,
  trackedSourceLineNumbers,
} from "./coverage-metrics.ts";

Deno.test("parseLcov accumulates hits per source line", () => {
  const coverage = parseLcov([
    "SF:/repo/packages/example/src/mod.ts",
    "DA:1,1",
    "DA:2,0",
    "DA:2,3",
    "DA:3,0",
    "end_of_record",
  ].join("\n"));

  const file = coverage.get("/repo/packages/example/src/mod.ts");
  assertEquals(file?.lineHits.get(1), 1);
  assertEquals(file?.lineHits.get(2), 3);
  assertEquals(countUncoveredProfileLines(file!), 1);
});

Deno.test("parseLcov merges per-instance records of the same physical file", () => {
  // Deno's coverage emits one record per module INSTANCE — the same file
  // appears plain and as `?testRun=<uuid>` once per importing test file.
  // Instances must merge so a line counts covered when ANY instance executed
  // it; otherwise the debt metric counts the same physical line once per
  // instance that skipped it, flapping with test order and punishing added
  // tests (CT-1861).
  const coverage = parseLcov([
    "SF:/repo/packages/example/src/mod.ts",
    "DA:1,1",
    "DA:2,0",
    "end_of_record",
    "SF:/repo/packages/example/src/mod.ts?testRun=aaaa-1111",
    "DA:1,0",
    "DA:2,2",
    "DA:3,0",
    "end_of_record",
    "SF:/repo/packages/example/src/mod.ts?testRun=bbbb-2222",
    "DA:3,0",
    "end_of_record",
  ].join("\n"));

  assertEquals(coverage.size, 1);
  const file = coverage.get("/repo/packages/example/src/mod.ts");
  // Line 1 covered by the plain instance, line 2 by testRun aaaa; line 3 by
  // neither — the ONLY genuinely uncovered line.
  assertEquals(file?.lineHits.get(1), 1);
  assertEquals(file?.lineHits.get(2), 2);
  assertEquals(file?.lineHits.get(3), 0);
  assertEquals(countUncoveredProfileLines(file!), 1);
});

Deno.test("countTrackedSourceLines ignores blank and comment-only lines", () => {
  assertEquals(
    countTrackedSourceLines([
      "",
      "// comment",
      "const value = 1;",
      "/* block",
      "comment */",
      "export const next = value + 1;",
      "const inline = 2; // comment",
    ].join("\n")),
    3,
  );
});

Deno.test("trackedSourceLineNumbers reports the executable line numbers", () => {
  assertEquals(
    trackedSourceLineNumbers([
      "", // 1
      "// comment", // 2
      "const value = 1;", // 3
      "/* block", // 4
      "comment */", // 5
      "export const next = value + 1;", // 6
      "const inline = 2; // comment", // 7
    ].join("\n")),
    [3, 6, 7],
  );
});

Deno.test("source inventory helpers group tracked files by package", () => {
  assertEquals(shouldTrackSourceFile("packages/runner/src/cell.ts"), true);
  assertEquals(
    shouldTrackSourceFile("packages/runner/test/cell.test.ts"),
    false,
  );
  assertEquals(
    shouldTrackSourceFile("packages/vendor-astral/src/page.ts"),
    false,
  );
  assertEquals(shouldTrackSourceFile("scripts/start-local-dev.sh"), false);
  assertEquals(shouldTrackSourceFile("scripts/build.ts"), false);
  assertEquals(
    metricGroupFor("packages/runner/src/cell.ts"),
    "packages/runner",
  );
  assertEquals(metricGroupFor("tasks/perf-check.ts"), "tasks");
});

Deno.test("collectSourceFiles excludes generated and dependency directories", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-source-test-" });
  try {
    const writeSourceFile = async (relativePath: string) => {
      const fullPath = path.join(rootDir, ...relativePath.split("/"));
      await Deno.mkdir(path.dirname(fullPath), { recursive: true });
      await Deno.writeTextFile(fullPath, "export const value = 1;\n");
    };

    await writeSourceFile("packages/example/src/mod.ts");
    await writeSourceFile("packages/example/build/generated.ts");
    await writeSourceFile("packages/example/node_modules/dep/index.ts");
    await writeSourceFile("packages/example/coverage/report.ts");
    await writeSourceFile("packages/example/src/test/helper.ts");
    await writeSourceFile("scripts/build.ts");

    const files = await collectSourceFiles(rootDir);
    assertEquals(
      files.map((file) => file.relativePath),
      ["packages/example/src/mod.ts"],
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectCoverageDebtMetricsFromLcov computes debt from compact reports", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lcov-test-" });
  try {
    const sourcePath = path.join(rootDir, "packages/example/src/mod.ts");
    await Deno.mkdir(path.dirname(sourcePath), { recursive: true });
    await Deno.writeTextFile(
      sourcePath,
      [
        "export const covered = 1;",
        "export const uncovered = 2;",
      ].join("\n"),
    );

    const metrics = await collectCoverageDebtMetricsFromLcov({
      rootDir,
      lcov: [
        `SF:${sourcePath}`,
        "DA:1,1",
        "DA:2,0",
        "end_of_record",
      ].join("\n"),
    });

    assertEquals(
      metrics.find((metric) =>
        metric.name === "coverage-debt: workspace uncovered lines"
      )?.uncoveredLines,
      1,
    );
    assertEquals(
      metrics.find((metric) =>
        metric.name === "coverage-debt: packages/example uncovered lines"
      )?.uncoveredLines,
      1,
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectUncoveredLinesForFiles resolves lines only for requested files", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lines-test-" });
  try {
    const coveredPath = path.join(rootDir, "packages/example/src/covered.ts");
    const untestedPath = path.join(rootDir, "packages/example/src/untested.ts");
    const otherPath = path.join(rootDir, "packages/example/src/other.ts");
    await Deno.mkdir(path.dirname(coveredPath), { recursive: true });
    await Deno.writeTextFile(
      coveredPath,
      [
        "export const covered = 1;",
        "export const uncovered = 2;",
      ].join("\n"),
    );
    // Never appears in the LCOV report, so every tracked line is uncovered.
    await Deno.writeTextFile(untestedPath, "export const neverRun = 3;\n");
    // Not requested, so it should not be read or returned.
    await Deno.writeTextFile(otherPath, "export const ignored = 4;\n");

    const uncovered = await collectUncoveredLinesForFiles({
      rootDir,
      lcov: [
        `SF:${coveredPath}`,
        "DA:1,1",
        "DA:2,0",
        "end_of_record",
      ].join("\n"),
      files: [
        "packages/example/src/covered.ts",
        "packages/example/src/untested.ts",
        "scripts/build.ts",
        // A test file is not tracked source, so it is skipped.
        "packages/example/src/covered.test.ts",
      ],
    });

    // Covered file: only the zero-hit line.
    assertEquals(uncovered.get("packages/example/src/covered.ts"), [2]);
    // Absent from the report: every tracked line is uncovered.
    assertEquals(uncovered.get("packages/example/src/untested.ts"), [1]);
    // Untracked and unrequested files are absent.
    assertEquals(uncovered.has("scripts/build.ts"), false);
    assertEquals(uncovered.has("packages/example/src/covered.test.ts"), false);
    assertEquals(uncovered.has("packages/example/src/other.ts"), false);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectUncoveredLinesForFiles skips a deleted file (absent from checkout)", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lines-test-" });
  try {
    const uncovered = await collectUncoveredLinesForFiles({
      rootDir,
      lcov: "",
      // Tracked source path with no file on disk — i.e. deleted by the PR.
      files: ["packages/example/src/deleted.ts"],
    });
    assertEquals(uncovered.size, 0);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectUncoveredLinesForFiles surfaces non-NotFound read failures", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lines-test-" });
  try {
    // A directory at a tracked source path makes readTextFile fail with a
    // non-NotFound error, which must propagate rather than be swallowed.
    const trackedPath = path.join(rootDir, "packages/example/src/mod.ts");
    await Deno.mkdir(trackedPath, { recursive: true });

    await assertRejects(() =>
      collectUncoveredLinesForFiles({
        rootDir,
        lcov: "",
        files: ["packages/example/src/mod.ts"],
      })
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});
