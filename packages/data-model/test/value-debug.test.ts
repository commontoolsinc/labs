import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toCompactDebugString, toIndentedDebugString } from "../value-debug.ts";
import type { FabricValue } from "../interface.ts";

// ============================================================================
// Tests
// ============================================================================

describe("value-debug", () => {
  // --------------------------------------------------------------------------
  // toCompactDebugString
  // --------------------------------------------------------------------------

  describe("toCompactDebugString", () => {
    it("compactly stringifies a plain object", () => {
      expect(toCompactDebugString({ a: 1, b: "two" } as FabricValue))
        .toBe('{"a":1,"b":"two"}');
    });

    it("compactly stringifies an array", () => {
      expect(toCompactDebugString([1, 2, 3] as FabricValue)).toBe("[1,2,3]");
    });

    it("stringifies JSON-native primitives", () => {
      expect(toCompactDebugString(42 as FabricValue)).toBe("42");
      expect(toCompactDebugString("hello" as FabricValue)).toBe('"hello"');
      expect(toCompactDebugString(true as FabricValue)).toBe("true");
      expect(toCompactDebugString(false as FabricValue)).toBe("false");
      expect(toCompactDebugString(null)).toBe("null");
    });

    it("renders top-level `undefined` as a bare token", () => {
      expect(toCompactDebugString(undefined)).toBe("undefined");
    });

    it("renders `undefined` inside an array as a bare token", () => {
      expect(toCompactDebugString([1, undefined, 2] as FabricValue))
        .toBe("[1,undefined,2]");
    });

    it("renders `undefined` as object value as a bare token", () => {
      expect(toCompactDebugString({ a: undefined, b: 1 } as FabricValue))
        .toBe('{"a":undefined,"b":1}');
    });

    it("renders top-level `bigint` as a bare token with `n` suffix", () => {
      expect(toCompactDebugString(42n as FabricValue)).toBe("42n");
    });

    it("renders zero, negative, and large `bigint`s", () => {
      expect(toCompactDebugString(0n as FabricValue)).toBe("0n");
      expect(toCompactDebugString(-42n as FabricValue)).toBe("-42n");
      expect(toCompactDebugString(12345678901234567890n as FabricValue))
        .toBe("12345678901234567890n");
    });

    it("renders `bigint` inside an array as a bare token", () => {
      expect(toCompactDebugString([42n, 7n] as FabricValue))
        .toBe("[42n,7n]");
    });

    it("renders `bigint` as object value as a bare token", () => {
      expect(toCompactDebugString({ n: 42n } as FabricValue))
        .toBe('{"n":42n}');
    });

    it("does not throw on mixed bigint/undefined values", () => {
      const v = {
        count: 100n,
        missing: undefined,
        items: [1n, 2n, undefined],
      } as FabricValue;
      expect(() => toCompactDebugString(v)).not.toThrow();
      expect(toCompactDebugString(v))
        .toBe('{"count":100n,"missing":undefined,"items":[1n,2n,undefined]}');
    });

    it("does not unquote ordinary string values that resemble bare tokens", () => {
      // A user string that just happens to read "undefined" or "42n" should
      // remain a quoted string in the output -- only sentinel-wrapped payloads
      // get unquoted.
      expect(toCompactDebugString("undefined" as FabricValue))
        .toBe('"undefined"');
      expect(toCompactDebugString("42n" as FabricValue)).toBe('"42n"');
      expect(toCompactDebugString({ a: "undefined" } as FabricValue))
        .toBe('{"a":"undefined"}');
    });
  });

  // --------------------------------------------------------------------------
  // toIndentedDebugString
  // --------------------------------------------------------------------------

  describe("toIndentedDebugString", () => {
    it("indents object output with 2 spaces", () => {
      expect(toIndentedDebugString({ a: 1, b: "two" } as FabricValue))
        .toBe('{\n  "a": 1,\n  "b": "two"\n}');
    });

    it("indents array output with 2 spaces", () => {
      expect(toIndentedDebugString([1, 2, 3] as FabricValue))
        .toBe("[\n  1,\n  2,\n  3\n]");
    });

    it("renders top-level `undefined` as bare token", () => {
      expect(toIndentedDebugString(undefined)).toBe("undefined");
    });

    it("renders top-level `bigint` as bare token", () => {
      expect(toIndentedDebugString(42n as FabricValue)).toBe("42n");
    });

    it("renders nested `bigint` and `undefined` as bare tokens", () => {
      const v = { n: 42n, m: undefined } as FabricValue;
      expect(toIndentedDebugString(v))
        .toBe('{\n  "n": 42n,\n  "m": undefined\n}');
    });

    it("renders `undefined` and `bigint` inside arrays as bare tokens", () => {
      expect(toIndentedDebugString([1n, undefined, 2n] as FabricValue))
        .toBe("[\n  1n,\n  undefined,\n  2n\n]");
    });
  });
});
