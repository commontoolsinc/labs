import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type TestIdentity,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import { loadTopology } from "./test-topology.ts";

import {
  batchesOf,
  changedFiles,
  describeConflicts,
  describePlan,
  describeWithheld,
  fullLanes,
  main,
  manifestMoment,
  parseLaneArgs,
  runBatch,
  runInvocation,
  runLane,
  spoolRecords,
} from "./ci-lane.ts";
import { capabilitiesBySuite } from "./test-topology.ts";
import { census } from "./test-selection/census.ts";
import type { Suite } from "./test-topology/suite.ts";
import {
  plan,
  type Selection,
  type SelectionReason,
} from "./test-selection/plan.ts";
import type { Manifest, ManifestEntry } from "./test-selection/manifest.ts";
import {
  FULL_LANE_BOUND_SECONDS,
  FULL_LANE_BUDGET_SECONDS,
  LANE_BUDGET_SECONDS,
} from "./test-selection/policy.ts";

/**
 * The repository, found from this file rather than from the process's
 * own directory: a package's tests run with that package as the working
 * directory, and the paths the topology reads are the repository's.
 */
const REPOSITORY = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
/** A suite holding exactly what a case describes. */
function suite(partial: Partial<Suite> & { id: string }): Suite {
  return {
    recordSurfaces: [{ kind: "unit", scope: "bakery" }],
    needs: ["deno"],
    units: [],
    unavailable: [],
    locate: () => undefined,
    command: () => Promise.resolve([]),
    ...partial,
  };
}

/** A manifest carrying exactly these entries. */
function manifestOf(entries: readonly Partial<ManifestEntry>[]): Manifest {
  return {
    schema: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    seed: "seed",
    commit: "c".repeat(40),
    runs: 1,
    dials: {},
    calibration: {
      setupCost: {},
      suites: {},
      unitOverhead: {},
      prologue: 40,
    },
    entries: entries.map((entry) => ({
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      suite: "workspace-unit",
      unit: "packages/bakery/glaze.test.ts",
      cost: 1,
      score: 0.5,
      inputs: { catches: 0, mainCatches: 0, sources: 0, churn: 0 },
      flakeRate: 0,
      repeats: 1,
      ...entry,
    })),
    withheld: [],
    unavailable: [],
    unschedulable: [],
    lanes: [],
    known: { count: 0, digest: "" },
    coverageBaselines: [],
  };
}

describe("reading the lane's command line", () => {
  it("takes the lane, its share, and the moment to resolve at", () => {
    const options = parseLaneArgs([
      "--lane",
      "3",
      "--of",
      "5",
      "--base",
      "origin/main",
      "--at",
      "2026-09-01T12:00:00Z",
    ], "/repo");
    expect(options?.lane).toBe(3);
    expect(options?.of).toBe(5);
    expect(options?.base).toBe("origin/main");
    expect(options?.at).toBe("2026-09-01T12:00:00Z");
  });

  it("refuses a lane outside the run it belongs to", () => {
    expect(parseLaneArgs(["--lane", "6", "--of", "5"])).toBeUndefined();
    expect(parseLaneArgs(["--lane", "0", "--of", "5"])).toBeUndefined();
  });

  it("refuses to count lanes for a run that is not the full one", () => {
    // Only `main` works its lane count out; a pull request's is a dial.
    expect(parseLaneArgs(["--lane-count"])).toBeUndefined();
    expect(parseLaneArgs(["--full", "--lane-count"])?.laneCount).toBe(true);
  });

  it("refuses a flag it does not know", () => {
    expect(parseLaneArgs(["--shard", "1/5"])).toBeUndefined();
  });
});

describe("the moment a lane resolves its manifest at", () => {
  const lane = { lane: 1, of: 5, full: false, dryRun: false, laneCount: false };

  /** A repository whose one commit was made at a moment a case chose. */
  async function repository(committed: string): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "ci-lane-commit-" });
    const git = (...args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd: root,
        env: {
          ...Deno.env.toObject(),
          GIT_AUTHOR_DATE: committed,
          GIT_COMMITTER_DATE: committed,
          GIT_AUTHOR_NAME: "A",
          GIT_AUTHOR_EMAIL: "a@example.com",
          GIT_COMMITTER_NAME: "A",
          GIT_COMMITTER_EMAIL: "a@example.com",
        },
        stdout: "null",
        stderr: "null",
      }).output();
    await git("init", "-q");
    await Deno.writeTextFile(`${root}/a.txt`, "a");
    await git("add", "a.txt");
    await git("commit", "-q", "-m", "one");
    return root;
  }

  it("takes the commit's date, normalized to UTC", async () => {
    // Git writes the committer's own offset and manifest names carry
    // UTC, so the two are only comparable once this one is normalized.
    const root = await repository("2026-09-01T10:41:59-07:00");
    expect((await manifestMoment({ ...lane, root })).at).toBe(
      "2026-09-01T17:41:59.000Z",
    );
  });

  it("takes the same moment however many times a run is attempted", async () => {
    // The property the whole thing turns on: nothing about the moment
    // comes from the run, so a re-run resolves what the first attempt
    // resolved.
    const root = await repository("2026-09-01T10:41:59-07:00");
    const first = await manifestMoment({ ...lane, root });
    const again = await manifestMoment({ ...lane, root });
    expect(again.at).toBe(first.at);
    expect(first.note).toBeUndefined();
  });

  it("lets a caller ask about a moment that is not this tree's", async () => {
    const root = await repository("2026-09-01T10:41:59-07:00");
    const moment = await manifestMoment({
      ...lane,
      root,
      at: "2026-08-01T00:00:00.000Z",
    });
    expect(moment.at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("falls back to the newest manifest outside a repository, and says so", async () => {
    const root = await Deno.makeTempDir({ prefix: "ci-lane-nogit-" });
    const moment = await manifestMoment({ ...lane, root });
    expect(moment.note).toContain("cannot read the commit's date");
    expect(Number.isNaN(new Date(moment.at).getTime())).toBe(false);
  });
});

describe("turning a lane's selections into batches", () => {
  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/glaze.test.ts"],
  });

  it("skips the identities inside a chosen unit that were not chosen", () => {
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 1,
    }]);
    expect(batches.length).toBe(1);
    expect(batches[0]!.units).toEqual([{
      unit: "packages/bakery/glaze.test.ts",
      skip: ["glaze > browns"],
    }]);
  });

  it("skips nothing when every identity of a unit was chosen", () => {
    const manifest = manifestOf([{}]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 1,
    }]);
    expect(batches[0]!.units[0]!.skip).toEqual([]);
  });

  it("takes the most runs any identity in the batch asked for", () => {
    const manifest = manifestOf([{}]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 3,
    }]);
    expect(batches[0]!.repeats).toBe(3);
  });

  it("holds the most runs when a later identity asks for fewer", () => {
    // The count answers for every identity in the unit, so one asking
    // for a single run after another asked for three still gets three.
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const batches = batchesOf([bakery], manifest, [
      { entry: manifest.entries[0]!, reason: "value", repeats: 3 },
      { entry: manifest.entries[1]!, reason: "value", repeats: 1 },
    ]);
    expect(batches[0]!.repeats).toBe(3);
  });

  it("holds the most runs across the units of one batch", () => {
    // A batch runs its units together under one count, so a unit asking
    // for fewer cannot cut short the one that asked for more.
    const twoUnits = suite({
      id: "workspace-unit",
      units: ["packages/bakery/glaze.test.ts", "packages/bakery/ice.test.ts"],
    });
    const manifest = manifestOf([
      {},
      {
        test: { k: "unit", s: "bakery", n: "ice > sets" },
        unit: "packages/bakery/ice.test.ts",
      },
    ]);
    const batches = batchesOf([twoUnits], manifest, [
      { entry: manifest.entries[0]!, reason: "value", repeats: 4 },
      { entry: manifest.entries[1]!, reason: "value", repeats: 2 },
    ]);
    expect(batches.length).toBe(1);
    expect(batches[0]!.repeats).toBe(4);
  });
});

