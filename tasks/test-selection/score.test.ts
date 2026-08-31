import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  churn,
  COST_SAMPLE_CAP,
  costSeconds,
  type DaySamples,
  daysBetween,
  emptyContext,
  emptyState,
  flakeRate,
  foldObservations,
  type Observation,
  parseContext,
  percentile90,
  sampledPercentile90,
  sampleDuration,
  scoreInputs,
  sealDay,
  serializeContext,
  trimContext,
  trimWindows,
  value,
} from "./score.ts";
import { VALUE_FLOOR } from "./policy.ts";
import { testIdentityKey } from "@commonfabric/test-support/records";

const TEST = { k: "unit", s: "memory", n: "space > writes a fact" };
const KEY = testIdentityKey(TEST);

/** One observation, with the parts a case does not care about filled in. */
function saw(
  outcome: "pass" | "fail" | "skip",
  fields: Partial<Observation> = {},
): Observation {
  return {
    test: TEST,
    outcome,
    durationMs: 100,
    day: "2026-08-20",
    startedAt: "2026-08-20T00:00:00.000Z",
    commit: "c1",
    source: "main",
    place: "main",
    ...fields,
  };
}

function stateFrom(observations: readonly Observation[]) {
  const state = foldObservations(observations).states.get(KEY);
  expect(state).toBeDefined();
  return state!;
}

