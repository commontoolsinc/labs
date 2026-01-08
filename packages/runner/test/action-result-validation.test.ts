import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { validateAndCheckOpaqueRefs } from "../src/runner.ts";

describe("validateAndCheckOpaqueRefs", () => {
  describe("valid values", () => {
    it("accepts null", () => {
      expect(validateAndCheckOpaqueRefs(null)).toBe(false);
    });

    it("accepts undefined", () => {
      expect(validateAndCheckOpaqueRefs(undefined)).toBe(false);
    });

    it("accepts primitives", () => {
      expect(validateAndCheckOpaqueRefs("hello")).toBe(false);
      expect(validateAndCheckOpaqueRefs(42)).toBe(false);
      expect(validateAndCheckOpaqueRefs(true)).toBe(false);
      expect(validateAndCheckOpaqueRefs(false)).toBe(false);
    });

    it("accepts plain objects", () => {
      expect(validateAndCheckOpaqueRefs({})).toBe(false);
      expect(validateAndCheckOpaqueRefs({ a: 1, b: "hello" })).toBe(false);
    });

    it("accepts arrays", () => {
      expect(validateAndCheckOpaqueRefs([])).toBe(false);
      expect(validateAndCheckOpaqueRefs([1, 2, 3])).toBe(false);
      expect(validateAndCheckOpaqueRefs([{ a: 1 }, { b: 2 }])).toBe(false);
    });

    it("accepts nested structures", () => {
      expect(
        validateAndCheckOpaqueRefs({
          a: { b: { c: [1, 2, { d: "hello" }] } },
        }),
      ).toBe(false);
    });

    it("accepts cell links", () => {
      const cellLink = { "/": { [Symbol.for("cell-link")]: { id: "test" } } };
      expect(validateAndCheckOpaqueRefs(cellLink)).toBe(false);
    });
  });

  describe("invalid values", () => {
    it("rejects Map", () => {
      expect(() => validateAndCheckOpaqueRefs(new Map())).toThrow(
        /Action returned a Map[\s\S]*Consider using a plain object/,
      );
    });

    it("rejects Set", () => {
      expect(() => validateAndCheckOpaqueRefs(new Set())).toThrow(
        /Action returned a Set[\s\S]*Consider using an array/,
      );
    });

    it("rejects functions", () => {
      expect(() => validateAndCheckOpaqueRefs(() => {})).toThrow(
        /Action returned a function/,
      );
    });

    it("rejects Date", () => {
      expect(() => validateAndCheckOpaqueRefs(new Date())).toThrow(
        /Action returned a Date/,
      );
    });

    it("rejects RegExp", () => {
      expect(() => validateAndCheckOpaqueRefs(/test/)).toThrow(
        /Action returned a RegExp/,
      );
    });

    it("rejects NaN", () => {
      expect(() => validateAndCheckOpaqueRefs(NaN)).toThrow(
        /Action returned a NaN[\s\S]*Check your inputs or return null instead/,
      );
    });

    it("rejects Infinity", () => {
      expect(() => validateAndCheckOpaqueRefs(Infinity)).toThrow(
        /Action returned a Infinity[\s\S]*Check your inputs or return null instead/,
      );
    });

    it("rejects -Infinity", () => {
      expect(() => validateAndCheckOpaqueRefs(-Infinity)).toThrow(
        /Action returned a Infinity[\s\S]*Check your inputs or return null instead/,
      );
    });

    it("rejects BigInt", () => {
      expect(() => validateAndCheckOpaqueRefs(BigInt(123))).toThrow(
        /Action returned a BigInt[\s\S]*Consider converting to number or string/,
      );
    });

    it("rejects Symbol", () => {
      expect(() => validateAndCheckOpaqueRefs(Symbol("test"))).toThrow(
        /Action returned a Symbol[\s\S]*Consider removing this property/,
      );
    });

    it("rejects NaN nested in object", () => {
      expect(() => validateAndCheckOpaqueRefs({ value: NaN })).toThrow(
        /Action returned a NaN at path "value"/,
      );
    });

    it("rejects nested Map with path info", () => {
      expect(() => validateAndCheckOpaqueRefs({ data: { items: new Map() } }))
        .toThrow(/Action returned a Map at path "data\.items"/);
    });

    it("rejects Map in array with path info", () => {
      expect(() => validateAndCheckOpaqueRefs([1, 2, new Map()])).toThrow(
        /Action returned a Map at path "\[2\]"/,
      );
    });

    it("rejects Set in nested structure with path info", () => {
      expect(() =>
        validateAndCheckOpaqueRefs({
          a: { b: [{ c: new Set() }] },
        })
      ).toThrow(/Action returned a Set at path "a\.b\.\[0\]\.c"/);
    });

    it("rejects function in object with path info", () => {
      expect(() => validateAndCheckOpaqueRefs({ handler: () => {} })).toThrow(
        /Action returned a function at path "handler"/,
      );
    });
  });

  describe("action name in errors", () => {
    it("includes action name in error message", () => {
      expect(() =>
        validateAndCheckOpaqueRefs(new Map(), "handleClick (src/app.ts:42)")
      ).toThrow(/in action: handleClick \(src\/app\.ts:42\)/);
    });

    it("includes action name with nested path", () => {
      expect(() =>
        validateAndCheckOpaqueRefs(
          { data: new Set() },
          "onSubmit (components/Form.tsx:15)",
        )
      ).toThrow(
        /Action returned a Set at path "data".*in action: onSubmit \(components\/Form\.tsx:15\)/s,
      );
    });

    it("works without action name", () => {
      expect(() => validateAndCheckOpaqueRefs(new Map())).toThrow(
        /Action returned a Map/,
      );
      // Should not include "in action:" when no name provided
      expect(() => validateAndCheckOpaqueRefs(new Map())).not.toThrow(
        /in action:/,
      );
    });
  });

  describe("opaque ref detection", () => {
    it("returns true when result contains opaque ref", () => {
      // We can't easily create an opaque ref in tests without more setup,
      // so this test is a placeholder for integration testing
    });
  });
});
