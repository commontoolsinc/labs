import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as path from "@std/path";
import {
  collectReports,
  main,
  measuredSetFigures,
  parseReportArgs,
  type ReportOptions,
  repositoryFigures,
  summarize,
} from "./coverage-report.ts";
import {
  coverageMetricForGroup,
  measuredSetCoverageMetric,
} from "./ci-check-lib.ts";
import type { CoverageDebtMetric } from "./coverage-metrics.ts";
import { COVERAGE_REPORT_DIR, COVERAGE_REPORT_FILE } from "./ci-lane.ts";
import { UNLAUNCHED_MEMBERS_FILE } from "./unlaunched-members.ts";
import { loadTopology } from "./test-topology.ts";
import {
  measuredSetDirectory,
  measuredSets,
} from "./test-selection/coverage.ts";

/** The repository the measured-set tests read the workspace from. */
const REPOSITORY = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** The workspace member those tests write a set report for. */
const MEMBER = "packages/leb128";

/** The suite whose units measure that member. */
const SUITE = "workspace-unit";

/** When a run these tests stand for happened. */
const WHEN = "2026-09-01T00:00:00Z";

/** The run identity every command line has to carry. */
const STAMP = ["--run-id", "1", "--sha", "abc", "--created-at", WHEN];

/** A directory holding one file per entry, at a path relative to its root. */
async function directoryOf(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "coverage-report-" });
  for (const [at, content] of Object.entries(files)) {
    const file = path.join(root, at);
    await Deno.mkdir(path.dirname(file), { recursive: true });
    await Deno.writeTextFile(file, content);
  }
  return root;
}

/** The rest of a command line, for a run over `root` reading `reports`. */
function optionsFor(root: string, reports: string): ReportOptions {
  return {
    reports,
    out: path.join(root, "metrics.json"),
    runId: 1,
    sha: "abc",
    createdAt: WHEN,
    root,
  };
}

/**
 * A workspace of two members, each holding one source file of one covered
 * line and one uncovered line, and the absolute path of the first file.
 */
async function workspaceOfTwo(): Promise<{ root: string; alpha: string }> {
  const source = ["export const covered = 1;", "export const uncovered = 2;"]
    .join("\n");
  const root = await directoryOf({
    "packages/alpha/src/mod.ts": source,
    "packages/beta/src/mod.ts": source,
  });
  return { root, alpha: path.join(root, "packages/alpha/src/mod.ts") };
}

/**
 * Where a lane writes `MEMBER`'s set report, under the artifact named.
 *
 * The directory comes from the topology rather than from a name written
 * here, because the topology is where the lane that writes one gets it
 * and a second answer could disagree with the first.
 */
async function reportPathIn(lane: string): Promise<string> {
  const ref = measuredSets(await loadTopology(REPOSITORY))
    .find((candidate) =>
      candidate.suite === SUITE && candidate.set.member === MEMBER
    );
  if (ref === undefined) throw new Error(`no ${SUITE} set for ${MEMBER}`);
  return path.join(
    lane,
    COVERAGE_REPORT_DIR,
    measuredSetDirectory(ref),
    COVERAGE_REPORT_FILE,
  );
}

/** The measured-set figures a reports directory yields. */
function setFiguresFrom(reports: string): Promise<CoverageDebtMetric[]> {
  return measuredSetFigures(optionsFor(REPOSITORY, reports));
}

