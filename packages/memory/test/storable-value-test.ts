import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isArrayIndexPropertyName,
  isStorableValue,
  resetStorableValueConfig,
  setStorableValueConfig,
  shallowStorableFromNativeValue,
  storableFromNativeValue,
} from "../storable-value.ts";
import { StorableError } from "../storable-native-instances.ts";

describe("storable-value", () => {
  // Explicitly pin richStorableValues off so the legacy-path tests (below the
  // rich-path section) exercise flag-off behavior regardless of the ambient
  // default. The rich-path describe blocks override this in their own
  // beforeEach.
  beforeEach(() => {
    setStorableValueConfig({ richStorableValues: false });
  });
  afterEach(() => {
    resetStorableValueConfig();
  });

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

      it("accepts sparse arrays (arrays with holes)", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isStorableValue(sparse)).toBe(true);
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

  describe("shallowStorableFromNativeValue", () => {
    describe("passes through JSON-encodable values", () => {
      it("passes through booleans", () => {
        expect(shallowStorableFromNativeValue(true)).toBe(true);
        expect(shallowStorableFromNativeValue(false)).toBe(false);
      });

      it("passes through strings", () => {
        expect(shallowStorableFromNativeValue("hello")).toBe("hello");
        expect(shallowStorableFromNativeValue("")).toBe("");
      });

      it("passes through finite numbers", () => {
        expect(shallowStorableFromNativeValue(42)).toBe(42);
        expect(shallowStorableFromNativeValue(-3.14)).toBe(-3.14);
        expect(shallowStorableFromNativeValue(0)).toBe(0);
      });

      it("converts negative zero to positive zero", () => {
        const result = shallowStorableFromNativeValue(-0);
        expect(result).toBe(0);
        expect(Object.is(result, -0)).toBe(false);
        expect(Object.is(result, 0)).toBe(true);
      });

      it("passes through null", () => {
        expect(shallowStorableFromNativeValue(null)).toBe(null);
      });

      it("passes through plain objects", () => {
        const obj = { a: 1, b: "two" };
        expect(shallowStorableFromNativeValue(obj)).toBe(obj);
      });

      it("passes through dense arrays", () => {
        const arr = [1, 2, 3];
        expect(shallowStorableFromNativeValue(arr)).toBe(arr);
      });

      it("passes through undefined", () => {
        expect(shallowStorableFromNativeValue(undefined)).toBe(undefined);
      });
    });

    describe("handles sparse arrays and undefined elements", () => {
      it("preserves sparse array holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        const result = shallowStorableFromNativeValue(sparse) as unknown[];
        expect(result).toBe(sparse); // sparse arrays pass through as-is
        expect(result[0]).toBe(1);
        expect(1 in result).toBe(false); // hole preserved
        expect(result[2]).toBe(3);
        expect(result.length).toBe(3);
      });

      it("preserves arrays with multiple holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = "a";
        sparse[3] = "b"; // holes at indices 1 and 2
        sparse[5] = "c"; // hole at index 4
        const result = shallowStorableFromNativeValue(sparse) as unknown[];
        expect(result[0]).toBe("a");
        expect(1 in result).toBe(false);
        expect(2 in result).toBe(false);
        expect(result[3]).toBe("b");
        expect(4 in result).toBe(false);
        expect(result[5]).toBe("c");
        expect(result.length).toBe(6);
      });

      it("converts undefined elements to null", () => {
        const result = shallowStorableFromNativeValue([1, undefined, 3]);
        expect(result).toEqual([1, null, 3]);
      });

      it("throws for arrays with named properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(() => shallowStorableFromNativeValue(arr)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });

      it("throws for sparse arrays with named properties", () => {
        // Even if the sparse array could be densified, named props are not allowed
        const sparse = [] as unknown[] & { foo?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.foo = "bar";
        expect(() => shallowStorableFromNativeValue(sparse)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });
    });

    describe("throws for non-convertible values", () => {
      it("throws for NaN", () => {
        expect(() => shallowStorableFromNativeValue(NaN)).toThrow(
          "Cannot store non-finite number",
        );
      });

      it("throws for Infinity", () => {
        expect(() => shallowStorableFromNativeValue(Infinity)).toThrow(
          "Cannot store non-finite number",
        );
        expect(() => shallowStorableFromNativeValue(-Infinity)).toThrow(
          "Cannot store non-finite number",
        );
      });

      it("throws for bigint", () => {
        expect(() => shallowStorableFromNativeValue(BigInt(123))).toThrow(
          "Cannot store bigint",
        );
      });

      it("throws for symbol", () => {
        expect(() => shallowStorableFromNativeValue(Symbol("test"))).toThrow(
          "Cannot store symbol",
        );
      });

      it("throws for functions without toJSON", () => {
        expect(() => shallowStorableFromNativeValue(() => {})).toThrow(
          "Cannot store function per se",
        );
      });

      it("throws for class instances without toJSON", () => {
        class NoToJSON {}
        expect(() => shallowStorableFromNativeValue(new NoToJSON())).toThrow(
          "Cannot store instance per se",
        );
      });
    });

    describe("converts Error instances to @Error wrapper", () => {
      it("converts basic Error with name, message, and stack", () => {
        const error = new Error("test message");
        const result = shallowStorableFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result).toHaveProperty("@Error");
        expect(result["@Error"].name).toBe("Error");
        expect(result["@Error"].message).toBe("test message");
        expect(typeof result["@Error"].stack).toBe("string");
      });

      it("preserves Error subclass name", () => {
        const error = new TypeError("type error message");
        const result = shallowStorableFromNativeValue(error) as {
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
        const result = shallowStorableFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].message).toBe("with extras");
        expect(result["@Error"].code).toBe(404);
        expect(result["@Error"].detail).toBe("Not Found");
      });

      it("converts RangeError", () => {
        const error = new RangeError("out of range");
        const result = shallowStorableFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].name).toBe("RangeError");
        expect(result["@Error"].message).toBe("out of range");
      });

      it("converts SyntaxError", () => {
        const error = new SyntaxError("invalid syntax");
        const result = shallowStorableFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].name).toBe("SyntaxError");
        expect(result["@Error"].message).toBe("invalid syntax");
      });

      it("preserves cause property from Error constructor (ES2022)", () => {
        const cause = new Error("root cause");
        const error = new Error("wrapper", { cause });
        const result = shallowStorableFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].message).toBe("wrapper");
        // cause is captured but not recursively converted by shallowStorableFromNativeValue
        // (shallow conversion) - the cause is still a raw Error here
        expect(result["@Error"].cause).toBe(cause);
      });
    });

    describe("converts via toJSON when available", () => {
      it("converts functions with toJSON", () => {
        const fn = () => {};
        (fn as any).toJSON = () => "converted function";
        expect(shallowStorableFromNativeValue(fn)).toBe("converted function");
      });

      it("converts class instances with toJSON", () => {
        class WithToJSON {
          toJSON() {
            return { converted: true };
          }
        }
        const result = shallowStorableFromNativeValue(new WithToJSON());
        expect(result).toEqual({ converted: true });
      });

      it("converts Date instances (which have toJSON)", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        expect(shallowStorableFromNativeValue(date)).toBe(
          "2024-01-15T12:00:00.000Z",
        );
      });

      it("converts regular objects with toJSON", () => {
        const obj = {
          secret: "internal",
          toJSON() {
            return { exposed: true };
          },
        };
        const result = shallowStorableFromNativeValue(obj);
        expect(result).toEqual({ exposed: true });
      });

      it("converts arrays with toJSON", () => {
        const arr = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
        arr.toJSON = () => "custom array";
        expect(shallowStorableFromNativeValue(arr)).toBe("custom array");
      });

      it("throws if toJSON returns a non-storable value", () => {
        class BadToJSON {
          toJSON() {
            return Symbol("bad");
          }
        }
        expect(() => shallowStorableFromNativeValue(new BadToJSON())).toThrow(
          "`toJSON()` on object returned something other than a storable value",
        );
      });

      it("throws if toJSON returns a function", () => {
        class ReturnsFunction {
          toJSON() {
            return () => {};
          }
        }
        expect(() => shallowStorableFromNativeValue(new ReturnsFunction()))
          .toThrow(
            "`toJSON()` on object returned something other than a storable value",
          );
      });

      it("throws if toJSON returns another instance", () => {
        class ReturnsInstance {
          toJSON() {
            return new Map();
          }
        }
        expect(() => shallowStorableFromNativeValue(new ReturnsInstance()))
          .toThrow(
            "`toJSON()` on object returned something other than a storable value",
          );
      });
    });
  });

  describe("storableFromNativeValue", () => {
    describe("passes through primitives", () => {
      it("passes through booleans", () => {
        expect(storableFromNativeValue(true)).toBe(true);
        expect(storableFromNativeValue(false)).toBe(false);
      });

      it("passes through strings", () => {
        expect(storableFromNativeValue("hello")).toBe("hello");
      });

      it("passes through numbers", () => {
        expect(storableFromNativeValue(42)).toBe(42);
      });

      it("passes through null", () => {
        expect(storableFromNativeValue(null)).toBe(null);
      });

      it("passes through undefined at top level", () => {
        expect(storableFromNativeValue(undefined)).toBe(undefined);
      });
    });

    describe("recursively processes arrays", () => {
      it("returns a new array", () => {
        const arr = [1, 2, 3];
        const result = storableFromNativeValue(arr);
        expect(result).toEqual([1, 2, 3]);
        expect(result).not.toBe(arr);
      });

      it("converts nested instances via toJSON", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = storableFromNativeValue([date]);
        expect(result).toEqual(["2024-01-15T12:00:00.000Z"]);
      });

      it("recursively processes nested arrays", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = storableFromNativeValue([[date]]);
        expect(result).toEqual([["2024-01-15T12:00:00.000Z"]]);
      });
    });

    describe("recursively processes objects", () => {
      it("returns a new object", () => {
        const obj = { a: 1 };
        const result = storableFromNativeValue(obj);
        expect(result).toEqual({ a: 1 });
        expect(result).not.toBe(obj);
      });

      it("converts nested instances via toJSON", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = storableFromNativeValue({ date });
        expect(result).toEqual({ date: "2024-01-15T12:00:00.000Z" });
      });

      it("recursively processes nested objects", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = storableFromNativeValue({ outer: { date } });
        expect(result).toEqual({ outer: { date: "2024-01-15T12:00:00.000Z" } });
      });

      it("omits undefined properties (matches JSON.stringify behavior)", () => {
        const result = storableFromNativeValue({ a: 1, b: undefined, c: 3 });
        expect(result).toEqual({ a: 1, c: 3 });
        expect("b" in (result as object)).toBe(false);
      });

      it("omits nested undefined properties", () => {
        const result = storableFromNativeValue({
          outer: { keep: 1, drop: undefined },
        });
        expect(result).toEqual({ outer: { keep: 1 } });
      });
    });

    describe("handles shared references (same object from multiple places)", () => {
      it("allows shared object references", () => {
        const shared = { value: 42 };
        const obj = { first: shared, second: shared };
        const result = storableFromNativeValue(obj);
        expect(result).toEqual({ first: { value: 42 }, second: { value: 42 } });
      });

      it("allows shared array references", () => {
        const shared = [1, 2, 3];
        const obj = { a: shared, b: shared };
        const result = storableFromNativeValue(obj);
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
        const result = storableFromNativeValue(obj);
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
        const result = storableFromNativeValue(obj) as {
          a: unknown[];
          b: unknown[];
        };
        expect(result.a[0]).toBe(1);
        expect(1 in result.a).toBe(false); // hole preserved
        expect(result.a[2]).toBe(3);
        expect(result.a.length).toBe(3);
        // Both should reference the same converted array
        expect(result.a).toBe(result.b);
      });
    });

    describe("throws for circular references", () => {
      it("throws when object references itself", () => {
        const obj: any = { a: 1 };
        obj.self = obj;
        expect(() => storableFromNativeValue(obj)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws when array references itself", () => {
        const arr: any[] = [1, 2];
        arr.push(arr);
        expect(() => storableFromNativeValue(arr)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws for indirect circular reference", () => {
        const a: any = { name: "a" };
        const b: any = { name: "b" };
        a.b = b;
        b.a = a;
        expect(() => storableFromNativeValue(a)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws when sparse array references itself", () => {
        const arr: any[] = [];
        arr[0] = 1;
        arr[2] = arr; // sparse array with circular reference at index 2
        expect(() => storableFromNativeValue(arr)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws when array with undefined references itself", () => {
        const arr: any[] = [1, undefined, null];
        arr[3] = arr; // array with undefined element + circular reference
        expect(() => storableFromNativeValue(arr)).toThrow(
          "Cannot store circular reference",
        );
      });
    });

    describe("throws for non-storable nested values", () => {
      it("throws for nested symbol", () => {
        expect(() => storableFromNativeValue({ val: Symbol("test") })).toThrow(
          "Cannot store symbol",
        );
      });

      it("throws for nested bigint", () => {
        expect(() => storableFromNativeValue([BigInt(123)])).toThrow(
          "Cannot store bigint",
        );
      });

      it("throws for deeply nested non-storable value", () => {
        expect(() =>
          storableFromNativeValue({ a: { b: { c: Symbol("deep") } } })
        )
          .toThrow("Cannot store symbol");
      });
    });

    describe("throws for nested instances without toJSON", () => {
      it("throws for instance property in object", () => {
        class NoToJSON {}
        expect(() => storableFromNativeValue({ a: 1, inst: new NoToJSON() }))
          .toThrow("Cannot store instance per se");
      });

      it("throws for instance element in array", () => {
        class NoToJSON {}
        expect(() => storableFromNativeValue([1, new NoToJSON(), 3]))
          .toThrow("Cannot store instance per se");
      });
    });

    describe("converts nested Error instances to @Error wrapper", () => {
      it("converts Error property in object", () => {
        const error = new Error("nested error");
        const result = storableFromNativeValue({ status: "failed", error }) as {
          status: string;
          error: { "@Error": Record<string, unknown> };
        };

        expect(result.status).toBe("failed");
        expect(result.error).toHaveProperty("@Error");
        expect(result.error["@Error"].message).toBe("nested error");
      });

      it("converts Error element in array", () => {
        const result = storableFromNativeValue([
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
        const result = storableFromNativeValue({
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

        const result = storableFromNativeValue(outer) as {
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

        const result = storableFromNativeValue(outer) as {
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
        const result = storableFromNativeValue({ a: 1, fn: () => {}, b: 2 });
        expect(result).toEqual({ a: 1, b: 2 });
      });

      it("converts function elements in arrays to null", () => {
        const result = storableFromNativeValue([1, () => {}, 3]);
        expect(result).toEqual([1, null, 3]);
      });

      it("converts nested function with toJSON via its toJSON method", () => {
        const fn = () => {};
        (fn as unknown as { toJSON: () => unknown }).toJSON = () =>
          "function with toJSON";
        const result = storableFromNativeValue({ a: 1, fn, b: 2 });
        expect(result).toEqual({ a: 1, fn: "function with toJSON", b: 2 });
      });

      it("converts function with toJSON in array via its toJSON method", () => {
        const fn = () => {};
        (fn as unknown as { toJSON: () => unknown }).toJSON = () =>
          "converted fn";
        const result = storableFromNativeValue([1, fn, 3]);
        expect(result).toEqual([1, "converted fn", 3]);
      });
    });

    describe("throws for top-level function", () => {
      it("throws when a bare function is passed (not nested)", () => {
        // This must throw, not return an internal symbol or other non-JSON value.
        expect(() => storableFromNativeValue(() => {})).toThrow(
          "Cannot store function per se",
        );
      });
    });

    describe("handles sparse arrays and undefined elements", () => {
      it("preserves top-level sparse array holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        const result = storableFromNativeValue(sparse) as unknown[];
        expect(result[0]).toBe(1);
        expect(1 in result).toBe(false); // hole preserved
        expect(result[2]).toBe(3);
        expect(result.length).toBe(3);
      });

      it("preserves nested sparse array holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = "a";
        sparse[2] = "c";
        const result = storableFromNativeValue({ arr: sparse }) as {
          arr: unknown[];
        };
        expect(result.arr[0]).toBe("a");
        expect(1 in result.arr).toBe(false); // hole preserved
        expect(result.arr[2]).toBe("c");
      });

      it("preserves sparse arrays inside arrays", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3;
        const result = storableFromNativeValue([[sparse]]) as unknown[][][];
        const inner = result[0][0];
        expect(inner[0]).toBe(1);
        expect(1 in inner).toBe(false); // hole preserved
        expect(inner[2]).toBe(3);
      });

      it("converts undefined elements to null", () => {
        const result = storableFromNativeValue([1, undefined, 3]);
        expect(result).toEqual([1, null, 3]);
      });

      it("recursively processes elements and preserves holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = new Date("2024-01-15T12:00:00.000Z");
        sparse[2] = { nested: true };
        const result = storableFromNativeValue(sparse) as unknown[];
        expect(result[0]).toBe("2024-01-15T12:00:00.000Z");
        expect(1 in result).toBe(false); // hole preserved
        expect(result[2]).toEqual({ nested: true });
      });
    });

    describe("throws for arrays with named properties", () => {
      it("throws for top-level array with named properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(() => storableFromNativeValue(arr)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });

      it("throws for nested array with named properties", () => {
        const arr = [1, 2] as unknown[] & { extra?: number };
        arr.extra = 42;
        expect(() => storableFromNativeValue({ data: arr })).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });

      it("throws for sparse array with named properties", () => {
        const sparse = [] as unknown[] & { name?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.name = "test";
        expect(() => storableFromNativeValue(sparse)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });
    });
  });

  // --------------------------------------------------------------------------
  // freeze parameter (rich path only)
  // --------------------------------------------------------------------------

  describe("freeze parameter (rich path)", () => {
    beforeEach(() => {
      setStorableValueConfig({ richStorableValues: true });
    });

    afterEach(() => {
      resetStorableValueConfig();
    });

    describe("shallowStorableFromNativeValue", () => {
      it("freezes plain objects by default", () => {
        const result = shallowStorableFromNativeValue({ a: 1 });
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("freezes arrays by default", () => {
        const result = shallowStorableFromNativeValue([1, 2, 3]);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("does not freeze plain objects when freeze=false", () => {
        const result = shallowStorableFromNativeValue({ a: 1 }, false);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("does not freeze arrays when freeze=false", () => {
        const result = shallowStorableFromNativeValue([1, 2, 3], false);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("wraps Error even when freeze=false", () => {
        const error = new Error("test");
        const result = shallowStorableFromNativeValue(error, false);
        expect(result).not.toBe(error);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("primitives are unaffected by freeze parameter", () => {
        expect(shallowStorableFromNativeValue(42, false)).toBe(42);
        expect(shallowStorableFromNativeValue("hello", false)).toBe("hello");
        expect(shallowStorableFromNativeValue(true, false)).toBe(true);
        expect(shallowStorableFromNativeValue(null, false)).toBe(null);
        expect(shallowStorableFromNativeValue(undefined, false)).toBe(
          undefined,
        );
        expect(shallowStorableFromNativeValue(BigInt(42), false)).toBe(
          BigInt(42),
        );
      });

      it("does not freeze the original array", () => {
        const arr = [1, 2, 3];
        shallowStorableFromNativeValue(arr, true);
        expect(Object.isFrozen(arr)).toBe(false);
      });

      it("does not freeze the original plain object", () => {
        const obj = { a: 1, b: 2 };
        shallowStorableFromNativeValue(obj, true);
        expect(Object.isFrozen(obj)).toBe(false);
      });

      it("returns a frozen copy for arrays when freeze=true", () => {
        const arr = [1, 2, 3];
        const result = shallowStorableFromNativeValue(arr, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(arr);
      });

      it("returns a frozen copy for plain objects when freeze=true", () => {
        const obj = { a: 1, b: 2 };
        const result = shallowStorableFromNativeValue(obj, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(obj);
      });

      it("converts function with toJSON via toRichStorableValueBase", () => {
        const fn = () => {};
        (fn as unknown as { toJSON: () => string }).toJSON = () =>
          "converted fn";
        expect(shallowStorableFromNativeValue(fn)).toBe("converted fn");
      });

      it("returns mutable shallow copy of frozen plain object when freeze=false", () => {
        const frozen = Object.freeze({ a: 1, b: "two" });
        const result = shallowStorableFromNativeValue(frozen, false) as Record<
          string,
          unknown
        >;
        expect(Object.isFrozen(result)).toBe(false);
        expect(result).not.toBe(frozen);
        expect(result).toEqual({ a: 1, b: "two" });
        // Verify the copy is actually mutable.
        result.c = 3;
        expect(result.c).toBe(3);
      });

      it("returns mutable shallow copy of frozen array when freeze=false", () => {
        const frozen = Object.freeze([1, 2, 3]);
        const result = shallowStorableFromNativeValue(
          frozen,
          false,
        ) as unknown[];
        expect(Object.isFrozen(result)).toBe(false);
        expect(result).not.toBe(frozen);
        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual([1, 2, 3]);
        // Verify the copy is actually mutable.
        result.push(4);
        expect(result.length).toBe(4);
      });

      it("preserves sparse holes in frozen array copy when freeze=false", () => {
        const arr = [1, , 3]; // sparse array with hole at index 1
        Object.freeze(arr);
        const result = shallowStorableFromNativeValue(arr, false) as unknown[];
        expect(Object.isFrozen(result)).toBe(false);
        expect(result.length).toBe(3);
        expect(0 in result).toBe(true);
        expect(1 in result).toBe(false); // hole preserved
        expect(2 in result).toBe(true);
      });

      it("returns frozen shallow copy of mutable plain object when freeze=true", () => {
        const mutable = { x: 1, y: 2 };
        const result = shallowStorableFromNativeValue(mutable, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(mutable);
        // Original stays mutable.
        expect(Object.isFrozen(mutable)).toBe(false);
      });

      it("returns frozen shallow copy of mutable array when freeze=true", () => {
        const mutable = [10, 20, 30];
        const result = shallowStorableFromNativeValue(mutable, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(mutable);
        expect(Object.isFrozen(mutable)).toBe(false);
      });

      it("returns already-frozen object as-is when freeze=true", () => {
        const frozen = Object.freeze({ a: 1 });
        const result = shallowStorableFromNativeValue(frozen, true);
        expect(result).toBe(frozen); // identity -- no copy needed
      });

      it("returns already-frozen array as-is when freeze=true", () => {
        const frozen = Object.freeze([1, 2]);
        const result = shallowStorableFromNativeValue(frozen, true);
        expect(result).toBe(frozen); // identity -- no copy needed
      });

      it("returns mutable object as-is when freeze=false", () => {
        const mutable = { a: 1 };
        const result = shallowStorableFromNativeValue(mutable, false);
        expect(result).toBe(mutable); // identity -- no copy needed
      });

      it("returns mutable array as-is when freeze=false", () => {
        const mutable = [1, 2];
        const result = shallowStorableFromNativeValue(mutable, false);
        expect(result).toBe(mutable); // identity -- no copy needed
      });
    });

    describe("storableFromNativeValue", () => {
      it("deep-freezes objects by default", () => {
        const result = storableFromNativeValue({ a: { b: 1 } }) as Record<
          string,
          unknown
        >;
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.a)).toBe(true);
      });

      it("deep-freezes arrays by default", () => {
        const result = storableFromNativeValue([[1, 2], [3, 4]]) as unknown[][];
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result[0])).toBe(true);
      });

      it("does not freeze objects when freeze=false", () => {
        const result = storableFromNativeValue(
          { a: { b: 1 } },
          false,
        ) as Record<
          string,
          unknown
        >;
        expect(Object.isFrozen(result)).toBe(false);
        expect(Object.isFrozen(result.a)).toBe(false);
      });

      it("does not freeze arrays when freeze=false", () => {
        const result = storableFromNativeValue(
          [[1, 2], [3, 4]],
          false,
        ) as unknown[][];
        expect(Object.isFrozen(result)).toBe(false);
        expect(Object.isFrozen(result[0])).toBe(false);
      });

      it("allows mutation when freeze=false", () => {
        const result = storableFromNativeValue({ a: 1 }, false) as Record<
          string,
          unknown
        >;
        expect(() => {
          result.a = 2;
        }).not.toThrow();
        expect(result.a).toBe(2);
      });

      it("still performs wrapping when freeze=false", () => {
        const error = new Error("test");
        const result = storableFromNativeValue(
          { error },
          false,
        ) as Record<string, unknown>;
        // Error should be wrapped into StorableError even without freezing.
        expect(result.error).not.toBe(error);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("still validates when freeze=false", () => {
        expect(() => storableFromNativeValue(Symbol("bad"), false)).toThrow();
      });

      it("primitives are unaffected by freeze parameter", () => {
        expect(storableFromNativeValue(42, false)).toBe(42);
        expect(storableFromNativeValue("hello", false)).toBe("hello");
        expect(storableFromNativeValue(null, false)).toBe(null);
      });

      it("does not freeze the original array", () => {
        const arr = [1, 2, 3];
        storableFromNativeValue(arr, true);
        expect(Object.isFrozen(arr)).toBe(false);
      });

      it("does not freeze the original plain object", () => {
        const obj = { a: 1, b: 2 };
        storableFromNativeValue(obj, true);
        expect(Object.isFrozen(obj)).toBe(false);
      });
    });
  });

  // =========================================================================
  // Error internals conversion (rich path): cause and custom properties must
  // be recursively converted to StorableValue before wrapping in StorableError
  // =========================================================================

  describe("Error internals deep conversion (rich path)", () => {
    beforeEach(() => {
      setStorableValueConfig({ richStorableValues: true });
    });
    afterEach(() => {
      resetStorableValueConfig();
    });

    it("converts Error with raw Error cause into nested StorableError", () => {
      const inner = new Error("inner");
      const outer = new Error("outer", { cause: inner });
      const result = storableFromNativeValue(outer);

      // Top level should be a StorableError.
      expect(result).toBeInstanceOf(StorableError);
      const se = result as StorableError;
      expect(se.error.message).toBe("outer");

      // cause should also be a StorableError (not a raw Error).
      expect(se.error.cause).toBeInstanceOf(StorableError);
      const innerSe = se.error.cause as StorableError;
      expect(innerSe.error.message).toBe("inner");
    });

    it("converts deeply nested Error chain (3 levels)", () => {
      const root = new Error("root");
      const mid = new Error("mid", { cause: root });
      const top = new Error("top", { cause: mid });
      const result = storableFromNativeValue(top) as StorableError;

      expect(result.error.message).toBe("top");
      const midSe = result.error.cause as StorableError;
      expect(midSe).toBeInstanceOf(StorableError);
      expect(midSe.error.message).toBe("mid");
      const rootSe = midSe.error.cause as StorableError;
      expect(rootSe).toBeInstanceOf(StorableError);
      expect(rootSe.error.message).toBe("root");
    });

    it("converts custom enumerable properties on Error", () => {
      const error = new Error("with props") as Error & {
        statusCode: number;
        details: { nested: string };
      };
      error.statusCode = 404;
      error.details = { nested: "value" };

      const result = storableFromNativeValue(error) as StorableError;
      expect(result.error.message).toBe("with props");
      // Custom properties should be preserved and converted.
      const converted = result.error as unknown as Record<string, unknown>;
      expect(converted.statusCode).toBe(404);
      expect(converted.details).toEqual({ nested: "value" });
    });

    it("converts Error with non-Error cause (plain object)", () => {
      const cause = { code: "ENOENT", path: "/missing" };
      const error = new Error("file error", { cause });
      const result = storableFromNativeValue(error) as StorableError;

      // cause should be a plain object (already valid StorableValue).
      expect(result.error.cause).toEqual({ code: "ENOENT", path: "/missing" });
      expect(Object.isFrozen(result.error.cause)).toBe(true);
    });

    it("preserves Error subclass through internals conversion", () => {
      const inner = new RangeError("bad range");
      const outer = new TypeError("bad type", { cause: inner });
      const result = storableFromNativeValue(outer) as StorableError;

      expect(result.error).toBeInstanceOf(TypeError);
      expect(result.error.name).toBe("TypeError");
      const innerSe = result.error.cause as StorableError;
      expect(innerSe.error).toBeInstanceOf(RangeError);
      expect(innerSe.error.name).toBe("RangeError");
    });

    it("does not mutate the original Error's cause", () => {
      const inner = new Error("inner");
      const outer = new Error("outer", { cause: inner });
      storableFromNativeValue(outer);

      // Original Error's cause should still be the raw Error, not StorableError.
      expect(outer.cause).toBe(inner);
      expect(outer.cause).not.toBeInstanceOf(StorableError);
    });

    it("handles Error with undefined cause (no conversion needed)", () => {
      const error = new Error("simple");
      const result = storableFromNativeValue(error) as StorableError;
      expect(result.error.cause).toBeUndefined();
    });

    it("freezes the StorableError wrapper when freeze=true", () => {
      const error = new Error("freeze me", { cause: new Error("nested") });
      const result = storableFromNativeValue(error);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("does not freeze StorableError wrapper when freeze=false", () => {
      const error = new Error("no freeze", { cause: new Error("nested") });
      const result = storableFromNativeValue(error, false);
      expect(Object.isFrozen(result)).toBe(false);
      // But internals should still be converted.
      expect(result).toBeInstanceOf(StorableError);
      const se = result as StorableError;
      expect(se.error.cause).toBeInstanceOf(StorableError);
    });
  });
});
