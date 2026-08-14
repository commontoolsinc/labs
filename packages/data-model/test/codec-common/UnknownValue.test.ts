/**
 * What a decode produces for a tag it does not recognize: that tag, and the
 * state untouched.
 *
 * Nothing here can interpret the state, so nothing tries. Encoding one writes
 * the bare state back under the tag it came with, which is what lets a value
 * this runtime has no codec for pass through unharmed rather than being
 * dropped or rewritten into something it was not.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  BaseFabricInstance,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/codec-common/BaseFabricInstance.ts";
import { CODEC } from "@/codec-interface/interface.ts";
import { UnknownValue } from "@/codec-common/UnknownValue.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "@/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "../fabric-instances/fixtures.ts";

describe("UnknownValue", () => {
  // Subclass-checking-superclass identity: lives directly under the class
  // describe (the rule's cross-cutting carve-out).
  it("is an instance of `BaseFabricInstance`", () => {
    const value = new UnknownValue("Test@1", "state");
    expect(value instanceof BaseFabricInstance).toBe(true);
  });

  describe("constructor()", () => {
    it("preserves `wireTypeTag` and `state`", () => {
      const us = new UnknownValue("FancyType@3", { data: [1, 2, 3] });
      expect(us.wireTypeTag).toBe("FancyType@3");
      expect(us.state).toEqual({ data: [1, 2, 3] });
    });

    it("throws given a tag that is not a codec type tag", () => {
      // This class encodes back to the tag it holds, so a tag a decoder would
      // refuse would make an instance that encodes and cannot be read back.
      expect(() => new UnknownValue("", "state")).toThrow(/not a codec type/);
      expect(() => new UnknownValue("hole", "state")).toThrow(
        /not a codec type/,
      );
      expect(() => new UnknownValue("Bytes", "state")).toThrow(
        /not a codec type/,
      );
    });

    it("throws given a tag that is not a string", () => {
      expect(() => new UnknownValue(42 as never, "state")).toThrow(
        /not a codec type/,
      );
    });
  });

  describe("instance members", () => {
    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      it("via dispatch: recurses state, freezes in place", () => {
        const child = { y: 2 };
        const uv = new UnknownValue(
          "Fancy@3",
          child,
        );
        const result = deepFreeze(uv);
        expect(result).toBe(uv);
        expect(Object.isFrozen(uv)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
        expect(isDeepFrozenFabricValue(uv)).toBe(true);
      });

      it("via direct member invocation: recurses state, freezes in place", () => {
        const child = { y: 2 };
        const uv = new UnknownValue(
          "Fancy@3",
          child,
        );
        const result = uv[DEEP_FREEZE](subFreeze);
        expect(result).toBe(uv);
        expect(Object.isFrozen(uv)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
        expect(uv[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      describe("tagForValue()", () => {
        it("returns the value's own (per-instance) wire type tag", () => {
          const uv = new UnknownValue("Weird@7", "s");
          expect(UnknownValue[CODEC].tagForValue(uv)).toBe("Weird@7");
        });
      });

      describe("encode()", () => {
        it("returns the bare `state` (the tag is carried separately)", () => {
          const uv = new UnknownValue("Weird@7", { data: [1, 2, 3] });
          expect(UnknownValue[CODEC].encode(uv)).toEqual({ data: [1, 2, 3] });
        });
      });
    });
  });
});