/** Every unit each lane of a plan would run, in lane order. */
function unitsPerLane(
  suites: readonly Suite[],
  manifest: Manifest | undefined,
  lanes: number,
  policy?: "everything",
): string[][] {
  const seen = census(suites, manifest, new Set());
  const laid = plan({
    manifest: seen.manifest,
    mandatory: seen.mandatory,
    capabilities: capabilitiesBySuite(suites),
    lanes,
    ...(policy === undefined ? {} : { policy }),
  });
  return laid.lanes.map((lane) =>
    batchesOf(suites, seen.manifest, lane.selections)
      .flatMap((batch) => batch.units.map((unit) => unit.unit))
      .toSorted()
  );
}

describe("the order a runner is handed its work in", () => {
  const bakery = [
    suite({
      id: "workspace-unit",
      units: ["c.test.ts", "a.test.ts", "b.test.ts"],
    }),
    suite({
      id: "repo-gates",
      recordSurfaces: [{ kind: "gate", scope: "repo" }],
      units: ["deno-fmt"],
    }),
  ];

  /** The units of one batch, in the order `batchesOf` returns them. */
  function handed(selections: readonly Selection[]): string[] {
    const seen = census(bakery, undefined, new Set());
    return batchesOf(bakery, seen.manifest, selections)
      .flatMap((batch) => batch.units.map((unit) => unit.unit));
  }

  it("hands the units over in the order the suite enumerates them", () => {
    const seen = census(bakery, undefined, new Set());
    const entries = seen.manifest.entries.filter((entry) =>
      entry.suite === "workspace-unit"
    );
    const selections = entries.map((entry) => ({
      entry,
      reason: "value" as const,
      repeats: 1,
    }));
    expect(handed(selections)).toEqual(["c.test.ts", "a.test.ts", "b.test.ts"]);
    // The same set chosen in a different order is handed over the same
    // way, which is what stops the two runs ordering one batch's work
    // differently from each other.
    expect(handed([...selections].reverse())).toEqual(handed(selections));
  });

  it("puts the batches themselves in one order whatever chose them", () => {
    const seen = census(bakery, undefined, new Set());
    const selections = seen.manifest.entries.map((entry) => ({
      entry,
      reason: "value" as const,
      repeats: 1,
    }));
    const suiteIds = (chosen: readonly Selection[]) =>
      batchesOf(bakery, seen.manifest, chosen).map((batch) => batch.suite.id);
    expect(suiteIds(selections)).toEqual(["repo-gates", "workspace-unit"]);
    expect(suiteIds([...selections].reverse())).toEqual(suiteIds(selections));
  });
});

describe("running everything", () => {
  const four = [
    suite({
      id: "workspace-unit",
      units: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
    }),
  ];

  it("gives each lane its own share and no unit twice", () => {
    const lanes = unitsPerLane(four, undefined, 3, "everything");
    expect(lanes.flat().toSorted()).toEqual([
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
    ]);
  });

  it("spreads the units rather than piling them into one lane", () => {
    // Nothing has measured any of these, so they cost the same as one
    // another. Costing them nothing would make every lane after the
    // first look more expensive than the one already holding the suite,
    // and the whole suite would land in lane one.
    const lanes = unitsPerLane(four, undefined, 4, "everything");
    expect(lanes.map((units) => units.length)).toEqual([1, 1, 1, 1]);
  });

  it("leaves out a unit a configuration declares unavailable", () => {
    const suites = [
      suite({
        id: "package-integration-on",
        units: ["a.test.ts", "b.test.ts"],
        unavailable: [{ unit: "a.test.ts", reason: "not landed yet" }],
      }),
    ];
    expect(unitsPerLane(suites, undefined, 1, "everything")[0])
      .toEqual(["b.test.ts"]);
  });

  it("keeps a unit whose unavailability names only one leaf", () => {
    const suites = [
      suite({
        id: "package-integration-on",
        units: ["a.test.ts", "b.test.ts"],
        unavailable: [{
          unit: "a.test.ts",
          leafName: "bakes > slowly",
          reason: "that step's surface has not landed",
        }],
      }),
    ];
    expect(unitsPerLane(suites, undefined, 1, "everything")[0])
      .toEqual(["a.test.ts", "b.test.ts"]);
  });
});

