import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import * as policy from "./policy.ts";
import { DIALS } from "./policy.ts";

// A dial nobody documented is a number that decides what runs and cannot
// be found, so the two halves of this module are held to each other.
const NAMED_IN_TABLE = new Set(DIALS.map((dial) => dial.name));
const EXPORTED_DIALS = Object.keys(policy).filter((name) =>
  /^[A-Z][A-Z0-9_]*$/.test(name) && name !== "DIALS"
);

describe("policy", () => {
  describe("the dial table", () => {
    it("names every exported dial", () => {
      const missing = EXPORTED_DIALS.filter((name) =>
        !NAMED_IN_TABLE.has(name)
      );
      expect(missing).toEqual([]);
    });

    it("names nothing this module does not export", () => {
      const exported = new Set(EXPORTED_DIALS);
      const strays = DIALS.map((dial) => dial.name).filter((name) =>
        !exported.has(name)
      );
      expect(strays).toEqual([]);
    });

    it("gives every dial a unit and a reason to move it", () => {
      for (const dial of DIALS) {
        expect(dial.unit.length).toBeGreaterThan(0);
        expect(dial.why.length).toBeGreaterThan(0);
      }
    });

    it("lists each dial once", () => {
      expect(NAMED_IN_TABLE.size).toBe(DIALS.length);
    });
  });

  describe("the values that constrain each other", () => {
    it("keeps the lane budget inside the lane's bound", () => {
      expect(policy.LANE_BUDGET_SECONDS).toBe(
        policy.LANE_BOUND_SECONDS - policy.LANE_PROLOGUE_SECONDS -
          policy.LANE_SAFETY_SECONDS,
      );
      expect(policy.LANE_BUDGET_SECONDS).toBeGreaterThan(0);
    });

    it("splits the whole budget across the three filling passes", () => {
      const shares = policy.FILL_VALUE_SHARE + policy.FILL_DENSITY_SHARE +
        policy.FILL_EXPLORATION_SHARE;
      expect(shares).toBeCloseTo(1, 10);
    });

    it("splits the whole score across the three weights", () => {
      const weights = policy.WEIGHT_PROVEN + policy.WEIGHT_BREADTH +
        policy.WEIGHT_CHURN;
      expect(weights + policy.VALUE_FLOOR).toBeCloseTo(1, 10);
    });

    it("puts the repeat rates below the exclusion rate, in order", () => {
      const rates = policy.FLAKE_REPEAT_RATES;
      expect(rates.length).toBe(policy.MAX_REPEATS - 1);
      for (let i = 1; i < rates.length; i++) {
        expect(rates[i]!).toBeGreaterThan(rates[i - 1]!);
      }
      expect(rates[rates.length - 1]!).toBeLessThan(
        policy.FLAKE_EXCLUSION_RATE,
      );
    });

    it("reads churn and flakes over windows the decay has faded", () => {
      // Past four half-lives a day's weight is under one part in sixteen,
      // which is what makes the read window a performance choice.
      expect(policy.CHURN_WINDOW_DAYS).toBeGreaterThanOrEqual(
        4 * policy.CHURN_HALF_LIFE_DAYS,
      );
    });
  });

  describe("the coverage exclusion list", () => {
    it("gives every excluded member a reason", () => {
      for (const [member, reason] of policy.EXCLUDED_FROM_COVERAGE_GATE) {
        expect(member.startsWith("packages/")).toBe(true);
        expect(reason.length).toBeGreaterThan(0);
      }
    });
  });
});
