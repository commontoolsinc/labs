import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import type { WorkflowRun } from "./ci-check-lib.ts";
import {
  type Baseline,
  baselinesFor,
  commentFor,
  failed,
  memberReports,
  ownCoverageMetric,
  ownCoverageMetrics,
  report,
  score,
  type Verdict,
} from "./coverage-gate.ts";

/** A directory holding what a run's lanes uploaded. */
async function artifacts(
  lanes: Record<string, Record<string, string>>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "coverage-gate-" });
  for (const [lane, reports] of Object.entries(lanes)) {
    for (const [file, contents] of Object.entries(reports)) {
      const at = join(root, lane, file);
      await Deno.mkdir(join(at, ".."), { recursive: true });
      await Deno.writeTextFile(at, contents);
    }
  }
  return root;
}

/** A run on the default branch, as the workflow API reports one. */
function run(id: number, sha: string): WorkflowRun {
  return {
    id,
    head_sha: sha,
    created_at: `2026-09-0${id}T00:00:00Z`,
  } as WorkflowRun;
}

describe("coverage-gate", () => {
  it("joins one package's report across the lanes that measured it", async () => {
    // A package's tests are spread across the lanes like any other
    // mandatory items, so its report arrives in pieces. LCOV consumers
    // accumulate records, so joining them is concatenation.
    const dir = await artifacts({
      "coverage-profile-lane-1": {
        "workspace-unit/memory.lcov": "SF:a.ts\nDA:1,1\nend_of_record\n",
        "pattern-integration/pattern-integration-patterns.lcov": "SF:p.ts\n",
      },
      "coverage-profile-lane-2": {
        "workspace-unit/memory.lcov": "SF:b.ts\nDA:1,0\nend_of_record\n",
        "runner-unit/runner.lcov": "SF:r.ts\n",
      },
    });
    try {
      const reports = await memberReports(dir);
      expect([...reports.keys()].sort()).toEqual(["memory", "runner"]);
      expect(reports.get("memory")).toContain("SF:a.ts");
      expect(reports.get("memory")).toContain("SF:b.ts");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reads a run that downloaded no artifacts at all", async () => {
    // The download step finds nothing where no lane measured anything, so
    // the directory the gate walks is not there. Every package is then one
    // this run has no figure for, which is a report rather than an error.
    const root = await Deno.makeTempDir({ prefix: "coverage-gate-" });
    try {
      expect((await memberReports(join(root, "absent"))).size).toBe(0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("gives no figure for a package this run measured nothing for", async () => {
    // Measuring nothing is a different thing from measuring no uncovered
    // lines, and a package with no report is reported rather than scored
    // as though its tests had all passed over nothing.
    const dir = await artifacts({ "coverage-profile-lane-1": {} });
    try {
      const figures = await ownCoverageMetrics(Deno.cwd(), dir, [
        "packages/memory",
      ]);
      expect(figures.size).toBe(0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("takes the nearest ancestor run that measured each package", async () => {
    // A rise measured against a tree the branch does not contain is not
    // the branch's rise, so a run that is not an ancestor is passed over
    // however recent it is.
    const ancestors = new Set(["old"]);
    const baselines = await baselinesFor(
      Deno.cwd(),
      ["packages/memory"],
      [run(3, "newer"), run(2, "old")],
      (which) =>
        Promise.resolve(
          new Map([[ownCoverageMetric("packages/memory"), which.id * 10]]),
        ),
      (sha) => Promise.resolve(ancestors.has(sha)),
    );
    expect(baselines.get("packages/memory")).toEqual({
      uncoveredLines: 20,
      sha: "old",
      runId: 2,
    });
  });

  it("has no baseline where no ancestor run measured the package", async () => {
    const baselines = await baselinesFor(
      Deno.cwd(),
      ["packages/memory"],
      [run(3, "newer")],
      () => Promise.resolve(new Map()),
      () => Promise.resolve(true),
    );
    expect(baselines.size).toBe(0);
  });

  it("fails a package whose own tests leave more of it untested", () => {
    const baseline: Baseline = {
      uncoveredLines: 10,
      sha: "abc123456",
      runId: 7,
    };
    const risen: Verdict = {
      member: "packages/memory",
      uncoveredLines: 12,
      baseline,
    };
    expect(failed(risen)).toBe(true);
    expect(failed({ ...risen, accepted: 2 })).toBe(false);
    expect(failed({ ...risen, uncoveredLines: 10 })).toBe(false);
  });

  it("reports rather than fails a package with no baseline", () => {
    // The first pull request to touch a new package should not inherit
    // the whole of that package's debt.
    expect(failed({ member: "packages/new", uncoveredLines: 40 })).toBe(false);
    expect(
      failed({
        member: "packages/new",
        uncoveredLines: 40,
        reported: "this run measured no coverage for it",
      }),
    ).toBe(false);
  });

  it("drops every baseline when the description resets the ratchet", () => {
    const baselines = new Map<string, Baseline>([[
      "packages/memory",
      { uncoveredLines: 1, sha: "abc", runId: 1 },
    ]]);
    const [verdict] = score(
      ["packages/memory"],
      new Map([["packages/memory", 9]]),
      baselines,
      new Map(),
      true,
    );
    expect(verdict!.baseline).toBeUndefined();
    expect(failed(verdict!)).toBe(false);
  });

  it("hands the pull request a comment only where it scored something", () => {
    // A gate that scored nothing has nothing to say, and a comment
    // saying so would be a notification people learn to resent.
    expect(commentFor(7, [])).toBeUndefined();
    expect(
      commentFor(7, [{ member: "packages/new", uncoveredLines: 3 }]),
    ).toBeUndefined();
  });

  it("collapses an earlier comment when the branch has fixed the rise", () => {
    // The resolved form rewrites a comment an earlier attempt left, so a
    // failure the branch has since fixed does not stand as one.
    const baseline: Baseline = { uncoveredLines: 10, sha: "abc", runId: 1 };
    const passing = commentFor(7, [{
      member: "packages/memory",
      uncoveredLines: 8,
      baseline,
    }]);
    expect(passing?.state).toBe("resolved");
    expect(passing?.improvedLines).toBe(2);
    expect(passing?.groups).toEqual([
      { group: "packages/memory", baseline: 10, current: 8 },
    ]);

    const failing = commentFor(7, [{
      member: "packages/memory",
      uncoveredLines: 12,
      baseline,
    }]);
    expect(failing?.state).toBe("regressed");
    expect(failing?.body).toContain("coverage failure");
  });

  it("says a coverage failure is one, and how to accept it", () => {
    const lines = report([{
      member: "packages/memory",
      uncoveredLines: 12,
      baseline: { uncoveredLines: 10, sha: "abcdef1234", runId: 7 },
    }]).join("\n");
    expect(lines).toContain("coverage failure");
    expect(lines).toContain("ACCEPT_COVERAGE_DEBT: packages/memory +2 lines");
  });
});
