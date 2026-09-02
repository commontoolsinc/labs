import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  AliasResolver,
  buildObjectBody,
  type RunContext,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";

import {
  buildManifest,
  CI_SOURCE,
  dayOf,
  emptyAggregate,
  Fold,
  foldReports,
  identityOfKey,
  lastRun,
  localReporter,
  locateSurfaces,
  parseAggregate,
  provenance,
  readReport,
  recordSurface,
  repeatsFor,
  reportFromText,
} from "./build.ts";
import { parseManifest, serializeManifest } from "./manifest.ts";
import type { Suite } from "../test-topology/suite.ts";
import {
  daysBetween,
  emptyState,
  flakeRate,
  type IdentityState,
} from "./score.ts";
import {
  COST_WINDOW_DAYS,
  FLAKE_EXCLUSION_RATE,
  MAX_REPEATS,
} from "./policy.ts";

const NO_ALIASES = new AliasResolver([]);

function context(fields: Partial<RunContext> = {}): RunContext {
  return {
    schema: 1,
    line: "context",
    reportId: "01K3",
    repo: "commontoolsinc/labs",
    commit: "c1",
    dirty: false,
    branch: "main",
    env: "ci",
    ci: {
      workflowRunId: "1",
      runAttempt: 1,
      workflow: "deno.yml",
      job: "Test (1/8)",
      event: "push",
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: "2026-08-20T00:00:00.000Z",
    ...fields,
  };
}

function record(fields: Partial<TestRecord> = {}): TestRecord {
  return {
    line: "record",
    test: { k: "unit", s: "memory", n: "space > writes" },
    outcome: "pass",
    durationMs: 40,
    ...fields,
  };
}

/** One stored object, built the way the relay builds one. */
function stored(
  objectName: string,
  runContext: RunContext,
  records: readonly TestRecord[],
) {
  return reportFromText(objectName, buildObjectBody(runContext, records));
}

const KEY = testIdentityKey({ k: "unit", s: "memory", n: "space > writes" });
const CI_NAME = "labs/test-records/submissions/ci/v1/2026/08/20/run-1-a.ndjson";
const LOCAL_NAME =
  "labs/test-records/submissions/local/ianh/v1/2026/08/20/01K3-branch.ndjson";

describe("build", () => {
  describe("provenance()", () => {
    it("reads a push to main as a run on main", () => {
      expect(provenance(context(), CI_NAME)).toEqual({
        place: "main",
        source: "main",
      });
    });

    it("reads any other branch as a pull request", () => {
      expect(provenance(context({ branch: "fix-writes" }), CI_NAME)).toEqual({
        place: "pr",
        source: "fix-writes",
      });
    });

    it("names the reporting person for a local run", () => {
      const local = context({
        env: "local",
        branch: "fix-writes",
      });
      delete local.ci;
      expect(provenance(local, LOCAL_NAME)).toEqual({
        place: "local",
        source: "ianh",
      });
    });

    it("declines a fork run, whose records the fork authored", () => {
      const forked = context();
      forked.ci!.fork = true;
      expect(provenance(forked, CI_NAME)).toBeUndefined();
    });

    it("declines a report with no context", () => {
      expect(provenance(undefined, CI_NAME)).toBeUndefined();
    });

    it("declines a continuous-integration run that names no branch", () => {
      // The branch is the source a catch is attributed to, so a run with
      // none cannot be told apart from any other run with none.
      const nameless = context();
      delete nameless.branch;
      expect(provenance(nameless, CI_NAME)).toBeUndefined();
      expect(provenance(context({ branch: "" }), CI_NAME)).toBeUndefined();
    });
  });

  describe("localReporter()", () => {
    it("reads the person out of a local object's name", () => {
      expect(localReporter(LOCAL_NAME)).toBe("ianh");
    });

    it("finds nobody in a continuous-integration object's name", () => {
      expect(localReporter(CI_NAME)).toBeUndefined();
    });
  });

  describe("dayOf()", () => {
    it("takes the UTC calendar day", () => {
      expect(dayOf("2026-08-20T23:59:59.000Z")).toBe("2026-08-20");
    });
  });

  describe("recordSurface()", () => {
    it("groups by kind and scope, and by variant when there is one", () => {
      expect(recordSurface({ k: "unit", s: "memory", n: "a" }, undefined).suite)
        .toBe("unit:memory");
      expect(
        recordSurface({ k: "unit", s: "memory", n: "a", v: "on" }, undefined)
          .suite,
      ).toBe("unit:memory:on");
    });

    it("takes the file as the invocation unit when one is known", () => {
      expect(
        recordSurface(
          { k: "unit", s: "memory", n: "a" },
          "packages/memory/test/space.test.ts",
        ).unit,
      ).toBe("packages/memory/test/space.test.ts");
    });

    it("keeps a file-backed unit when a later record has none", () => {
      const read = readReport(
        stored(CI_NAME, context(), [
          record({ file: "packages/memory/test/space.test.ts" }),
          record(),
        ]),
        NO_ALIASES,
      );
      expect([...read.surfaces.values()][0]!.unit).toEqual(
        "packages/memory/test/space.test.ts",
      );
    });

    it("falls back to the identity's own name", () => {
      expect(
        recordSurface({ k: "pattern", s: "patterns", n: "a.tsx" }, undefined)
          .unit,
      ).toBe("a.tsx");
    });
  });

  describe("repeatsFor()", () => {
    it("runs a steady test once", () => {
      expect(repeatsFor(0)).toBe(1);
    });

    it("runs a slightly intermittent one more than once", () => {
      expect(repeatsFor(0.02)).toBeGreaterThan(1);
      expect(repeatsFor(0.04)).toBe(MAX_REPEATS);
    });

    it("runs one past the exclusion rate once, since it is not selected", () => {
      expect(repeatsFor(FLAKE_EXCLUSION_RATE + 0.1)).toBe(1);
    });
  });

  describe("readReport()", () => {
    it("turns a stored object into observations", () => {
      const read = readReport(
        stored(CI_NAME, context(), [record(), record({ outcome: "fail" })]),
        NO_ALIASES,
      );
      expect(read.observations.length).toBe(2);
      expect(read.observations[0]!.place).toBe("main");
      expect(read.observations[0]!.day).toBe("2026-08-20");
    });

    it("keeps the durations of everything that ran", () => {
      const read = readReport(
        stored(CI_NAME, context(), [
          record({ durationMs: 10 }),
          record({ durationMs: 90 }),
          record({ outcome: "skip", durationMs: 5000 }),
        ]),
        NO_ALIASES,
      );
      const byDay = [...read.durations.values()][0]!;
      expect(byDay.get("2026-08-20")).toEqual([10, 90]);
    });

    it("reads nothing from a fork run", () => {
      const forked = context();
      forked.ci!.fork = true;
      expect(
        readReport(stored(CI_NAME, forked, [record()]), NO_ALIASES)
          .observations,
      ).toEqual([]);
    });
  });

  describe("the fold", () => {
    it("folds a stream in chunks the way it folds one batch", () => {
      const reports = [
        stored(CI_NAME, context({ commit: "c1" }), [record()]),
        stored(
          `${CI_NAME}2`,
          context({
            commit: "c2",
            startedAt: "2026-08-20T01:00:00.000Z",
          }),
          [record({ outcome: "fail" })],
        ),
        stored(
          `${CI_NAME}3`,
          context({
            commit: "c3",
            startedAt: "2026-08-20T02:00:00.000Z",
          }),
          [record()],
        ),
      ];
      const whole = foldReports(
        emptyAggregate("2026-08-20"),
        reports,
        NO_ALIASES,
        "2026-08-20",
      );
      const streamed = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      for (const report of reports) streamed.add([report]);
      expect(streamed.finish().states).toEqual(whole.states);
    });

    it("does not fold a day it took from a rollup", () => {
      // A rollup carries the day's reports whole, so its raw objects
      // never reach `folded`; a later run over a wide window has to ask
      // about the day or it folds the day twice and doubles its catches.
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      expect(fold.settled(CI_SOURCE, "2026/08/10")).toBe(false);
      fold.markSettled(CI_SOURCE, "2026/08/10");
      expect(fold.settled(CI_SOURCE, "2026/08/10")).toBe(true);
      expect(fold.finish().aggregate.compacted).toEqual(["ci\t2026/08/10"]);
    });

    it("leaves a local source of a settled day still owing", () => {
      // Rollups cover the continuous-integration area alone, so a receipt
      // naming the day by itself would say the day is accounted for and
      // that day's local submissions would never be read.
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      fold.markSettled(CI_SOURCE, "2026/08/10");
      expect(fold.settled("local/ianh", "2026/08/10")).toBe(false);
    });

    it("knows which source and date it holds raw objects from", () => {
      // A rollup written after them would overlap what they contributed,
      // and nothing in one of this format says by how much.
      const fold = new Fold(
        {
          ...emptyAggregate("2026-08-20"),
          folded: [CI_NAME, LOCAL_NAME],
        },
        NO_ALIASES,
        "2026-08-20",
      );
      expect(fold.hasRaw(CI_SOURCE, "2026/08/20")).toBe(true);
      expect(fold.hasRaw("local/ianh", "2026/08/20")).toBe(true);
      expect(fold.hasRaw(CI_SOURCE, "2026/08/19")).toBe(false);
      expect(fold.hasRaw("local/someone-else", "2026/08/20")).toBe(false);
    });

    it("carries the settled pairs across a saved aggregate", () => {
      const first = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      first.markSettled(CI_SOURCE, "2026/08/10");
      const saved = parseAggregate(
        JSON.stringify(first.finish().aggregate),
      );
      expect(saved).toBeDefined();
      const second = new Fold(saved!, NO_ALIASES, "2026-08-21");
      expect(second.settled(CI_SOURCE, "2026/08/10")).toBe(true);
    });

    it("reads an aggregate written before rollups as settling nothing", () => {
      const older = { ...emptyAggregate("2026-08-20") } as Record<
        string,
        unknown
      >;
      delete older.compacted;
      const parsed = parseAggregate(JSON.stringify(older));
      expect(parsed?.compacted).toEqual([]);
    });

    it("reads a receipt naming a day alone as the shared area's", () => {
      // That area is the only one a rollup has ever covered, so nothing
      // else could have written the receipt, and reading it forward is
      // exact rather than a guess.
      const older = { ...emptyAggregate("2026-08-20") } as Record<
        string,
        unknown
      >;
      delete older.compacted;
      older.compactedDays = ["2026/08/10"];
      expect(parseAggregate(JSON.stringify(older))?.compacted).toEqual([
        "ci\t2026/08/10",
      ]);
    });

    it("carries what the cross-run rules saw into the next run", () => {
      // A commit's runs can arrive in two publisher runs. Without the
      // context, the second would not see that the identity had already
      // passed at that commit, and would read the failure as a catch
      // rather than as the test disagreeing with itself.
      const first = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      first.add([stored(CI_NAME, context({ commit: "c1" }), [record()])]);
      const saved = parseAggregate(JSON.stringify(first.finish().aggregate))!;
      expect(saved.context!.outcomesAtCommit.length).toBeGreaterThan(0);

      const second = new Fold(saved, NO_ALIASES, "2026-08-20");
      second.add([
        stored(
          `${CI_NAME}2`,
          context({ commit: "c1", startedAt: "2026-08-20T01:00:00.000Z" }),
          [record({ outcome: "fail" })],
        ),
      ]);
      const state = second.finish().states.get(KEY)!;
      expect(state.mainCatches).toBe(0);
      expect(flakeRate(state, "2026-08-20")).toBe(1);
    });

    it("does not fold an object it has already folded", () => {
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.folded.push(CI_NAME);
      const fold = new Fold(aggregate, NO_ALIASES, "2026-08-20");
      expect(fold.knows(CI_NAME)).toBe(true);
      expect(fold.knows(`${CI_NAME}2`)).toBe(false);
    });

    it("names the identities the newest run on main left red", () => {
      const folded = foldReports(
        emptyAggregate("2026-08-20"),
        [stored(CI_NAME, context(), [record({ outcome: "fail" })])],
        NO_ALIASES,
        "2026-08-20",
      );
      expect(folded.mainRed.size).toBe(1);
    });
  });

  describe("parseAggregate()", () => {
    it("round-trips an aggregate", () => {
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.folded.push(CI_NAME);
      expect(parseAggregate(JSON.stringify(aggregate))).toEqual(aggregate);
    });

    it("returns undefined for anything that is not one", () => {
      expect(parseAggregate("{not json")).toBeUndefined();
      expect(parseAggregate('{"schema":99}')).toBeUndefined();
      expect(parseAggregate('{"schema":1,"day":"x"}')).toBeUndefined();
    });

    it("refuses a shape it would otherwise have to guess at", () => {
      const whole = {
        schema: 1,
        day: "2026-08-20",
        folded: [],
        states: {},
        compacted: [],
      };
      const refused: Array<[string, unknown]> = [
        ["a document that is not an object", 7],
        ["a null document", null],
        ["no folded list", { ...whole, folded: undefined }],
        ["a folded list that is not one", { ...whole, folded: "one.ndjson" }],
        ["a folded name that is not one", { ...whole, folded: [7] }],
        ["states that are not a record", { ...whole, states: [] }],
        ["null states", { ...whole, states: null }],
        [
          "a compacted list that is not one",
          { ...whole, compacted: "2026-08-20" },
        ],
        ["a settled pair that is not one", { ...whole, compacted: [7] }],
      ];
      for (const [what, value] of refused) {
        expect(parseAggregate(JSON.stringify(value)), what).toBeUndefined();
      }
    });

    it("reads an aggregate written before rollups were read", () => {
      // No compacted list at all is the truthful reading that nothing
      // was compacted, which is different from a list it cannot read.
      const before = {
        schema: 1,
        day: "2026-08-20",
        folded: [],
        states: {},
      };
      expect(parseAggregate(JSON.stringify(before))?.compacted).toEqual([]);
    });
  });

  describe("identityOfKey()", () => {
    it("recovers the identity a canonical key names", () => {
      expect(identityOfKey('["unit","memory","a"]')).toEqual({
        k: "unit",
        s: "memory",
        n: "a",
      });
      expect(identityOfKey('["unit","memory","a","on"]')).toEqual({
        k: "unit",
        s: "memory",
        n: "a",
        v: "on",
      });
    });

    it("returns undefined for anything that is not one", () => {
      expect(identityOfKey("not json")).toBeUndefined();
      expect(identityOfKey('["unit","memory"]')).toBeUndefined();
      expect(identityOfKey('["unit",1,"a"]')).toBeUndefined();
    });
  });

  describe("locateSurfaces()", () => {
    /** A suite claiming what a case tells it to. */
    function claiming(id: string, locate: Suite["locate"]): Suite {
      return {
        id,
        recordSurfaces: [{ kind: "unit", scope: "memory" }],
        needs: ["deno"],
        units: [],
        unavailable: [],
        locate,
        command: () => Promise.resolve([]),
      };
    }

    it("names the suite and unit the topology says, not the record's own", () => {
      const { placed } = locateSurfaces(
        [claiming("workspace-unit", () => ({
          level: "unit",
          unit: "packages/memory/test/space.test.ts",
        }))],
        new Map([[KEY, {
          suite: "unit:memory",
          unit: "packages/memory/test/space.test.ts",
          fromFile: true,
        }]]),
      );
      expect(placed.get(KEY)).toEqual({
        suite: "workspace-unit",
        unit: "packages/memory/test/space.test.ts",
        fromFile: true,
      });
    });

    it("passes on an identity that measures the suite rather than a unit", () => {
      // An overlapping whole-invocation record names no unit, so nothing
      // can be asked to run one of them.
      const { placed, unplaced } = locateSurfaces(
        [claiming("cli-core", () => ({ level: "suite" }))],
        new Map([[KEY, {
          suite: "unit:memory",
          unit: "space > writes",
          fromFile: false,
        }]]),
      );
      expect(placed.size).toBe(0);
      expect(unplaced.suiteLevel).toEqual([KEY]);
    });

    it("passes on an identity no suite claims", () => {
      const { placed, unplaced } = locateSurfaces(
        [claiming("workspace-unit", () => undefined)],
        new Map([[KEY, {
          suite: "unit:memory",
          unit: "space > writes",
          fromFile: false,
        }]]),
      );
      expect(placed.size).toBe(0);
      expect(unplaced.unclaimed).toEqual([KEY]);
    });

    it("passes over a key that names no identity", () => {
      // The surfaces come from a stored aggregate, which is untrusted
      // input like every other object in the store, so a key nothing can
      // read is skipped rather than thrown on.
      const { placed, unplaced } = locateSurfaces(
        [claiming("workspace-unit", () => ({ level: "unit", unit: "one" }))],
        new Map([["not an identity key", {
          suite: "unit:memory",
          unit: "space > writes",
          fromFile: false,
        }]]),
      );
      expect(placed.size).toBe(0);
      expect(unplaced).toEqual({ suiteLevel: [], unclaimed: [] });
    });

    it("passes on an identity two suites claim", () => {
      // Two claims on one identity is a topology defect that the drift
      // guard fails on, and placing it either way would put the work in
      // whichever suite happened to come first.
      const unit = { level: "unit" as const, unit: "one" };
      const { placed, unplaced } = locateSurfaces(
        [claiming("a", () => unit), claiming("b", () => unit)],
        new Map([[KEY, {
          suite: "unit:memory",
          unit: "space > writes",
          fromFile: false,
        }]]),
      );
      expect(placed.size).toBe(0);
      expect(unplaced.unclaimed).toEqual([KEY]);
    });
  });

  describe("buildManifest()", () => {
    it("produces a manifest its own validator accepts", () => {
      const folded = foldReports(
        emptyAggregate("2026-08-20"),
        [stored(CI_NAME, context(), [
          record(),
          record({
            test: { k: "unit", s: "memory", n: "space > reads" },
          }),
        ])],
        NO_ALIASES,
        "2026-08-20",
      );
      const manifest = buildManifest({
        states: folded.states,
        mainRed: folded.mainRed,
        surfaces: folded.surfaces,
        today: "2026-08-20",
        generatedAt: "2026-08-20T04:00:00.000Z",
        seed: "01K3",
        commit: "c1",
        runs: 1,
      });
      expect(manifest.entries.length).toBe(2);
      expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    });

    it("withholds an identity failing in the newest run on main", () => {
      const folded = foldReports(
        emptyAggregate("2026-08-20"),
        [stored(CI_NAME, context(), [record({ outcome: "fail" })])],
        NO_ALIASES,
        "2026-08-20",
      );
      const manifest = buildManifest({
        states: folded.states,
        mainRed: folded.mainRed,
        surfaces: folded.surfaces,
        today: "2026-08-20",
        generatedAt: "2026-08-20T04:00:00.000Z",
        seed: "01K3",
        commit: "c1",
        runs: 1,
      });
      expect(manifest.withheld.map((held) => held.reason)).toEqual([
        "main-red",
      ]);
    });

    it("takes the last day an identity actually ran, not the last it holds", () => {
      // A day can be carried with no runs in it once the counters have
      // been aged, and reading that as the last run would tell the
      // exploration draw a test it has been ignoring was just run.
      expect(lastRun({
        ...emptyState(),
        runsByDay: { "2026-08-18": 3, "2026-08-19": 0, "2026-08-20": 0 },
      })).toBe("2026-08-18");
    });

    it("has no last day for an identity nothing has run", () => {
      expect(lastRun(emptyState())).toBeUndefined();
    });

    it("carries the last day anything ran an identity", () => {
      // The exploration draw takes the longest-unrun first, so without
      // this it has nothing to order by and sweeps nothing.
      const folded = foldReports(
        emptyAggregate("2026-08-19"),
        [
          stored(CI_NAME, context(), [record()]),
          stored(
            `${CI_NAME}2`,
            context({
              commit: "c2",
              startedAt: "2026-08-19T00:00:00.000Z",
            }),
            [record()],
          ),
        ],
        NO_ALIASES,
        "2026-08-20",
      );
      const manifest = buildManifest({
        states: folded.states,
        mainRed: folded.mainRed,
        surfaces: folded.surfaces,
        today: "2026-08-20",
        generatedAt: "2026-08-20T04:00:00.000Z",
        seed: "01K3",
        commit: "c1",
        runs: 2,
      });
      expect(manifest.entries[0]!.lastRun).toBe("2026-08-20");
    });
  });
});

describe("a fold's count of what it has folded", () => {
  it("counts every execution, not every object", () => {
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    expect(fold.observations).toBe(0);
    fold.add([stored(CI_NAME, context(), [record(), record()])]);
    expect(fold.observations).toBe(2);
    expect(fold.finish().observations).toBe(2);
  });
});

describe("what buildManifest() does with the states it is given", () => {
  const KEY = testIdentityKey({ k: "unit", s: "memory", n: "space > writes" });

  function built(
    states: Map<string, IdentityState>,
    mainRed = new Set<string>(),
  ) {
    return buildManifest({
      states,
      mainRed,
      surfaces: new Map(),
      today: "2026-08-20",
      generatedAt: "2026-08-20T00:00:00.000Z",
      seed: "01K3SAMPLE",
      commit: "c8893b3a8",
      runs: 1,
    });
  }

  it("skips a state whose key does not name an identity", () => {
    // A key that is not one cannot be turned back into a test to run, so
    // carrying it would put an entry in the manifest naming nothing.
    const states = new Map([
      ["not a key", emptyState()],
      ["[]", emptyState()],
      [KEY, emptyState()],
    ]);
    expect(built(states).entries.length).toBe(1);
  });

  it("withholds a test that disagrees with itself too often", () => {
    const state = emptyState();
    state.failuresByDay["2026-08-20"] = 10;
    state.flakesByDay["2026-08-20"] = 10;
    const manifest = built(new Map([[KEY, state]]));
    expect(manifest.withheld.length).toBe(1);
    expect(manifest.withheld[0]!.reason).toBe("flaky");
  });

  it("calls a test failing on main red, however flaky it also is", () => {
    // The two reasons are exclusive, and being broken on the default
    // branch is the one that decides what a pull request may act on.
    const state = emptyState();
    state.failuresByDay["2026-08-20"] = 10;
    state.flakesByDay["2026-08-20"] = 10;
    const manifest = built(new Map([[KEY, state]]), new Set([KEY]));
    expect(manifest.withheld.length).toBe(1);
    expect(manifest.withheld[0]!.reason).toBe("main-red");
  });

  it("withholds nothing for a test that has never failed", () => {
    expect(built(new Map([[KEY, emptyState()]])).withheld).toEqual([]);
  });
});

describe("a batch whose reports interleave in time", () => {
  const KEY = testIdentityKey({ k: "unit", s: "memory", n: "space > writes" });

  /** One object holding one run of the test at one commit. */
  function run(commit: string, outcome: TestRecord["outcome"], at: string) {
    return stored(
      `labs/test-records/aggregated/v1/2026/08/20/shard-${commit}.ndjson`,
      context({ commit, startedAt: at }),
      [record({ outcome })],
    );
  }

  function foldedIn(reports: ReturnType<typeof run>[]) {
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    fold.add(reports);
    return fold.finish().states.get(KEY)!;
  }

  it("folds a day's shards in the order the runs happened", () => {
    // A rollup holds a whole day, and its shards are read concurrently,
    // so the order they arrive in is not the order they ran in. The
    // rules that decide whether a failure is a catch look backwards and
    // forwards along that order, so it has to be the real one.
    const broke = run("c1", "fail", "2026-08-20T01:00:00.000Z");
    const fixed = run("c2", "pass", "2026-08-20T02:00:00.000Z");
    expect(foldedIn([broke, fixed]).mainCatches).toBe(1);
    expect(foldedIn([fixed, broke]).mainCatches).toBe(1);
  });

  it("reaches the same state whichever order the shards arrive in", () => {
    const reports = [
      run("c1", "fail", "2026-08-20T01:00:00.000Z"),
      run("c2", "pass", "2026-08-20T02:00:00.000Z"),
      run("c3", "fail", "2026-08-20T03:00:00.000Z"),
      run("c4", "pass", "2026-08-20T04:00:00.000Z"),
    ];
    const forwards = foldedIn(reports);
    const backwards = foldedIn([...reports].reverse());
    const shuffled = foldedIn([
      reports[2]!,
      reports[0]!,
      reports[3]!,
      reports[1]!,
    ]);
    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
    expect(forwards.mainCatches).toBe(2);
  });
});

describe("a report holding a whole day", () => {
  it("folds a rollup shard larger than a call can carry arguments", () => {
    // A rollup shard is a whole day of records in one object. Appending
    // its observations by spreading them as arguments overflows the
    // stack, and the rollup path is the one that reads these.
    const many = Array.from(
      { length: 200_000 },
      (_, i) => record({ test: { k: "unit", s: "memory", n: `case ${i}` } }),
    );
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    fold.add([stored(CI_NAME, context(), many)]);
    expect(fold.observations).toBe(many.length);
  });
});

describe("the days a fold measures cost over", () => {
  const KEY = testIdentityKey({ k: "unit", s: "memory", n: "space > writes" });

  /** One run of the test on `day`, taking `ms`. */
  function ranOn(day: string, ms: number) {
    return stored(
      `labs/test-records/submissions/ci/v1/${
        day.replaceAll("-", "/")
      }/r.ndjson`,
      context({ startedAt: `${day}T00:00:00.000Z`, commit: `c-${day}` }),
      [record({ durationMs: ms })],
    );
  }

  function costsAfterFolding(days: readonly string[]) {
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    for (const day of days) fold.add([ranOn(day, 1000)]);
    return fold.finish().states.get(KEY)!.costByDay;
  }

  it("keeps a day inside the window", () => {
    expect(Object.keys(costsAfterFolding(["2026-08-20"]))).toEqual([
      "2026-08-20",
    ]);
  });

  it("holds no cost for a day the window cannot reach", () => {
    // This is what makes not sampling such a day safe: `finish` seals a
    // day's cost and then ages it off in the same call, so a day past
    // the window has no cost either way, and sampling it only costs the
    // memory to hold sixty days of samples during a bootstrap.
    const old = "2026-06-01";
    expect(daysBetween(old, "2026-08-20")).toBeGreaterThan(COST_WINDOW_DAYS);
    expect(costsAfterFolding([old])).toEqual({});
    expect(costsAfterFolding([old, "2026-08-20"])).toEqual(
      costsAfterFolding(["2026-08-20"]),
    );
  });
});
