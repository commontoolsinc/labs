/**
 * The cheap test for whether a string is this package's encoded form rather
 * than JSON from somewhere else.
 *
 * It decides on the prefix alone and never parses, so the cases are about
 * where that suffices and where it would be too eager: the bare prefix counts,
 * a prefix that is partial or not at the front does not, and plain JSON that
 * happens to look similar does not. One case feeds it real encoder output, so
 * the shape recognized here cannot drift from the shape produced.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { seemsLikeJsonEncodedFabricValue } from "@/codec-json/impl.ts";
import { jsonFromFabricValue } from "@/codecs.ts";

describe("impl", () => {
  describe("seemsLikeJsonEncodedFabricValue", () => {
    it("recognizes a string with the encoding prefix", () => {
      expect(seemsLikeJsonEncodedFabricValue('fvj1:{"a":1}')).toBe(true);
      expect(seemsLikeJsonEncodedFabricValue("fvj1:null")).toBe(true);
      expect(seemsLikeJsonEncodedFabricValue("fvj1:42")).toBe(true);
    });

    it("recognizes the bare prefix", () => {
      expect(seemsLikeJsonEncodedFabricValue("fvj1:")).toBe(true);
    });

    it("recognizes the actual output of `jsonFromFabricValue()` (round-trip check)", () => {
      const encoded = jsonFromFabricValue({ a: 1, b: 42n });
      expect(seemsLikeJsonEncodedFabricValue(encoded)).toBe(true);
    });

    it("returns `false` for an empty string", () => {
      expect(seemsLikeJsonEncodedFabricValue("")).toBe(false);
    });

    it("returns `false` for plain JSON without the prefix", () => {
      // These are plain JSON without the prefix, so the dispatch must reject
      // them.
      expect(seemsLikeJsonEncodedFabricValue("true")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("false")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("null")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue('"hello"')).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("[1,2,3]")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue('{"a":1}')).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("42")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("-1")).toBe(false);
    });

    it("returns `false` for a partial or misplaced prefix", () => {
      expect(seemsLikeJsonEncodedFabricValue("fvj")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("fvj1")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("FVJ1:")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("fvj2:")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue(" fvj1:")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("xfvj1:")).toBe(false);
    });

    it("returns `false` for a bare identifier or other non-JSON-looking string", () => {
      expect(seemsLikeJsonEncodedFabricValue("hello")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("undefined")).toBe(false);
    });
  });
});