describe("how many lanes the full run asks for", () => {
  const options = {
    lane: 1,
    of: 1,
    full: true,
    dryRun: true,
    laneCount: true,
    root: REPOSITORY,
  };

  /** A topology holding `count` units of one suite, each costing `cost`. */
  function corpus(count: number, cost: number) {
    const units = Array.from({ length: count }, (_, i) => `unit-${i}.test.ts`);
    return {
      topology: () => Promise.resolve([suite({ id: "workspace-unit", units })]),
      manifest: () =>
        Promise.resolve({
          manifest: manifestOf(units.map((unit, i) => ({
            test: { k: "unit", s: "bakery", n: `case ${i}` },
            unit,
            cost,
          }))),
          objectName: "manifest-fixture.json.gz",
        }),
    };
  }

  it("asks for one lane for work that fits in one", async () => {
    expect(await fullLanes(options, corpus(10, 1))).toBe(1);
  });

  it("asks for enough lanes that none of them runs long", async () => {
    const deps = corpus(FULL_LANE_BUDGET_SECONDS * 4, 1);
    expect(await fullLanes(options, deps)).toBe(4);
  });

  /**
   * A corpus with the shapes that make packing hard: several suites, the
   * measured skew the plan document records with a tenth of the tests
   * holding most of the time, capabilities whose setup a lane pays once,
   * fitted overheads, and one identity larger than a whole lane.
   */
  function awkward() {
    const suites = [
      suite({ id: "workspace-unit", needs: ["deno"], units: [] }),
      suite({
        id: "pattern-integration",
        needs: ["deno", "browser"],
        units: [],
      }),
      suite({ id: "cli-core", needs: ["deno", "toolshed"], units: [] }),
    ].map((s, i) => ({
      ...s,
      units: Array.from({ length: 40 }, (_, u) => `s${i}/unit-${u}.test.ts`),
    }));
    const entries = suites.flatMap((s, i) =>
      s.units.map((unit, u) => ({
        test: { k: "unit", s: "bakery", n: `s${i} case ${u}` },
        suite: s.id,
        unit,
        // A tenth of them hold most of the time, and one is larger than
        // any lane can hold.
        cost: u === 0 && i === 0
          ? FULL_LANE_BUDGET_SECONDS * 2
          : u % 10 === 0
          ? 40
          : 0.4,
      }))
    );
    const manifest = manifestOf(entries);
    manifest.calibration = {
      setupCost: { deno: 15, browser: 60, toolshed: 45 },
      suites: Object.fromEntries(
        suites.map((s) => [s.id, { overhead: 12, correction: 1.3 }]),
      ),
      unitOverhead: {},
      prologue: 40,
    };
    return {
      suites,
      topology: () => Promise.resolve(suites),
      manifest: () =>
        Promise.resolve({ manifest, objectName: "manifest-fixture.json.gz" }),
    };
  }

  it("gives every unit a lane at the count it asked for", async () => {
    // The integer is the whole of what the job ahead of the full run
    // emits, so it has to be a count the lanes can honor. Every identity
    // placed exactly once is the property that matters: what the full
    // run does not run, nothing runs.
    const deps = awkward();
    const lanes = await fullLanes(options, deps);
    const seen = census(
      deps.suites,
      (await deps.manifest()).manifest,
      new Set(),
    );
    const laid = plan({
      manifest: seen.manifest,
      mandatory: seen.mandatory,
      capabilities: capabilitiesBySuite(deps.suites),
      policy: "everything",
      lanes,
    });
    const placed = laid.lanes.flatMap((lane) =>
      lane.selections.map((s) => testIdentityKey(s.entry.test))
    );
    expect(placed.length).toBe(seen.manifest.entries.length);
    expect(new Set(placed).size).toBe(seen.manifest.entries.length);
    // The lanes the count was chosen for hold what it promised, save the
    // one carrying an identity larger than any lane, which carries it
    // alone because nothing else would fit beside it.
    const over = laid.lanes.filter((lane) =>
      lane.projectedSeconds > laid.budgetSeconds
    );
    expect(over.length).toBe(1);
    expect(over[0]!.selections.length).toBe(1);
  });

  it("gives every unit a lane when nothing has been measured", async () => {
    // The same property down the fallback path, where the count comes
    // from the shape of the topology rather than from a cost model.
    const deps = awkward();
    const lanes = await fullLanes(options, {
      topology: deps.topology,
      manifest: () => Promise.resolve({ absent: "the store is gone" }),
    });
    const seen = census(deps.suites, undefined, new Set());
    const laid = plan({
      manifest: seen.manifest,
      mandatory: seen.mandatory,
      capabilities: capabilitiesBySuite(deps.suites),
      policy: "everything",
      lanes,
    });
    const placed = laid.lanes.flatMap((lane) =>
      lane.selections.map((s) => testIdentityKey(s.entry.test))
    );
    expect(placed.length).toBe(120);
    expect(new Set(placed).size).toBe(120);
    expect(laid.overBudgetSeconds).toBe(0);
  });

  it("takes the topology's shape when a manifest knows none of it", async () => {
    // A manifest that arrived is not the question. One published before
    // this tree existed arrives and still knows none of it, and a cost
    // model reading it is as blind as one reading nothing.
    const suites = [
      suite({ id: "workspace-unit", units: ["a.test.ts", "b.test.ts"] }),
      suite({ id: "repo-gates", units: ["deno-fmt"] }),
    ];
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: string) => errors.push(line);
    let lanes: number;
    try {
      lanes = await fullLanes(options, {
        topology: () => Promise.resolve(suites),
        manifest: () =>
          Promise.resolve({
            manifest: manifestOf([{ unit: "somewhere/else.test.ts" }]),
            objectName: "manifest-fixture.json.gz",
          }),
      });
    } finally {
      console.error = error;
    }
    expect(lanes).toBe(2);
    expect(errors.join("\n")).toContain("measured");
  });

  it("takes the topology's shape when there is no manifest", async () => {
    // Nothing has a measured cost, so a projection from costs would be
    // arithmetic over an invented figure, and being wrong downward means
    // every lane runs past the bound its job is killed at.
    const suites = [
      suite({ id: "workspace-unit", units: ["a.test.ts", "b.test.ts"] }),
      suite({ id: "repo-gates", units: ["deno-fmt"] }),
      suite({
        id: "package-integration-opposite",
        units: ["c.test.ts"],
        unavailable: [{ unit: "c.test.ts", reason: "not in this posture" }],
      }),
    ];
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: string) => errors.push(line);
    let lanes: number;
    try {
      lanes = await fullLanes(options, {
        topology: () => Promise.resolve(suites),
        manifest: () => Promise.resolve({ absent: "the store is gone" }),
      });
    } finally {
      console.error = error;
    }
    // A lane for each suite with anything to run, so the suite whose
    // every unit this configuration declares unavailable takes none.
    expect(lanes).toBe(2);
    expect(errors.join("\n")).toContain("measured");
  });

  it("answers with an integer on its own, and exits zero", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    let status: number;
    try {
      status = await main(
        ["--full", "--lane-count"],
        REPOSITORY,
        corpus(10, 1),
      );
    } finally {
      console.log = log;
    }
    expect(status).toBe(0);
    expect(lines).toEqual(["1"]);
  });
});

