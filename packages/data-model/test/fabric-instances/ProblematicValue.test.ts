import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@/interface.ts";
import {
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/fabric-instances/BaseFabricInstance.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { ExplicitTagValue } from "@/fabric-instances/ExplicitTagValue.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "@/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("ProblematicValue", () => {
  // Subclass-checking-superclass identity: lives directly under the class
  // describe (the rule's cross-cutting carve-out).
  it("is an instance of `ExplicitTagValue`", () => {
    const ps = new ProblematicValue("Test@1", "state", "oops");
    expect(ps instanceof ExplicitTagValue).toBe(true);
  });

  describe("constructor()", () => {
    it("preserves `wireTypeTag`, `state`, and `error`", () => {
      const ps = new ProblematicValue("BadType@1", { x: 1 }, "boom");
      expect(ps.wireTypeTag).toBe("BadType@1");
      expect(ps.state).toEqual({ x: 1 });
      expect(ps.error).toBe("boom");
    });
  });

  describe("instance members", () => {
    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      it("via dispatch: recurses state, freezes in place", () => {
        const child = { x: 1 };
        const pv = new ProblematicValue(
          "Bad@1",
          child as unknown as FabricValue,
          "oops",
        );
        const result = deepFreeze(pv);
        expect(result).toBe(pv);
        expect(Object.isFrozen(pv)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
        expect(isDeepFrozenFabricValue(pv)).toBe(true);
      });

      it("via direct member invocation: recurses state, freezes in place", () => {
        const child = { x: 1 };
        const pv = new ProblematicValue(
          "Bad@1",
          child as unknown as FabricValue,
          "oops",
        );
        const result = pv[DEEP_FREEZE](subFreeze);
        expect(result).toBe(pv);
        expect(Object.isFrozen(pv)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
        expect(pv[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      describe("tagForValue()", () => {
        it("returns the value's own (per-instance) wire type tag", () => {
          const pv = new ProblematicValue("Weird@7", "s", "oops");
          expect(ProblematicValue[CODEC].tagForValue(pv)).toBe("Weird@7");
        });
      });

      describe("encode()", () => {
        it("returns the bare `state` (the tag is carried separately)", () => {
          const pv = new ProblematicValue("Weird@7", { x: 1 }, "oops");
          expect(ProblematicValue[CODEC].encode(pv)).toEqual({ x: 1 });
        });
      });
    });
  });
});
