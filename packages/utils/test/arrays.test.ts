import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
} from "@commonfabric/utils/arrays";

describe("arrays", () => {
  describe("isArrayIndexPropertyName()", () => {
    describe("returns `true` for valid array indices", () => {
      it("accepts `0`", () => {
        expect(isArrayIndexPropertyName("0")).toBe(true);
      });

      it("accepts single-digit indices `1` through `9`", () => {
        for (let i = 1; i <= 9; i++) {
          expect(isArrayIndexPropertyName(String(i))).toBe(true);
        }
      });

      it("accepts multi-digit indices", () => {
        expect(isArrayIndexPropertyName("10")).toBe(true);
        expect(isArrayIndexPropertyName("99")).toBe(true);
        expect(isArrayIndexPropertyName("123")).toBe(true);
        expect(isArrayIndexPropertyName("999999999")).toBe(true);
      });

      it("accepts values from `2**31` up to the `2**32 - 2` maximum", () => {
        expect(isArrayIndexPropertyName("2147483647")).toBe(true); // `2**31 - 1`
        expect(isArrayIndexPropertyName("2147483648")).toBe(true); // `2**31`
        expect(isArrayIndexPropertyName("4294967294")).toBe(true); // `2**32 - 2`
      });

      it("accepts 10-digit numbers below `2**32 - 1`", () => {
        expect(isArrayIndexPropertyName("1000000000")).toBe(true);
        expect(isArrayIndexPropertyName("2147483646")).toBe(true); // `2**31 - 2`
      });
    });

    describe("returns `false` for invalid indices", () => {
      it("rejects the empty string", () => {
        expect(isArrayIndexPropertyName("")).toBe(false);
      });

      it("rejects leading zeros", () => {
        expect(isArrayIndexPropertyName("00")).toBe(false);
        expect(isArrayIndexPropertyName("01")).toBe(false);
        expect(isArrayIndexPropertyName("007")).toBe(false);
      });

      it("rejects negative numbers", () => {
        expect(isArrayIndexPropertyName("-1")).toBe(false);
        expect(isArrayIndexPropertyName("-0")).toBe(false);
        expect(isArrayIndexPropertyName("-100")).toBe(false);
      });

      it("rejects decimals", () => {
        expect(isArrayIndexPropertyName("1.5")).toBe(false);
        expect(isArrayIndexPropertyName("0.0")).toBe(false);
        expect(isArrayIndexPropertyName("1.0")).toBe(false);
      });

      it("rejects scientific notation", () => {
        expect(isArrayIndexPropertyName("1e5")).toBe(false);
        expect(isArrayIndexPropertyName("1E5")).toBe(false);
        expect(isArrayIndexPropertyName("1e+5")).toBe(false);
      });

      it("rejects surrounding whitespace", () => {
        expect(isArrayIndexPropertyName(" 1")).toBe(false);
        expect(isArrayIndexPropertyName("1 ")).toBe(false);
        expect(isArrayIndexPropertyName(" 1 ")).toBe(false);
      });

      it("rejects non-numeric strings", () => {
        expect(isArrayIndexPropertyName("NaN")).toBe(false);
        expect(isArrayIndexPropertyName("Infinity")).toBe(false);
        expect(isArrayIndexPropertyName("abc")).toBe(false);
        expect(isArrayIndexPropertyName("1a")).toBe(false);
        expect(isArrayIndexPropertyName("a1")).toBe(false);
      });

      it("rejects a leading plus sign", () => {
        expect(isArrayIndexPropertyName("+1")).toBe(false);
        expect(isArrayIndexPropertyName("+0")).toBe(false);
      });

      it("rejects values at or above `2**32 - 1`", () => {
        expect(isArrayIndexPropertyName("4294967295")).toBe(false); // `2**32 - 1`, reserved for `.length`
        expect(isArrayIndexPropertyName("4294967296")).toBe(false); // `2**32`
        expect(isArrayIndexPropertyName("9999999999")).toBe(false); // way past `2**32`
        expect(isArrayIndexPropertyName("10000000000")).toBe(false); // 11 digits
      });
    });
  });

  describe("isArrayWithOnlyIndexProperties()", () => {
    it("returns `true` for an empty array", () => {
      expect(isArrayWithOnlyIndexProperties([])).toBe(true);
    });

    it("returns `true` for a dense array", () => {
      expect(isArrayWithOnlyIndexProperties([1, 2, 3])).toBe(true);
    });

    it("returns `true` for a sparse array (holes are not named properties)", () => {
      const sparse: unknown[] = [];
      sparse[0] = 1;
      sparse[2] = 3; // hole at index `1`
      expect(isArrayWithOnlyIndexProperties(sparse)).toBe(true);
    });

    it("returns `false` for an array with a named property", () => {
      const arr = [1, 2, 3] as unknown[] & { foo?: string };
      arr.foo = "bar";
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for a sparse array whose extra key is a named property", () => {
      // `length` is `3`, hole at index `1`, plus a named `foo` -- so
      // `Object.keys()` yields `["0", "2", "foo"]`, a key count that equals
      // `length` but still contains a non-index key.
      const sparse = [] as unknown[] & { foo?: string };
      sparse[0] = 1;
      sparse[2] = 3;
      sparse.foo = "bar";
      expect(isArrayWithOnlyIndexProperties(sparse)).toBe(false);
    });

    it("returns `false` when a named property was added before any indices", () => {
      // `Object.keys()` still orders indices first, so the named key is last:
      // `["0", "1", "foo"]`. Pins the last-key optimization's reliance on that
      // ordering rather than on insertion order.
      const arr = [] as unknown[] & { foo?: string };
      arr.foo = "bar";
      arr[0] = 1;
      arr[1] = 2;
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with an enumerable symbol-keyed property", () => {
      const arr = [1, 2, 3];
      (arr as unknown as Record<symbol, unknown>)[Symbol("foo")] = "bar";
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a non-enumerable symbol-keyed property", () => {
      // A symbol key is not expressible as a property name at all, so unlike a
      // non-enumerable string key it is rejected.
      const arr = [1, 2, 3];
      Object.defineProperty(arr, Symbol("foo"), {
        value: "bar",
        enumerable: false,
      });
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a registered symbol-keyed property", () => {
      // Registry-interned symbols are portable across realms -- and so are
      // valid fabric *values* -- but they are still not property *names*.
      const arr = [1, 2, 3];
      (arr as unknown as Record<symbol, unknown>)[Symbol.for("foo")] = "bar";
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a well-known symbol-keyed property", () => {
      const arr = [1, 2, 3];
      (arr as unknown as Record<symbol, unknown>)[Symbol.toStringTag] = "Nope";
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a non-enumerable string-keyed property", () => {
      const arr = [1, 2, 3];
      Object.defineProperty(arr, "foo", { value: "bar", enumerable: false });
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `false` for an array with a non-enumerable index-shaped named key", () => {
      // `"01"` is a named property, not an index, so it is rejected on the same
      // footing as any other non-enumerable named key.
      const arr = [1, 2, 3];
      Object.defineProperty(arr, "01", { value: "bar", enumerable: false });
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `true` for an array whose only non-index key is `length`", () => {
      // `length` is intrinsic to every array, so it can never be disqualifying.
      const arr = [1, 2, 3];
      expect(Object.getOwnPropertyNames(arr)).toContain("length");
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(true);
    });

    it("returns `true` after `length` is redefined", () => {
      // Redefining does not re-create the property, so it keeps its original
      // position in own-key order.
      const arr = [1, 2, 3];
      Object.defineProperty(arr, "length", { value: 3, writable: true });
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(true);
    });

    it("returns `false` when a named property outlives a deleted sibling", () => {
      // Deleting one named property must not restore index-only-ness while
      // another remains.
      const arr = [1, 2, 3] as unknown[] & { foo?: string; bar?: string };
      arr.foo = "a";
      arr.bar = "b";
      delete arr.foo;
      expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
    });

    it("returns `true` for an `Array` subclass instance with only indices", () => {
      class Sub extends Array {}
      const sub = new Sub();
      sub.push(1, 2);
      expect(isArrayWithOnlyIndexProperties(sub)).toBe(true);
    });

    describe("returns `false` for non-canonical index-shaped named keys", () => {
      // These keys are named properties, not array indices, but each has a
      // `Number(key)` that is an in-range non-negative integer -- so a naive
      // numeric coercion would misclassify the array as index-only.
      for (const key of ["01", " 1", "1.0", "1e1", "-0", ""]) {
        it(`rejects the named key ${JSON.stringify(key)}`, () => {
          // A roomy all-holes array, so the named key sits below `length` and
          // doesn't trip the `keys.length > length` quick check.
          const arr: unknown[] = [];
          arr.length = 1000;
          (arr as unknown as Record<string, unknown>)[key] = "x";
          expect(isArrayWithOnlyIndexProperties(arr)).toBe(false);
        });
      }
    });
  });
});
