import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isPlainObjectWithOnlyEnumerableStringKeys } from "@commonfabric/utils/objects";

describe("objects", () => {
  describe("isPlainObjectWithOnlyEnumerableStringKeys()", () => {
    describe("returns `true` for a plain object with only enumerable string keys", () => {
      it("accepts an empty object", () => {
        expect(isPlainObjectWithOnlyEnumerableStringKeys({})).toBe(true);
      });

      it("accepts an object with string-keyed values", () => {
        expect(isPlainObjectWithOnlyEnumerableStringKeys({ a: 1, b: "two" }))
          .toBe(true);
      });

      it("accepts a null-prototype object", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isPlainObjectWithOnlyEnumerableStringKeys(obj)).toBe(true);
      });

      it("accepts a key whose value is `undefined`", () => {
        // A present key holding `undefined` is still an enumerable string key.
        expect(isPlainObjectWithOnlyEnumerableStringKeys({ a: undefined }))
          .toBe(true);
      });

      it("accepts an index-shaped string key", () => {
        // Unlike an array, an object has no notion of an index key; `"0"` is
        // just a string name here.
        expect(isPlainObjectWithOnlyEnumerableStringKeys({ 0: "a", 1: "b" }))
          .toBe(true);
      });

      it("accepts a frozen object", () => {
        expect(
          isPlainObjectWithOnlyEnumerableStringKeys(Object.freeze({ a: 1 })),
        )
          .toBe(true);
      });
    });

    describe("returns `false` for unrepresentable keys", () => {
      it("rejects an enumerable symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol("s")] = 2;
        expect(isPlainObjectWithOnlyEnumerableStringKeys(obj)).toBe(false);
      });

      it("rejects a non-enumerable symbol-keyed property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, Symbol("s"), {
          value: 2,
          enumerable: false,
        });
        expect(isPlainObjectWithOnlyEnumerableStringKeys(obj)).toBe(false);
      });

      it("rejects a registry-interned symbol-keyed property", () => {
        // Such a symbol is a valid fabric *value*, but still not a property
        // *name*.
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol.for("s")] = 2;
        expect(isPlainObjectWithOnlyEnumerableStringKeys(obj)).toBe(false);
      });

      it("rejects a well-known symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol.toStringTag] = "Nope";
        expect(isPlainObjectWithOnlyEnumerableStringKeys(obj)).toBe(false);
      });

      it("rejects a non-enumerable string-keyed property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });
        expect(isPlainObjectWithOnlyEnumerableStringKeys(obj)).toBe(false);
      });

      it("rejects a non-enumerable string key whose value is `undefined`", () => {
        // The key's presence is what disqualifies it, not what it holds.
        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", {
          value: undefined,
          enumerable: false,
        });
        expect(isPlainObjectWithOnlyEnumerableStringKeys(obj)).toBe(false);
      });

      it("rejects an accessor property, enumerable or not", () => {
        const enumerable = {};
        Object.defineProperty(enumerable, "g", {
          get: () => 1,
          enumerable: true,
        });
        const hidden = {};
        Object.defineProperty(hidden, "g", { get: () => 1, enumerable: false });

        // An enumerable accessor is a string key and passes; a non-enumerable
        // one does not. This pins that the check is about key visibility rather
        // than about data-versus-accessor.
        expect(isPlainObjectWithOnlyEnumerableStringKeys(enumerable)).toBe(
          true,
        );
        expect(isPlainObjectWithOnlyEnumerableStringKeys(hidden)).toBe(false);
      });
    });

    describe("returns `false` for anything that is not a plain object", () => {
      it("rejects an array, empty or not", () => {
        expect(isPlainObjectWithOnlyEnumerableStringKeys([])).toBe(false);
        expect(isPlainObjectWithOnlyEnumerableStringKeys([1, 2])).toBe(false);
      });

      it("rejects a class instance", () => {
        class Thing {
          a = 1;
        }
        expect(isPlainObjectWithOnlyEnumerableStringKeys(new Thing()))
          .toBe(false);
      });

      it("rejects built-in instances", () => {
        expect(isPlainObjectWithOnlyEnumerableStringKeys(new Date())).toBe(
          false,
        );
        expect(isPlainObjectWithOnlyEnumerableStringKeys(new Map())).toBe(
          false,
        );
        expect(isPlainObjectWithOnlyEnumerableStringKeys(/re/)).toBe(false);
        expect(isPlainObjectWithOnlyEnumerableStringKeys(new Uint8Array([1])))
          .toBe(false);
      });

      it("rejects an object whose prototype is `Array.prototype`", () => {
        const fake = Object.create(Array.prototype) as Record<string, unknown>;
        fake.a = 1;
        expect(isPlainObjectWithOnlyEnumerableStringKeys(fake)).toBe(false);
      });

      it("answers rather than throwing for `null` and `undefined`", () => {
        expect(isPlainObjectWithOnlyEnumerableStringKeys(null)).toBe(false);
        expect(isPlainObjectWithOnlyEnumerableStringKeys(undefined)).toBe(
          false,
        );
      });

      it("answers rather than throwing for primitives", () => {
        expect(isPlainObjectWithOnlyEnumerableStringKeys("abc")).toBe(false);
        expect(isPlainObjectWithOnlyEnumerableStringKeys(42)).toBe(false);
        expect(isPlainObjectWithOnlyEnumerableStringKeys(true)).toBe(false);
        expect(isPlainObjectWithOnlyEnumerableStringKeys(1n)).toBe(false);
        expect(isPlainObjectWithOnlyEnumerableStringKeys(Symbol("s")))
          .toBe(false);
      });

      it("rejects a function", () => {
        expect(isPlainObjectWithOnlyEnumerableStringKeys(() => 1)).toBe(false);
      });
    });

    it("sees through a `Proxy` to its target's shape", () => {
      // `Object.getPrototypeOf` and the key traps forward to the target, so a
      // pass-through proxy over a plain object is judged on the target.
      expect(
        isPlainObjectWithOnlyEnumerableStringKeys(new Proxy({ a: 1 }, {})),
      ).toBe(true);

      const withSymbol = { a: 1 } as Record<string | symbol, unknown>;
      withSymbol[Symbol("s")] = 2;
      expect(
        isPlainObjectWithOnlyEnumerableStringKeys(new Proxy(withSymbol, {})),
      ).toBe(false);
    });
  });
});
