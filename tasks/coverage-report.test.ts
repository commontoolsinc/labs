import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as path from "@std/path";
import {
  describe as summarize,
  type Figure,
  joinReports,
  parseReportArgs,
} from "./coverage-report.ts";
import { COVERAGE_METRIC_PREFIX } from "./coverage-metrics.ts";

/** A directory holding one LCOV report at `at`, relative to its root. */
async function reportsIn(
  files: Record<string, string>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "coverage-report-" });
  for (const [at, content] of Object.entries(files)) {
    const file = path.join(root, at);
    await Deno.mkdir(path.dirname(file), { recursive: true });
    await Deno.writeTextFile(file, content);
  }
  return root;
}

describe("what the full run publishes about coverage", () => {
  it("reads a command line and fills the rest in", () => {
    const options = parseReportArgs(["--reports", "artifacts"], "/root");
    expect(options?.reports).toBe("artifacts");
    expect(options?.out).toBe("perf-metrics.json");
    expect(options?.root).toBe("/root");
  });

  it("refuses a flag with no value", () => {
    expect(parseReportArgs(["--reports"], "/root")).toBeUndefined();
  });

  it("refuses a flag nothing reads", () => {
    expect(parseReportArgs(["--nonsense", "1"], "/root")).toBeUndefined();
  });

  it("joins every report under the directory it is given", async () => {
    const root = await reportsIn({
      "lane-1/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
        "SF:/a.ts\nend_of_record\n",
      "lane-2/lcov/sets/runner-unit/packages_runner/coverage.lcov":
        "SF:/b.ts\nend_of_record\n",
      "lane-2/notes.txt": "not a report",
    });
    try {
      const joined = await joinReports(root);
      expect(joined).toContain("SF:/a.ts");
      expect(joined).toContain("SF:/b.ts");
      expect(joined).not.toContain("not a report");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads a directory nothing was downloaded into as no reports", async () => {
    // A run whose lanes reported nothing scores an empty report rather
    // than raising, which charges every tracked line as uncovered.
    expect(await joinReports("/nonexistent-coverage-artifacts")).toBe("");
  });

  it("names the workspace figure in the summary", () => {
    const figures: Figure[] = [
      {
        name: `${COVERAGE_METRIC_PREFIX} workspace uncovered lines`,
        uncoveredLines: 12,
      },
      {
        name: `${COVERAGE_METRIC_PREFIX} packages/memory uncovered lines`,
        uncoveredLines: 3,
      },
    ];
    const summary = summarize(figures);
    expect(summary).toContain("12 uncovered lines");
    expect(summary).toContain("2 figures published");
  });

  it("says so where no report covered the workspace", () => {
    expect(summarize([])).toContain("No report covered the workspace");
  });
});
