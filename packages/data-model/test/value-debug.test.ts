import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toCompactDebugString, toIndentedDebugString } from "../value-debug.ts";

// ============================================================================
// Tests
// ============================================================================

describe("value-debug", () => {
  // --------------------------------------------------------------------------
  // toCompactDebugString
  // --------------------------------------------------------------------------

  describe("toCompactDebugString", () => {
    it("compactly stringifies a plain object", () => {
      expect(toCompactDebugString({ a: 1, b: "two" }))
        .toBe('{"a":1,"b":"two"}');
    });

    it("compactly stringifies an array", () => {
      expect(toCompactDebugString([1, 2, 3])).toBe("[1,2,3]");
    });

    it("stringifies JSON-native primitives", () => {
      expect(toCompactDebugString(42)).toBe("42");
      expect(toCompactDebugString("hello")).toBe('"hello"');
      expect(toCompactDebugString(true)).toBe("true");
      expect(toCompactDebugString(false)).toBe("false");
      expect(toCompactDebugString(null)).toBe("null");
    });

    it("renders top-level `undefined` as a bare token", () => {
      expect(toCompactDebugString(undefined)).toBe("undefined");
    });

    it("renders `undefined` inside an array as a bare token", () => {
      expect(toCompactDebugString([1, undefined, 2]))
        .toBe("[1,undefined,2]");
    });

    it("renders `undefined` as object value as a bare token", () => {
      expect(toCompactDebugString({ a: undefined, b: 1 }))
        .toBe('{"a":undefined,"b":1}');
    });

    it("renders top-level `bigint` as a bare token with `n` suffix", () => {
      expect(toCompactDebugString(42n)).toBe("42n");
    });

    it("renders zero, negative, and large `bigint`s", () => {
      expect(toCompactDebugString(0n)).toBe("0n");
      expect(toCompactDebugString(-42n)).toBe("-42n");
      expect(toCompactDebugString(12345678901234567890n))
        .toBe("12345678901234567890n");
    });

    it("renders `bigint` inside an array as a bare token", () => {
      expect(toCompactDebugString([42n, 7n]))
        .toBe("[42n,7n]");
    });

    it("renders `bigint` as object value as a bare token", () => {
      expect(toCompactDebugString({ n: 42n }))
        .toBe('{"n":42n}');
    });

    it("does not throw on mixed bigint/undefined values", () => {
      const v = {
        count: 100n,
        missing: undefined,
        items: [1n, 2n, undefined],
      };
      expect(() => toCompactDebugString(v)).not.toThrow();
      expect(toCompactDebugString(v))
        .toBe('{"count":100n,"missing":undefined,"items":[1n,2n,undefined]}');
    });

    it("does not unquote ordinary string values that resemble bare tokens", () => {
      // A user string that just happens to read "undefined" or "42n" should
      // remain a quoted string in the output -- only sentinel-wrapped payloads
      // get unquoted.
      expect(toCompactDebugString("undefined"))
        .toBe('"undefined"');
      expect(toCompactDebugString("42n")).toBe('"42n"');
      expect(toCompactDebugString({ a: "undefined" }))
        .toBe('{"a":"undefined"}');
    });
  });

  // --------------------------------------------------------------------------
  // toIndentedDebugString
  // --------------------------------------------------------------------------

  describe("toIndentedDebugString", () => {
    it("indents object output with 2 spaces", () => {
      expect(toIndentedDebugString({ a: 1, b: "two" }))
        .toBe('{\n  "a": 1,\n  "b": "two"\n}');
    });

    it("indents array output with 2 spaces", () => {
      expect(toIndentedDebugString([1, 2, 3]))
        .toBe("[\n  1,\n  2,\n  3\n]");
    });

    it("renders top-level `undefined` as bare token", () => {
      expect(toIndentedDebugString(undefined)).toBe("undefined");
    });

    it("renders top-level `bigint` as bare token", () => {
      expect(toIndentedDebugString(42n)).toBe("42n");
    });

    it("renders nested `bigint` and `undefined` as bare tokens", () => {
      const v = { n: 42n, m: undefined };
      expect(toIndentedDebugString(v))
        .toBe('{\n  "n": 42n,\n  "m": undefined\n}');
    });

    it("renders `undefined` and `bigint` inside arrays as bare tokens", () => {
      expect(toIndentedDebugString([1n, undefined, 2n]))
        .toBe("[\n  1n,\n  undefined,\n  2n\n]");
    });
  });
});
