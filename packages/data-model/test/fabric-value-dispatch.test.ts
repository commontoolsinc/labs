import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromNativeValue,
  nativeFromFabricValue,
  resetDataModelConfig,
  setDataModelConfig,
} from "../fabric-value.ts";
import type { FabricValue } from "../fabric-value.ts";
import { FabricError } from "../fabric-native-instances.ts";

/** Encode then decode a value through the current dispatch configuration. */
function roundTrip(value: FabricValue): FabricValue {
  return nativeFromFabricValue(fabricFromNativeValue(value));
}

// ============================================================================
// Tests
// ============================================================================

describe("fabric-value-dispatch", () => {
  // Always reset after each test to avoid leaking flag state.
  afterEach(() => {
    resetDataModelConfig();
  });

  // --------------------------------------------------------------------------
  // Default state (flag OFF)
  // --------------------------------------------------------------------------

  describe("default state (flag OFF)", () => {
    it("fabricFromNativeValue performs legacy deep conversion", () => {
      const value = { hello: "world" } as FabricValue;
      // fabricFromNativeValue returns a new frozen copy for objects.
      const stored = fabricFromNativeValue(value);
      expect(stored).toEqual({ hello: "world" });
    });

    it("nativeFromFabricValue is identity passthrough", () => {
      const value = { hello: "world" } as FabricValue;
      expect(nativeFromFabricValue(value)).toBe(value);
    });

    it("fabricFromNativeValue converts Error via legacy path", () => {
      // fabricFromNativeValue handles Error conversion directly (the old
      // toDeepStorableValue function has been subsumed).
      const error = new Error("legacy error");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      expect(stored).not.toBeInstanceOf(Error);
      const obj = stored as Record<string, unknown>;
      expect(obj["@Error"]).toBeDefined();
      expect((obj["@Error"] as Record<string, unknown>).message).toBe(
        "legacy error",
      );
    });

    it("primitives pass through", () => {
      expect(fabricFromNativeValue(42 as FabricValue)).toBe(42);
      expect(fabricFromNativeValue("hello" as FabricValue)).toBe("hello");
      expect(fabricFromNativeValue(null)).toBe(null);
      expect(fabricFromNativeValue(true as FabricValue)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Flag ON: modern fabric value conversion
  // --------------------------------------------------------------------------

  describe("flag ON: modern fabric value conversion", () => {
    it("round-trip preserves primitives", () => {
      setDataModelConfig(true);
      expect(roundTrip(42 as FabricValue)).toBe(42);
      expect(roundTrip("hello" as FabricValue)).toBe("hello");
      expect(roundTrip(null)).toBe(null);
      expect(roundTrip(true as FabricValue)).toBe(true);
    });

    it("round-trip preserves undefined", () => {
      setDataModelConfig(true);
      expect(roundTrip(undefined)).toBe(undefined);
    });

    it("round-trip preserves bigint", () => {
      setDataModelConfig(true);
      expect(roundTrip(42n as FabricValue)).toBe(42n);
    });

    it("round-trip preserves plain objects", () => {
      setDataModelConfig(true);
      const value = { a: 1, b: "two" } as FabricValue;
      expect(roundTrip(value)).toEqual({ a: 1, b: "two" });
    });

    it("round-trip preserves arrays", () => {
      setDataModelConfig(true);
      const value = [1, "two", null] as FabricValue;
      expect(roundTrip(value)).toEqual([1, "two", null]);
    });

    it("fabricFromNativeValue wraps Error into FabricError", () => {
      setDataModelConfig(true);
      const error = new Error("test error");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      expect(stored).toBeInstanceOf(FabricError);
    });

    it("nativeFromFabricValue unwraps FabricError back to Error", () => {
      setDataModelConfig(true);
      const error = new Error("test error");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      const restored = nativeFromFabricValue(stored);
      expect(restored).toBeInstanceOf(Error);
      expect((restored as unknown as Error).message).toBe("test error");
    });

    it("fabricFromNativeValue deep-freezes result", () => {
      setDataModelConfig(true);
      const value = { a: 1, b: [2, 3] } as FabricValue;
      const stored = fabricFromNativeValue(value);
      expect(Object.isFrozen(stored)).toBe(true);
    });

    it("round-trip preserves nested structure", () => {
      setDataModelConfig(true);
      const value = {
        name: "test",
        count: 42n,
        missing: undefined,
      } as FabricValue;
      const result = roundTrip(value) as Record<string, unknown>;
      expect(result.name).toBe("test");
      expect(result.count).toBe(42n);
      expect(result.missing).toBe(undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Config lifecycle
  // --------------------------------------------------------------------------

  describe("config lifecycle", () => {
    it("setDataModelConfig(true) enables conversion", () => {
      setDataModelConfig(true);
      const error = new Error("test");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      expect(stored).toBeInstanceOf(FabricError);
    });

    it("resetDataModelConfig() restores legacy conversion", () => {
      setDataModelConfig(true);
      resetDataModelConfig();
      const error = new Error("reset test");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      // Back to legacy path: Error becomes @Error object, not FabricError.
      expect(stored).not.toBeInstanceOf(FabricError);
      const obj = stored as Record<string, unknown>;
      expect(obj["@Error"]).toBeDefined();
    });

    it("multiple set/reset cycles work correctly", () => {
      // Cycle 1: ON — modern conversion
      setDataModelConfig(true);
      const error1 = new Error("test1");
      expect(fabricFromNativeValue(error1 as unknown as FabricValue))
        .toBeInstanceOf(
          FabricError,
        );

      // Cycle 1: OFF — legacy conversion
      resetDataModelConfig();
      const error1b = new Error("test1b");
      const stored1 = fabricFromNativeValue(
        error1b as unknown as FabricValue,
      );
      expect(stored1).not.toBeInstanceOf(FabricError);
      expect((stored1 as Record<string, unknown>)["@Error"]).toBeDefined();

      // Cycle 2: ON — modern conversion
      setDataModelConfig(true);
      const error2 = new Error("test2");
      expect(fabricFromNativeValue(error2 as unknown as FabricValue))
        .toBeInstanceOf(
          FabricError,
        );

      // Cycle 2: OFF — legacy conversion
      resetDataModelConfig();
      const error2b = new Error("test2b");
      const stored2 = fabricFromNativeValue(
        error2b as unknown as FabricValue,
      );
      expect(stored2).not.toBeInstanceOf(FabricError);
      expect((stored2 as Record<string, unknown>)["@Error"]).toBeDefined();
    });

    it("setDataModelConfig(false) after true restores legacy conversion", () => {
      setDataModelConfig(true);
      setDataModelConfig(false);
      const error = new Error("toggle test");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      expect(stored).not.toBeInstanceOf(FabricError);
      expect((stored as Record<string, unknown>)["@Error"]).toBeDefined();
    });
  });
});
