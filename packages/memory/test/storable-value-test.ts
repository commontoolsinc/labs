import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  canBeStored,
  isArrayIndexPropertyName,
  isStorableValue,
  resetExperimentalStorableConfig,
  setExperimentalStorableConfig,
  toDeepStorableValue,
  toStorableValue,
} from "../storable-value.ts";

describe("storable-value", () => {
  describe("isArrayIndexPropertyName", () => {
    describe("returns true for valid array indices", () => {
      it("accepts '0'", () => {
        expect(isArrayIndexPropertyName("0")).toBe(true);
      });

      it("accepts single-digit indices 1-9", () => {
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

      it("accepts max valid index (2**31 - 1)", () => {
        expect(isArrayIndexPropertyName("2147483647")).toBe(true);
      });

      it("accepts 10-digit numbers below 2**31", () => {
        expect(isArrayIndexPropertyName("1000000000")).toBe(true);
        expect(isArrayIndexPropertyName("2147483646")).toBe(true); // 2**31 - 2
      });
    });

    describe("returns false for invalid indices", () => {
      it("rejects empty string", () => {
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

      it("rejects whitespace", () => {
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

      it("rejects leading plus sign", () => {
        expect(isArrayIndexPropertyName("+1")).toBe(false);
        expect(isArrayIndexPropertyName("+0")).toBe(false);
      });

      it("rejects values >= 2**31", () => {
        expect(isArrayIndexPropertyName("2147483648")).toBe(false); // 2**31
        expect(isArrayIndexPropertyName("2147483649")).toBe(false); // 2**31 + 1
        expect(isArrayIndexPropertyName("4294967295")).toBe(false); // 2**32 - 1
        expect(isArrayIndexPropertyName("9999999999")).toBe(false); // way > 2**31
        expect(isArrayIndexPropertyName("10000000000")).toBe(false); // 11 digits
      });
    });
  });

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
        expect(isStorableValue([null, "test", null])).toBe(true);
      });
    });

    describe("returns false for non-storable arrays", () => {
      it("rejects arrays with undefined elements", () => {
        expect(isStorableValue([1, undefined, 3])).toBe(false);
        expect(isStorableValue([undefined])).toBe(false);
      });

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

    describe("returns true for storable-but-not-JSON-encodable values", () => {
      it("accepts undefined", () => {
        expect(isStorableValue(undefined)).toBe(true);
      });
    });

    describe("returns false for non-storable values", () => {
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

      it("passes through undefined", () => {
        expect(toStorableValue(undefined)).toBe(undefined);
      });
    });

    describe("handles sparse arrays and undefined elements", () => {
      it("densifies sparse arrays by filling holes with null", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        const result = toStorableValue(sparse);
        expect(result).not.toBe(sparse); // returns a new array
        expect(result).toEqual([1, null, 3]);
      });

      it("densifies arrays with multiple holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = "a";
        sparse[3] = "b"; // holes at indices 1 and 2
        sparse[5] = "c"; // hole at index 4
        const result = toStorableValue(sparse);
        expect(result).toEqual(["a", null, null, "b", null, "c"]);
      });

      it("converts undefined elements to null", () => {
        const result = toStorableValue([1, undefined, 3]);
        expect(result).toEqual([1, null, 3]);
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
          "Cannot store instance per se",
        );
      });
    });

    describe("converts Error instances to @Error wrapper", () => {
      it("converts basic Error with name, message, and stack", () => {
        const error = new Error("test message");
        const result = toStorableValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result).toHaveProperty("@Error");
        expect(result["@Error"].name).toBe("Error");
        expect(result["@Error"].message).toBe("test message");
        expect(typeof result["@Error"].stack).toBe("string");
      });

      it("preserves Error subclass name", () => {
        const error = new TypeError("type error message");
        const result = toStorableValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].name).toBe("TypeError");
        expect(result["@Error"].message).toBe("type error message");
      });

      it("preserves custom enumerable properties on Error", () => {
        const error = new Error("with extras") as Error & {
          code: number;
          detail: string;
        };
        error.code = 404;
        error.detail = "Not Found";
        const result = toStorableValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].message).toBe("with extras");
        expect(result["@Error"].code).toBe(404);
        expect(result["@Error"].detail).toBe("Not Found");
      });

      it("converts RangeError", () => {
        const error = new RangeError("out of range");
        const result = toStorableValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].name).toBe("RangeError");
        expect(result["@Error"].message).toBe("out of range");
      });

      it("converts SyntaxError", () => {
        const error = new SyntaxError("invalid syntax");
        const result = toStorableValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].name).toBe("SyntaxError");
        expect(result["@Error"].message).toBe("invalid syntax");
      });

      it("preserves cause property from Error constructor (ES2022)", () => {
        const cause = new Error("root cause");
        const error = new Error("wrapper", { cause });
        const result = toStorableValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].message).toBe("wrapper");
        // cause is captured but not recursively converted by toStorableValue
        // (shallow conversion) - the cause is still a raw Error here
        expect(result["@Error"].cause).toBe(cause);
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

      it("converts arrays with toJSON", () => {
        const arr = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
        arr.toJSON = () => "custom array";
        expect(toStorableValue(arr)).toBe("custom array");
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

      it("passes through undefined at top level", () => {
        expect(toDeepStorableValue(undefined)).toBe(undefined);
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

      it("omits undefined properties (matches JSON.stringify behavior)", () => {
        const result = toDeepStorableValue({ a: 1, b: undefined, c: 3 });
        expect(result).toEqual({ a: 1, c: 3 });
        expect("b" in (result as object)).toBe(false);
      });

      it("omits nested undefined properties", () => {
        const result = toDeepStorableValue({
          outer: { keep: 1, drop: undefined },
        });
        expect(result).toEqual({ outer: { keep: 1 } });
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

      it("only calls toJSON() once per shared object", () => {
        let callCount = 0;
        const shared = {
          toJSON() {
            callCount++;
            return { converted: true };
          },
        };
        const obj = { first: shared, second: shared, third: shared };
        const result = toDeepStorableValue(obj);
        expect(result).toEqual({
          first: { converted: true },
          second: { converted: true },
          third: { converted: true },
        });
        expect(callCount).toBe(1);
      });

      it("returns same result for shared sparse arrays", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3;
        const obj = { a: sparse, b: sparse };
        const result = toDeepStorableValue(obj) as {
          a: unknown[];
          b: unknown[];
        };
        expect(result.a).toEqual([1, null, 3]);
        expect(result.b).toEqual([1, null, 3]);
        // Both should reference the same converted array
        expect(result.a).toBe(result.b);
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

      it("throws when sparse array references itself", () => {
        const arr: any[] = [];
        arr[0] = 1;
        arr[2] = arr; // sparse array with circular reference at index 2
        expect(() => toDeepStorableValue(arr)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws when array with undefined references itself", () => {
        const arr: any[] = [1, undefined, null];
        arr[3] = arr; // array with undefined element + circular reference
        expect(() => toDeepStorableValue(arr)).toThrow(
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
          .toThrow("Cannot store instance per se");
      });

      it("throws for instance element in array", () => {
        class NoToJSON {}
        expect(() => toDeepStorableValue([1, new NoToJSON(), 3]))
          .toThrow("Cannot store instance per se");
      });
    });

    describe("converts nested Error instances to @Error wrapper", () => {
      it("converts Error property in object", () => {
        const error = new Error("nested error");
        const result = toDeepStorableValue({ status: "failed", error }) as {
          status: string;
          error: { "@Error": Record<string, unknown> };
        };

        expect(result.status).toBe("failed");
        expect(result.error).toHaveProperty("@Error");
        expect(result.error["@Error"].message).toBe("nested error");
      });

      it("converts Error element in array", () => {
        const result = toDeepStorableValue([
          new Error("first"),
          "middle",
          new Error("last"),
        ]) as unknown[];

        expect(
          (result[0] as { "@Error": Record<string, unknown> })["@Error"]
            .message,
        ).toBe("first");
        expect(result[1]).toBe("middle");
        expect(
          (result[2] as { "@Error": Record<string, unknown> })["@Error"]
            .message,
        ).toBe("last");
      });

      it("converts deeply nested Error", () => {
        const result = toDeepStorableValue({
          outer: {
            inner: {
              error: new TypeError("deep error"),
            },
          },
        }) as {
          outer: { inner: { error: { "@Error": Record<string, unknown> } } };
        };

        expect(result.outer.inner.error["@Error"].name).toBe("TypeError");
        expect(result.outer.inner.error["@Error"].message).toBe("deep error");
      });

      it("converts Error with another Error as a custom property", () => {
        const cause = new Error("root cause");
        const outer = new Error("outer error") as Error & { cause: Error };
        outer.cause = cause;

        const result = toDeepStorableValue(outer) as {
          "@Error": Record<string, unknown> & {
            cause: { "@Error": Record<string, unknown> };
          };
        };

        expect(result["@Error"].message).toBe("outer error");
        expect(result["@Error"].cause["@Error"].message).toBe("root cause");
      });

      it("converts Error with standard cause option (ES2022)", () => {
        const cause = new Error("root cause");
        const outer = new Error("outer error", { cause });

        const result = toDeepStorableValue(outer) as {
          "@Error": Record<string, unknown> & {
            cause: { "@Error": Record<string, unknown> };
          };
        };

        expect(result["@Error"].message).toBe("outer error");
        expect(result["@Error"].cause["@Error"].message).toBe("root cause");
      });
    });

    // Nested functions without `toJSON()` are handled like `JSON.stringify()`:
    // converted to `null` in arrays, omitted from objects.
    describe("handles nested functions like JSON.stringify", () => {
      it("omits function properties from objects", () => {
        const result = toDeepStorableValue({ a: 1, fn: () => {}, b: 2 });
        expect(result).toEqual({ a: 1, b: 2 });
      });

      it("converts function elements in arrays to null", () => {
        const result = toDeepStorableValue([1, () => {}, 3]);
        expect(result).toEqual([1, null, 3]);
      });

      it("converts nested function with toJSON via its toJSON method", () => {
        const fn = () => {};
        (fn as unknown as { toJSON: () => unknown }).toJSON = () =>
          "function with toJSON";
        const result = toDeepStorableValue({ a: 1, fn, b: 2 });
        expect(result).toEqual({ a: 1, fn: "function with toJSON", b: 2 });
      });

      it("converts function with toJSON in array via its toJSON method", () => {
        const fn = () => {};
        (fn as unknown as { toJSON: () => unknown }).toJSON = () =>
          "converted fn";
        const result = toDeepStorableValue([1, fn, 3]);
        expect(result).toEqual([1, "converted fn", 3]);
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

    describe("handles sparse arrays and undefined elements", () => {
      it("densifies top-level sparse arrays with null", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        const result = toDeepStorableValue(sparse);
        expect(result).toEqual([1, null, 3]);
      });

      it("densifies nested sparse arrays with null", () => {
        const sparse: unknown[] = [];
        sparse[0] = "a";
        sparse[2] = "c";
        const result = toDeepStorableValue({ arr: sparse });
        expect(result).toEqual({ arr: ["a", null, "c"] });
      });

      it("densifies sparse arrays inside arrays with null", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3;
        const result = toDeepStorableValue([[sparse]]);
        expect(result).toEqual([[[1, null, 3]]]);
      });

      it("converts undefined elements to null", () => {
        const result = toDeepStorableValue([1, undefined, 3]);
        expect(result).toEqual([1, null, 3]);
      });

      it("recursively processes elements after densifying", () => {
        const sparse: unknown[] = [];
        sparse[0] = new Date("2024-01-15T12:00:00.000Z");
        sparse[2] = { nested: true };
        const result = toDeepStorableValue(sparse);
        expect(result).toEqual(["2024-01-15T12:00:00.000Z", null, {
          nested: true,
        }]);
      });
    });

    describe("throws for arrays with named properties", () => {
      it("throws for top-level array with named properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(() => toDeepStorableValue(arr)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });

      it("throws for nested array with named properties", () => {
        const arr = [1, 2] as unknown[] & { extra?: number };
        arr.extra = 42;
        expect(() => toDeepStorableValue({ data: arr })).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });

      it("throws for sparse array with named properties", () => {
        const sparse = [] as unknown[] & { name?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.name = "test";
        expect(() => toDeepStorableValue(sparse)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });
    });
  });

  // --------------------------------------------------------------------------
  // canBeStored (public API)
  // --------------------------------------------------------------------------

  describe("canBeStored", () => {
    describe("legacy mode (richStorableValues OFF)", () => {
      it("accepts null", () => {
        expect(canBeStored(null)).toBe(true);
      });

      it("accepts booleans", () => {
        expect(canBeStored(true)).toBe(true);
        expect(canBeStored(false)).toBe(true);
      });

      it("accepts finite numbers", () => {
        expect(canBeStored(42)).toBe(true);
        expect(canBeStored(0)).toBe(true);
        expect(canBeStored(-1.5)).toBe(true);
      });

      it("accepts strings", () => {
        expect(canBeStored("hello")).toBe(true);
        expect(canBeStored("")).toBe(true);
      });

      it("accepts undefined", () => {
        expect(canBeStored(undefined)).toBe(true);
      });

      it("accepts plain objects", () => {
        expect(canBeStored({ a: 1 })).toBe(true);
        expect(canBeStored({})).toBe(true);
      });

      it("accepts dense arrays", () => {
        expect(canBeStored([1, 2, 3])).toBe(true);
        expect(canBeStored([])).toBe(true);
      });

      it("rejects symbols", () => {
        expect(canBeStored(Symbol("x"))).toBe(false);
      });

      it("rejects functions", () => {
        expect(canBeStored(() => {})).toBe(false);
      });

      it("rejects bigint", () => {
        expect(canBeStored(BigInt(42))).toBe(false);
      });
    });

    describe("rich mode (richStorableValues ON)", () => {
      beforeEach(() => {
        setExperimentalStorableConfig({ richStorableValues: true });
      });
      afterEach(() => {
        resetExperimentalStorableConfig();
      });

      it("accepts null", () => {
        expect(canBeStored(null)).toBe(true);
      });

      it("accepts undefined", () => {
        expect(canBeStored(undefined)).toBe(true);
      });

      it("accepts plain objects", () => {
        expect(canBeStored({ a: 1 })).toBe(true);
      });

      it("accepts Error instances", () => {
        expect(canBeStored(new Error("test"))).toBe(true);
      });

      it("rejects symbols", () => {
        expect(canBeStored(Symbol("x"))).toBe(false);
      });
    });
  });

  // --------------------------------------------------------------------------
  // freeze parameter (API surface)
  // --------------------------------------------------------------------------

  describe("freeze parameter (API surface)", () => {
    it("toStorableValue accepts a second argument", () => {
      // Verify the parameter exists without error.
      expect(toStorableValue(42, true)).toBe(42);
      expect(toStorableValue(42, false)).toBe(42);
    });

    it("toDeepStorableValue accepts a second argument", () => {
      expect(toDeepStorableValue(42, true)).toBe(42);
      expect(toDeepStorableValue(42, false)).toBe(42);
    });
  });
});
