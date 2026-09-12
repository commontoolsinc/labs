import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as path from "@std/path";
import {
  describe as summarize,
  type Figure,
  joinReports,
  markedSets,
  measuredSetFigures,
  parseReportArgs,
} from "./coverage-report.ts";
import { COVERAGE_METRIC_PREFIX } from "./coverage-metrics.ts";
import { COVERAGE_FAILURE_MARKER } from "./ci-lane.ts";

/** The repository this test reads the workspace members of. */
const REPOSITORY = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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

  it("skips a marked set whose lane wrote no report of its own", async () => {
    // A lane that ran a set's unit and saw it fail may have collected no
    // profile for it. Another lane's report for the same set must still
    // not become the baseline, so the marker is looked for by the set's
    // directory rather than beside a report that may not be there.
    const root = await reportsIn({
      "lane-1/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
        "SF:/a.ts\nend_of_record\n",
      [`lane-2/lcov/sets/workspace-unit/packages_memory/${COVERAGE_FAILURE_MARKER}`]:
        "packages/memory/test/one.test.ts\n",
      [`lane-2/lcov/sets/runner-unit/packages_runner/${COVERAGE_FAILURE_MARKER}`]:
        "packages/runner/test/two.test.ts\n",
      "lane-2/notes.txt": "not under the layout at all",
    });
    try {
      expect([...await markedSets(root)].sort()).toEqual([
        "runner-unit/packages_runner",
        "workspace-unit/packages_memory",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("marks nothing where nothing was downloaded", async () => {
    expect([...await markedSets("/nonexistent-coverage-artifacts")]).toEqual(
      [],
    );
  });

  it("publishes no baseline for a set measured through a failure", async () => {
    // A lane that excused a flaky failure stayed green, and the number
    // is short by whatever that failing test would have reached.
    // Publishing it would hold every later pull request to a bar this
    // run did not clear either.
    const root = await reportsIn({
      "lane-1/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
        "SF:/a.ts\nend_of_record\n",
      [`lane-1/lcov/sets/workspace-unit/packages_memory/${COVERAGE_FAILURE_MARKER}`]:
        "packages/memory/test/one.test.ts\n",
    });
    try {
      const figures = await measuredSetFigures({
        reports: root,
        out: "/dev/null",
        runId: 1,
        sha: "abc",
        createdAt: "2026-09-01T00:00:00Z",
        root: REPOSITORY,
      });
      expect(
        figures.some((figure) => figure.name.includes("packages/memory")),
      ).toBe(false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
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
