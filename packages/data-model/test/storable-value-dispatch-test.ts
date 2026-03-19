import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  nativeFromStorableValue,
  resetStorableValueConfig,
  setStorableValueConfig,
  storableFromNativeValue,
} from "../storable-value.ts";
import type { FabricValue } from "../fabric-value.ts";
import { StorableError } from "../storable-native-instances.ts";

/** Encode then decode a value through the current dispatch configuration. */
function roundTrip(value: FabricValue): FabricValue {
  return nativeFromStorableValue(storableFromNativeValue(value));
}

// ============================================================================
// Tests
// ============================================================================

describe("storable-value-dispatch", () => {
  // Always reset after each test to avoid leaking flag state.
  afterEach(() => {
    resetStorableValueConfig();
  });

  // --------------------------------------------------------------------------
  // Default state (flag OFF)
  // --------------------------------------------------------------------------

  describe("default state (flag OFF)", () => {
    it("storableFromNativeValue performs legacy deep conversion", () => {
      const value = { hello: "world" } as FabricValue;
      // storableFromNativeValue returns a new frozen copy for objects.
      const stored = storableFromNativeValue(value);
      expect(stored).toEqual({ hello: "world" });
    });

    it("nativeFromStorableValue is identity passthrough", () => {
      const value = { hello: "world" } as FabricValue;
      expect(nativeFromStorableValue(value)).toBe(value);
    });

    it("storableFromNativeValue converts Error via legacy path", () => {
      // storableFromNativeValue handles Error conversion directly (the old
      // toDeepStorableValue function has been subsumed).
      const error = new Error("legacy error");
      const stored = storableFromNativeValue(error as unknown as FabricValue);
      expect(stored).not.toBeInstanceOf(Error);
      const obj = stored as Record<string, unknown>;
      expect(obj["@Error"]).toBeDefined();
      expect((obj["@Error"] as Record<string, unknown>).message).toBe(
        "legacy error",
      );
    });

    it("primitives pass through", () => {
      expect(storableFromNativeValue(42 as FabricValue)).toBe(42);
      expect(storableFromNativeValue("hello" as FabricValue)).toBe("hello");
      expect(storableFromNativeValue(null)).toBe(null);
      expect(storableFromNativeValue(true as FabricValue)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Flag ON: rich storable value conversion
  // --------------------------------------------------------------------------

  describe("flag ON: rich storable value conversion", () => {
    it("round-trip preserves primitives", () => {
      setStorableValueConfig({ richStorableValues: true });
      expect(roundTrip(42 as FabricValue)).toBe(42);
      expect(roundTrip("hello" as FabricValue)).toBe("hello");
      expect(roundTrip(null)).toBe(null);
      expect(roundTrip(true as FabricValue)).toBe(true);
    });

    it("round-trip preserves undefined", () => {
      setStorableValueConfig({ richStorableValues: true });
      expect(roundTrip(undefined)).toBe(undefined);
    });

    it("round-trip preserves bigint", () => {
      setStorableValueConfig({ richStorableValues: true });
      expect(roundTrip(42n as FabricValue)).toBe(42n);
    });

    it("round-trip preserves plain objects", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1, b: "two" } as FabricValue;
      expect(roundTrip(value)).toEqual({ a: 1, b: "two" });
    });

    it("round-trip preserves arrays", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = [1, "two", null] as FabricValue;
      expect(roundTrip(value)).toEqual([1, "two", null]);
    });

    it("storableFromNativeValue wraps Error into StorableError", () => {
      setStorableValueConfig({ richStorableValues: true });
      const error = new Error("test error");
      const stored = storableFromNativeValue(error as unknown as FabricValue);
      expect(stored).toBeInstanceOf(StorableError);
    });

    it("nativeFromStorableValue unwraps StorableError back to Error", () => {
      setStorableValueConfig({ richStorableValues: true });
      const error = new Error("test error");
      const stored = storableFromNativeValue(error as unknown as FabricValue);
      const restored = nativeFromStorableValue(stored);
      expect(restored).toBeInstanceOf(Error);
      expect((restored as unknown as Error).message).toBe("test error");
    });

    it("storableFromNativeValue deep-freezes result", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1, b: [2, 3] } as FabricValue;
      const stored = storableFromNativeValue(value);
      expect(Object.isFrozen(stored)).toBe(true);
    });

    it("round-trip preserves nested structure", () => {
      setStorableValueConfig({ richStorableValues: true });
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
    it("setStorableValueConfig({ richStorableValues: true }) enables conversion", () => {
      setStorableValueConfig({ richStorableValues: true });
      const error = new Error("test");
      const stored = storableFromNativeValue(error as unknown as FabricValue);
      expect(stored).toBeInstanceOf(StorableError);
    });

    it("resetStorableValueConfig() restores legacy conversion", () => {
      setStorableValueConfig({ richStorableValues: true });
      resetStorableValueConfig();
      const error = new Error("reset test");
      const stored = storableFromNativeValue(error as unknown as FabricValue);
      // Back to legacy path: Error becomes @Error object, not StorableError.
      expect(stored).not.toBeInstanceOf(StorableError);
      const obj = stored as Record<string, unknown>;
      expect(obj["@Error"]).toBeDefined();
    });

    it("multiple set/reset cycles work correctly", () => {
      // Cycle 1: ON — rich conversion
      setStorableValueConfig({ richStorableValues: true });
      const error1 = new Error("test1");
      expect(storableFromNativeValue(error1 as unknown as FabricValue))
        .toBeInstanceOf(
          StorableError,
        );

      // Cycle 1: OFF — legacy conversion
      resetStorableValueConfig();
      const error1b = new Error("test1b");
      const stored1 = storableFromNativeValue(
        error1b as unknown as FabricValue,
      );
      expect(stored1).not.toBeInstanceOf(StorableError);
      expect((stored1 as Record<string, unknown>)["@Error"]).toBeDefined();

      // Cycle 2: ON — rich conversion
      setStorableValueConfig({ richStorableValues: true });
      const error2 = new Error("test2");
      expect(storableFromNativeValue(error2 as unknown as FabricValue))
        .toBeInstanceOf(
          StorableError,
        );

      // Cycle 2: OFF — legacy conversion
      resetStorableValueConfig();
      const error2b = new Error("test2b");
      const stored2 = storableFromNativeValue(
        error2b as unknown as FabricValue,
      );
      expect(stored2).not.toBeInstanceOf(StorableError);
      expect((stored2 as Record<string, unknown>)["@Error"]).toBeDefined();
    });

    it("setStorableValueConfig({ richStorableValues: false }) after true restores legacy conversion", () => {
      setStorableValueConfig({ richStorableValues: true });
      setStorableValueConfig({ richStorableValues: false });
      const error = new Error("toggle test");
      const stored = storableFromNativeValue(error as unknown as FabricValue);
      expect(stored).not.toBeInstanceOf(StorableError);
      expect((stored as Record<string, unknown>)["@Error"]).toBeDefined();
    });
  });
});
