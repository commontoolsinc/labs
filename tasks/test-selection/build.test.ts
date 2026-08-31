import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  AliasResolver,
  buildObjectBody,
  type RunContext,
  type TestRecord,
} from "@commonfabric/test-support/records";

import {
  buildManifest,
  dayOf,
  emptyAggregate,
  Fold,
  foldReports,
  identityOfKey,
  localReporter,
  parseAggregate,
  provenance,
  readReport,
  recordSurface,
  repeatsFor,
  reportFromText,
} from "./build.ts";
import { parseManifest, serializeManifest } from "./manifest.ts";
import { FLAKE_EXCLUSION_RATE, MAX_REPEATS } from "./policy.ts";

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
      expect(fold.knowsDay("2026/08/10")).toBe(false);
      fold.markCompacted("2026/08/10");
      expect(fold.knowsDay("2026/08/10")).toBe(true);
      expect(fold.finish().aggregate.compactedDays).toEqual(["2026/08/10"]);
    });

    it("carries the compacted days across a saved aggregate", () => {
      const first = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      first.markCompacted("2026/08/10");
      const saved = parseAggregate(
        JSON.stringify(first.finish().aggregate),
      );
      expect(saved).toBeDefined();
      const second = new Fold(saved!, NO_ALIASES, "2026-08-21");
      expect(second.knowsDay("2026/08/10")).toBe(true);
    });

    it("reads an aggregate written before rollups as compacting nothing", () => {
      const older = { ...emptyAggregate("2026-08-20") } as Record<
        string,
        unknown
      >;
      delete older.compactedDays;
      const parsed = parseAggregate(JSON.stringify(older));
      expect(parsed?.compactedDays).toEqual([]);
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
  });
});
