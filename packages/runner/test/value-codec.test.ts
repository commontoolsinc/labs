import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isStorableValue,
  toDeepStorableValue,
  toStorableValue,
} from "../src/value-codec.ts";

describe("value-codec", () => {
  describe("isStorableValue", () => {
    describe("returns true for JSON-encodable values", () => {
      it("accepts booleans", () => {
        expect(isStorableValue(true)).toBe(true);
        expect(isStorableValue(false)).toBe(true);
      });

      it("accepts strings", () => {
        expect(isStorableValue("")).toBe(true);
        expect(isStorableValue("hello")).toBe(true);
        expect(isStorableValue("with\nnewlines")).toBe(true);
      });

      it("accepts finite numbers", () => {
        expect(isStorableValue(0)).toBe(true);
        expect(isStorableValue(-0)).toBe(true);
        expect(isStorableValue(1)).toBe(true);
        expect(isStorableValue(-1)).toBe(true);
        expect(isStorableValue(3.14159)).toBe(true);
        expect(isStorableValue(Number.MAX_VALUE)).toBe(true);
        expect(isStorableValue(Number.MIN_VALUE)).toBe(true);
      });

      it("accepts null", () => {
        expect(isStorableValue(null)).toBe(true);
      });

      it("accepts plain objects", () => {
        expect(isStorableValue({})).toBe(true);
        expect(isStorableValue({ a: 1 })).toBe(true);
        expect(isStorableValue({ nested: { object: true } })).toBe(true);
      });

      it("accepts dense arrays", () => {
        expect(isStorableValue([])).toBe(true);
        expect(isStorableValue([1, 2, 3])).toBe(true);
        expect(isStorableValue([{ a: 1 }, { b: 2 }])).toBe(true);
        expect(isStorableValue([null, undefined, null])).toBe(true);
      });
    });

    describe("returns false for non-storable arrays", () => {
      it("rejects sparse arrays (arrays with holes)", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isStorableValue(sparse)).toBe(false);
      });

      it("rejects arrays with extra non-numeric properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isStorableValue(arr)).toBe(false);
      });

      it("rejects sparse arrays even when extra properties balance the count", () => {
        // This array has length 3, hole at index 1, but extra property "foo"
        // So Object.keys() returns ["0", "2", "foo"] which has length 3
        // But it should still be rejected because indices aren't all present
        const sparse = [] as unknown[] & { foo?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.foo = "bar";
        expect(isStorableValue(sparse)).toBe(false);
      });
    });

    describe("returns true for edge cases", () => {
      // TODO(@danfuzz): This should return false once the TODO is resolved
      it("accepts undefined (TODO: should be false)", () => {
        expect(isStorableValue(undefined)).toBe(true);
      });
    });

    describe("returns false for non-JSON-encodable values", () => {
      it("rejects NaN", () => {
        expect(isStorableValue(NaN)).toBe(false);
      });

      it("rejects Infinity", () => {
        expect(isStorableValue(Infinity)).toBe(false);
        expect(isStorableValue(-Infinity)).toBe(false);
      });

      it("rejects functions", () => {
        expect(isStorableValue(() => {})).toBe(false);
        expect(isStorableValue(function () {})).toBe(false);
        expect(isStorableValue(async () => {})).toBe(false);
      });

      it("rejects class instances", () => {
        expect(isStorableValue(new Date())).toBe(false);
        expect(isStorableValue(new Map())).toBe(false);
        expect(isStorableValue(new Set())).toBe(false);
        expect(isStorableValue(/regex/)).toBe(false);
      });

      it("rejects bigint", () => {
        expect(isStorableValue(BigInt(123))).toBe(false);
      });

      it("rejects symbol", () => {
        expect(isStorableValue(Symbol("test"))).toBe(false);
      });
    });
  });

  describe("toStorableValue", () => {
    describe("passes through JSON-encodable values", () => {
      it("passes through booleans", () => {
        expect(toStorableValue(true)).toBe(true);
        expect(toStorableValue(false)).toBe(false);
      });

      it("passes through strings", () => {
        expect(toStorableValue("hello")).toBe("hello");
        expect(toStorableValue("")).toBe("");
      });

      it("passes through finite numbers", () => {
        expect(toStorableValue(42)).toBe(42);
        expect(toStorableValue(-3.14)).toBe(-3.14);
        expect(toStorableValue(0)).toBe(0);
      });

      it("converts negative zero to positive zero", () => {
        const result = toStorableValue(-0);
        expect(result).toBe(0);
        expect(Object.is(result, -0)).toBe(false);
        expect(Object.is(result, 0)).toBe(true);
      });

      it("passes through null", () => {
        expect(toStorableValue(null)).toBe(null);
      });

      it("passes through plain objects", () => {
        const obj = { a: 1, b: "two" };
        expect(toStorableValue(obj)).toBe(obj);
      });

      it("passes through dense arrays", () => {
        const arr = [1, 2, 3];
        expect(toStorableValue(arr)).toBe(arr);
      });

      // TODO(@danfuzz): This should throw once the TODO is resolved
      it("passes through undefined (TODO: should throw)", () => {
        expect(toStorableValue(undefined)).toBe(undefined);
      });
    });

    describe("handles sparse arrays", () => {
      it("densifies sparse arrays by filling holes with undefined", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        const result = toStorableValue(sparse);
        expect(result).not.toBe(sparse); // returns a new array
        expect(result).toEqual([1, undefined, 3]);
      });

      it("densifies arrays with multiple holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = "a";
        sparse[3] = "b"; // holes at indices 1 and 2
        sparse[5] = "c"; // hole at index 4
        const result = toStorableValue(sparse);
        expect(result).toEqual([
          "a",
          undefined,
          undefined,
          "b",
          undefined,
          "c",
        ]);
      });

      it("throws for arrays with named properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(() => toStorableValue(arr)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });

      it("throws for sparse arrays with named properties", () => {
        // Even if the sparse array could be densified, named props are not allowed
        const sparse = [] as unknown[] & { foo?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.foo = "bar";
        expect(() => toStorableValue(sparse)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });
    });

    describe("throws for non-convertible values", () => {
      it("throws for NaN", () => {
        expect(() => toStorableValue(NaN)).toThrow(
          "Cannot store non-finite number",
        );
      });

      it("throws for Infinity", () => {
        expect(() => toStorableValue(Infinity)).toThrow(
          "Cannot store non-finite number",
        );
        expect(() => toStorableValue(-Infinity)).toThrow(
          "Cannot store non-finite number",
        );
      });

      it("throws for bigint", () => {
        expect(() => toStorableValue(BigInt(123))).toThrow(
          "Cannot store bigint",
        );
      });

      it("throws for symbol", () => {
        expect(() => toStorableValue(Symbol("test"))).toThrow(
          "Cannot store symbol",
        );
      });

      it("throws for functions without toJSON", () => {
        expect(() => toStorableValue(() => {})).toThrow(
          "Cannot store function per se",
        );
      });

      it("throws for class instances without toJSON", () => {
        class NoToJSON {}
        expect(() => toStorableValue(new NoToJSON())).toThrow(
          "Cannot store object per se",
        );
      });
    });

    describe("converts via toJSON when available", () => {
      it("converts functions with toJSON", () => {
        const fn = () => {};
        (fn as any).toJSON = () => "converted function";
        expect(toStorableValue(fn)).toBe("converted function");
      });

      it("converts class instances with toJSON", () => {
        class WithToJSON {
          toJSON() {
            return { converted: true };
          }
        }
        const result = toStorableValue(new WithToJSON());
        expect(result).toEqual({ converted: true });
      });

      it("converts Date instances (which have toJSON)", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        expect(toStorableValue(date)).toBe("2024-01-15T12:00:00.000Z");
      });

      it("converts regular objects with toJSON", () => {
        const obj = {
          secret: "internal",
          toJSON() {
            return { exposed: true };
          },
        };
        const result = toStorableValue(obj);
        expect(result).toEqual({ exposed: true });
      });

      it("throws if toJSON returns a non-storable value", () => {
        class BadToJSON {
          toJSON() {
            return Symbol("bad");
          }
        }
        expect(() => toStorableValue(new BadToJSON())).toThrow(
          "`toJSON()` on object returned something other than a storable value",
        );
      });

      it("throws if toJSON returns a function", () => {
        class ReturnsFunction {
          toJSON() {
            return () => {};
          }
        }
        expect(() => toStorableValue(new ReturnsFunction())).toThrow(
          "`toJSON()` on object returned something other than a storable value",
        );
      });

      it("throws if toJSON returns another instance", () => {
        class ReturnsInstance {
          toJSON() {
            return new Map();
          }
        }
        expect(() => toStorableValue(new ReturnsInstance())).toThrow(
          "`toJSON()` on object returned something other than a storable value",
        );
      });
    });
  });

  describe("toDeepStorableValue", () => {
    describe("passes through primitives", () => {
      it("passes through booleans", () => {
        expect(toDeepStorableValue(true)).toBe(true);
        expect(toDeepStorableValue(false)).toBe(false);
      });

      it("passes through strings", () => {
        expect(toDeepStorableValue("hello")).toBe("hello");
      });

      it("passes through numbers", () => {
        expect(toDeepStorableValue(42)).toBe(42);
      });

      it("passes through null", () => {
        expect(toDeepStorableValue(null)).toBe(null);
      });
    });

    describe("recursively processes arrays", () => {
      it("returns a new array", () => {
        const arr = [1, 2, 3];
        const result = toDeepStorableValue(arr);
        expect(result).toEqual([1, 2, 3]);
        expect(result).not.toBe(arr);
      });

      it("converts nested instances via toJSON", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = toDeepStorableValue([date]);
        expect(result).toEqual(["2024-01-15T12:00:00.000Z"]);
      });

      it("recursively processes nested arrays", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = toDeepStorableValue([[date]]);
        expect(result).toEqual([["2024-01-15T12:00:00.000Z"]]);
      });
    });

    describe("recursively processes objects", () => {
      it("returns a new object", () => {
        const obj = { a: 1 };
        const result = toDeepStorableValue(obj);
        expect(result).toEqual({ a: 1 });
        expect(result).not.toBe(obj);
      });

      it("converts nested instances via toJSON", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = toDeepStorableValue({ date });
        expect(result).toEqual({ date: "2024-01-15T12:00:00.000Z" });
      });

      it("recursively processes nested objects", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = toDeepStorableValue({ outer: { date } });
        expect(result).toEqual({ outer: { date: "2024-01-15T12:00:00.000Z" } });
      });
    });

    describe("handles shared references (same object from multiple places)", () => {
      it("allows shared object references", () => {
        const shared = { value: 42 };
        const obj = { first: shared, second: shared };
        const result = toDeepStorableValue(obj);
        expect(result).toEqual({ first: { value: 42 }, second: { value: 42 } });
      });

      it("allows shared array references", () => {
        const shared = [1, 2, 3];
        const obj = { a: shared, b: shared };
        const result = toDeepStorableValue(obj);
        expect(result).toEqual({ a: [1, 2, 3], b: [1, 2, 3] });
      });
    });

    describe("throws for circular references", () => {
      it("throws when object references itself", () => {
        const obj: any = { a: 1 };
        obj.self = obj;
        expect(() => toDeepStorableValue(obj)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws when array references itself", () => {
        const arr: any[] = [1, 2];
        arr.push(arr);
        expect(() => toDeepStorableValue(arr)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws for indirect circular reference", () => {
        const a: any = { name: "a" };
        const b: any = { name: "b" };
        a.b = b;
        b.a = a;
        expect(() => toDeepStorableValue(a)).toThrow(
          "Cannot store circular reference",
        );
      });
    });

    describe("throws for non-storable nested values", () => {
      it("throws for nested symbol", () => {
        expect(() => toDeepStorableValue({ val: Symbol("test") })).toThrow(
          "Cannot store symbol",
        );
      });

      it("throws for nested bigint", () => {
        expect(() => toDeepStorableValue([BigInt(123)])).toThrow(
          "Cannot store bigint",
        );
      });

      it("throws for deeply nested non-storable value", () => {
        expect(() => toDeepStorableValue({ a: { b: { c: Symbol("deep") } } }))
          .toThrow("Cannot store symbol");
      });
    });

    describe("throws for nested instances without toJSON", () => {
      it("throws for instance property in object", () => {
        class NoToJSON {}
        expect(() => toDeepStorableValue({ a: 1, inst: new NoToJSON() }))
          .toThrow("Cannot store object per se");
      });

      it("throws for instance element in array", () => {
        class NoToJSON {}
        expect(() => toDeepStorableValue([1, new NoToJSON(), 3]))
          .toThrow("Cannot store object per se");
      });
    });

    // TODO(@danfuzz): These tests verify the temporary JSON.stringify-compatible
    // behavior for functions. Once the codebase is tightened up, these tests
    // should be updated to expect throws instead of drops/nulls.
    describe("drops function values like JSON.stringify (TODO: should throw)", () => {
      it("omits function properties from objects", () => {
        const result = toDeepStorableValue({ a: 1, fn: () => {}, b: 2 });
        expect(result).toEqual({ a: 1, b: 2 });
      });

      it("converts function elements in arrays to null", () => {
        const result = toDeepStorableValue([1, () => {}, 3]);
        expect(result).toEqual([1, null, 3]);
      });
    });

    describe("throws for top-level function", () => {
      it("throws when a bare function is passed (not nested)", () => {
        // This must throw, not return an internal symbol or other non-JSON value.
        expect(() => toDeepStorableValue(() => {})).toThrow(
          "Cannot store function per se",
        );
      });
    });
  });
});
