import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
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

/** Encode then decode a value through the current dispatch configuration. */
function roundTrip(value: StorableValue): StorableValue {
  return valueFromJson(jsonFromValue(value), mockRuntime);
}

/** Assert that encoding a value produces the expected JSON wire format. */
function expectWireFormat(value: StorableValue, expected: unknown): void {
  expect(JSON.parse(jsonFromValue(value))).toEqual(expected);
}

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
    it("jsonFromValue produces valid JSON for objects", () => {
      const value = { hello: "world" } as StorableValue;
      expect(jsonFromValue(value)).toBe('{"hello":"world"}');
    });

    it("jsonFromValue stringifies null", () => {
      expect(jsonFromValue(null)).toBe("null");
    });

    it("jsonFromValue stringifies primitives", () => {
      expect(jsonFromValue(42 as StorableValue)).toBe("42");
      expect(jsonFromValue("hello" as StorableValue)).toBe('"hello"');
      expect(jsonFromValue(true as StorableValue)).toBe("true");
    });

    it("valueFromJson parses objects", () => {
      const result = valueFromJson('{"hello":"world"}', mockRuntime);
      expect(result).toEqual({ hello: "world" });
    });

    it("valueFromJson parses null", () => {
      expect(valueFromJson("null", mockRuntime)).toBe(null);
    });

    it("round-trip preserves objects", () => {
      const original = { a: 1, b: [2, 3] } as StorableValue;
      expect(roundTrip(original)).toEqual(original);
    });
  });

  // --------------------------------------------------------------------------
  // Flag ON: rich type encoding
  // --------------------------------------------------------------------------

  describe("flag ON: rich type encoding", () => {
    it("round-trip preserves undefined", () => {
      setJsonEncodingConfig(true);
      expect(roundTrip(undefined)).toBe(undefined);
    });

    it("round-trip preserves bigint", () => {
      setJsonEncodingConfig(true);
      expect(roundTrip(42n as StorableValue)).toBe(42n);
    });

    it("jsonFromValue encodes undefined to tagged JSON", () => {
      setJsonEncodingConfig(true);
      expectWireFormat(undefined, { "/Undefined@1": null });
    });

    it("jsonFromValue encodes bigint to tagged JSON", () => {
      setJsonEncodingConfig(true);
      expectWireFormat(42n as StorableValue, { "/BigInt@1": "Kg" });
    });

    it("valueFromJson decodes tagged undefined", () => {
      setJsonEncodingConfig(true);
      const json = '{"\/Undefined@1":null}';
      expect(valueFromJson(json, mockRuntime)).toBe(undefined);
    });

    it("valueFromJson decodes tagged bigint", () => {
      setJsonEncodingConfig(true);
      const json = '{"\/BigInt@1":"Kg"}';
      expect(valueFromJson(json, mockRuntime)).toBe(42n);
    });

    it("round-trip preserves plain objects", () => {
      setJsonEncodingConfig(true);
      const value = { a: 1, b: "two" } as StorableValue;
      expect(roundTrip(value)).toEqual({ a: 1, b: "two" });
    });

    it("round-trip preserves arrays", () => {
      setJsonEncodingConfig(true);
      const value = [1, "two", null] as StorableValue;
      expect(roundTrip(value)).toEqual([1, "two", null]);
    });

    it("round-trip preserves null", () => {
      setJsonEncodingConfig(true);
      expect(roundTrip(null)).toBe(null);
    });

    it("JSON-safe primitives stringify normally", () => {
      setJsonEncodingConfig(true);
      expect(jsonFromValue(42 as StorableValue)).toBe("42");
      expect(jsonFromValue("hello" as StorableValue)).toBe('"hello"');
      expect(jsonFromValue(true as StorableValue)).toBe("true");
      expect(jsonFromValue(null)).toBe("null");
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases (flag ON)
  // --------------------------------------------------------------------------

  describe("edge cases (flag ON)", () => {
    it("round-trip preserves object with slash-prefixed key", () => {
      setJsonEncodingConfig(true);
      const value = { "/foo": "bar" } as StorableValue;
      expect(roundTrip(value)).toEqual({ "/foo": "bar" });
    });

    it("decoded objects are frozen", () => {
      setJsonEncodingConfig(true);
      const value = { a: 1, b: "two" } as StorableValue;
      expect(Object.isFrozen(roundTrip(value))).toBe(true);
    });

    it("decoded arrays are frozen", () => {
      setJsonEncodingConfig(true);
      const value = [1, 2, 3] as StorableValue;
      expect(Object.isFrozen(roundTrip(value))).toBe(true);
    });

    it("round-trip preserves nested object with special types", () => {
      setJsonEncodingConfig(true);
      const value = {
        name: "test",
        count: 42n,
        missing: undefined,
      } as StorableValue;
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.name).toBe("test");
      expect(decoded.count).toBe(42n);
      expect(decoded.missing).toBe(undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Legacy marker passthrough (flag ON)
  // --------------------------------------------------------------------------

  describe("legacy marker passthrough (flag ON)", () => {
    it("sigil link round-trips through jsonFromValue/valueFromJson", () => {
      setJsonEncodingConfig(true);
      const sigilLink = {
        "/": { "link@1": { id: "of:bafyabc", path: [], space: "did:key:z1" } },
      } as StorableValue;
      expect(roundTrip(sigilLink)).toEqual(sigilLink);
    });

    it("nested sigil link within object round-trips", () => {
      setJsonEncodingConfig(true);
      const value = {
        name: "test",
        ref: { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      } as StorableValue;
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.name).toBe("test");
      expect(decoded.ref).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
    });

    it("entity ID { '/': 'string' } round-trips", () => {
      setJsonEncodingConfig(true);
      const entityId = { "/": "bafyabc123" } as StorableValue;
      expect(roundTrip(entityId)).toEqual(entityId);
    });

    it("$stream marker passes through unchanged", () => {
      setJsonEncodingConfig(true);
      const value = { $stream: true } as StorableValue;
      expect(roundTrip(value)).toEqual({ $stream: true });
    });

    it("@Error marker passes through unchanged", () => {
      setJsonEncodingConfig(true);
      const value = {
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      } as StorableValue;
      expect(roundTrip(value)).toEqual({
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      });
    });

    it("$alias marker passes through unchanged", () => {
      setJsonEncodingConfig(true);
      const value = {
        $alias: { path: ["value", "name"], cell: { "/": "bafyabc" } },
      } as StorableValue;
      expect(roundTrip(value)).toEqual({
        $alias: { path: ["value", "name"], cell: { "/": "bafyabc" } },
      });
    });

    it("legacy sigil link decodes correctly (no /object wrapping)", () => {
      setJsonEncodingConfig(true);
      // Simulate legacy JSON stored without the flag.
      const legacyJson = '{"\/":{"link@1":{"id":"of:bafyabc","path":[]}}}';
      const decoded = valueFromJson(legacyJson, mockRuntime);
      expect(decoded).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
    });

    it("legacy entity ID decodes correctly", () => {
      setJsonEncodingConfig(true);
      const legacyJson = '{"\/":"bafyabc123"}';
      const decoded = valueFromJson(legacyJson, mockRuntime);
      expect(decoded).toEqual({ "/": "bafyabc123" });
    });

    it("mixed value with rich types and sigil links round-trips", () => {
      setJsonEncodingConfig(true);
      const value = {
        count: 42n,
        ref: { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
        items: [1, { "/": "bafyxyz" }, undefined],
      } as StorableValue;
      const decoded = roundTrip(value) as Record<string, unknown>;
      expect(decoded.count).toBe(42n);
      expect(decoded.ref).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
      expect((decoded.items as unknown[])[0]).toBe(1);
      expect((decoded.items as unknown[])[1]).toEqual({ "/": "bafyxyz" });
      expect((decoded.items as unknown[])[2]).toBe(undefined);
    });

    it("sigil link inside array round-trips", () => {
      setJsonEncodingConfig(true);
      const value = [
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
        { "/": { "link@1": { id: "of:bafydef", path: ["x"] } } },
      ] as StorableValue;
      expect(roundTrip(value)).toEqual(value);
    });
  });

  // --------------------------------------------------------------------------
  // Flag OFF behavior (explicit)
  // --------------------------------------------------------------------------

  describe("flag OFF behavior (explicit)", () => {
    it("jsonFromValue is plain stringify after explicit OFF", () => {
      setJsonEncodingConfig(false);
      const value = { "/foo": 1 } as StorableValue;
      expect(jsonFromValue(value)).toBe('{"/foo":1}');
    });

    it("valueFromJson is plain parse after explicit OFF", () => {
      setJsonEncodingConfig(false);
      expect(valueFromJson('{"/foo":1}', mockRuntime)).toEqual({ "/foo": 1 });
    });
  });

  // --------------------------------------------------------------------------
  // Config lifecycle
  // --------------------------------------------------------------------------

  describe("config lifecycle", () => {
    it("setJsonEncodingConfig(true) enables dispatch", () => {
      setJsonEncodingConfig(true);
      expectWireFormat(undefined, { "/Undefined@1": null });
    });

    it("resetJsonEncodingConfig() restores passthrough", () => {
      setJsonEncodingConfig(true);
      resetJsonEncodingConfig();
      // Should be plain stringify again.
      const value = { a: 1 } as StorableValue;
      expect(jsonFromValue(value)).toBe('{"a":1}');
    });

    it("multiple set/reset cycles work correctly", () => {
      // Cycle 1: ON
      setJsonEncodingConfig(true);
      expectWireFormat(undefined, { "/Undefined@1": null });

      // Cycle 1: OFF
      resetJsonEncodingConfig();
      expect(jsonFromValue({ a: 1 } as StorableValue)).toBe('{"a":1}');

      // Cycle 2: ON
      setJsonEncodingConfig(true);
      expectWireFormat(undefined, { "/Undefined@1": null });

      // Cycle 2: OFF
      resetJsonEncodingConfig();
      expect(jsonFromValue({ b: 2 } as StorableValue)).toBe('{"b":2}');
    });

    it("setJsonEncodingConfig(false) after true restores passthrough", () => {
      setJsonEncodingConfig(true);
      setJsonEncodingConfig(false);
      // undefined stringifies to undefined (JSON.stringify returns undefined
      // for undefined input), so test with null instead.
      expect(jsonFromValue(null)).toBe("null");
    });
  });
});
