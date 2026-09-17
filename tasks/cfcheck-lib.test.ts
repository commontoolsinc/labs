import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  formatError,
  parseOnly,
  parseShard,
  patternsToCheck,
  selectionFor,
  shardLabel,
  USAGE,
  WHOLE,
} from "./cfcheck-lib.ts";

/** Four patterns, spread across the trees the collector walks. */
const CORPUS = [
  "packages/connectors/agents/debug-view/logic.ts",
  "packages/patterns/counter/counter.tsx",
  "packages/patterns/form-demo.tsx",
  "packages/patterns/system/home.tsx",
];

describe("cfcheck-lib", () => {
  describe("parseOnly()", () => {
    it("returns nothing for a command line carrying no term", () => {
      expect(parseOnly([])).toEqual([]);
    });

    it("returns a term given as a separate word", () => {
      expect(parseOnly(["--only", "home.tsx"])).toEqual(["home.tsx"]);
    });

    it("returns a term given after an equals sign", () => {
      expect(parseOnly(["--only=home.tsx"])).toEqual(["home.tsx"]);
    });

    it("returns every term of a repeated flag, in the order given", () => {
      expect(parseOnly(["--only", "b.tsx", "--only=a.tsx"]))
        .toEqual(["b.tsx", "a.tsx"]);
    });

    it("throws for a `--only` at the end of the command line", () => {
      // The whole reason this throws rather than dropping the term: a run
      // with no terms checks everything, so a dropped one turns a request
      // for one pattern into a request for the corpus.
      expect(() => parseOnly(["--only"])).toThrow("--only needs a value");
    });

    it("throws for a term given as the empty string", () => {
      expect(() => parseOnly(["--only="])).toThrow("--only needs a value");
      expect(() => parseOnly(["--only", ""])).toThrow("--only needs a value");
    });

    it("throws for a term that is the caller's next flag", () => {
      // `--only --only x` reads the second flag as the first one's value.
      // It matches no pattern, so the run would check nothing.
      expect(() => parseOnly(["--only", "--only", "a.tsx"]))
        .toThrow('--only needs a value, and was given "--only"');
    });

    it("throws for an argument that is not a term at all", () => {
      expect(() => parseOnly(["--update"])).toThrow(
        "Unknown argument: --update",
      );
      expect(() => parseOnly(["home.tsx"])).toThrow(
        "Unknown argument: home.tsx",
      );
    });
  });

  describe("parseShard()", () => {
    it("returns the whole corpus where the environment names no share", () => {
      expect(parseShard(undefined)).toEqual(WHOLE);
      expect(parseShard("")).toEqual(WHOLE);
    });

    it("counts from one outside and from zero inside", () => {
      // `CFCHECK_SHARD=1/8` is the first of eight, which selects the files
      // whose index leaves no remainder.
      expect(parseShard("1/8")).toEqual({ index: 0, count: 8 });
      expect(parseShard("8/8")).toEqual({ index: 7, count: 8 });
    });

    it("throws for a share it cannot read", () => {
      expect(() => parseShard("nonsense")).toThrow();
      expect(() => parseShard("1/")).toThrow();
    });

    it("throws for a share outside the count it names", () => {
      expect(() => parseShard("9/8")).toThrow();
      expect(() => parseShard("0/8")).toThrow();
    });
  });

  describe("patternsToCheck()", () => {
    it("takes the whole corpus where no term was given", () => {
      expect(patternsToCheck(CORPUS, [])).toEqual(CORPUS);
    });

    it("takes the one pattern a whole path names", () => {
      // What a lane passes: a unit is a whole path, and the lane is
      // charged for the units it asked for and no others.
      expect(patternsToCheck(CORPUS, ["packages/patterns/form-demo.tsx"]))
        .toEqual(["packages/patterns/form-demo.tsx"]);
    });

    it("takes every pattern a term matches", () => {
      expect(patternsToCheck(CORPUS, ["packages/patterns/"])).toEqual([
        "packages/patterns/counter/counter.tsx",
        "packages/patterns/form-demo.tsx",
        "packages/patterns/system/home.tsx",
      ]);
    });

    it("takes a pattern under either of two terms", () => {
      expect(patternsToCheck(CORPUS, ["form-demo", "home.tsx"])).toEqual([
        "packages/patterns/form-demo.tsx",
        "packages/patterns/system/home.tsx",
      ]);
    });

    it("takes nothing for a term no pattern matches", () => {
      expect(patternsToCheck(CORPUS, ["no-such-pattern"])).toEqual([]);
    });

    it("divides the corpus between the shares of a shard", () => {
      const first = patternsToCheck(CORPUS, [], { index: 0, count: 2 });
      const second = patternsToCheck(CORPUS, [], { index: 1, count: 2 });
      expect(first).toEqual([
        "packages/connectors/agents/debug-view/logic.ts",
        "packages/patterns/form-demo.tsx",
      ]);
      // Between them the two shares are the corpus, with nothing in both.
      expect([...first, ...second].toSorted()).toEqual([...CORPUS].toSorted());
    });

    it("divides what the terms selected rather than the corpus", () => {
      // The shard applies after the filter. Dividing first and filtering
      // second would leave one share holding both matches and the other
      // holding none, so a two-process run would do all its work in one.
      const only = ["packages/patterns/counter/counter.tsx", "home.tsx"];
      const first = patternsToCheck(CORPUS, only, { index: 0, count: 2 });
      const second = patternsToCheck(CORPUS, only, { index: 1, count: 2 });
      expect(first).toEqual(["packages/patterns/counter/counter.tsx"]);
      expect(second).toEqual(["packages/patterns/system/home.tsx"]);
    });
  });

  describe("selectionFor()", () => {
    it("reads the command line and the share together", () => {
      const selected = selectionFor(
        CORPUS,
        ["--only", "packages/patterns/"],
        "2/2",
      );

      expect(selected.shard).toEqual({ index: 1, count: 2 });
      expect(selected.files).toEqual(["packages/patterns/form-demo.tsx"]);
    });

    it("takes the whole corpus given neither", () => {
      expect(selectionFor(CORPUS, [], undefined))
        .toEqual({ files: CORPUS, shard: WHOLE });
    });

    it("throws rather than widening, for either one it cannot read", () => {
      expect(() => selectionFor(CORPUS, ["--only"], undefined)).toThrow();
      expect(() => selectionFor(CORPUS, [], "nonsense")).toThrow();
    });
  });

  describe("shardLabel()", () => {
    it("says which share a run took, of how many", () => {
      expect(shardLabel({ index: 0, count: 8 })).toBe(" [shard 1/8]");
    });

    it("says nothing for a run that took the whole corpus", () => {
      expect(shardLabel(WHOLE)).toBe("");
    });
  });

  describe("formatError()", () => {
    it("returns the message of an error", () => {
      expect(formatError(new Error("no such pattern"))).toBe("no such pattern");
    });

    it("returns the text of anything else thrown", () => {
      expect(formatError("bare string")).toBe("bare string");
    });
  });

  describe("USAGE", () => {
    it("names both the flag and the environment variable", () => {
      // A caller who gets this has already had one of them refused, so it
      // has to name the other as well for the message to be any use.
      expect(USAGE).toContain("--only");
      expect(USAGE).toContain("CFCHECK_SHARD");
    });
  });
});
