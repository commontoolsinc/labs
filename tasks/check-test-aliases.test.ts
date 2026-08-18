import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  aliasGraphProblems,
  type AliasLine,
  parseAliasLine,
} from "./check-test-aliases.ts";

const FULL: AliasLine = {
  date: "2026-08-17",
  from: { k: "unit", s: "bakery", n: "glaze > sets" },
  to: { k: "unit", s: "bakery", n: "glaze > cures" },
};

const SCOPE: AliasLine = {
  date: "2026-08-17",
  from: { k: "unit", s: "bakery" },
  to: { k: "unit", s: "patisserie" },
};

describe("check-test-aliases", () => {
  describe("parseAliasLine()", () => {
    it("returns a full-identity alias", () => {
      expect(parseAliasLine(JSON.stringify(FULL))).toEqual(FULL);
    });

    it("returns a whole-scope alias", () => {
      expect(parseAliasLine(JSON.stringify(SCOPE))).toEqual(SCOPE);
    });

    it("returns an error for malformed JSON", () => {
      expect(parseAliasLine("{oops")).toBe("is not JSON");
    });

    it("returns an error for a missing date", () => {
      const line = JSON.stringify({ from: FULL.from, to: FULL.to });
      expect(parseAliasLine(line)).toBe("has no ISO date");
    });

    it("returns an error when a scope maps to a single identity", () => {
      const line = JSON.stringify({
        date: "2026-08-17",
        from: { k: "unit", s: "bakery" },
        to: { k: "unit", s: "patisserie", n: "one test" },
      });
      expect(typeof parseAliasLine(line)).toBe("string");
    });
  });

  describe("aliasGraphProblems()", () => {
    it("returns nothing for a chain", () => {
      const chain: AliasLine[] = [
        FULL,
        {
          date: "2026-08-18",
          from: { k: "unit", s: "bakery", n: "glaze > cures" },
          to: { k: "unit", s: "bakery", n: "glaze > hardens" },
        },
      ];
      expect(aliasGraphProblems(chain)).toEqual([]);
    });

    it("returns a problem for a second mapping from one identity", () => {
      const doubled: AliasLine[] = [FULL, {
        ...FULL,
        to: { k: "unit", s: "bakery", n: "elsewhere" },
      }];
      expect(aliasGraphProblems(doubled).length).toBe(1);
      expect(aliasGraphProblems(doubled)[0]).toContain("two mappings");
    });

    it("returns a problem for a two-step cycle", () => {
      const cycle: AliasLine[] = [
        FULL,
        {
          date: "2026-08-18",
          from: { k: "unit", s: "bakery", n: "glaze > cures" },
          to: { k: "unit", s: "bakery", n: "glaze > sets" },
        },
      ];
      const problems = aliasGraphProblems(cycle);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0]).toContain("cycle");
    });

    it("returns a problem for a self-mapping", () => {
      const selfLoop: AliasLine[] = [{ ...FULL, to: FULL.from }];
      expect(aliasGraphProblems(selfLoop).length).toBe(1);
    });

    it("keeps a tail into a cycle from doubling the report", () => {
      const tailAndCycle: AliasLine[] = [
        {
          date: "2026-08-17",
          from: { k: "unit", s: "bakery", n: "tail" },
          to: { k: "unit", s: "bakery", n: "a" },
        },
        {
          date: "2026-08-17",
          from: { k: "unit", s: "bakery", n: "a" },
          to: { k: "unit", s: "bakery", n: "b" },
        },
        {
          date: "2026-08-17",
          from: { k: "unit", s: "bakery", n: "b" },
          to: { k: "unit", s: "bakery", n: "a" },
        },
      ];
      expect(aliasGraphProblems(tailAndCycle).length).toBe(2);
    });
  });
});
