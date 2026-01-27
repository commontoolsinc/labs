import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepEqual } from "@commontools/utils/deep-equal";

describe("deepEqual", () => {
  describe("primitives", () => {
    it("returns true for identical numbers", () => {
      expect(deepEqual(42, 42)).toBe(true);
      expect(deepEqual(0, 0)).toBe(true);
      expect(deepEqual(-3.14, -3.14)).toBe(true);
    });

    it("returns false for different numbers", () => {
      expect(deepEqual(42, 43)).toBe(false);
      expect(deepEqual(0, 1)).toBe(false);
    });

    it("returns true for identical strings", () => {
      expect(deepEqual("hello", "hello")).toBe(true);
      expect(deepEqual("", "")).toBe(true);
    });

    it("returns false for different strings", () => {
      expect(deepEqual("hello", "world")).toBe(false);
    });

    it("returns true for identical booleans", () => {
      expect(deepEqual(true, true)).toBe(true);
      expect(deepEqual(false, false)).toBe(true);
    });

    it("returns false for different booleans", () => {
      expect(deepEqual(true, false)).toBe(false);
    });

    it("returns true for null === null", () => {
      expect(deepEqual(null, null)).toBe(true);
    });

    it("returns true for undefined === undefined", () => {
      expect(deepEqual(undefined, undefined)).toBe(true);
    });

    it("returns false for null vs undefined", () => {
      expect(deepEqual(null, undefined)).toBe(false);
      expect(deepEqual(undefined, null)).toBe(false);
    });
  });

  describe("special number cases", () => {
    it("returns true for NaN === NaN", () => {
      expect(deepEqual(NaN, NaN)).toBe(true);
    });

    it("returns false for NaN vs number", () => {
      expect(deepEqual(NaN, 0)).toBe(false);
      expect(deepEqual(0, NaN)).toBe(false);
    });

    it("distinguishes -0 from +0", () => {
      expect(deepEqual(-0, 0)).toBe(false);
      expect(deepEqual(0, -0)).toBe(false);
      expect(deepEqual(-0, -0)).toBe(true);
    });

    it("handles Infinity", () => {
      expect(deepEqual(Infinity, Infinity)).toBe(true);
      expect(deepEqual(-Infinity, -Infinity)).toBe(true);
      expect(deepEqual(Infinity, -Infinity)).toBe(false);
    });
  });

  describe("arrays", () => {
    it("returns true for identical arrays", () => {
      expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(deepEqual([], [])).toBe(true);
    });

    it("returns false for arrays with different lengths", () => {
      expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(deepEqual([1, 2, 3], [1, 2])).toBe(false);
    });

    it("returns false for arrays with different elements", () => {
      expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    it("returns true for nested arrays", () => {
      expect(deepEqual([[1, 2], [3, 4]], [[1, 2], [3, 4]])).toBe(true);
    });

    it("returns false for different nested arrays", () => {
      expect(deepEqual([[1, 2], [3, 4]], [[1, 2], [3, 5]])).toBe(false);
    });
  });

  describe("sparse arrays", () => {
    it("returns true for equal sparse arrays", () => {
      const a = [1, , 3];
      const b = [1, , 3];
      expect(deepEqual(a, b)).toBe(true);
    });

    it("returns false when hole vs value at same index", () => {
      const a = [1, , 3];
      const b = [1, 2, 3];
      expect(deepEqual(a, b)).toBe(false);
      expect(deepEqual(b, a)).toBe(false);
    });

    it("returns false for holes at different positions", () => {
      const a = [1, , 3];
      const b = [, 2, 3];
      expect(deepEqual(a, b)).toBe(false);
    });

    it("returns true for multiple holes in same positions", () => {
      const a = [1, , , 4];
      const b = [1, , , 4];
      expect(deepEqual(a, b)).toBe(true);
    });

    it("returns false for hole vs explicit undefined at same index", () => {
      // Both arrays have 3 keys, but holes and undefineds are in opposite positions.
      // This exercises the hasOwn check that distinguishes stored undefined from holes.
      const a = [1, undefined, , 4]; // keys: 0, 1, 3 - undefined at 1, hole at 2
      const b = [1, , undefined, 4]; // keys: 0, 2, 3 - hole at 1, undefined at 2
      expect(deepEqual(a, b)).toBe(false);
      expect(deepEqual(b, a)).toBe(false);
    });
  });

  describe("arrays with named properties", () => {
    it("returns true for arrays with equal named properties", () => {
      const a = Object.assign([1, 2], { foo: "bar" });
      const b = Object.assign([1, 2], { foo: "bar" });
      expect(deepEqual(a, b)).toBe(true);
    });

    it("returns false for arrays with different named property values", () => {
      const a = Object.assign([1, 2], { foo: "bar" });
      const b = Object.assign([1, 2], { foo: "baz" });
      expect(deepEqual(a, b)).toBe(false);
    });

    it("returns false for arrays with different named property keys", () => {
      const a = Object.assign([1, 2], { foo: "x" });
      const b = Object.assign([1, 2], { bar: "x" });
      expect(deepEqual(a, b)).toBe(false);
    });

    it("returns false when one array has named properties and other does not", () => {
      const a = Object.assign([1, 2], { foo: "bar" });
      const b = [1, 2];
      expect(deepEqual(a, b)).toBe(false);
      expect(deepEqual(b, a)).toBe(false);
    });

    it("handles sparse arrays with named properties", () => {
      const a = Object.assign([1, , 3], { foo: "bar" });
      const b = Object.assign([1, , 3], { foo: "bar" });
      expect(deepEqual(a, b)).toBe(true);

      const c = Object.assign([1, , 3], { foo: "bar" });
      const d = Object.assign([1, 2, 3], { foo: "bar" });
      expect(deepEqual(c, d)).toBe(false);
    });

    it("returns false when hole + named property balances key count with dense array", () => {
      // Both have 3 keys, but structured differently:
      // a: indices 0,2 + named 'foo' = 3 keys
      // b: indices 0,1,2 = 3 keys
      const a = Object.assign([1, , 3], { foo: "bar" });
      const b = [1, 2, 3];
      expect(deepEqual(a, b)).toBe(false);
      expect(deepEqual(b, a)).toBe(false);
    });
  });

  describe("objects", () => {
    it("returns true for identical objects", () => {
      expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
      expect(deepEqual({}, {})).toBe(true);
    });

    it("returns true regardless of key order", () => {
      expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    });

    it("returns false for objects with different key counts", () => {
      expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
      expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    });

    it("returns false for objects with different keys", () => {
      expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    });

    it("returns false for same key count but different keys including undefined", () => {
      // Both have 2 keys, but different keys. Exercises hasOwn check in checkSpecificProps.
      // Parallel to the array hole-vs-undefined test.
      const a = { x: 1, y: undefined };
      const b = { x: 1, z: 2 };
      expect(deepEqual(a, b)).toBe(false);
      expect(deepEqual(b, a)).toBe(false);
    });

    it("returns false for different keys both with undefined values", () => {
      // Both have 1 key set to undefined, but different key names.
      expect(deepEqual({ x: undefined }, { y: undefined })).toBe(false);
    });

    it("returns false for objects with different values", () => {
      expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it("returns true for nested objects", () => {
      expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(
        true,
      );
    });

    it("returns false for different nested objects", () => {
      expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(
        false,
      );
    });
  });

  describe("mixed structures", () => {
    it("returns true for objects containing arrays", () => {
      expect(deepEqual({ a: [1, 2, 3] }, { a: [1, 2, 3] })).toBe(true);
    });

    it("returns true for arrays containing objects", () => {
      expect(deepEqual([{ a: 1 }, { b: 2 }], [{ a: 1 }, { b: 2 }])).toBe(true);
    });

    it("handles complex nested structures", () => {
      const a = { x: [1, { y: [2, 3] }], z: { w: 4 } };
      const b = { x: [1, { y: [2, 3] }], z: { w: 4 } };
      expect(deepEqual(a, b)).toBe(true);
    });

    it("detects differences in complex nested structures", () => {
      const a = { x: [1, { y: [2, 3] }], z: { w: 4 } };
      const b = { x: [1, { y: [2, 4] }], z: { w: 4 } };
      expect(deepEqual(a, b)).toBe(false);
    });
  });

  describe("reference equality", () => {
    it("returns true for same object reference", () => {
      const obj = { a: 1 };
      expect(deepEqual(obj, obj)).toBe(true);
    });

    it("returns true for same array reference", () => {
      const arr = [1, 2, 3];
      expect(deepEqual(arr, arr)).toBe(true);
    });
  });

  describe("type mismatches", () => {
    it("returns false for object vs array", () => {
      expect(deepEqual({}, [])).toBe(false);
      expect(deepEqual([], {})).toBe(false);
    });

    it("returns false for object vs primitive", () => {
      expect(deepEqual({}, 1)).toBe(false);
      expect(deepEqual(1, {})).toBe(false);
      expect(deepEqual({}, "string")).toBe(false);
    });

    it("returns false for array vs primitive", () => {
      expect(deepEqual([], 1)).toBe(false);
      expect(deepEqual([1], 1)).toBe(false);
    });
  });

  describe("constructor differences", () => {
    it("returns false for plain object vs Object.create(null)", () => {
      const plain = { a: 1 };
      const nullProto = Object.create(null);
      nullProto.a = 1;
      expect(deepEqual(plain, nullProto)).toBe(false);
    });
  });
});
