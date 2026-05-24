import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  DEEP_FREEZE,
  FabricInstance,
  type FabricValue,
  IS_DEEP_FROZEN,
  RECONSTRUCT,
} from "../../src/interface.ts";
import { FabricMap } from "../../src/fabric-instances/FabricMap.ts";
import { FabricNativeWrapper } from "../../src/fabric-instances/FabricNativeWrapper.ts";
import { FrozenMap } from "../../src/frozen-builtins.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "../../src/deep-freeze.ts";
import { dummyContext, subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("FabricMap", () => {
  it("FabricMap implements FabricInstance", () => {
    const sm = new FabricMap(new Map());
    expect(sm instanceof FabricInstance).toBe(true);
    expect(sm.typeTag).toBe("Map@1");
  });

  it("FabricMap is instanceof FabricNativeWrapper", () => {
    const sm = new FabricMap(new Map());
    expect(sm instanceof FabricNativeWrapper).toBe(true);
  });

  it("FabricMap [DECONSTRUCT] throws (stub)", () => {
    const sm = new FabricMap(new Map());
    expect(() => sm[DECONSTRUCT]()).toThrow("not yet implemented");
  });

  it("FabricMap [RECONSTRUCT] throws (stub)", () => {
    expect(() => FabricMap[RECONSTRUCT](null, dummyContext)).toThrow(
      "not yet implemented",
    );
  });

  it("FabricMap.toNativeValue(true) returns FrozenMap", () => {
    const map = new Map<FabricValue, FabricValue>([["a", 1]]);
    const sm = new FabricMap(map);
    const result = sm.toNativeValue(true);
    expect(result).toBeInstanceOf(FrozenMap);
    expect((result as FrozenMap<string, number>).get("a")).toBe(1);
  });

  it("FabricMap.toNativeValue(false) returns the original Map", () => {
    const map = new Map<FabricValue, FabricValue>([["a", 1]]);
    const sm = new FabricMap(map);
    const result = sm.toNativeValue(false);
    expect(result).toBe(map); // same reference
    expect(result).toBeInstanceOf(Map);
    expect(result).not.toBeInstanceOf(FrozenMap);
  });

  it("FabricMap.toNativeValue(true) returns same FrozenMap if already frozen", () => {
    const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
    const sm = new FabricMap(fm);
    const result = sm.toNativeValue(true);
    expect(result).toBe(fm); // same reference
  });

  it("FabricMap.toNativeValue(false) copies a FrozenMap to mutable Map", () => {
    const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
    const sm = new FabricMap(fm);
    const result = sm.toNativeValue(false);
    expect(result).not.toBe(fm);
    expect(result).toBeInstanceOf(Map);
    expect(result).not.toBeInstanceOf(FrozenMap);
    expect(result.get("a" as FabricValue)).toBe(1);
  });

  // FabricMap deliberately keeps throwing stubs for the protocol methods
  // (per Dan's PR #3612 review: not yet used, reworked separately).
  describe("[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — via dispatch", () => {
    it("[DEEP_FREEZE] throws not-yet-implemented", () => {
      const fm = new FabricMap(
        new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
      );
      expect(() => deepFreeze(fm)).toThrow("FabricMap: not yet implemented");
    });

    it("[IS_DEEP_FROZEN] throws not-yet-implemented (via type guard)", () => {
      const fm = new FabricMap(
        new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
      );
      Object.freeze(fm);
      expect(() => isDeepFrozenFabricValue(fm)).toThrow(
        "FabricMap: not yet implemented",
      );
    });
  });

  describe("[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — direct member invocation", () => {
    it("[DEEP_FREEZE] throws not-yet-implemented", () => {
      const fm = new FabricMap(
        new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
      );
      expect(() => fm[DEEP_FREEZE](subFreeze)).toThrow(
        "FabricMap: not yet implemented",
      );
    });

    it("[IS_DEEP_FROZEN] throws not-yet-implemented", () => {
      const fm = new FabricMap(
        new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
      );
      Object.freeze(fm);
      expect(() => fm[IS_DEEP_FROZEN](subIsDeepFrozen)).toThrow(
        "FabricMap: not yet implemented",
      );
    });
  });
});
