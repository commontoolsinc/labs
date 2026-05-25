import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  DEEP_FREEZE,
  type FabricValue,
  IS_DEEP_FROZEN,
} from "../../src/interface.ts";
import { UnknownValue } from "../../src/fabric-instances/UnknownValue.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "../../src/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("UnknownValue", () => {
  describe("constructor()", () => {
    it("preserves `typeTag` and `state`", () => {
      const us = new UnknownValue("FancyType@3", { data: [1, 2, 3] });
      expect(us.typeTag).toBe("FancyType@3");
      expect(us.state).toEqual({ data: [1, 2, 3] });
    });
  });

  describe("instance members", () => {
    describe("[DECONSTRUCT]", () => {
      it("returns the type-tagged state", () => {
        const us = new UnknownValue("Test@1", "state");
        expect(us[DECONSTRUCT]()).toEqual({
          type: "Test@1",
          state: "state",
        });
      });
    });

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
});
