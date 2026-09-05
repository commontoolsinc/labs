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
 * Two of them are checked over a construction rather than over listed
 * outcomes, because a list is a slice of a class and the rest of the class is
 * where a gap hides: that every character the grammar reserves forces
 * quoting, and that a printed value splits back into the one value it was
 * printed from. The construction is where a value nobody would have listed
 * gets driven.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  quoteToken,
  RESERVED_CHARACTERS,
  splitLine,
} from "../lib/shuttle/line.ts";

describe("line", () => {
  describe("RESERVED_CHARACTERS", () => {
    it("holds the pipe, the local escape, the redirections, `#` and `%`, and nothing else", () => {
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

    it("separates on a whitespace character that is not the space", () => {
      // Every separator here is written as an escape, and none of them is
      // a line break: an invisible character in a fixture is unreadable,
      // and a line break would tie this case to the one below it.

      expect(splitLine("a\tb\rc\vd\fe")).toEqual({
        kind: "split",
        tokens: ["a", "b", "c", "d", "e"],
      });
    });

    it("separates on a no-break space and on the Unicode line separator, neither of which a reader sees", () => {
      // The realistic way an operand acquires one is a paste out of a
      // document. The pair stays consistent about them either way: what
      // separates here is what the printer quotes, so a value holding one
      // still round-trips.

      expect(splitLine("a\u00a0b")).toEqual({
        kind: "split",
        tokens: ["a", "b"],
      });
      expect(splitLine("a\u2028b")).toEqual({
        kind: "split",
        tokens: ["a", "b"],
      });
    });

    it("returns no tokens for a line holding separators alone", () => {
      expect(splitLine("  \t ")).toEqual({ kind: "split", tokens: [] });
    });

    it("returns no empty token for a run of separators, or for one at either edge", () => {
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

    it("returns a backslash inside single quotes as a character of the token, even before one double quotes would escape", () => {
      // The character after the backslash is what makes this discriminate.
      // Before an ordinary one the two quote rules agree, so a fixture
      // there would pass whether or not single quotes escape.

      expect(splitLine("'a\\\"b'")).toEqual({
        kind: "split",
        tokens: ['a\\"b'],
      });
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
      expect(splitLine('"a\\\\b"')).toEqual({
        kind: "split",
        tokens: ["a\\b"],
      });
    });

    it("returns a backslash inside double quotes as a character of the token where it escapes neither quote nor backslash", () => {
      expect(splitLine('"C:\\path"')).toEqual({
        kind: "split",
        tokens: ["C:\\path"],
      });
    });

    it("returns a reserved character between double quotes as a character of the token", () => {
      // The construction at the end of this file cannot reach this: a value
      // takes the double-quoted form only where it holds a `\'`, and no value
      // that construction builds pairs one with a reserved character. So the
      // grouping half of the double-quote rule is driven here or nowhere.

      for (const character of RESERVED_CHARACTERS) {
        expect(splitLine(`"a${character}b"`)).toEqual({
          kind: "split",
          tokens: [`a${character}b`],
        });
      }
      expect(splitLine('a"b#c"d')).toEqual({
        kind: "split",
        tokens: ["ab#cd"],
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

    it("returns one run of tokens for text carrying a line break, the break separating like any other", () => {
      // A terminator is the caller's to strip, and a paste of two lines is
      // one caller's problem rather than two commands here.

      expect(splitLine("set x 1\nset y 2")).toEqual({
        kind: "split",
        tokens: ["set", "x", "1", "set", "y", "2"],
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

      it("counts the column in code points, so a character stored as two code units counts one", () => {
        expect(splitLine("\u{1f369} 'a b")).toEqual({
          kind: "refused",
          reason: "The `'` opened at column 3 is never closed.",
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
      // Neither value holds a separator or a reserved character, so each
      // rests on the syntax character alone. A fixture that also holds a
      // space passes whether or not the quote is in the set.

      expect(quoteToken('a"b')).toBe("'a\"b'");
      expect(quoteToken("a\\b")).toBe("'a\\b'");
    });

    it("returns a value holding a single quote in double quotes, its own quotes escaped", () => {
      expect(quoteToken("a'b")).toBe('"a\'b"');
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

    it("returns text that splits back into the value it was printed from, for every value the construction drives", () => {
      // What the two halves owe each other, held over a construction rather
      // than over a list: a listed set is a slice of the class, and the
      // values nobody lists are the ones that break a printer.
      //
      // One crossing it cannot reach, however long it runs: a value takes
      // the double-quoted form only where it holds a `'`, and no mark here
      // pairs one with a reserved character. The splitting case above
      // drives that crossing directly.

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