describe("what the two runs agree about", () => {
  const bakery = [
    suite({
      id: "workspace-unit",
      units: ["packages/bakery/glaze.test.ts", "packages/bakery/proof.test.ts"],
      unavailable: [{
        unit: "packages/bakery/gone.test.ts",
        reason: "not in this configuration",
      }],
    }),
  ];

  /**
   * A manifest naming a unit this tree does not have and one it declares
   * unavailable, which is what a manifest published before the tree
   * changed looks like.
   */
  const stale = manifestOf([
    { unit: "packages/bakery/glaze.test.ts" },
    {
      test: { k: "unit", s: "bakery", n: "gone > entirely" },
      unit: "packages/bakery/gone.test.ts",
    },
    {
      test: { k: "unit", s: "bakery", n: "deleted > long ago" },
      unit: "packages/bakery/deleted.test.ts",
    },
  ]);

  it("runs the same units in both, since both read the same tree", () => {
    const full = unitsPerLane(bakery, stale, 1, "everything")[0];
    const budgeted = unitsPerLane(bakery, stale, 1)[0];
    expect(full).toEqual([
      "packages/bakery/glaze.test.ts",
      "packages/bakery/proof.test.ts",
    ]);
    expect(budgeted).toEqual(full);
  });

  it("selects the same set as a full run when nothing is scarce", () => {
    // The one difference between the two policies is what a run can
    // afford. Given a budget nothing exhausts and a corpus nothing is
    // withheld from, they must choose the same tests; if they ever stop
    // doing so, something has been added to one and not the other.
    const suites = [
      suite({
        id: "workspace-unit",
        units: Array.from({ length: 12 }, (_, i) => `unit-${i}.test.ts`),
      }),
    ];
    const seen = census(suites, undefined, new Set());
    const shared = {
      manifest: seen.manifest,
      mandatory: new Map<string, SelectionReason>(),
      capabilities: capabilitiesBySuite(suites),
      lanes: 3,
      budgetSeconds: 1_000_000,
    };
    const full = plan({ ...shared, policy: "everything" as const });
    const budgeted = plan(shared);
    const keys = (result: ReturnType<typeof plan>) =>
      result.lanes.flatMap((lane) =>
        lane.selections.map((s) => testIdentityKey(s.entry.test))
      ).toSorted();
    expect(keys(budgeted)).toEqual(keys(full));
  });
});

