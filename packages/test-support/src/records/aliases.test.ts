import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  aliasGraphProblems,
  type AliasLine,
  AliasResolver,
  loadAliasResolver,
  parseAliasLine,
} from "./aliases.ts";

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

describe("aliases", () => {
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

    it("returns an error for an impossible calendar date", () => {
      const line = JSON.stringify({ ...FULL, date: "2026-02-31" });
      expect(parseAliasLine(line)).toBe("has an impossible calendar date");
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

  describe("AliasResolver", () => {
    it("maps an old identity recorded before the rename", () => {
      const resolver = new AliasResolver([FULL]);
      expect(resolver.resolve(
        { k: "unit", s: "bakery", n: "glaze > sets" },
        "2026/08/10",
      )).toEqual({ k: "unit", s: "bakery", n: "glaze > cures" });
    });

    it("leaves a record from the rename day onward alone", () => {
      const resolver = new AliasResolver([FULL]);
      const identity = { k: "unit", s: "bakery", n: "glaze > sets" };
      expect(resolver.resolve(identity, "2026/08/17")).toEqual(identity);
      expect(resolver.resolve(identity, "2026/08/20")).toEqual(identity);
    });

    it("follows a chain of renames transitively", () => {
      const resolver = new AliasResolver([
        FULL,
        {
          date: "2026-08-19",
          from: { k: "unit", s: "bakery", n: "glaze > cures" },
          to: { k: "unit", s: "bakery", n: "glaze > hardens" },
        },
      ]);
      expect(resolver.resolve(
        { k: "unit", s: "bakery", n: "glaze > sets" },
        "2026/08/10",
      )).toEqual({ k: "unit", s: "bakery", n: "glaze > hardens" });
    });

    it("renames a whole scope keeping each test's name", () => {
      const resolver = new AliasResolver([SCOPE]);
      expect(resolver.resolve(
        { k: "unit", s: "bakery", n: "anything" },
        "2026/08/10",
      )).toEqual({ k: "unit", s: "patisserie", n: "anything" });
    });

    it("prefers a full-identity mapping over the scope's", () => {
      const resolver = new AliasResolver([SCOPE, {
        date: "2026-08-17",
        from: { k: "unit", s: "bakery", n: "special" },
        to: { k: "unit", s: "confiserie", n: "special" },
      }]);
      expect(resolver.resolve(
        { k: "unit", s: "bakery", n: "special" },
        "2026/08/10",
      )).toEqual({ k: "unit", s: "confiserie", n: "special" });
    });

    it("stops on a malformed cycle instead of hanging", () => {
      const resolver = new AliasResolver([
        FULL,
        {
          date: "2026-08-17",
          from: { k: "unit", s: "bakery", n: "glaze > cures" },
          to: { k: "unit", s: "bakery", n: "glaze > sets" },
        },
      ]);
      const resolved = resolver.resolve(
        { k: "unit", s: "bakery", n: "glaze > sets" },
        "2026/08/10",
      );
      expect(resolved.s).toBe("bakery");
    });
  });

  describe("loadAliasResolver()", () => {
    let directory: string;

    beforeEach(async () => {
      directory = await Deno.makeTempDir({ prefix: "test-records-aliases-" });
    });

    afterEach(async () => {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
    });

    it("loads parsable lines and skips the rest", async () => {
      const file = join(directory, "aliases.jsonl");
      await Deno.writeTextFile(
        file,
        `${JSON.stringify(FULL)}\nnot json\n${JSON.stringify(SCOPE)}\n`,
      );
      const resolver = await loadAliasResolver(file);
      expect(resolver.empty).toBe(false);
      expect(
        resolver.resolve(
          { k: "unit", s: "bakery", n: "glaze > sets" },
          "2026/08/10",
        ).n,
      ).toBe("glaze > cures");
    });

    it("returns an empty resolver for a missing file", async () => {
      const resolver = await loadAliasResolver(join(directory, "absent"));
      expect(resolver.empty).toBe(true);
    });
  });
});
