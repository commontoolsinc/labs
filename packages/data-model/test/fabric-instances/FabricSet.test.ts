import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  DEEP_FREEZE,
  FabricInstance,
  type FabricValue,
  IS_DEEP_FROZEN,
} from "../../src/interface.ts";
import { FabricSet } from "../../src/fabric-instances/FabricSet.ts";
import { FrozenSet } from "../../src/frozen-builtins.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "../../src/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("FabricSet", () => {
  it("FabricSet implements FabricInstance", () => {
    const ss = new FabricSet(new Set());
    expect(ss instanceof FabricInstance).toBe(true);
    expect(ss.typeTag).toBe("Set@1");
  });

  it("FabricSet [DECONSTRUCT] throws (stub)", () => {
    const ss = new FabricSet(new Set());
    expect(() => ss[DECONSTRUCT]()).toThrow("not yet implemented");
  });

  it("FabricSet.toNativeValue(true) returns FrozenSet", () => {
    const set = new Set<FabricValue>([1, 2]);
    const ss = new FabricSet(set);
    const result = ss.toNativeValue(true);
    expect(result).toBeInstanceOf(FrozenSet);
    expect((result as FrozenSet<number>).has(1)).toBe(true);
  });

  it("FabricSet.toNativeValue(false) returns the original Set", () => {
    const set = new Set<FabricValue>([1, 2]);
    const ss = new FabricSet(set);
    const result = ss.toNativeValue(false);
    expect(result).toBe(set); // same reference
    expect(result).toBeInstanceOf(Set);
    expect(result).not.toBeInstanceOf(FrozenSet);
  });

  it("FabricSet.toNativeValue(true) returns same FrozenSet if already frozen", () => {
    const fs = new FrozenSet<FabricValue>([1, 2]);
    const ss = new FabricSet(fs);
    const result = ss.toNativeValue(true);
    expect(result).toBe(fs); // same reference
  });

  it("FabricSet.toNativeValue(false) copies a FrozenSet to mutable Set", () => {
    const fs = new FrozenSet<FabricValue>([1, 2]);
    const ss = new FabricSet(fs);
    const result = ss.toNativeValue(false);
    expect(result).not.toBe(fs);
    expect(result).toBeInstanceOf(Set);
    expect(result).not.toBeInstanceOf(FrozenSet);
    expect(result.has(1 as FabricValue)).toBe(true);
  });

  describe("[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — via dispatch", () => {
    it("[DEEP_FREEZE] throws not-yet-implemented", () => {
      const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
      expect(() => deepFreeze(fs)).toThrow("FabricSet: not yet implemented");
    });

    it("[IS_DEEP_FROZEN] throws not-yet-implemented (via type guard)", () => {
      const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
      Object.freeze(fs);
      expect(() => isDeepFrozenFabricValue(fs)).toThrow(
        "FabricSet: not yet implemented",
      );
    });
  });

  describe("[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — direct member invocation", () => {
    it("[DEEP_FREEZE] throws not-yet-implemented", () => {
      const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
      expect(() => fs[DEEP_FREEZE](subFreeze)).toThrow(
        "FabricSet: not yet implemented",
      );
    });

    it("[IS_DEEP_FROZEN] throws not-yet-implemented", () => {
      const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
      Object.freeze(fs);
      expect(() => fs[IS_DEEP_FROZEN](subIsDeepFrozen)).toThrow(
        "FabricSet: not yet implemented",
      );
    });
  });
});
