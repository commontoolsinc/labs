import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  decodeJsonValue,
  encodeJsonValue,
  jsonFromValue,
  resetJsonEncodingConfig,
  setJsonEncodingConfig,
  valueFromJson,
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
  // Edge cases (flag ON)
  // --------------------------------------------------------------------------

  describe("edge cases (flag ON)", () => {
    it("round-trip preserves object with slash-prefixed key", () => {
      setJsonEncodingConfig(true);
      // Objects with a single key starting with "/" must be escaped via
      // TAGS.object to avoid misinterpretation as a tagged type.
      const value = { "/foo": "bar" } as StorableValue;
      const encoded = encodeJsonValue(value);
      // Should be wrapped in /object escaping (TAGS.object = "object").
      expect(encoded).toEqual({ "/object": { "/foo": "bar" } });
      const decoded = decodeJsonValue(encoded, mockRuntime);
      expect(decoded).toEqual({ "/foo": "bar" });
    });

    it("decoded objects are frozen", () => {
      setJsonEncodingConfig(true);
      const value = { a: 1, b: "two" } as StorableValue;
      const encoded = encodeJsonValue(value);
      const decoded = decodeJsonValue(encoded, mockRuntime);
      expect(Object.isFrozen(decoded)).toBe(true);
    });

    it("decoded arrays are frozen", () => {
      setJsonEncodingConfig(true);
      const value = [1, 2, 3] as StorableValue;
      const encoded = encodeJsonValue(value);
      const decoded = decodeJsonValue(encoded, mockRuntime);
      expect(Object.isFrozen(decoded)).toBe(true);
    });

    it("round-trip preserves nested object with special types", () => {
      setJsonEncodingConfig(true);
      const value = {
        name: "test",
        count: 42n,
        missing: undefined,
      } as StorableValue;
      const encoded = encodeJsonValue(value);
      const decoded = decodeJsonValue(encoded, mockRuntime);
      expect((decoded as Record<string, unknown>).name).toBe("test");
      expect((decoded as Record<string, unknown>).count).toBe(42n);
      expect((decoded as Record<string, unknown>).missing).toBe(undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Legacy marker passthrough (flag ON)
  // --------------------------------------------------------------------------

  describe("legacy marker passthrough (flag ON)", () => {
    it("sigil link round-trips through encode -> stringify -> parse -> decode", () => {
      setJsonEncodingConfig(true);
      const sigilLink = {
        "/": { "link@1": { id: "of:bafyabc", path: [], space: "did:key:z1" } },
      } as StorableValue;
      const encoded = encodeJsonValue(sigilLink);
      const json = JSON.stringify(encoded);
      const parsed = JSON.parse(json) as StorableValue;
      const decoded = decodeJsonValue(parsed, mockRuntime);
      expect(decoded).toEqual(sigilLink);
    });

    it("nested sigil link within object round-trips", () => {
      setJsonEncodingConfig(true);
      const value = {
        name: "test",
        ref: { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      } as StorableValue;
      const encoded = encodeJsonValue(value);
      const json = JSON.stringify(encoded);
      const parsed = JSON.parse(json) as StorableValue;
      const decoded = decodeJsonValue(parsed, mockRuntime);
      expect((decoded as Record<string, unknown>).name).toBe("test");
      expect((decoded as Record<string, unknown>).ref).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
    });

    it("entity ID { '/': 'string' } round-trips", () => {
      setJsonEncodingConfig(true);
      const entityId = { "/": "bafyabc123" } as StorableValue;
      const encoded = encodeJsonValue(entityId);
      const json = JSON.stringify(encoded);
      const parsed = JSON.parse(json) as StorableValue;
      const decoded = decodeJsonValue(parsed, mockRuntime);
      expect(decoded).toEqual(entityId);
    });

    it("$stream marker passes through unchanged", () => {
      setJsonEncodingConfig(true);
      const value = { $stream: true } as StorableValue;
      const encoded = encodeJsonValue(value);
      const json = JSON.stringify(encoded);
      const parsed = JSON.parse(json) as StorableValue;
      const decoded = decodeJsonValue(parsed, mockRuntime);
      expect(decoded).toEqual({ $stream: true });
    });

    it("@Error marker passes through unchanged", () => {
      setJsonEncodingConfig(true);
      const value = {
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      } as StorableValue;
      const encoded = encodeJsonValue(value);
      const json = JSON.stringify(encoded);
      const parsed = JSON.parse(json) as StorableValue;
      const decoded = decodeJsonValue(parsed, mockRuntime);
      expect(decoded).toEqual({
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      });
    });

    it("$alias marker passes through unchanged", () => {
      setJsonEncodingConfig(true);
      const value = {
        $alias: { path: ["value", "name"], cell: { "/": "bafyabc" } },
      } as StorableValue;
      const encoded = encodeJsonValue(value);
      const json = JSON.stringify(encoded);
      const parsed = JSON.parse(json) as StorableValue;
      const decoded = decodeJsonValue(parsed, mockRuntime);
      expect(decoded).toEqual({
        $alias: { path: ["value", "name"], cell: { "/": "bafyabc" } },
      });
    });

    it("legacy sigil link decodes correctly (no /object wrapping)", () => {
      setJsonEncodingConfig(true);
      // Simulate legacy data: JSON.parse of data written without the flag.
      const legacyData = {
        "/": { "link@1": { id: "of:bafyabc", path: [] } },
      } as StorableValue;
      const decoded = decodeJsonValue(legacyData, mockRuntime);
      expect(decoded).toEqual(legacyData);
    });

    it("legacy entity ID decodes correctly", () => {
      setJsonEncodingConfig(true);
      const legacyData = { "/": "bafyabc123" } as StorableValue;
      const decoded = decodeJsonValue(legacyData, mockRuntime);
      expect(decoded).toEqual(legacyData);
    });

    it("mixed value with rich types and sigil links round-trips", () => {
      setJsonEncodingConfig(true);
      const value = {
        count: 42n,
        ref: { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
        items: [1, { "/": "bafyxyz" }, undefined],
      } as StorableValue;
      const encoded = encodeJsonValue(value);
      const json = JSON.stringify(encoded);
      const parsed = JSON.parse(json) as StorableValue;
      const decoded = decodeJsonValue(parsed, mockRuntime);
      const result = decoded as Record<string, unknown>;
      expect(result.count).toBe(42n);
      expect(result.ref).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
      expect((result.items as unknown[])[0]).toBe(1);
      expect((result.items as unknown[])[1]).toEqual({ "/": "bafyxyz" });
      expect((result.items as unknown[])[2]).toBe(undefined);
    });

    it("sigil link inside array round-trips", () => {
      setJsonEncodingConfig(true);
      const value = [
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
        { "/": { "link@1": { id: "of:bafydef", path: ["x"] } } },
      ] as StorableValue;
      const encoded = encodeJsonValue(value);
      const json = JSON.stringify(encoded);
      const parsed = JSON.parse(json) as StorableValue;
      const decoded = decodeJsonValue(parsed, mockRuntime);
      expect(decoded).toEqual(value);
    });
  });

  // --------------------------------------------------------------------------
  // Combined functions (jsonFromValue / valueFromJson)
  // --------------------------------------------------------------------------

  describe("combined functions", () => {
    it("jsonFromValue produces valid JSON (flag OFF)", () => {
      const value = { hello: "world" } as StorableValue;
      const json = jsonFromValue(value);
      expect(json).toBe('{"hello":"world"}');
    });

    it("valueFromJson parses JSON (flag OFF)", () => {
      const json = '{"hello":"world"}';
      const value = valueFromJson(json, mockRuntime);
      expect(value).toEqual({ hello: "world" });
    });

    it("round-trip through jsonFromValue/valueFromJson (flag OFF)", () => {
      const original = { a: 1, b: [2, 3] } as StorableValue;
      const json = jsonFromValue(original);
      const restored = valueFromJson(json, mockRuntime);
      expect(restored).toEqual(original);
    });

    it("jsonFromValue encodes rich types (flag ON)", () => {
      setJsonEncodingConfig(true);
      const json = jsonFromValue(42n as StorableValue);
      expect(json).toBe('{"\/BigInt@1":"Kg"}');
    });

    it("valueFromJson decodes rich types (flag ON)", () => {
      setJsonEncodingConfig(true);
      const json = '{"\/BigInt@1":"Kg"}';
      const value = valueFromJson(json, mockRuntime);
      expect(value).toBe(42n);
    });

    it("round-trip through jsonFromValue/valueFromJson (flag ON)", () => {
      setJsonEncodingConfig(true);
      const original = {
        count: 42n,
        ref: { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      } as StorableValue;
      const json = jsonFromValue(original);
      const restored = valueFromJson(json, mockRuntime);
      const result = restored as Record<string, unknown>;
      expect(result.count).toBe(42n);
      expect(result.ref).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
    });

    it("valueFromJson handles legacy sigil links (flag ON)", () => {
      setJsonEncodingConfig(true);
      // Simulate legacy JSON stored without the flag.
      const legacyJson = '{"\/":{"link@1":{"id":"of:bafyabc","path":[]}}}';
      const value = valueFromJson(legacyJson, mockRuntime);
      expect(value).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
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
