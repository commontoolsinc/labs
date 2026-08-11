import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { backtickQuote } from "../src/markdown.ts";
import { parseCodeSpan } from "./parse-code-span.ts";

describe("markdown", () => {
  describe("backtickQuote()", () => {
    it("wraps ordinary text in a single pair of backticks", () => {
      expect(backtickQuote("hello")).toBe("`hello`");
      expect(backtickQuote("a b c")).toBe("`a b c`");
    });

    it("returns a bare pair of backticks for empty text", () => {
      expect(backtickQuote("")).toBe("``");
    });

    it("uses a longer delimiter than the longest run inside", () => {
      expect(backtickQuote("a`b")).toBe("``a`b``");
      expect(backtickQuote("a``b")).toBe("```a``b```");
      expect(backtickQuote("a```b``c")).toBe("````a```b``c````");
    });

    it("pads when the text starts or ends with a backtick", () => {
      expect(backtickQuote("`x")).toBe("`` `x ``");
      expect(backtickQuote("x`")).toBe("`` x` ``");
      expect(backtickQuote("`")).toBe("`` ` ``");
    });

    it("pads when the text both starts and ends with a space", () => {
      expect(backtickQuote(" x ")).toBe("`  x  `");
    });

    it("does not pad when only one end is a space", () => {
      expect(backtickQuote(" x")).toBe("` x`");
      expect(backtickQuote("x ")).toBe("`x `");
    });

    it("does not pad all-space text, which a reader leaves alone", () => {
      expect(backtickQuote(" ")).toBe("` `");
      expect(backtickQuote("   ")).toBe("`   `");
    });

    it("round-trips through a Markdown reader", () => {
      // The property that matters: parsing the result yields back the input.
      for (
        const text of [
          "hello",
          "a`b",
          "a``b",
          "`x",
          "x`",
          "`",
          "``",
          " x ",
          " x",
          "x ",
          " ",
          "   ",
          '{"a":1}',
          "Symbol(`odd`)",
        ]
      ) {
        expect(parseCodeSpan(backtickQuote(text))).toBe(text);
      }
    });
  });
});