describe("score", () => {
  describe("a stored fold context", () => {
    it("round-trips what a run learned", () => {
      const context = emptyContext();
      context.mainAtCommit.set("k c1", { day: "2026-08-20", outcome: "fail" });
      context.credited.set("k c1 branch", "2026-08-20");
      const back = parseContext(serializeContext(context));
      expect(back.mainAtCommit.get("k c1")?.outcome).toBe("fail");
      expect(back.credited.get("k c1 branch")).toBe("2026-08-20");
    });

    it("drops what it cannot read rather than believing it", () => {
      // An unknown outcome would read as one more thing the identity did
      // at that commit, and two of them is the test disagreeing with
      // itself, which suppresses a real catch. A credited entry with no
      // readable day can never be aged out, so it suppresses one forever.
      const back = parseContext({
        outcomesAtCommit: [["k c1", { day: "2026-08-20", outcomes: ["wat"] }]],
        mainAtCommit: [["k c1", { day: "nope", outcome: "fail" }]],
        credited: [["k c1 branch", "not a day"]],
        failures: [["k", [{ day: "2026-08-20", source: "branch" }]]],
      });
      expect(back.outcomesAtCommit.size).toBe(0);
      expect(back.mainAtCommit.size).toBe(0);
      expect(back.credited.size).toBe(0);
      expect(back.failures.size).toBe(1);
    });

    it("rejects a day the calendar does not have", () => {
      // "2026-02-31" parses, rolling forward into March. Believed, it
      // would be aged from three days later than it claims, so a stored
      // entry outlives the window it was meant to be dropped from.
      const back = parseContext({
        outcomesAtCommit: [],
        mainAtCommit: [
          ["k a", { day: "2026-02-31", outcome: "fail" }],
          ["k b", { day: "2026-02-30", outcome: "fail" }],
          ["k c", { day: "2025-02-29", outcome: "fail" }],
          ["k d", { day: "2026-02-28", outcome: "fail" }],
        ],
        credited: [],
        failures: [],
      });
      expect([...back.mainAtCommit.keys()]).toEqual(["k d"]);
    });

    it("keeps the last day of a month, and a real leap day", () => {
      const back = parseContext({
        outcomesAtCommit: [],
        mainAtCommit: [
          ["k a", { day: "2026-01-31", outcome: "fail" }],
          ["k b", { day: "2024-02-29", outcome: "fail" }],
          ["k c", { day: "2026-12-31", outcome: "fail" }],
        ],
        credited: [],
        failures: [],
      });
      expect(back.mainAtCommit.size).toBe(3);
    });

    it(
      "starts from nothing rather than believing a shape it cannot read",
      () => {
        // A context is an optimization over re-reading, so an unreadable
        // one costs the two cross-run rules their reach and nothing else.
        for (const value of [undefined, null, 7, "a context", []]) {
          const back = parseContext(value);
          expect(back.outcomesAtCommit.size).toBe(0);
          expect(back.mainAtCommit.size).toBe(0);
          expect(back.credited.size).toBe(0);
          expect(back.failures.size).toBe(0);
        }
      },
    );

    it("keeps only the pairs that are pairs", () => {
      const back = parseContext({
        outcomesAtCommit: "not a list",
        mainAtCommit: [7, ["k a"], [9, { day: "2026-08-20", outcome: "fail" }]],
        credited: [["k a b", "2026-08-20"], [7, "2026-08-20"]],
        failures: 7,
      });
      expect(back.mainAtCommit.size).toBe(0);
      expect([...back.credited.keys()]).toEqual(["k a b"]);
    });

    it("drops an entry whose held value is not a record", () => {
      const back = parseContext({
        outcomesAtCommit: [["k a", "yesterday"], ["k b", null]],
        mainAtCommit: [["k a", 7], ["k b", null]],
        credited: [],
        failures: [["k a", "not a list"], ["k b", 7]],
      });
      expect(back.outcomesAtCommit.size).toBe(0);
      expect(back.mainAtCommit.size).toBe(0);
      expect(back.failures.size).toBe(0);
    });

    it("drops an outcome record with no readable day or outcomes", () => {
      const back = parseContext({
        outcomesAtCommit: [
          ["k a", { day: 7, outcomes: ["pass"] }],
          ["k b", { day: "2026-08-20", outcomes: "pass" }],
          ["k c", { day: "2026-08-20", outcomes: ["wat"] }],
          ["k d", { day: "2026-08-20", outcomes: ["pass", "fail"] }],
        ],
        mainAtCommit: [
          ["k a", { day: "2026-08-20", outcome: "skip" }],
          ["k b", { day: "2026-08-20", outcome: "pass" }],
        ],
        credited: [],
        failures: [],
      });
      expect([...back.outcomesAtCommit.keys()]).toEqual(["k d"]);
      // A skip is not an outcome the cross-run rules act on, so a stored
      // one is not a main verdict to be resumed from.
      expect([...back.mainAtCommit.keys()]).toEqual(["k b"]);
    });

    it("keeps a failure list, dropping the failures it cannot read", () => {
      const back = parseContext({
        outcomesAtCommit: [],
        mainAtCommit: [],
        credited: [],
        failures: [["k a", [
          { day: "2026-08-20", source: "branch" },
          { day: "nope", source: "branch" },
          { day: "2026-08-20", source: 7 },
          null,
        ]]],
      });
      expect(back.failures.get("k a")?.length).toBe(1);
    });

    it("drops a whole entry when nothing in it survives", () => {
      const back = parseContext({
        outcomesAtCommit: [],
        mainAtCommit: [],
        credited: [],
        failures: [["k a", [{ day: "nope", source: "branch" }]]],
      });
      expect(back.failures.size).toBe(0);
    });

    it("ages out what the rules can no longer reach", () => {
      const context = emptyContext();
      context.mainAtCommit.set("k old", { day: "2026-01-01", outcome: "fail" });
      context.mainAtCommit.set("k new", { day: "2026-08-20", outcome: "fail" });
      context.credited.set("k old branch", "2026-01-01");
      trimContext(context, "2026-08-20");
      expect([...context.mainAtCommit.keys()]).toEqual(["k new"]);
      expect(context.credited.size).toBe(0);
    });

    it("drops a failure list once every failure in it is stale", () => {
      const context = emptyContext();
      context.failures.set("k gone", [{ day: "2020-01-01", source: "a" }]);
      context.failures.set("k here", [
        { day: "2020-01-01", source: "a" },
        { day: "2026-08-20", source: "b" },
      ]);
      context.outcomesAtCommit.set("k old", {
        day: "2020-01-01",
        outcomes: new Set(["fail"]),
      });
      trimContext(context, "2026-08-20");
      expect([...context.failures.keys()]).toEqual(["k here"]);
      expect(context.failures.get("k here")?.length).toBe(1);
      expect(context.outcomesAtCommit.size).toBe(0);
    });
  });

  describe("what counts as a catch", () => {
    it("counts a failure on a branch where main was green", () => {
      const state = stateFrom([
        saw("pass", { day: "2026-08-19", commit: "c0" }),
        saw("fail", { commit: "c1", place: "pr", source: "fix-writes" }),
      ]);
      expect(state.prCatches).toBe(1);
      expect(state.lastCatch).toBe("2026-08-20");
    });

    it("counts nothing at a commit where main was already red", () => {
      const state = stateFrom([
        saw("fail", { day: "2026-08-19", commit: "c0" }),
        saw("fail", { commit: "c1", place: "pr", source: "fix-writes" }),
      ]);
      expect(state.prCatches).toBe(0);
    });

    it("reads a pass and a failure at one commit as a flake", () => {
      const state = stateFrom([
        saw("pass", { commit: "c1", place: "pr", source: "branch" }),
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
      ]);
      expect(state.prCatches).toBe(0);
      expect(flakeRate(state, "2026-08-20")).toBe(1);
    });

    it("reads a failure across many branches as the environment", () => {
      const branches = ["a", "b", "c", "d", "e", "f"];
      const state = stateFrom(
        branches.map((branch, i) =>
          saw("fail", { commit: `c${i}`, place: "pr", source: branch })
        ),
      );
      expect(state.prCatches).toBe(0);
    });

    it("counts one catch however often a broken commit is re-run", () => {
      const state = stateFrom([
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
      ]);
      expect(state.prCatches).toBe(1);
    });

    it("weighs a catch on a workstation double", () => {
      const state = stateFrom([
        saw("fail", { commit: "c1", place: "local", source: "ianh" }),
      ]);
      expect(state.localCatches).toBe(1);
      expect(scoreInputs(state, "2026-08-20").catches).toBe(2);
    });
  });

  describe("a failure on main, judged by what came next", () => {
    it("waits while the same failure is still there", () => {
      const state = stateFrom([
        saw("fail", { day: "2026-08-19", commit: "c0" }),
        saw("fail", { commit: "c1" }),
      ]);
      expect(state.mainCatches).toBe(0);
      expect(state.pendingMain.length).toBe(2);
    });

    it("counts a catch once a later run passes", () => {
      const state = stateFrom([
        saw("fail", { day: "2026-08-19", commit: "c0" }),
        saw("pass", { commit: "c1" }),
      ]);
      expect(state.mainCatches).toBe(1);
      expect(state.pendingMain).toEqual([]);
    });

    it("reads a green rerun of the same commit as a flake", () => {
      // The two runs can arrive in separate batches, so the same-commit
      // check inside one batch does not see this pair.
      const state = stateFrom([
        saw("fail", { commit: "c1" }),
        saw("pass", {
          commit: "c1",
          day: "2026-08-21",
          startedAt: "2026-08-21T00:00:00.000Z",
        }),
      ]);
      expect(state.mainCatches).toBe(0);
      expect(flakeRate(state, "2026-08-21")).toBe(1);
    });

    it("reads a failure nothing fixed as a flake", () => {
      const folded = foldObservations([
        saw("fail", { day: "2026-08-19", commit: "c0" }),
        saw("pass", { commit: "c1" }),
      ], { coveredChanged: () => false });
      const state = folded.states.get(KEY)!;
      expect(state.mainCatches).toBe(0);
      expect(flakeRate(state, "2026-08-20")).toBe(1);
    });
  });

  describe("what the latest run on main says", () => {
    it("names the identities that run left red", () => {
      const folded = foldObservations([
        saw("pass", { day: "2026-08-19", commit: "c0" }),
        saw("fail", { commit: "c1" }),
      ]);
      expect(folded.mainRed.has(KEY)).toBe(true);
    });

    it("clears one a later run passed", () => {
      const folded = foldObservations([
        saw("fail", { day: "2026-08-19", commit: "c0" }),
        saw("pass", { commit: "c1" }),
      ]);
      expect(folded.mainRed.has(KEY)).toBe(false);
    });
  });

  describe("variants", () => {
    it("scores a variant apart from the default it shadows", () => {
      const marked = { ...TEST, v: "server-execution" };
      const folded = foldObservations([
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
        saw("pass", {
          test: marked,
          commit: "c1",
          place: "pr",
          source: "branch",
        }),
      ]);
      const markedKey = JSON.stringify([
        marked.k,
        marked.s,
        marked.n,
        marked.v,
      ]);
      expect(folded.states.get(KEY)!.prCatches).toBe(1);
      expect(folded.states.get(markedKey)!.prCatches).toBe(0);
    });
  });

  describe("the value formula", () => {
    it("scores a test that never failed anywhere at exactly the floor", () => {
      const state = stateFrom([saw("pass")]);
      expect(value(scoreInputs(state, "2026-08-20"), "2026-08-20")).toBe(
        VALUE_FLOOR,
      );
    });

    it("scores failures that were not catches at the floor plus churn", () => {
      // Every failure here disagrees with a pass at the same commit, so
      // none is a catch, and what is left is the churn term alone.
      const state = stateFrom([
        saw("pass", { commit: "c1", place: "pr", source: "branch" }),
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
      ]);
      const inputs = scoreInputs(state, "2026-08-20");
      expect(inputs.catches).toBe(0);
      expect(inputs.lastCatch).toBeUndefined();
      const scored = value(inputs, "2026-08-20");
      expect(Number.isFinite(scored)).toBe(true);
      expect(scored).toBeGreaterThan(VALUE_FLOOR);
      expect(scored).toBeCloseTo(VALUE_FLOOR + 0.15 * inputs.churn, 10);
    });

    it("keeps an old proven test ahead of one with no record", () => {
      const proven = {
        catches: 4,
        mainCatches: 0,
        lastCatch: "2024-08-20",
        sources: 2,
        churn: 0,
      };
      const unproven = {
        catches: 0,
        mainCatches: 0,
        sources: 0,
        churn: 0,
      };
      expect(value(proven, "2026-08-20")).toBeGreaterThan(
        value(unproven, "2026-08-20"),
      );
    });

    it("saturates, so a fifth catch cannot crowd everything out", () => {
      const at = (catches: number) =>
        value(
          {
            catches,
            mainCatches: 0,
            lastCatch: "2026-08-20",
            sources: 1,
            churn: 0,
          },
          "2026-08-20",
        );
      expect(at(3) - at(2)).toBeLessThan(at(2) - at(1));
      expect(at(5) - at(4)).toBeLessThan(at(3) - at(2));
      expect(at(100)).toBeLessThan(1);
    });

    it("decays a catch slowly and never below the freshness floor", () => {
      const at = (lastCatch: string) =>
        value(
          { catches: 4, mainCatches: 0, lastCatch, sources: 0, churn: 0 },
          "2026-08-20",
        );
      expect(at("2026-08-13")).toBeGreaterThan(at("2026-04-20"));
      expect(at("2024-08-20")).toBeGreaterThan(VALUE_FLOOR);
    });
  });

  describe("churn", () => {
    it("puts a live failure ahead of a long-dead outage", () => {
      const live = emptyState();
      for (let age = 0; age < 3; age++) {
        const day = dayBefore("2026-08-20", age);
        live.runsByDay[day] = 250;
        live.failuresByDay[day] = 250;
      }
      const healed = emptyState();
      for (let age = 240; age < 247; age++) {
        const day = dayBefore("2026-08-20", age);
        healed.runsByDay[day] = 250;
        healed.failuresByDay[day] = 150;
      }
      for (let age = 0; age < 240; age++) {
        healed.runsByDay[dayBefore("2026-08-20", age)] = 250;
      }
      expect(churn(live, "2026-08-20")).toBeGreaterThan(
        churn(healed, "2026-08-20"),
      );
    });

    it("is zero for a test that has never run", () => {
      expect(churn(emptyState(), "2026-08-20")).toBe(0);
    });
  });

  describe("cost", () => {
    it("combines a day read across two runs without double counting", () => {
      // A day arrives over as many runs as it takes, so sealing combines
      // rather than replaces — and nothing else writes a day's cost, or
      // the combination would fold a running value into itself.
      const state = emptyState();
      sealDay(state, "2026-08-20", [100, 100, 900]);
      const first = state.costByDay["2026-08-20"]!;
      sealDay(state, "2026-08-20", [200]);
      const both = state.costByDay["2026-08-20"]!;
      expect(both.count).toBe(first.count + 1);
      expect(both.p90).toBe(Math.max(first.p90, 200));
    });

    it("takes the ninetieth percentile by nearest rank", () => {
      expect(percentile90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
      expect(percentile90([5])).toBe(5);
      expect(percentile90([])).toBe(0);
    });

    it("reports the worst day inside the window, in seconds", () => {
      const state = emptyState();
      sealDay(state, "2026-08-20", [100, 200, 4000]);
      sealDay(state, "2026-08-19", [100, 100, 100]);
      expect(costSeconds(state, "2026-08-20")).toBe(4);
    });

    it("forgets a day past the window", () => {
      const state = emptyState();
      sealDay(state, "2026-08-01", [9000]);
      expect(costSeconds(state, "2026-08-20")).toBe(0);
    });
  });

  describe("trimming", () => {
    it("drops the days each window has passed", () => {
      const state = emptyState();
      state.runsByDay["2026-01-01"] = 1;
      state.runsByDay["2026-08-20"] = 1;
      sealDay(state, "2026-01-01", [10]);
      trimWindows(state, "2026-08-20");
      expect(Object.keys(state.runsByDay)).toEqual(["2026-08-20"]);
      expect(Object.keys(state.costByDay)).toEqual([]);
    });
  });

  describe("days", () => {
    it("counts calendar days between two of them", () => {
      expect(daysBetween("2026-08-19", "2026-08-20")).toBe(1);
      expect(daysBetween("2026-08-20", "2026-08-20")).toBe(0);
      expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    });
  });
});

function dayBefore(day: string, ago: number): string {
  const stamp = Date.parse(`${day}T00:00:00Z`) - ago * 86_400_000;
  return new Date(stamp).toISOString().slice(0, 10);
}

describe("a day's bounded sample of its slowest runs", () => {
  const empty = (): DaySamples => ({ count: 0, slowest: [] });

  it("keeps what it is given while there is room, in order", () => {
    const samples = empty();
    for (const ms of [30, 10, 20]) sampleDuration(samples, ms);
    expect(samples.slowest).toEqual([10, 20, 30]);
    expect(samples.count).toBe(3);
  });

  it("counts every run, keeping only the slowest of them", () => {
    const samples = empty();
    for (let i = 1; i <= COST_SAMPLE_CAP + 50; i++) sampleDuration(samples, i);
    expect(samples.count).toBe(COST_SAMPLE_CAP + 50);
    expect(samples.slowest.length).toBe(COST_SAMPLE_CAP);
    expect(samples.slowest[0]).toBe(51);
    expect(samples.slowest.at(-1)).toBe(COST_SAMPLE_CAP + 50);
  });

  it("drops a run slower than nothing it kept, once it is full", () => {
    const samples = empty();
    for (let i = 100; i < 100 + COST_SAMPLE_CAP; i++) {
      sampleDuration(samples, i);
    }
    const kept = [...samples.slowest];
    sampleDuration(samples, 1);
    expect(samples.slowest).toEqual(kept);
    // Counted all the same: the count is what the percentile's rank is
    // taken from, so dropping it would move the percentile up.
    expect(samples.count).toBe(COST_SAMPLE_CAP + 1);
  });

  it("takes a run that displaces the fastest it kept", () => {
    const samples = empty();
    for (let i = 100; i < 100 + COST_SAMPLE_CAP; i++) {
      sampleDuration(samples, i);
    }
    sampleDuration(samples, 150);
    expect(samples.slowest.length).toBe(COST_SAMPLE_CAP);
    expect(samples.slowest[0]).toBe(101);
    expect(samples.slowest).toContain(150);
  });

  it("has no percentile for a day nothing ran on", () => {
    expect(sampledPercentile90(empty())).toBe(0);
  });

  it("agrees with the exact percentile while everything is kept", () => {
    const durations = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    const samples = empty();
    for (const ms of durations) sampleDuration(samples, ms);
    expect(sampledPercentile90(samples)).toBe(percentile90(durations));
  });

  it("over-estimates rather than under-estimates past what it kept", () => {
    // The rank falls outside the sample, so the answer is the smallest
    // kept run. A budget survives an over-estimate; it does not survive
    // the other one.
    const samples = empty();
    for (let i = 1; i <= 1000; i++) sampleDuration(samples, i);
    expect(sampledPercentile90(samples)).toBeGreaterThanOrEqual(900);
  });
});

describe("sealDay()", () => {
  it("writes nothing for a day with no runs in it", () => {
    const state = emptyState();
    sealDay(state, "2026-08-20", []);
    expect(state.costByDay["2026-08-20"]).toBeUndefined();
    sealDay(state, "2026-08-20", { count: 0, slowest: [] });
    expect(state.costByDay["2026-08-20"]).toBeUndefined();
  });
});

describe("flakeRate()", () => {
  it("counts only failures inside the window", () => {
    const state = emptyState();
    state.failuresByDay["2026-08-20"] = 2;
    state.flakesByDay["2026-08-20"] = 1;
    // Far enough back that the window cannot reach it, so neither its
    // failures nor its flakes are in the share.
    state.failuresByDay["2020-01-01"] = 50;
    expect(flakeRate(state, "2026-08-20")).toBe(0.5);
  });

  it("is zero for a test that has never failed", () => {
    expect(flakeRate(emptyState(), "2026-08-20")).toBe(0);
  });
});

describe("a main failure resolved in a later batch", () => {
  it("is a flake when the same commit later passes", () => {
    // The two runs of one commit can arrive in separate batches, so the
    // same-commit check inside a batch does not see this pair. Dropping
    // the pending failure would lose the flake as well as the catch.
    const context = emptyContext();
    const first = foldObservations([saw("fail", { commit: "c1" })], {
      context,
    });
    const second = foldObservations([saw("pass", { commit: "c1" })], {
      context,
      prior: first.states,
    });
    const state = second.states.get(KEY)!;
    expect(state.flakesByDay["2026-08-20"]).toBe(1);
    // A flake at one commit is not a catch: nothing was fixed between the
    // failure and the pass, because there is nothing between them.
    expect(state.mainCatches).toBe(0);
  });

  it("is a catch when a later commit passes", () => {
    const context = emptyContext();
    const first = foldObservations([saw("fail", { commit: "c1" })], {
      context,
    });
    const second = foldObservations([saw("pass", { commit: "c2" })], {
      context,
      prior: first.states,
    });
    const state = second.states.get(KEY)!;
    expect(state.flakesByDay["2026-08-20"]).toBeUndefined();
    expect(state.mainCatches).toBe(1);
  });
});

describe("a failure seen from many places at once", () => {
  it("is environmental, and credits nobody, when the sources are near", () => {
    // Five sources failing within the breadth window is the environment
    // breaking, not the test catching five separate changes.
    const sources = ["main", "a", "b", "c", "d"];
    const folded = foldObservations(
      sources.map((source) =>
        saw("fail", { source, place: "pr", commit: `c-${source}` })
      ),
    );
    const state = folded.states.get(KEY)!;
    expect(state.prCatches).toBe(0);
  });

  it("credits each of them when the crowd is one short", () => {
    const sources = ["a", "b", "c", "d"];
    const folded = foldObservations(
      sources.map((source) =>
        saw("fail", { source, place: "pr", commit: `c-${source}` })
      ),
    );
    expect(folded.states.get(KEY)!.prCatches).toBe(sources.length);
  });

  it("counts a failure outside the window as a separate one", () => {
    // The same five sources, but one of them failed long enough ago that
    // the breadth window cannot reach it, so it is not part of the crowd.
    const near = ["a", "b", "c"].map((source) =>
      saw("fail", {
        source,
        place: "pr",
        commit: `c-${source}`,
        day: "2026-08-20",
      })
    );
    const far = saw("fail", {
      source: "d",
      place: "pr",
      commit: "c-d",
      day: "2026-08-01",
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    const folded = foldObservations([far, ...near]);
    const state = folded.states.get(KEY)!;
    expect(state.failuresByDay["2026-08-01"]).toBe(1);
    expect(state.failuresByDay["2026-08-20"]).toBe(3);
    // Four sources in all, but never four at once, so each is a catch.
    expect(state.prCatches).toBe(4);
  });
});

describe("a skipped run", () => {
  it("counts as nothing at all", () => {
    const folded = foldObservations([
      saw("skip"),
      saw("skip", { commit: "c2" }),
    ]);
    const state = folded.states.get(KEY);
    expect(state?.runsByDay["2026-08-20"]).toBeUndefined();
    expect(state?.failuresByDay["2026-08-20"]).toBeUndefined();
  });

  it("does not show that a test failing on main was fixed", () => {
    const folded = foldObservations([
      saw("fail", { commit: "c1" }),
      saw("skip", { commit: "c2" }),
    ]);
    expect(folded.mainRed.has(KEY)).toBe(true);
  });
});
