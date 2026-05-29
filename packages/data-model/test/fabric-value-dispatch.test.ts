import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromNativeValue,
  getDataModelConfig,
  nativeFromFabricValue,
  resetDataModelConfig,
  setDataModelConfig,
} from "../src/fabric-value.ts";
import type { FabricValue } from "../src/fabric-value.ts";
import { FabricError } from "../src/fabric-instances/FabricError.ts";

/** Encode then decode a value through the current dispatch configuration. */
function roundTrip(value: FabricValue): FabricValue {
  return nativeFromFabricValue(fabricFromNativeValue(value));
}

describe("fabric-value-dispatch", () => {
  // Always reset after each test to avoid leaking flag state.
  afterEach(() => {
    resetDataModelConfig();
  });

  describe("flag OFF: legacy fabric value conversion", () => {
    it("performs legacy deep conversion via `fabricFromNativeValue`", () => {
      setDataModelConfig(false);
      const value = { hello: "world" } as FabricValue;
      // fabricFromNativeValue returns a new frozen copy for objects.
      const stored = fabricFromNativeValue(value);
      expect(stored).toEqual({ hello: "world" });
    });

    it("is an identity passthrough via `nativeFromFabricValue`", () => {
      setDataModelConfig(false);
      const value = { hello: "world" } as FabricValue;
      expect(nativeFromFabricValue(value)).toBe(value);
    });

    it("converts `Error` via legacy path through `fabricFromNativeValue`", () => {
      setDataModelConfig(false);
      // `fabricFromNativeValue()` handles Error conversion directly.
      const error = new Error("legacy error");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      expect(stored).not.toBeInstanceOf(Error);
      const obj = stored as Record<string, unknown>;
      expect(obj["@Error"]).toBeDefined();
      expect((obj["@Error"] as Record<string, unknown>).message).toBe(
        "legacy error",
      );
    });

    it("passes primitives through", () => {
      setDataModelConfig(false);
      expect(fabricFromNativeValue(42 as FabricValue)).toBe(42);
      expect(fabricFromNativeValue("hello" as FabricValue)).toBe("hello");
      expect(fabricFromNativeValue(null)).toBe(null);
      expect(fabricFromNativeValue(true as FabricValue)).toBe(true);
    });
  });

  describe("flag ON: modern fabric value conversion", () => {
    it("round-trips primitives", () => {
      setDataModelConfig(true);
      expect(roundTrip(42 as FabricValue)).toBe(42);
      expect(roundTrip("hello" as FabricValue)).toBe("hello");
      expect(roundTrip(null)).toBe(null);
      expect(roundTrip(true as FabricValue)).toBe(true);
    });

    it("round-trips `undefined`", () => {
      setDataModelConfig(true);
      expect(roundTrip(undefined)).toBe(undefined);
    });

    it("round-trips `bigint`", () => {
      setDataModelConfig(true);
      expect(roundTrip(42n as FabricValue)).toBe(42n);
    });

    it("round-trips plain objects", () => {
      setDataModelConfig(true);
      const value = { a: 1, b: "two" } as FabricValue;
      expect(roundTrip(value)).toEqual({ a: 1, b: "two" });
    });

    it("round-trips arrays", () => {
      setDataModelConfig(true);
      const value = [1, "two", null] as FabricValue;
      expect(roundTrip(value)).toEqual([1, "two", null]);
    });

    it("wraps `Error` into `FabricError` via `fabricFromNativeValue`", () => {
      setDataModelConfig(true);
      const error = new Error("test error");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      expect(stored).toBeInstanceOf(FabricError);
    });

    it("unwraps `FabricError` back to `Error` via `nativeFromFabricValue`", () => {
      setDataModelConfig(true);
      const error = new Error("test error");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      const restored = nativeFromFabricValue(stored);
      expect(restored).toBeInstanceOf(Error);
      expect((restored as unknown as Error).message).toBe("test error");
    });

    it("deep-freezes the result via `fabricFromNativeValue`", () => {
      setDataModelConfig(true);
      const value = { a: 1, b: [2, 3] } as FabricValue;
      const stored = fabricFromNativeValue(value);
      expect(Object.isFrozen(stored)).toBe(true);
    });

    it("round-trips nested structure", () => {
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

  describe("config lifecycle", () => {
    it("enables conversion after `setDataModelConfig(true)`", () => {
      setDataModelConfig(true);
      const error = new Error("test");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      expect(stored).toBeInstanceOf(FabricError);
    });

    it("restores the default state on `resetDataModelConfig()`", () => {
      const defaultState = getDataModelConfig();
      setDataModelConfig(!defaultState);
      expect(getDataModelConfig()).toBe(!defaultState);
      resetDataModelConfig();
      expect(getDataModelConfig()).toBe(defaultState);
    });

    it("works correctly across multiple set/reset cycles", () => {
      const defaultState = getDataModelConfig();
      for (let i = 0; i < 3; i++) {
        setDataModelConfig(true);
        expect(getDataModelConfig()).toBe(true);
        setDataModelConfig(false);
        expect(getDataModelConfig()).toBe(false);
        resetDataModelConfig();
        expect(getDataModelConfig()).toBe(defaultState);
      }
    });

    it("restores legacy conversion on `setDataModelConfig(false)` after `true`", () => {
      setDataModelConfig(true);
      setDataModelConfig(false);
      const error = new Error("toggle test");
      const stored = fabricFromNativeValue(error as unknown as FabricValue);
      expect(stored).not.toBeInstanceOf(FabricError);
      expect((stored as Record<string, unknown>)["@Error"]).toBeDefined();
    });
  });
});
