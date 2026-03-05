import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fromStorable,
  resetStorableValueConfig,
  setStorableValueConfig,
  toStorable,
} from "../storable-value-dispatch.ts";
import type { StorableValue } from "../interface.ts";
import { StorableError } from "../storable-native-instances.ts";
import { toDeepStorableValue } from "../storable-value.ts";

/** Encode then decode a value through the current dispatch configuration. */
function roundTrip(value: StorableValue): StorableValue {
  return fromStorable(toStorable(value));
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
    it("toStorable is identity passthrough", () => {
      const value = { hello: "world" } as StorableValue;
      expect(toStorable(value)).toBe(value);
    });

    it("fromStorable is identity passthrough", () => {
      const value = { hello: "world" } as StorableValue;
      expect(fromStorable(value)).toBe(value);
    });

    it("round-trip preserves object identity", () => {
      const value = { a: 1, b: [2, 3] } as StorableValue;
      expect(roundTrip(value)).toBe(value);
    });

    it("toDeepStorableValue + toStorable chain converts Error (legacy path)", () => {
      // Simulates the setRaw() pipeline: toDeepStorableValue handles legacy
      // Error conversion even when the dispatch flag is OFF.
      const error = new Error("legacy error");
      const stored = toStorable(
        toDeepStorableValue(error as unknown as StorableValue),
      );
      // Legacy path converts Error to a plain object with @Error key.
      expect(stored).not.toBeInstanceOf(Error);
      const obj = stored as Record<string, unknown>;
      expect(obj["@Error"]).toBeDefined();
      expect((obj["@Error"] as Record<string, unknown>).message).toBe(
        "legacy error",
      );
    });

    it("primitives pass through", () => {
      expect(toStorable(42 as StorableValue)).toBe(42);
      expect(toStorable("hello" as StorableValue)).toBe("hello");
      expect(toStorable(null)).toBe(null);
      expect(toStorable(true as StorableValue)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Flag ON: rich storable value conversion
  // --------------------------------------------------------------------------

  describe("flag ON: rich storable value conversion", () => {
    it("round-trip preserves primitives", () => {
      setStorableValueConfig(true);
      expect(roundTrip(42 as StorableValue)).toBe(42);
      expect(roundTrip("hello" as StorableValue)).toBe("hello");
      expect(roundTrip(null)).toBe(null);
      expect(roundTrip(true as StorableValue)).toBe(true);
    });

    it("round-trip preserves undefined", () => {
      setStorableValueConfig(true);
      expect(roundTrip(undefined)).toBe(undefined);
    });

    it("round-trip preserves bigint", () => {
      setStorableValueConfig(true);
      expect(roundTrip(42n as StorableValue)).toBe(42n);
    });

    it("round-trip preserves plain objects", () => {
      setStorableValueConfig(true);
      const value = { a: 1, b: "two" } as StorableValue;
      expect(roundTrip(value)).toEqual({ a: 1, b: "two" });
    });

    it("round-trip preserves arrays", () => {
      setStorableValueConfig(true);
      const value = [1, "two", null] as StorableValue;
      expect(roundTrip(value)).toEqual([1, "two", null]);
    });

    it("toStorable wraps Error into StorableError", () => {
      setStorableValueConfig(true);
      const error = new Error("test error");
      const stored = toStorable(error as unknown as StorableValue);
      expect(stored).toBeInstanceOf(StorableError);
    });

    it("fromStorable unwraps StorableError back to Error", () => {
      setStorableValueConfig(true);
      const error = new Error("test error");
      const stored = toStorable(error as unknown as StorableValue);
      const restored = fromStorable(stored);
      expect(restored).toBeInstanceOf(Error);
      expect((restored as unknown as Error).message).toBe("test error");
    });

    it("toStorable deep-freezes result", () => {
      setStorableValueConfig(true);
      const value = { a: 1, b: [2, 3] } as StorableValue;
      const stored = toStorable(value);
      expect(Object.isFrozen(stored)).toBe(true);
    });

    it("round-trip preserves nested structure", () => {
      setStorableValueConfig(true);
      const value = {
        name: "test",
        count: 42n,
        missing: undefined,
      } as StorableValue;
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
    it("setStorableValueConfig(true) enables conversion", () => {
      setStorableValueConfig(true);
      const error = new Error("test");
      const stored = toStorable(error as unknown as StorableValue);
      expect(stored).toBeInstanceOf(StorableError);
    });

    it("resetStorableValueConfig() restores passthrough", () => {
      setStorableValueConfig(true);
      resetStorableValueConfig();
      const value = { a: 1 } as StorableValue;
      expect(toStorable(value)).toBe(value);
    });

    it("multiple set/reset cycles work correctly", () => {
      // Cycle 1: ON
      setStorableValueConfig(true);
      const error1 = new Error("test1");
      expect(toStorable(error1 as unknown as StorableValue)).toBeInstanceOf(
        StorableError,
      );

      // Cycle 1: OFF
      resetStorableValueConfig();
      const value1 = { a: 1 } as StorableValue;
      expect(toStorable(value1)).toBe(value1);

      // Cycle 2: ON
      setStorableValueConfig(true);
      const error2 = new Error("test2");
      expect(toStorable(error2 as unknown as StorableValue)).toBeInstanceOf(
        StorableError,
      );

      // Cycle 2: OFF
      resetStorableValueConfig();
      const value2 = { b: 2 } as StorableValue;
      expect(toStorable(value2)).toBe(value2);
    });

    it("setStorableValueConfig(false) after true restores passthrough", () => {
      setStorableValueConfig(true);
      setStorableValueConfig(false);
      const value = { a: 1 } as StorableValue;
      expect(toStorable(value)).toBe(value);
    });
  });
});
