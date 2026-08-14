import { assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import * as path from "@std/path";
import {
  collectCoverageDebtMetricsFromLcov,
  collectRegressedLines,
  collectSourceFiles,
  collectUncoveredLinesForFiles,
  countTrackedSourceLines,
  countUncoveredProfileLines,
  metricGroupFor,
  parseLcov,
  shouldTrackSourceFile,
  trackedSourceLineNumbers,
} from "./coverage-metrics.ts";
import { normalizeLcovInstancePaths } from "./write-coverage-lcov.ts";

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

Deno.test("instance-suffix normalization merges records of the same physical file", () => {
  // Deno's coverage emits one record per module INSTANCE — the same file
  // appears plain and as `?testRun=<uuid>` once per cache-busting import.
  // The suffix is stripped at LCOV GENERATION (normalizeLcovInstancePaths,
  // applied by write-coverage-lcov.ts and the local lcovFromCoverageProfile
  // path) so every consumer sees one record set per physical file, and a
  // line counts covered when ANY instance executed it. Without this the debt
  // metric counted the same physical line once per instance that skipped it,
  // flapping with test order and punishing added tests (CT-1861).
  const normalized = normalizeLcovInstancePaths([
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
  const coverage = parseLcov(normalized);

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
  assertEquals(shouldTrackSourceFile("scripts/start-local-dev.sh"), false);
  assertEquals(shouldTrackSourceFile("scripts/build.ts"), false);
  assertEquals(
    metricGroupFor("packages/runner/src/cell.ts"),
    "packages/runner",
  );
  assertEquals(metricGroupFor("tasks/coverage-check.ts"), "tasks");
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

Deno.test("a file that compiles to nothing carries no debt", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-types-test-" });
  try {
    const writeSourceFile = async (relativePath: string, content: string) => {
      const fullPath = path.join(rootDir, ...relativePath.split("/"));
      await Deno.mkdir(path.dirname(fullPath), { recursive: true });
      await Deno.writeTextFile(fullPath, content);
    };

    // Declarations only: no statement to run, so no test could cover a line of
    // it, and Deno's coverage reports no record for it either way.
    await writeSourceFile(
      "packages/example/src/types.ts",
      [
        "export interface Shape {",
        "  sides: number;",
        "}",
        "export type Either = Shape | number;",
      ].join("\n"),
    );
    // Real code no test loaded: charged in full.
    await writeSourceFile(
      "packages/example/src/untested.ts",
      ["export function untested() {", "  return 1;", "}"].join("\n"),
    );

    const metrics = await collectCoverageDebtMetricsFromLcov({
      rootDir,
      lcov: "",
    });

    expect(
      metrics.find((metric) =>
        metric.name === "coverage-debt: packages/example uncovered lines"
      )?.uncoveredLines,
    ).toBe(3);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("integration pattern coverage feeds the debt metric", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-fold-test-" });
  try {
    const sourcePath = path.join(rootDir, "packages/patterns/main.tsx");
    await Deno.mkdir(path.dirname(sourcePath), { recursive: true });
    await Deno.writeTextFile(
      sourcePath,
      [
        "export const a = 1;",
        "export const b = 2;",
        "export const c = 3;",
      ].join("\n"),
    );

    const metricFor = async (lcov: string) =>
      (await collectCoverageDebtMetricsFromLcov({ rootDir, lcov })).find(
        (metric) =>
          metric.name === "coverage-debt: packages/patterns uncovered lines",
      )?.uncoveredLines;

    // No record: every tracked line is uncovered.
    assertEquals(await metricFor(""), 3);

    // A record from the integration stream is scored like any other: its
    // covered lines leave the debt and its unhit lines stay in it. Nothing
    // discriminates on the test name, so a line only an end-to-end flow
    // exercises lowers the gated number.
    assertEquals(
      await metricFor([
        "TN:pattern-runtime-integration",
        `SF:${sourcePath}`,
        "DA:1,1",
        "DA:2,0",
        "end_of_record",
      ].join("\n")),
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

Deno.test("collectUncoveredLinesForFiles reports no lines for a file that compiles to nothing", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lines-test-" });
  try {
    const typesPath = path.join(rootDir, "packages/example/src/types.ts");
    await Deno.mkdir(path.dirname(typesPath), { recursive: true });
    await Deno.writeTextFile(
      typesPath,
      ["export interface Shape {", "  sides: number;", "}"].join("\n"),
    );

    const uncovered = await collectUncoveredLinesForFiles({
      rootDir,
      lcov: "",
      files: ["packages/example/src/types.ts"],
    });

    expect(uncovered.size).toBe(0);
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

Deno.test("collectRegressedLines names lines the baseline covered and this run did not", async () => {
  const rootDir = await Deno.makeTempDir({
    prefix: "coverage-regressed-test-",
  });
  try {
    const flakyPath = path.join(rootDir, "packages/example/src/flaky.ts");
    const steadyPath = path.join(rootDir, "packages/example/src/steady.ts");
    const debtPath = path.join(rootDir, "packages/example/src/debt.ts");
    await Deno.mkdir(path.dirname(flakyPath), { recursive: true });
    await Deno.writeTextFile(
      flakyPath,
      [
        "export const one = 1;",
        "export const two = 2;",
        "export const three = 3;",
      ].join("\n"),
    );
    await Deno.writeTextFile(steadyPath, "export const steady = 1;\n");
    // Uncovered in both runs: existing debt, not something this run lost.
    await Deno.writeTextFile(debtPath, "export const owed = 1;\n");

    const report = (flakyHits: string[]) =>
      [
        `SF:${flakyPath}`,
        ...flakyHits,
        "end_of_record",
        `SF:${steadyPath}`,
        "DA:1,1",
        "end_of_record",
        `SF:${debtPath}`,
        "DA:1,0",
        "end_of_record",
      ].join("\n");

    const regressed = await collectRegressedLines({
      rootDir,
      // Line 2 covered before and not now; line 3 uncovered in both.
      lcov: report(["DA:1,1", "DA:2,0", "DA:3,0"]),
      baselineLcov: report(["DA:1,1", "DA:2,4", "DA:3,0"]),
      groups: new Set(["packages/example"]),
      changedFiles: new Set(),
    });

    // Only the line that moved: the file uncovered in both runs is not one
    // this run regressed, and the file covered in both has nothing to report.
    assertEquals(regressed, [{
      relativePath: "packages/example/src/flaky.ts",
      metricGroup: "packages/example",
      lines: [2],
    }]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectRegressedLines skips changed files and other groups", async () => {
  const rootDir = await Deno.makeTempDir({
    prefix: "coverage-regressed-test-",
  });
  try {
    const changedPath = path.join(rootDir, "packages/example/src/changed.ts");
    const otherPath = path.join(rootDir, "packages/other/src/mod.ts");
    await Deno.mkdir(path.dirname(changedPath), { recursive: true });
    await Deno.mkdir(path.dirname(otherPath), { recursive: true });
    await Deno.writeTextFile(changedPath, "export const changed = 1;\n");
    await Deno.writeTextFile(otherPath, "export const other = 1;\n");

    const regressed = await collectRegressedLines({
      rootDir,
      lcov: [
        `SF:${changedPath}`,
        "DA:1,0",
        "end_of_record",
        `SF:${otherPath}`,
        "DA:1,0",
        "end_of_record",
      ].join("\n"),
      baselineLcov: [
        `SF:${changedPath}`,
        "DA:1,2",
        "end_of_record",
        `SF:${otherPath}`,
        "DA:1,2",
        "end_of_record",
      ].join("\n"),
      // A file the PR changed has line numbers that moved between the two
      // checkouts, and a group the PR did not regress is not being explained.
      groups: new Set(["packages/example"]),
      changedFiles: new Set(["packages/example/src/changed.ts"]),
    });

    assertEquals(regressed, []);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectRegressedLines counts a file the baseline reported and this run did not", async () => {
  const rootDir = await Deno.makeTempDir({
    prefix: "coverage-regressed-test-",
  });
  try {
    const droppedPath = path.join(rootDir, "packages/example/src/dropped.ts");
    await Deno.mkdir(path.dirname(droppedPath), { recursive: true });
    await Deno.writeTextFile(
      droppedPath,
      ["export const first = 1;", "export const second = 2;"].join("\n"),
    );

    const regressed = await collectRegressedLines({
      rootDir,
      // No record at all: a file no job loaded this time owes every tracked
      // line, the same rule the debt metric charges it by.
      lcov: "",
      baselineLcov: [
        `SF:${droppedPath}`,
        "DA:1,1",
        "DA:2,1",
        "end_of_record",
      ].join("\n"),
      groups: new Set(["packages/example"]),
      changedFiles: new Set(),
    });

    assertEquals(regressed, [{
      relativePath: "packages/example/src/dropped.ts",
      metricGroup: "packages/example",
      lines: [1, 2],
    }]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});
