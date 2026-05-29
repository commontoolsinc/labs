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
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (they don't fit a single member, aren't construction mechanics).
  it("implements `FabricInstance` with tag `Map@1`", () => {
    const sm = new FabricMap(new Map());
    expect(sm instanceof FabricInstance).toBe(true);
    expect(sm.typeTag).toBe("Map@1");
  });

  it("is an instance of `FabricNativeWrapper`", () => {
    const sm = new FabricMap(new Map());
    expect(sm instanceof FabricNativeWrapper).toBe(true);
  });

  describe("instance members", () => {
    describe("[DECONSTRUCT]", () => {
      it("throws (stub)", () => {
        const sm = new FabricMap(new Map());
        expect(() => sm[DECONSTRUCT]()).toThrow("not yet implemented");
      });
    });

    describe("toNativeValue()", () => {
      it("returns a `FrozenMap` when `frozen` is `true`", () => {
        const map = new Map<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(map);
        const result = sm.toNativeValue(true);
        expect(result).toBeInstanceOf(FrozenMap);
        expect((result as FrozenMap<string, number>).get("a")).toBe(1);
      });

      it("returns the original `Map` when `frozen` is `false`", () => {
        const map = new Map<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(map);
        const result = sm.toNativeValue(false);
        expect(result).toBe(map); // same reference
        expect(result).toBeInstanceOf(Map);
        expect(result).not.toBeInstanceOf(FrozenMap);
      });

      it("returns the same `FrozenMap` if already frozen (`frozen=true`)", () => {
        const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(fm);
        const result = sm.toNativeValue(true);
        expect(result).toBe(fm); // same reference
      });

      it("copies a `FrozenMap` to a mutable `Map` (`frozen=false`)", () => {
        const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(fm);
        const result = sm.toNativeValue(false);
        expect(result).not.toBe(fm);
        expect(result).toBeInstanceOf(Map);
        expect(result).not.toBeInstanceOf(FrozenMap);
        expect(result.get("a" as FabricValue)).toBe(1);
      });
    });

    // FabricMap deliberately keeps throwing stubs for the protocol methods
    // (per Dan's PR #3612 review: not yet used, reworked separately).
    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      it("via dispatch: `[DEEP_FREEZE]` throws not-yet-implemented", () => {
        const fm = new FabricMap(
          new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
        );
        expect(() => deepFreeze(fm)).toThrow("FabricMap: not yet implemented");
      });

      it("via dispatch: `[IS_DEEP_FROZEN]` throws not-yet-implemented (via type guard)", () => {
        const fm = new FabricMap(
          new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
        );
        Object.freeze(fm);
        expect(() => isDeepFrozenFabricValue(fm)).toThrow(
          "FabricMap: not yet implemented",
        );
      });

      it("via direct member invocation: `[DEEP_FREEZE]` throws not-yet-implemented", () => {
        const fm = new FabricMap(
          new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
        );
        expect(() => fm[DEEP_FREEZE](subFreeze)).toThrow(
          "FabricMap: not yet implemented",
        );
      });

      it("via direct member invocation: `[IS_DEEP_FROZEN]` throws not-yet-implemented", () => {
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

  describe("static members", () => {
    describe("[RECONSTRUCT]", () => {
      it("throws (stub)", () => {
        expect(() => FabricMap[RECONSTRUCT](null, dummyContext)).toThrow(
          "not yet implemented",
        );
      });
    });
  });
});
