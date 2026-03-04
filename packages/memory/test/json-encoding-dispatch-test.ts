import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  decodeJsonValue,
  encodeJsonValue,
  resetJsonEncodingConfig,
  setJsonEncodingConfig,
} from "../json-encoding-dispatch.ts";
import type { ReconstructionContext } from "../storable-protocol.ts";
import type { StorableValue } from "../interface.ts";

/** Mock runtime for deserialization calls. */
const mockRuntime: ReconstructionContext = {
  getCell(_ref) {
    throw new Error("getCell not implemented in test runtime");
  },
};

// ============================================================================
// Tests
// ============================================================================

describe("json-encoding-dispatch", () => {
  // Always reset after each test to avoid leaking flag state.
  afterEach(() => {
    resetJsonEncodingConfig();
  });

  // --------------------------------------------------------------------------
  // Default state (flag OFF)
  // --------------------------------------------------------------------------

  describe("default state (flag OFF)", () => {
    it("encodeJsonValue is passthrough", () => {
      const value = { hello: "world" } as StorableValue;
      expect(encodeJsonValue(value)).toBe(value);
    });

    it("decodeJsonValue is passthrough", () => {
      const data = { hello: "world" } as StorableValue;
      expect(decodeJsonValue(data, mockRuntime)).toBe(data);
    });

    it("encodeJsonValue passes through undefined", () => {
      expect(encodeJsonValue(undefined)).toBe(undefined);
    });

    it("encodeJsonValue passes through null", () => {
      expect(encodeJsonValue(null)).toBe(null);
    });

    it("encodeJsonValue passes through primitives", () => {
      expect(encodeJsonValue(42 as StorableValue)).toBe(42);
      expect(encodeJsonValue("hello" as StorableValue)).toBe("hello");
      expect(encodeJsonValue(true as StorableValue)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Flag ON behavior
  // --------------------------------------------------------------------------

  describe("flag ON behavior", () => {
    it("encodeJsonValue serializes undefined to tagged form", () => {
      setJsonEncodingConfig(true);
      const result = encodeJsonValue(undefined);
      expect(result).toEqual({ "/Undefined@1": null });
    });

    it("encodeJsonValue serializes bigint to tagged form", () => {
      setJsonEncodingConfig(true);
      const result = encodeJsonValue(42n as StorableValue);
      // BigInt is serialized via the BigIntHandler with tag "BigInt@1"
      // and base64url two's-complement encoding.
      expect(result).toEqual({ "/BigInt@1": "Kg" });
    });

    it("decodeJsonValue deserializes tagged undefined", () => {
      setJsonEncodingConfig(true);
      const data = { "/Undefined@1": null } as unknown as StorableValue;
      const result = decodeJsonValue(data, mockRuntime);
      expect(result).toBe(undefined);
    });

    it("decodeJsonValue deserializes tagged bigint", () => {
      setJsonEncodingConfig(true);
      const data = { "/BigInt@1": "Kg" } as unknown as StorableValue;
      const result = decodeJsonValue(data, mockRuntime);
      expect(result).toBe(42n);
    });

    it("round-trip preserves undefined", () => {
      setJsonEncodingConfig(true);
      const encoded = encodeJsonValue(undefined);
      const decoded = decodeJsonValue(encoded, mockRuntime);
      expect(decoded).toBe(undefined);
    });

    it("round-trip preserves bigint", () => {
      setJsonEncodingConfig(true);
      const encoded = encodeJsonValue(42n as StorableValue);
      const decoded = decodeJsonValue(encoded, mockRuntime);
      expect(decoded).toBe(42n);
    });

    it("round-trip preserves plain objects", () => {
      setJsonEncodingConfig(true);
      const value = { a: 1, b: "two" } as StorableValue;
      const encoded = encodeJsonValue(value);
      const decoded = decodeJsonValue(encoded, mockRuntime);
      expect(decoded).toEqual({ a: 1, b: "two" });
    });

    it("round-trip preserves arrays", () => {
      setJsonEncodingConfig(true);
      const value = [1, "two", null] as StorableValue;
      const encoded = encodeJsonValue(value);
      const decoded = decodeJsonValue(encoded, mockRuntime);
      expect(decoded).toEqual([1, "two", null]);
    });

    it("round-trip preserves null", () => {
      setJsonEncodingConfig(true);
      const encoded = encodeJsonValue(null);
      const decoded = decodeJsonValue(encoded, mockRuntime);
      expect(decoded).toBe(null);
    });

    it("encodeJsonValue passes through JSON-safe primitives unchanged", () => {
      setJsonEncodingConfig(true);
      // Primitives that are JSON-safe should remain as-is after serialization.
      expect(encodeJsonValue(42 as StorableValue)).toBe(42);
      expect(encodeJsonValue("hello" as StorableValue)).toBe("hello");
      expect(encodeJsonValue(true as StorableValue)).toBe(true);
      expect(encodeJsonValue(null)).toBe(null);
    });
  });

  // --------------------------------------------------------------------------
  // Flag OFF behavior (explicit)
  // --------------------------------------------------------------------------

  describe("flag OFF behavior (explicit)", () => {
    it("encodeJsonValue returns value unchanged after explicit OFF", () => {
      setJsonEncodingConfig(false);
      const value = { x: 1 } as StorableValue;
      expect(encodeJsonValue(value)).toBe(value);
    });

    it("decodeJsonValue returns data unchanged after explicit OFF", () => {
      setJsonEncodingConfig(false);
      const data = { x: 1 } as StorableValue;
      expect(decodeJsonValue(data, mockRuntime)).toBe(data);
    });
  });

  // --------------------------------------------------------------------------
  // Config lifecycle
  // --------------------------------------------------------------------------

  describe("config lifecycle", () => {
    it("setJsonEncodingConfig(true) enables dispatch", () => {
      setJsonEncodingConfig(true);
      // undefined should be serialized (not passthrough).
      const result = encodeJsonValue(undefined);
      expect(result).toEqual({ "/Undefined@1": null });
    });

    it("resetJsonEncodingConfig() restores passthrough", () => {
      setJsonEncodingConfig(true);
      resetJsonEncodingConfig();
      // Should be passthrough again.
      const value = { a: 1 } as StorableValue;
      expect(encodeJsonValue(value)).toBe(value);
    });

    it("multiple set/reset cycles work correctly", () => {
      // Cycle 1: ON
      setJsonEncodingConfig(true);
      expect(encodeJsonValue(undefined)).toEqual({ "/Undefined@1": null });

      // Cycle 1: OFF
      resetJsonEncodingConfig();
      const obj1 = { a: 1 } as StorableValue;
      expect(encodeJsonValue(obj1)).toBe(obj1);

      // Cycle 2: ON
      setJsonEncodingConfig(true);
      expect(encodeJsonValue(undefined)).toEqual({ "/Undefined@1": null });

      // Cycle 2: OFF
      resetJsonEncodingConfig();
      const obj2 = { b: 2 } as StorableValue;
      expect(encodeJsonValue(obj2)).toBe(obj2);
    });

    it("setJsonEncodingConfig(false) after true restores passthrough", () => {
      setJsonEncodingConfig(true);
      setJsonEncodingConfig(false);
      const value = undefined;
      expect(encodeJsonValue(value)).toBe(undefined);
    });
  });
});
