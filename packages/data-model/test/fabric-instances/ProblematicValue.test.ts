import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  DEEP_FREEZE,
  type FabricValue,
  IS_DEEP_FROZEN,
} from "../../src/interface.ts";
import { ProblematicValue } from "../../src/fabric-instances/ProblematicValue.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "../../src/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("ProblematicValue", () => {
  it("preserves typeTag, state, and error", () => {
    const ps = new ProblematicValue("BadType@1", { x: 1 }, "boom");
    expect(ps.typeTag).toBe("BadType@1");
    expect(ps.state).toEqual({ x: 1 });
    expect(ps.error).toBe("boom");
  });

  it("has DECONSTRUCT method", () => {
    const ps = new ProblematicValue("T@1", "s", "e");
    expect(ps[DECONSTRUCT]()).toEqual({
      type: "T@1",
      state: "s",
      error: "e",
    });
  });

  describe("[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — via dispatch", () => {
    it("ProblematicValue [DEEP_FREEZE] recurses state, freezes in place", () => {
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
  });

  describe("[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — direct member invocation", () => {
    it("ProblematicValue [DEEP_FREEZE] recurses state, freezes in place", () => {
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
