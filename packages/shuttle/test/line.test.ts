/**
 * Unit tests for the line split and the printer that inverts it. Both halves
 * are pure functions over strings, so a case hands one a string and reads the
 * value back: no connection, no terminal, and no line loop stands behind any
 * of it.
 *
 * Each case is written against one mutation of `src/line.ts` — the one its
 * description forbids — so that a case which stops discriminating stops
 * passing. A case pinning a refusal pins the whole sentence rather than a
 * fragment of it, since a fragment lets a rewording through that says
 * something else.
 *
 * Two properties are checked over a construction rather than over listed
 * values, because listing them is what leaves a class unguarded: every
 * character the grammar reserves forces quoting, and every awkward value
 * prints as text that splits back into that one value. The construction is
 * where a value nobody would have listed gets driven.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { quoteToken, RESERVED_CHARACTERS, splitLine } from "../src/line.ts";

describe("line", () => {
  describe("RESERVED_CHARACTERS", () => {
    it("holds the pipe, the local escape, the redirections, `#` and `%`", () => {
      expect(RESERVED_CHARACTERS).toBe("!#%<>|");
    });
  });

  describe("splitLine()", () => {
    it("returns one token per run of characters between separators", () => {
      expect(splitLine("cd slugs/board")).toEqual({
        kind: "split",
        tokens: ["cd", "slugs/board"],
      });
    });

    it("separates on every whitespace character, not on the space alone", () => {
      expect(splitLine("a\tb\nc\rd e")).toEqual({
        kind: "split",
        tokens: ["a", "b", "c", "d", "e"],
      });
    });

    it("returns no tokens for a line holding separators alone", () => {
      expect(splitLine("  \t ")).toEqual({ kind: "split", tokens: [] });
    });

    it("returns a run of separators as one separator", () => {
      expect(splitLine("  cd   board  ")).toEqual({
        kind: "split",
        tokens: ["cd", "board"],
      });
    });

    it("returns what single quotes hold as one token, whitespace and all", () => {
      expect(splitLine("get 'a b'")).toEqual({
        kind: "split",
        tokens: ["get", "a b"],
      });
    });

    it("returns a backslash inside single quotes as a character of the token", () => {
      expect(splitLine("'a\\b'")).toEqual({
        kind: "split",
        tokens: ["a\\b"],
      });
    });

    it("returns what double quotes hold as one token, whitespace and all", () => {
      expect(splitLine('get "a b"')).toEqual({
        kind: "split",
        tokens: ["get", "a b"],
      });
    });

    it("returns the character after a backslash inside double quotes, and not the backslash", () => {
      expect(splitLine('"a\\"b"')).toEqual({
        kind: "split",
        tokens: ['a"b'],
      });
    });

    it("returns the character after a backslash outside quotes, and not the backslash", () => {
      expect(splitLine("a\\ b")).toEqual({ kind: "split", tokens: ["a b"] });
    });

    it("returns quoted and bare runs that touch as one token", () => {
      expect(splitLine('a"b c"d')).toEqual({
        kind: "split",
        tokens: ["ab cd"],
      });
    });

    it("returns an empty pair of quotes as a token that is the empty string", () => {
      expect(splitLine("set x ''")).toEqual({
        kind: "split",
        tokens: ["set", "x", ""],
      });
    });

    describe("a JSON value on the line", () => {
      // The case the split exists for. A JSON object holds a space after
      // every comma and colon a person writes, so the value it is written as
      // survives only where quoting is what bounds the token.

      it("returns a quoted JSON value as one token", () => {
        expect(splitLine('set draft \'{"title": "a b"}\'')).toEqual({
          kind: "split",
          tokens: ["set", "draft", '{"title": "a b"}'],
        });
      });

      it("returns an unquoted JSON value as one token per run, its quotes taken off", () => {
        expect(splitLine('set draft {"title": "a b"}')).toEqual({
          kind: "split",
          tokens: ["set", "draft", "{title:", "a b}"],
        });
      });
    });

    describe("refusals", () => {
      it("refuses a line whose `'` is never closed", () => {
        expect(splitLine("cd 'a b")).toEqual({
          kind: "refused",
          reason: "The `'` opened at column 4 is never closed.",
        });
      });

      it('refuses a line whose `"` is never closed, naming that quote', () => {
        expect(splitLine('"a b')).toEqual({
          kind: "refused",
          reason: 'The `"` opened at column 1 is never closed.',
        });
      });

      it("names the column the unclosed quote opened at", () => {
        expect(splitLine('get "a b')).toEqual({
          kind: "refused",
          reason: 'The `"` opened at column 5 is never closed.',
        });
      });

      it("refuses a line ending in a backslash", () => {
        expect(splitLine("cd a\\")).toEqual({
          kind: "refused",
          reason: "The line ends in a `\\`, which has nothing to escape.",
        });
      });

      it("refuses a line ending in a backslash inside a quote, naming the quote rather than the backslash", () => {
        // Both faults are one token with no end, and the quote is the one
        // that says where it started.

        expect(splitLine('"a\\')).toEqual({
          kind: "refused",
          reason: 'The `"` opened at column 1 is never closed.',
        });
      });
    });
  });

  describe("quoteToken()", () => {
    it("returns a value holding nothing that needs quoting unchanged", () => {
      expect(quoteToken("of:fid1:abcdefghijklmnop@space")).toBe(
        "of:fid1:abcdefghijklmnop@space",
      );
      expect(quoteToken("topics/3")).toBe("topics/3");
      expect(quoteToken("--json")).toBe("--json");
    });

    it("returns a value holding a separator in single quotes", () => {
      expect(quoteToken("a b")).toBe("'a b'");
    });

    it("returns the empty value as an empty pair of quotes", () => {
      expect(quoteToken("")).toBe("''");
    });

    it("returns a value holding a syntax character in single quotes", () => {
      expect(quoteToken('say "hi"')).toBe("'say \"hi\"'");
      expect(quoteToken("a\\b")).toBe("'a\\b'");
    });

    it("returns a value holding a single quote in double quotes, its own quotes escaped", () => {
      expect(quoteToken('it\'s "x"')).toBe('"it\'s \\"x\\""');
    });

    it("escapes a backslash in the double-quoted form", () => {
      expect(quoteToken("it's a\\b")).toBe('"it\'s a\\\\b"');
    });

    it("quotes a value holding a reserved character, wherever in the value it sits", () => {
      for (const character of RESERVED_CHARACTERS) {
        expect(quoteToken(`a${character}b`)).toBe(`'a${character}b'`);
        expect(quoteToken(`${character}ab`)).toBe(`'${character}ab'`);
      }
    });

    it("returns for every awkward value text that splits back into that one value", () => {
      // What the two halves owe each other, held over a construction rather
      // than over a list: a listed set is a slice of the class, and the
      // values nobody lists are the ones that break a printer.

      const marks = [
        "",
        " ",
        "\t",
        "\n",
        "\r",
        "\v",
        "\f",
        "\u00a0",
        "\u2028",
        "\u2029",
        "\ufeff",
        "'",
        '"',
        "\\",
        "\\'",
        "'\"",
        "~",
        ".",
        "-",
        "..",
        "/",
        "@",
        ":",
        "%1",
        "€",
        "🍩",
        ...RESERVED_CHARACTERS,
      ];
      const values: string[] = [];
      for (const mark of marks) {
        values.push(mark, `a${mark}`, `${mark}b`, `a${mark}b`, mark + mark);
      }
      for (const value of values) {
        expect(splitLine(quoteToken(value))).toEqual({
          kind: "split",
          tokens: [value],
        });
      }
    });
  });
});
