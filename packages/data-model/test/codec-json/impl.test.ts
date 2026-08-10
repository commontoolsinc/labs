import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { seemsLikeJsonEncodedFabricValue } from "@/codec-json/impl.ts";
import { jsonFromValue } from "@/codecs.ts";

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

    it("recognizes the actual output of `jsonFromValue()` (round-trip check)", () => {
      const encoded = jsonFromValue({ a: 1, b: 42n });
      expect(seemsLikeJsonEncodedFabricValue(encoded)).toBe(true);
    });

    it("rejects empty string", () => {
      expect(seemsLikeJsonEncodedFabricValue("")).toBe(false);
    });

    it("rejects plain JSON without the prefix", () => {
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

    it("rejects partial or misplaced prefixes", () => {
      expect(seemsLikeJsonEncodedFabricValue("fvj")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("fvj1")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("FVJ1:")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("fvj2:")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue(" fvj1:")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("xfvj1:")).toBe(false);
    });

    it("rejects bare identifiers and other non-JSON-looking strings", () => {
      expect(seemsLikeJsonEncodedFabricValue("hello")).toBe(false);
      expect(seemsLikeJsonEncodedFabricValue("undefined")).toBe(false);
    });
  });
});