describe("running a lane's work", () => {
  const lane = {
    lane: 1,
    of: 5,
    full: false,
    dryRun: false,
    laneCount: false,
    root: REPOSITORY,
  };

  /** A suite that runs the command a case gives it. */
  function runnable(command: readonly string[], id = "probe"): Suite {
    return suite({
      id,
      units: ["one"],
      command: (_units, context) =>
        Promise.resolve([{ command: [...command], cwd: context.root }]),
    });
  }

  it("reports what an invocation cost and whether it passed", async () => {
    const ok = await runInvocation(
      { command: [Deno.execPath(), "eval", "0"], cwd: Deno.cwd() },
      {},
    );
    expect(ok.ok).toBe(true);
    expect(ok.seconds).toBeGreaterThan(0);
    const bad = await runInvocation(
      { command: [Deno.execPath(), "eval", "Deno.exit(3)"], cwd: Deno.cwd() },
      {},
    );
    expect(bad.ok).toBe(false);
  });

  it("runs a batch once per repeat, and every one must pass", async () => {
    // A repeat is not a retry: three runs of a test is strictly stricter
    // than one, so a batch that fails once has failed.
    const workDir = await Deno.makeTempDir({ prefix: "lane-batch-" });
    const passing = await runBatch(
      {
        suite: runnable([Deno.execPath(), "eval", "0"]),
        units: [],
        repeats: 3,
      },
      lane,
      workDir,
      undefined,
      {},
    );
    expect(passing.ok).toBe(true);

    const failing = await runBatch(
      {
        suite: runnable([Deno.execPath(), "eval", "Deno.exit(1)"], "red"),
        units: [],
        repeats: 2,
      },
      lane,
      workDir,
      undefined,
      {},
    );
    expect(failing.ok).toBe(false);
    await Deno.remove(workDir, { recursive: true });
  });

  it("keeps the records a batch's producers wrote", async () => {
    // Each execution writes into a spool of its own and is gathered
    // before another can reuse a runner-owned path.
    const workDir = await Deno.makeTempDir({ prefix: "lane-records-" });
    const written = JSON.stringify({
      line: "record",
      test: { k: "gate", s: "repo", n: "probe" },
      outcome: "pass",
      durationMs: 1,
    });
    const result = await runBatch(
      {
        suite: runnable([
          Deno.execPath(),
          "eval",
          `Deno.writeTextFileSync(
            Deno.env.get("CF_TEST_RECORDS_DIR") + "/fragment-a.ndjson",
            ${JSON.stringify(written + "\n")},
          )`,
        ]),
        units: [],
        repeats: 1,
      },
      lane,
      workDir,
      undefined,
      {},
    );
    expect(result.records.map((record) => record.test.n)).toEqual(["probe"]);
    await Deno.remove(workDir, { recursive: true });
  });

  it("says which manifest it read and what it will run", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [{
          suite: runnable(["true"], "workspace-unit"),
          units: [],
          repeats: 2,
        }],
        ["deno", "toolshed"],
        { objectName: "manifest-x.json.gz" },
        ["binaries: build-binary toolshed costs 900s"],
        { selections: [], projectedSeconds: 0 },
        LANE_BUDGET_SECONDS,
        0,
        0,
      );
    } finally {
      console.log = log;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("manifest-x.json.gz");
    expect(printed).toContain("deno, toolshed");
    expect(printed).toContain("workspace-unit");
    // What no lane can hold is named rather than left silently absent.
    expect(printed).toContain("build-binary toolshed");
  });

  it("says what each batch costs and why each test is in it", () => {
    // "Why did my test not run" is the question a selected run provokes,
    // and a summary naming only the suites cannot begin to answer it.
    const entry: ManifestEntry = {
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      suite: "workspace-unit",
      unit: "packages/bakery/glaze.test.ts",
      cost: 1.5,
      score: 0.5,
      inputs: { catches: 0, mainCatches: 0, sources: 0, churn: 0 },
      flakeRate: 0,
      repeats: 1,
    };
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [{
          suite: runnable(["true"], "workspace-unit"),
          units: [{ unit: "packages/bakery/glaze.test.ts", skip: [] }],
          repeats: 2,
        }],
        ["deno"],
        { objectName: "manifest-x.json.gz" },
        [],
        {
          selections: [{ entry, reason: "value", repeats: 2 }],
          projectedSeconds: 96,
        },
        LANE_BUDGET_SECONDS,
        0,
        1,
      );
    } finally {
      console.log = log;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("Projected: 96s");
    expect(printed).toContain("3.0s");
    expect(printed).toContain("value 1");
  });

  it("says it is running unselected when there is no manifest", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [],
        [],
        { absent: "the store is unreachable" },
        [],
        { selections: [], projectedSeconds: 0 },
        LANE_BUDGET_SECONDS,
        0,
        0,
      );
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("the store is unreachable");
  });

  it("names what the manifest withheld, and what came back", () => {
    const red = { k: "unit", s: "bakery", n: "glaze > sets" };
    const flaky = { k: "unit", s: "bakery", n: "proof > rises" };
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeWithheld(
        [
          { test: red, suite: "workspace-unit", reason: "main-red" },
          { test: flaky, suite: "workspace-unit", reason: "flaky" },
        ],
        new Map([[testIdentityKey(red), "changed"]]),
      );
    } finally {
      console.log = log;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("already failing in the latest run on `main`");
    expect(printed).toContain("too noisy to judge a change by");
    // The change reaches the failing one, which is very likely a fix, so
    // it runs in spite of being withheld.
    expect(printed).toContain("yes, the change reaches it");
    expect(printed).toContain("| no |");
  });

  it("names the records no suite describes", () => {
    // The only report they get before the store half of the drift guard
    // fails on them on the next run on `main`.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeConflicts([{
        line: "record",
        test: { k: "integration", s: "runner", n: "attaches" },
        outcome: "pass",
        durationMs: 1,
      }]);
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain(
      testIdentityKey({ k: "integration", s: "runner", n: "attaches" }),
    );
    expect(lines.join("\n")).toContain("kept as written");
  });

  it("says nothing when every record was one its suite describes", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeConflicts([]);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual([]);
  });

  it("says nothing about a manifest that withheld nothing", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeWithheld([], new Map());
    } finally {
      console.log = log;
    }
    expect(lines).toEqual([]);
  });
});

describe("planning a lane without running it", () => {
  it("plans the full run against the working tree", async () => {
    // The full run switches selection off, so this reaches the topology
    // and the packing without a manifest or a store.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    let ok: boolean;
    try {
      ok = await runLane({
        lane: 2,
        of: 5,
        full: true,
        dryRun: true,
        laneCount: false,
        root: REPOSITORY,
      });
    } finally {
      console.log = log;
    }
    expect(ok).toBe(true);
    const printed = lines.join("\n");
    expect(printed).toContain("Lane 2 of 5");
    // A lane's share of the full run is a real share of real suites,
    // measured against the full run's own budget rather than a pull
    // request's.
    expect(printed).toContain("workspace-unit");
    expect(printed).toContain(`of ${FULL_LANE_BUDGET_SECONDS}s`);
    expect(FULL_LANE_BUDGET_SECONDS).toBeLessThan(FULL_LANE_BOUND_SECONDS);
  });
});

