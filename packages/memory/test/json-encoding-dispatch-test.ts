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
      const restored = valueFromJson(jsonFromValue(original), mockRuntime);
      expect(restored).toEqual(original);
    });
  });

  // --------------------------------------------------------------------------
  // Flag ON: rich type encoding
  // --------------------------------------------------------------------------

  describe("flag ON: rich type encoding", () => {
    it("round-trip preserves undefined", () => {
      setJsonEncodingConfig(true);
      const json = jsonFromValue(undefined);
      expect(valueFromJson(json, mockRuntime)).toBe(undefined);
    });

    it("round-trip preserves bigint", () => {
      setJsonEncodingConfig(true);
      const json = jsonFromValue(42n as StorableValue);
      expect(valueFromJson(json, mockRuntime)).toBe(42n);
    });

    it("jsonFromValue encodes undefined to tagged JSON", () => {
      setJsonEncodingConfig(true);
      const json = jsonFromValue(undefined);
      expect(JSON.parse(json)).toEqual({ "/Undefined@1": null });
    });

    it("jsonFromValue encodes bigint to tagged JSON", () => {
      setJsonEncodingConfig(true);
      const json = jsonFromValue(42n as StorableValue);
      expect(JSON.parse(json)).toEqual({ "/BigInt@1": "Kg" });
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
      const restored = valueFromJson(jsonFromValue(value), mockRuntime);
      expect(restored).toEqual({ a: 1, b: "two" });
    });

    it("round-trip preserves arrays", () => {
      setJsonEncodingConfig(true);
      const value = [1, "two", null] as StorableValue;
      const restored = valueFromJson(jsonFromValue(value), mockRuntime);
      expect(restored).toEqual([1, "two", null]);
    });

    it("round-trip preserves null", () => {
      setJsonEncodingConfig(true);
      expect(valueFromJson(jsonFromValue(null), mockRuntime)).toBe(null);
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
      const restored = valueFromJson(jsonFromValue(value), mockRuntime);
      expect(restored).toEqual({ "/foo": "bar" });
    });

    it("decoded objects are frozen", () => {
      setJsonEncodingConfig(true);
      const value = { a: 1, b: "two" } as StorableValue;
      const decoded = valueFromJson(jsonFromValue(value), mockRuntime);
      expect(Object.isFrozen(decoded)).toBe(true);
    });

    it("decoded arrays are frozen", () => {
      setJsonEncodingConfig(true);
      const value = [1, 2, 3] as StorableValue;
      const decoded = valueFromJson(jsonFromValue(value), mockRuntime);
      expect(Object.isFrozen(decoded)).toBe(true);
    });

    it("round-trip preserves nested object with special types", () => {
      setJsonEncodingConfig(true);
      const value = {
        name: "test",
        count: 42n,
        missing: undefined,
      } as StorableValue;
      const decoded = valueFromJson(
        jsonFromValue(value),
        mockRuntime,
      ) as Record<string, unknown>;
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
      const decoded = valueFromJson(jsonFromValue(sigilLink), mockRuntime);
      expect(decoded).toEqual(sigilLink);
    });

    it("nested sigil link within object round-trips", () => {
      setJsonEncodingConfig(true);
      const value = {
        name: "test",
        ref: { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      } as StorableValue;
      const decoded = valueFromJson(
        jsonFromValue(value),
        mockRuntime,
      ) as Record<string, unknown>;
      expect(decoded.name).toBe("test");
      expect(decoded.ref).toEqual(
        { "/": { "link@1": { id: "of:bafyabc", path: [] } } },
      );
    });

    it("entity ID { '/': 'string' } round-trips", () => {
      setJsonEncodingConfig(true);
      const entityId = { "/": "bafyabc123" } as StorableValue;
      const decoded = valueFromJson(jsonFromValue(entityId), mockRuntime);
      expect(decoded).toEqual(entityId);
    });

    it("$stream marker passes through unchanged", () => {
      setJsonEncodingConfig(true);
      const value = { $stream: true } as StorableValue;
      const decoded = valueFromJson(jsonFromValue(value), mockRuntime);
      expect(decoded).toEqual({ $stream: true });
    });

    it("@Error marker passes through unchanged", () => {
      setJsonEncodingConfig(true);
      const value = {
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      } as StorableValue;
      const decoded = valueFromJson(jsonFromValue(value), mockRuntime);
      expect(decoded).toEqual({
        "@Error": { name: "TypeError", message: "oops", stack: "" },
      });
    });

    it("$alias marker passes through unchanged", () => {
      setJsonEncodingConfig(true);
      const value = {
        $alias: { path: ["value", "name"], cell: { "/": "bafyabc" } },
      } as StorableValue;
      const decoded = valueFromJson(jsonFromValue(value), mockRuntime);
      expect(decoded).toEqual({
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
      const decoded = valueFromJson(
        jsonFromValue(value),
        mockRuntime,
      ) as Record<string, unknown>;
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
      const decoded = valueFromJson(jsonFromValue(value), mockRuntime);
      expect(decoded).toEqual(value);
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
      // undefined should be serialized to tagged form.
      const json = jsonFromValue(undefined);
      expect(JSON.parse(json)).toEqual({ "/Undefined@1": null });
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
      expect(JSON.parse(jsonFromValue(undefined))).toEqual(
        { "/Undefined@1": null },
      );

      // Cycle 1: OFF
      resetJsonEncodingConfig();
      expect(jsonFromValue({ a: 1 } as StorableValue)).toBe('{"a":1}');

      // Cycle 2: ON
      setJsonEncodingConfig(true);
      expect(JSON.parse(jsonFromValue(undefined))).toEqual(
        { "/Undefined@1": null },
      );

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
