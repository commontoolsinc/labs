import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  churn,
  costSeconds,
  daysBetween,
  emptyState,
  flakeRate,
  foldObservations,
  type Observation,
  percentile90,
  scoreInputs,
  sealDay,
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