describe("planning a lane the manifest chose", () => {
  const root = REPOSITORY;

  /** What a lane prints, with the store answering as a case describes. */
  async function planned(
    entries: readonly Partial<ManifestEntry>[],
    lane = 1,
  ): Promise<string> {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        {
          lane,
          of: 5,
          full: false,
          dryRun: true,
          laneCount: false,
          root,
          at: "2026-09-01T00:00:00Z",
        },
        {
          manifest: () =>
            Promise.resolve({
              manifest: manifestOf(entries),
              objectName: "manifest-fixture.json.gz",
            }),
        },
      );
    } finally {
      console.log = log;
    }
    return lines.join("\n");
  }

  it("refuses a lane the plan has no share for", async () => {
    // Taking an empty share instead would run nothing and exit zero,
    // reporting a pass over a set no lane ran.
    await expect(runLane(
      {
        lane: 3,
        of: 2,
        full: false,
        dryRun: true,
        laneCount: false,
        root,
        at: "2026-09-01T00:00:00Z",
      },
      {
        manifest: () =>
          Promise.resolve({
            manifest: manifestOf([{}]),
            objectName: "manifest-fixture.json.gz",
          }),
      },
    )).rejects.toThrow("lane 3 has no share of a plan for 2 lanes");
  });

  it("names the manifest it planned from", async () => {
    const printed = await planned([]);
    expect(printed).toContain("manifest-fixture.json.gz");
  });

  it("gives the five lanes the whole corpus, and no unit twice", async () => {
    // Every lane packs the same manifest over the same inputs and takes
    // its own share, so the five partition the work by construction
    // rather than by anything coordinating them.
    const counted = (printed: string): number =>
      printed.split("\n")
        .map((line) => /^\| \S+ \| (\d+) \| /.exec(line))
        .reduce((total, row) => total + (row === null ? 0 : Number(row[1])), 0);
    let placed = 0;
    for (const lane of [1, 2, 3, 4, 5]) {
      placed += counted(await planned([], lane));
    }
    const suites = await loadTopology(root);
    const available = suites.reduce(
      (total, suite) =>
        total + suite.units.length -
        suite.unavailable.filter((entry) => entry.leafName === undefined)
          .length,
      0,
    );
    expect(placed).toBe(available);
  });

  it("runs everything when the store has no manifest to give", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        { lane: 1, of: 5, full: false, dryRun: true, laneCount: false, root },
        { manifest: () => Promise.resolve({ absent: "the store is gone" }) },
      );
    } finally {
      console.log = log;
    }
    // A lane with no manifest runs the mandatory set plus a
    // deterministic slice rather than failing, so pull requests keep
    // flowing while the store is unreachable.
    const printed = lines.join("\n");
    expect(printed).toContain("the store is gone");
    expect(printed).toContain("workspace-unit");
  });
});

describe("the lane's own housekeeping", () => {
  const root = REPOSITORY;

  it("answers with the status the job would exit with", async () => {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      // A command line this cannot read is a usage error rather than a
      // lane that ran nothing and reported success.
      expect(await main(["--shard", "1/5"], REPOSITORY)).toBe(2);
      expect(
        await main(
          ["--lane", "9999", "--of", "10000", "--full", "--dry-run"],
          REPOSITORY,
        ),
      ).toBe(0);
    } finally {
      console.log = log;
      console.error = err;
    }
  });

  it("reads the two flags that carry no value", () => {
    const options = parseLaneArgs(["--full", "--dry-run", "--lane", "2"]);
    expect(options?.full).toBe(true);
    expect(options?.dryRun).toBe(true);
    expect(parseLaneArgs(["--base"])).toBeUndefined();
  });

  it("takes the files a change touched from the diff", async () => {
    const repo = await Deno.makeTempDir({ prefix: "lane-diff-" });
    const git = (...args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd: repo,
        env: {
          ...Deno.env.toObject(),
          GIT_AUTHOR_NAME: "A",
          GIT_AUTHOR_EMAIL: "a@example.com",
          GIT_COMMITTER_NAME: "A",
          GIT_COMMITTER_EMAIL: "a@example.com",
        },
        stdout: "null",
        stderr: "null",
      }).output();
    await git("init", "-q");
    await Deno.writeTextFile(`${repo}/kept.ts`, "a");
    await git("add", ".");
    await git("commit", "-q", "-m", "first");
    await git("branch", "base");
    await Deno.writeTextFile(`${repo}/added.test.ts`, "b");
    await git("add", ".");
    await git("commit", "-q", "-m", "second");
    expect([...await changedFiles(repo, "base")]).toEqual(["added.test.ts"]);
    // With no base there is no change to speak of, which is what the
    // full run on `main` asks for.
    expect([...await changedFiles(repo, undefined)]).toEqual([]);
    // A diff that cannot be taken is not a change-free pull request:
    // reading it as one would drop every changed unit without a word.
    await expect(changedFiles(repo, "no-such-ref")).rejects.toThrow(
      "cannot diff",
    );
    await Deno.remove(repo, { recursive: true });
  });

  it("writes the plan into the job summary as well as the log", async () => {
    const summary = await Deno.makeTempFile({ prefix: "summary-" });
    const previous = Deno.env.get("GITHUB_STEP_SUMMARY");
    Deno.env.set("GITHUB_STEP_SUMMARY", summary);
    const log = console.log;
    console.log = () => {};
    try {
      describePlan(
        { lane: 1, of: 5, full: false, dryRun: true, laneCount: false, root },
        [],
        [],
        { objectName: "manifest-x.json.gz" },
        [],
        { selections: [], projectedSeconds: 0 },
        LANE_BUDGET_SECONDS,
        0,
        0,
      );
    } finally {
      console.log = log;
      if (previous === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
      else Deno.env.set("GITHUB_STEP_SUMMARY", previous);
    }
    expect(await Deno.readTextFile(summary)).toContain("manifest-x.json.gz");
    await Deno.remove(summary);
  });

  it("runs a lane that was given no share of the work", async () => {
    // The whole path, with nothing in it: no capability is opened, no
    // batch runs, and the directory the lane made for itself goes.
    //
    // The lane is given a temporary root of its own to make that in.
    // The shared one is a namespace every test file writes to at once,
    // so a check over it would answer about its neighbours rather than
    // about this lane.
    // The spool is made before the temporary root is redirected, so it
    // does not end up inside the directory this then checks and clears.
    const spool = await Deno.makeTempDir({ prefix: "lane-spool-" });
    const temp = await Deno.makeTempDir({ prefix: "lane-tmp-" });
    const previous = Deno.env.get("TMPDIR");
    Deno.env.set("TMPDIR", temp);
    // The spool is what makes the lane reach the point where it would
    // record what its setup cost. It opened nothing, so there is
    // nothing to record.
    const previousSpool = Deno.env.get("CF_TEST_RECORDS_DIR");
    Deno.env.set("CF_TEST_RECORDS_DIR", spool);
    const log = console.log;
    console.log = () => {};
    let ok: boolean;
    try {
      ok = await runLane({
        lane: 9999,
        of: 10000,
        full: true,
        dryRun: false,
        laneCount: false,
        root,
      });
    } finally {
      console.log = log;
      if (previous === undefined) Deno.env.delete("TMPDIR");
      else Deno.env.set("TMPDIR", previous);
      if (previousSpool === undefined) Deno.env.delete("CF_TEST_RECORDS_DIR");
      else Deno.env.set("CF_TEST_RECORDS_DIR", previousSpool);
    }
    expect(ok).toBe(true);
    // Named rather than counted: the private root keeps other test
    // files out, and anything else this process makes a temporary
    // directory for lands here too.
    const left = (await Array.fromAsync(Deno.readDir(temp)))
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("ci-lane-"));
    expect(left).toEqual([]);
    // Narrower than an empty spool: anything else in this process that
    // records writes there too once the variable is set.
    const spooled = (await Promise.all(
      (await Array.fromAsync(Deno.readDir(spool)))
        .filter((entry) => entry.isFile)
        .map((entry) => Deno.readTextFile(`${spool}/${entry.name}`)),
    )).join("");
    expect(spooled).not.toContain("ci-lane setup");
    await Deno.remove(temp, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  });
});