describe("coverage-report", () => {
  describe("parseReportArgs()", () => {
    it("returns the defaults for the flags a command line omits", () => {
      const options = parseReportArgs([...STAMP, "--reports", "at"], "/root");
      expect(options?.reports).toBe("at");
      expect(options?.out).toBe("perf-metrics.json");
      expect(options?.root).toBe("/root");
    });

    it("returns `undefined` for a flag with no value", () => {
      expect(parseReportArgs([...STAMP, "--reports"], "/root")).toBeUndefined();
    });

    it("returns `undefined` for a flag nothing reads", () => {
      expect(parseReportArgs([...STAMP, "--nonsense", "1"], "/root"))
        .toBeUndefined();
    });

    it("returns `undefined` for a command line carrying no commit", () => {
      // A baseline the gate can never look up is worth less than a
      // refusal naming the flag the job lost.

      expect(parseReportArgs(["--run-id", "7", "--created-at", WHEN]))
        .toBeUndefined();
    });

    it("returns `undefined` for a commit that expanded to nothing", () => {
      expect(
        parseReportArgs(["--run-id", "7", "--sha", "", "--created-at", WHEN]),
      )
        .toBeUndefined();
    });

    it("returns `undefined` for a date nothing can read", () => {
      expect(
        parseReportArgs(["--run-id", "7", "--sha", "abc", "--created-at", ""]),
      )
        .toBeUndefined();
    });

    it("returns `undefined` for a run id that is not a positive integer", () => {
      expect(
        parseReportArgs([
          "--run-id",
          "0",
          "--sha",
          "abc",
          "--created-at",
          WHEN,
        ]),
      )
        .toBeUndefined();
    });
  });

  describe("collectReports()", () => {
    it("returns every LCOV report under the directory it is given", async () => {
      const root = await directoryOf({
        "lane-1/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
          "SF:/a.ts\nend_of_record\n",
        "lane-2/lcov/sets/runner-unit/packages_runner/coverage.lcov":
          "SF:/b.ts\nend_of_record\n",
        "lane-2/notes.txt": "not a report",
      });
      try {
        const reports = await collectReports(root);
        expect(reports.lcov.join("\n")).toContain("SF:/a.ts");
        expect(reports.lcov.join("\n")).toContain("SF:/b.ts");
        expect(reports.lcov.join("\n")).not.toContain("not a report");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns the members every lane's record says it never launched", async () => {
      const root = await directoryOf({
        "lane-1/lcov/sets/workspace-unit/packages_memory/coverage.lcov":
          "SF:/a.ts\nend_of_record\n",
        [`lane-1/lcov/sets/workspace-unit/packages_memory/${UNLAUNCHED_MEMBERS_FILE}`]:
          "./packages/runner\n",
        [`lane-2/lcov/sets/runner-unit/packages_runner/${UNLAUNCHED_MEMBERS_FILE}`]:
          "./packages/shell\n./packages/runner\n",
      });
      try {
        expect((await collectReports(root)).unlaunchedMembers).toEqual([
          "./packages/runner",
          "./packages/shell",
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns nothing for a directory nothing was downloaded into", async () => {
      expect(await collectReports("/nonexistent-coverage-artifacts")).toEqual({
        lcov: [],
        unlaunchedMembers: [],
      });
    });
  });

  describe("repositoryFigures()", () => {
    it("returns the workspace total and a figure for each source group", async () => {
      const { root, alpha } = await workspaceOfTwo();
      try {
        // Alpha's second line ran nowhere, and beta has no record at all,
        // so both of its lines are charged.

        expect(
          await repositoryFigures(optionsFor(root, "artifacts"), {
            lcov: [`SF:${alpha}\nDA:1,1\nDA:2,0\nend_of_record\n`],
            unlaunchedMembers: [],
          }),
        ).toEqual([
          { name: coverageMetricForGroup("workspace"), uncoveredLines: 3 },
          { name: coverageMetricForGroup("packages/alpha"), uncoveredLines: 1 },
          { name: coverageMetricForGroup("packages/beta"), uncoveredLines: 2 },
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns no figure at all where no lane reported", async () => {
      // Scoring an empty report charges every tracked line as uncovered,
      // which states a measurement the run did not make. The dashboard
      // charts this series, so the spike and the recovery after it would
      // both be invented.

      const { root } = await workspaceOfTwo();
      try {
        expect(
          await repositoryFigures(optionsFor(root, "artifacts"), {
            lcov: [],
            unlaunchedMembers: [],
          }),
        ).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns no workspace total where a member never launched", async () => {
      // A member no lane started has unknown coverage rather than none,
      // so its group goes unscored and the total that would have held it
      // goes with it.

      const { root, alpha } = await workspaceOfTwo();
      try {
        expect(
          await repositoryFigures(optionsFor(root, "artifacts"), {
            lcov: [`SF:${alpha}\nDA:1,1\nDA:2,0\nend_of_record\n`],
            unlaunchedMembers: ["./packages/beta"],
          }),
        ).toEqual([
          { name: coverageMetricForGroup("packages/alpha"), uncoveredLines: 1 },
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("measuredSetFigures()", () => {
    it("returns a figure for the set a lane reported and for no other", async () => {
      // Every other set the topology declares went unreported, and a set
      // with no report is left out. The gate reads the newest baseline
      // the branch holds, so leaving it out leaves the previous run's
      // figure standing, where publishing one would tell every later
      // pull request that the member's whole source had gone uncovered.

      const source = path.join(REPOSITORY, MEMBER, "src/index.ts");
      const root = await directoryOf({
        [await reportPathIn("lane-1")]:
          `SF:${source}\nDA:1,1\nDA:2,0\nend_of_record\n`,
      });
      try {
        expect((await setFiguresFrom(root)).map((figure) => figure.name))
          .toEqual([measuredSetCoverageMetric(`${SUITE}/${MEMBER}`)]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns a figure counting every lane that reported the set", async () => {
      // The packer spreads one set's units over as many lanes as it
      // likes, so a figure taken from one lane's report alone would
      // charge whatever the other lanes covered.

      const source = path.join(REPOSITORY, MEMBER, "src/index.ts");
      const first = `SF:${source}\nDA:1,1\nDA:2,0\nend_of_record\n`;
      const second = `SF:${source}\nDA:1,0\nDA:2,1\nend_of_record\n`;
      const alone = await directoryOf({
        [await reportPathIn("lane-1")]: first,
      });
      const both = await directoryOf({
        [await reportPathIn("lane-1")]: first,
        [await reportPathIn("lane-2")]: second,
      });
      try {
        const [one] = await setFiguresFrom(alone);
        const [joined] = await setFiguresFrom(both);
        expect(one.uncoveredLines).toBeGreaterThan(0);
        expect(joined.uncoveredLines).toBe(one.uncoveredLines - 1);
      } finally {
        await Deno.remove(alone, { recursive: true });
        await Deno.remove(both, { recursive: true });
      }
    });

    it("returns no figure where the report reached none of the member's files", async () => {
      // A report with a record for none of the member's files measured
      // nothing, whatever it says about the lines it does carry, and a
      // baseline from it is one no run of the set stands behind.

      const root = await directoryOf({
        [await reportPathIn("lane-1")]:
          "SF:/elsewhere.ts\nDA:1,1\nend_of_record\n",
      });
      try {
        expect(await setFiguresFrom(root)).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("summarize()", () => {
    it("returns a summary naming the workspace figure", () => {
      const figures: CoverageDebtMetric[] = [
        { name: coverageMetricForGroup("workspace"), uncoveredLines: 12 },
        { name: coverageMetricForGroup("packages/memory"), uncoveredLines: 3 },
      ];
      const summary = summarize(figures);
      expect(summary).toContain("12 uncovered lines");
      expect(summary).toContain("2 figures published");
    });

    it("returns a summary naming the member that withheld the total", () => {
      expect(summarize([], ["./packages/beta"])).toContain(
        "Nothing launched ./packages/beta",
      );
    });

    it("returns a summary saying so where no lane reported", () => {
      expect(summarize([])).toContain("No lane reported coverage");
    });
  });

  describe("main()", () => {
    it("returns zero having published nothing where no lane reported", async () => {
      // The run this reports on has already decided whether it passed.
      // Coverage is a trend on the default branch, so however the
      // figures came out, and however few of them there are, this exits
      // zero.

      const out = await Deno.makeTempFile({ prefix: "coverage-report-" });
      const summaryFile = await Deno.makeTempFile({ prefix: "step-summary-" });
      const before = Deno.env.get("GITHUB_STEP_SUMMARY");
      Deno.env.set("GITHUB_STEP_SUMMARY", summaryFile);
      try {
        const status = await main(
          [...STAMP, "--reports", "/nonexistent-artifacts", "--out", out],
          REPOSITORY,
        );
        expect(status).toBe(0);
        expect(JSON.parse(await Deno.readTextFile(out)).metrics).toEqual([]);
        expect(await Deno.readTextFile(summaryFile)).toContain(
          "No lane reported coverage",
        );
      } finally {
        if (before === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
        else Deno.env.set("GITHUB_STEP_SUMMARY", before);
        await Deno.remove(out);
        await Deno.remove(summaryFile);
      }
    });

    it("returns two for a command line it cannot read", async () => {
      expect(await main([...STAMP, "--nonsense", "1"], REPOSITORY)).toBe(2);
    });
  });
});
