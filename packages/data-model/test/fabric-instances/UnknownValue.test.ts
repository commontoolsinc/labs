import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@/interface.ts";
import {
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/fabric-instances/BaseFabricInstance.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";
import { ExplicitTagValue } from "@/fabric-instances/ExplicitTagValue.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "@/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("UnknownValue", () => {
  // Subclass-checking-superclass identity: lives directly under the class
  // describe (the rule's cross-cutting carve-out).
  it("is an instance of `ExplicitTagValue`", () => {
    const us = new UnknownValue("Test@1", "state");
    expect(us instanceof ExplicitTagValue).toBe(true);
  });

  describe("constructor()", () => {
    it("preserves `wireTypeTag` and `state`", () => {
      const us = new UnknownValue("FancyType@3", { data: [1, 2, 3] });
      expect(us.wireTypeTag).toBe("FancyType@3");
      expect(us.state).toEqual({ data: [1, 2, 3] });
    });
  });

  describe("instance members", () => {
    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      it("via dispatch: recurses state, freezes in place", () => {
        const child = { y: 2 };
        const uv = new UnknownValue(
          "Fancy@3",
          child as unknown as FabricValue,
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
          child as unknown as FabricValue,
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
