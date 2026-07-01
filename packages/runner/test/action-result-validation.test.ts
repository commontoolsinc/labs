import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { validateAndCheckReactives } from "../src/runner.ts";
import { isReactiveMarker } from "../src/builder/types.ts";

describe("validateAndCheckReactives", () => {
  describe("valid values", () => {
    it("accepts null", () => {
      expect(validateAndCheckReactives(null)).toBe(false);
    });

    it("accepts undefined", () => {
      expect(validateAndCheckReactives(undefined)).toBe(false);
    });

    it("accepts primitives", () => {
      expect(validateAndCheckReactives("hello")).toBe(false);
      expect(validateAndCheckReactives(42)).toBe(false);
      expect(validateAndCheckReactives(true)).toBe(false);
      expect(validateAndCheckReactives(false)).toBe(false);
    });

    it("accepts plain objects", () => {
      expect(validateAndCheckReactives({})).toBe(false);
      expect(validateAndCheckReactives({ a: 1, b: "hello" })).toBe(false);
    });

    it("accepts arrays", () => {
      expect(validateAndCheckReactives([])).toBe(false);
      expect(validateAndCheckReactives([1, 2, 3])).toBe(false);
      expect(validateAndCheckReactives([{ a: 1 }, { b: 2 }])).toBe(false);
    });

    it("accepts nested structures", () => {
      expect(
        validateAndCheckReactives({
          a: { b: { c: [1, 2, { d: "hello" }] } },
        }),
      ).toBe(false);
    });

    it("accepts cell links", () => {
      const cellLink = { "/": { [Symbol.for("cell-link")]: { id: "test" } } };
      expect(validateAndCheckReactives(cellLink)).toBe(false);
    });
  });

  describe("invalid values", () => {
    it("rejects Map", () => {
      expect(() => validateAndCheckReactives(new Map())).toThrow(
        /Action returned a Map[\s\S]*Consider using a plain object/,
      );
    });

    it("rejects Set", () => {
      expect(() => validateAndCheckReactives(new Set())).toThrow(
        /Action returned a Set[\s\S]*Consider using an array/,
      );
    });

    it("rejects functions", () => {
      expect(() => validateAndCheckReactives(() => {})).toThrow(
        /Action returned a function/,
      );
    });

    it("rejects Date", () => {
      expect(() => validateAndCheckReactives(new Date())).toThrow(
        /Action returned a Date/,
      );
    });

    it("rejects RegExp", () => {
      expect(() => validateAndCheckReactives(/test/)).toThrow(
        /Action returned a RegExp/,
      );
    });

    it("rejects NaN", () => {
      expect(() => validateAndCheckReactives(NaN)).toThrow(
        /Action returned a NaN[\s\S]*Check your inputs or return null instead/,
      );
    });

    it("rejects Infinity", () => {
      expect(() => validateAndCheckReactives(Infinity)).toThrow(
        /Action returned a Infinity[\s\S]*Check your inputs or return null instead/,
      );
    });

    it("rejects -Infinity", () => {
      expect(() => validateAndCheckReactives(-Infinity)).toThrow(
        /Action returned a Infinity[\s\S]*Check your inputs or return null instead/,
      );
    });

    it("rejects BigInt", () => {
      expect(() => validateAndCheckReactives(BigInt(123))).toThrow(
        /Action returned a BigInt[\s\S]*Consider converting to number or string/,
      );
    });

    it("rejects Symbol", () => {
      expect(() => validateAndCheckReactives(Symbol("test"))).toThrow(
        /Action returned a Symbol[\s\S]*Consider removing this property/,
      );
    });

    it("rejects NaN nested in object", () => {
      expect(() => validateAndCheckReactives({ value: NaN })).toThrow(
        /Action returned a NaN at path "value"/,
      );
    });

    it("rejects nested Map with path info", () => {
      expect(() => validateAndCheckReactives({ data: { items: new Map() } }))
        .toThrow(/Action returned a Map at path "data\.items"/);
    });

    it("rejects Map in array with path info", () => {
      expect(() => validateAndCheckReactives([1, 2, new Map()])).toThrow(
        /Action returned a Map at path "\[2\]"/,
      );
    });

    it("rejects Set in nested structure with path info", () => {
      expect(() =>
        validateAndCheckReactives({
          a: { b: [{ c: new Set() }] },
        })
      ).toThrow(/Action returned a Set at path "a\.b\.\[0\]\.c"/);
    });

    it("rejects function in object with path info", () => {
      expect(() => validateAndCheckReactives({ handler: () => {} })).toThrow(
        /Action returned a function at path "handler"/,
      );
    });
  });

  describe("action name in errors", () => {
    it("includes action name in error message", () => {
      expect(() =>
        validateAndCheckReactives(new Map(), "handleClick (src/app.ts:42)")
      ).toThrow(/in action: handleClick \(src\/app\.ts:42\)/);
    });

    it("includes action name with nested path", () => {
      expect(() =>
        validateAndCheckReactives(
          { data: new Set() },
          "onSubmit (components/Form.tsx:15)",
        )
      ).toThrow(
        /Action returned a Set at path "data".*in action: onSubmit \(components\/Form\.tsx:15\)/s,
      );
    });

    it("works without action name", () => {
      expect(() => validateAndCheckReactives(new Map())).toThrow(
        /Action returned a Map/,
      );
      // Should not include "in action:" when no name provided
      expect(() => validateAndCheckReactives(new Map())).not.toThrow(
        /in action:/,
      );
    });
  });

  describe("opaque ref detection", () => {
    it("returns true for opaque ref at top level", () => {
      const reactive = { [isReactiveMarker]: true };
      expect(validateAndCheckReactives(reactive)).toBe(true);
    });

    it("returns true when opaque ref is nested in object", () => {
      const reactive = { [isReactiveMarker]: true };
      expect(validateAndCheckReactives({ data: reactive })).toBe(true);
    });

    it("returns true when opaque ref is in array", () => {
      const reactive = { [isReactiveMarker]: true };
      expect(validateAndCheckReactives([1, reactive, 3])).toBe(true);
    });

    it("returns false when no opaque refs present", () => {
      expect(validateAndCheckReactives({ a: 1, b: "hello" })).toBe(false);
    });
  });
});
