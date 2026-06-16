import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  collectCoverageDebtMetricsFromLcov,
  collectSourceFiles,
  countTrackedSourceLines,
  countUncoveredProfileLines,
  metricGroupFor,
  parseLcov,
  shouldTrackSourceFile,
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
