import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from "@/interface.ts";
import { DECONSTRUCT } from "@/wire-common/interface.ts";
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
    describe("[DECONSTRUCT]", () => {
      it("returns the type-tagged `state` and `error`", () => {
        const ps = new ProblematicValue("T@1", "s", "e");
        expect(ps[DECONSTRUCT]()).toEqual({
          type: "T@1",
          state: "s",
          error: "e",
        });
      });
    });

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
});