describe("what a lane records about itself", () => {
  const lane = {
    lane: 1,
    of: 5,
    full: false,
    dryRun: false,
    laneCount: false,
    root: REPOSITORY,
  };

  it("records what each batch cost, beside the records it gathered", async () => {
    // The publisher fits the suite overheads and corrections from these,
    // so they travel as ordinary records rather than a pipeline of their
    // own — and they stay unmarked, because they measure the lane rather
    // than an alternate execution of a test.
    const workDir = await Deno.makeTempDir({ prefix: "lane-timing-" });
    const spool = await Deno.makeTempDir({ prefix: "lane-spool-" });
    const report = `${workDir}/report.xml`;
    const suiteUnderTest = suite({
      id: "workspace-unit",
      units: ["one"],
      command: (_units, context) =>
        Promise.resolve([{
          command: [
            Deno.execPath(),
            "eval",
            `Deno.writeTextFileSync(${JSON.stringify(report)}, ${
              JSON.stringify(
                '<?xml version="1.0"?><testsuites><testsuite name="s" ' +
                  'tests="1" failures="0"><testcase name="bakes" ' +
                  'classname="test/bake.test.ts" time="0.25"/></testsuite>' +
                  "</testsuites>",
              )
            })`,
          ],
          cwd: context.root,
          junit: [{
            path: report,
            kind: "unit",
            scope: "bakery",
            filePrefix: "packages/bakery",
          }],
        }]),
    });
    const result = await runBatch(
      { suite: suiteUnderTest, units: [], repeats: 1 },
      lane,
      workDir,
      spool,
      {},
    );
    expect(result.ok).toBe(true);
    // The report's case reaches the lane's records with its file joined on.
    expect(result.records.map((record) => record.test.n)).toEqual(["bakes"]);
    expect(result.records[0]!.file).toBe("packages/bakery/test/bake.test.ts");

    const spooled: string[] = [];
    for await (const entry of Deno.readDir(spool)) {
      if (entry.isFile) {
        spooled.push(await Deno.readTextFile(`${spool}/${entry.name}`));
      }
    }
    const written = spooled.join("");
    expect(written).toContain("ci-lane batch workspace-unit");
    expect(written).toContain('"s":"ci"');
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  });

  /**
   * A batch whose one invocation spools exactly this record, run against
   * a suite declaring the surface and variant given.
   */
  async function spooling(
    record: TestIdentity,
    declared: Partial<Suite>,
  ): Promise<{
    ok: boolean;
    records: TestRecord[];
    conflicts: TestRecord[];
  }> {
    const workDir = await Deno.makeTempDir({ prefix: "lane-variant-" });
    const written = JSON.stringify({
      line: "record",
      test: record,
      outcome: "pass",
      durationMs: 1,
    });
    try {
      return await runBatch(
        {
          suite: suite({
            id: "package-integration-on",
            units: ["one"],
            command: (_units, context) =>
              Promise.resolve([{
                command: [
                  Deno.execPath(),
                  "eval",
                  `Deno.writeTextFileSync(
                    Deno.env.get("CF_TEST_RECORDS_DIR") + "/fragment-a.ndjson",
                    ${JSON.stringify(written + "\n")},
                  )`,
                ],
                cwd: context.root,
              }]),
            ...declared,
          }),
          units: [],
          repeats: 1,
        },
        lane,
        workDir,
        undefined,
        {},
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  }

  it("marks a batch's records with the variant its suite declares", async () => {
    // A variant belongs to the suite that ran, not to the producer that
    // reported, so it is written on regardless of what the producer said.
    const result = await spooling(
      { k: "integration", s: "runner", n: "attaches" },
      {
        variant: "server-execution",
        recordSurfaces: [{ kind: "integration", scope: "runner" }],
      },
    );
    expect(result.records[0]!.test.v).toBe("server-execution");
    expect(result.conflicts).toEqual([]);
  });

  it("leaves a record off the suite's surfaces as its producer wrote it", async () => {
    const result = await spooling(
      { k: "integration", s: "runner", n: "attaches" },
      {
        variant: "server-execution",
        recordSurfaces: [{ kind: "integration", scope: "shell" }],
      },
    );
    expect(result.records[0]!.test.v).toBeUndefined();
    expect(result.conflicts.length).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("reports a producer's own variant in a default batch", async () => {
    // The execution was a default one, so a marker on its record
    // describes a configuration that did not run.
    const result = await spooling(
      {
        k: "integration",
        s: "runner",
        n: "attaches",
        v: "server-execution",
      },
      { recordSurfaces: [{ kind: "integration", scope: "runner" }] },
    );
    expect(result.records[0]!.test.v).toBe("server-execution");
    expect(result.conflicts.length).toBe(1);
  });

  it("says how far past a lane's budget the mandatory set went", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        {
          lane: 1,
          of: 5,
          full: false,
          dryRun: true,
          laneCount: false,
          root: REPOSITORY,
          at: "2026-09-01T00:00:00Z",
        },
        {
          manifest: () =>
            Promise.resolve({
              // A gate the change did not touch, costing most of a lane:
              // `always` outranks the budget, so the lane takes it and
              // reports what that cost rather than dropping it.
              manifest: manifestOf([{
                test: { k: "format", s: "repo", n: "deno-fmt" },
                suite: "repo-gates",
                unit: "deno-fmt",
                // Past a lane's 230-second budget and inside the
                // 300-second bound, so it is placed and reported rather
                // than being unschedulable.
                cost: 280,
              }]),
              objectName: "manifest-fixture.json.gz",
            }),
        },
      );
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("past the");
  });
});

describe("the last corners of a lane's bookkeeping", () => {
  it("puts two identities of one unit in one batch, and skips neither", () => {
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const bakery = suite({
      id: "workspace-unit",
      units: ["packages/bakery/glaze.test.ts"],
    });
    const batches = batchesOf(
      [bakery],
      manifest,
      manifest.entries.map((entry) => ({
        entry,
        reason: "value" as const,
        repeats: 1,
      })),
    );
    expect(batches.length).toBe(1);
    expect(batches[0]!.units).toEqual([{
      unit: "packages/bakery/glaze.test.ts",
      skip: [],
    }]);
  });

  it("drops a selection whose suite the topology no longer has", () => {
    // A manifest naming a suite this tree does not declare is a
    // manifest written before the suite was renamed or removed.
    const manifest = manifestOf([{ suite: "a-suite-that-left" }]);
    expect(
      batchesOf([], manifest, [{
        entry: manifest.entries[0]!,
        reason: "value",
        repeats: 1,
      }]),
    ).toEqual([]);
  });
});

describe("writing the lane's records into its spool", () => {
  it("writes nothing when there is nothing to write", async () => {
    // A lane that opened no capability and ran no batch has nothing to
    // say about either, and an empty fragment would be a report of a
    // run that did not happen.
    const spool = await Deno.makeTempDir({ prefix: "lane-empty-" });
    spoolRecords(spool, []);
    expect(await Array.fromAsync(Deno.readDir(spool))).toEqual([]);
    await Deno.remove(spool, { recursive: true });
  });

  it("says nothing where the spool cannot be written", async () => {
    // Recording is telemetry: a spool this process cannot write costs
    // the run its records and must not cost it the run.
    //
    // The spool is a path underneath a file, which no user can make a
    // directory of, so the case occurs whoever the suite runs as. A
    // path that merely does not exist would not do: the superuser
    // creates it and the case never happens.
    const file = await Deno.makeTempFile({ prefix: "lane-not-a-dir-" });
    try {
      expect(() =>
        spoolRecords(`${file}/spool`, [{
          line: "record",
          test: { k: "gate", s: "ci", n: "ci-lane setup deno" },
          outcome: "pass",
          durationMs: 1,
        }])
      ).not.toThrow();
    } finally {
      await Deno.remove(file);
    }
  });
});

describe("what a lane does with the batches it was given", () => {
  /** A topology of one suite running the command a case names. */
  function topology(command: readonly string[]) {
    return () =>
      Promise.resolve([
        suite({
          id: "workspace-unit",
          units: ["packages/bakery/test/glaze.test.ts"],
          command: (_units, context) =>
            Promise.resolve([{ command: [...command], cwd: context.root }]),
        }),
      ]);
  }

  /** A manifest selecting that suite's one unit. */
  function selecting() {
    return () =>
      Promise.resolve({
        manifest: manifestOf([{}]),
        objectName: "manifest-fixture.json.gz",
      });
  }

  async function run(command: readonly string[]): Promise<boolean> {
    const log = console.log;
    console.log = () => {};
    try {
      return await runLane(
        {
          lane: 1,
          of: 1,
          full: false,
          dryRun: false,
          laneCount: false,
          root: REPOSITORY,
          at: "2026-09-01T00:00:00Z",
        },
        { manifest: selecting(), topology: topology(command) },
      );
    } finally {
      console.log = log;
    }
  }

  it("passes when every batch passed", async () => {
    expect(await run([Deno.execPath(), "eval", "0"])).toBe(true);
  });

  it("fails when a batch failed, having run it", async () => {
    // A lane reports what it measured: the batch ran and went red, so
    // the lane is red, and nothing about that is a crash or a timeout.
    expect(await run([Deno.execPath(), "eval", "Deno.exit(1)"])).toBe(false);
  });

  it("says it could not date the tree it is testing", async () => {
    // Outside a repository there is no commit to resolve the manifest
    // at, so the lane takes the newest manifest there is and prints
    // that it did rather than appearing to have chosen one.
    const outside = await Deno.makeTempDir({ prefix: "lane-nogit-" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        {
          lane: 1,
          of: 1,
          full: false,
          dryRun: true,
          laneCount: false,
          root: outside,
        },
        {
          manifest: () => Promise.resolve({ absent: "nothing published" }),
          topology: () => Promise.resolve([]),
        },
      );
    } finally {
      console.log = log;
      await Deno.remove(outside, { recursive: true });
    }
    expect(lines.join("\n")).toContain("cannot read the commit's date");
  });
});
