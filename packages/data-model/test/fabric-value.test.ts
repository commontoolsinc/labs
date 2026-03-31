import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromNativeValue,
  isArrayIndexPropertyName,
  isFabricValue,
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
} from "../fabric-value.ts";
import { FabricError } from "../fabric-native-instances.ts";
import { FabricBytes } from "../fabric-bytes.ts";

describe("fabric-value", () => {
  // Explicitly pin modernDataModel off so the legacy-path tests (below the
  // modern-path section) exercise flag-off behavior regardless of the ambient
  // default. The modern-path describe blocks override this in their own
  // beforeEach.
  beforeEach(() => {
    setDataModelConfig(false);
  });
  afterEach(() => {
    resetDataModelConfig();
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

      it("accepts values in the upper range (2**31 and above, below 2**32 - 1)", () => {
        expect(isArrayIndexPropertyName("2147483647")).toBe(true); // 2**31 - 1
        expect(isArrayIndexPropertyName("2147483648")).toBe(true); // 2**31
        expect(isArrayIndexPropertyName("4294967294")).toBe(true); // 2**32 - 2 (max valid)
      });

      it("accepts 10-digit numbers below 2**32 - 1", () => {
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

      it("rejects values >= 2**32 - 1", () => {
        expect(isArrayIndexPropertyName("4294967295")).toBe(false); // 2**32 - 1 (not a valid index)
        expect(isArrayIndexPropertyName("4294967296")).toBe(false); // 2**32
        expect(isArrayIndexPropertyName("9999999999")).toBe(false); // way > 2**32
        expect(isArrayIndexPropertyName("10000000000")).toBe(false); // 11 digits
      });
    });
  });

  describe("isFabricValue", () => {
    describe("returns true for JSON-encodable values", () => {
      it("accepts booleans", () => {
        expect(isFabricValue(true)).toBe(true);
        expect(isFabricValue(false)).toBe(true);
      });

      it("accepts strings", () => {
        expect(isFabricValue("")).toBe(true);
        expect(isFabricValue("hello")).toBe(true);
        expect(isFabricValue("with\nnewlines")).toBe(true);
      });

      it("accepts finite numbers", () => {
        expect(isFabricValue(0)).toBe(true);
        expect(isFabricValue(-0)).toBe(true);
        expect(isFabricValue(1)).toBe(true);
        expect(isFabricValue(-1)).toBe(true);
        expect(isFabricValue(3.14159)).toBe(true);
        expect(isFabricValue(Number.MAX_VALUE)).toBe(true);
        expect(isFabricValue(Number.MIN_VALUE)).toBe(true);
      });

      it("accepts null", () => {
        expect(isFabricValue(null)).toBe(true);
      });

      it("accepts plain objects", () => {
        expect(isFabricValue({})).toBe(true);
        expect(isFabricValue({ a: 1 })).toBe(true);
        expect(isFabricValue({ nested: { object: true } })).toBe(true);
      });

      it("accepts dense arrays", () => {
        expect(isFabricValue([])).toBe(true);
        expect(isFabricValue([1, 2, 3])).toBe(true);
        expect(isFabricValue([{ a: 1 }, { b: 2 }])).toBe(true);
        expect(isFabricValue([null, "test", null])).toBe(true);
      });
    });

    describe("returns false for non-fabric arrays", () => {
      it("rejects arrays with undefined elements", () => {
        expect(isFabricValue([1, undefined, 3])).toBe(false);
        expect(isFabricValue([undefined])).toBe(false);
      });

      it("accepts sparse arrays (arrays with holes)", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isFabricValue(sparse)).toBe(true);
      });

      it("rejects arrays with extra non-numeric properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isFabricValue(arr)).toBe(false);
      });

      it("rejects sparse arrays even when extra properties balance the count", () => {
        // This array has length 3, hole at index 1, but extra property "foo"
        // So Object.keys() returns ["0", "2", "foo"] which has length 3
        // But it should still be rejected because indices aren't all present
        const sparse = [] as unknown[] & { foo?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.foo = "bar";
        expect(isFabricValue(sparse)).toBe(false);
      });
    });

    describe("returns true for fabric-compatible-but-not-JSON-encodable values", () => {
      it("accepts undefined", () => {
        expect(isFabricValue(undefined)).toBe(true);
      });
    });

    describe("returns false for non-fabric values", () => {
      it("rejects NaN", () => {
        expect(isFabricValue(NaN)).toBe(false);
      });

      it("rejects Infinity", () => {
        expect(isFabricValue(Infinity)).toBe(false);
        expect(isFabricValue(-Infinity)).toBe(false);
      });

      it("rejects functions", () => {
        expect(isFabricValue(() => {})).toBe(false);
        expect(isFabricValue(function () {})).toBe(false);
        expect(isFabricValue(async () => {})).toBe(false);
      });

      it("rejects class instances", () => {
        expect(isFabricValue(new Date())).toBe(false);
        expect(isFabricValue(new Map())).toBe(false);
        expect(isFabricValue(new Set())).toBe(false);
        expect(isFabricValue(/regex/)).toBe(false);
      });

      it("rejects bigint", () => {
        expect(isFabricValue(BigInt(123))).toBe(false);
      });

      it("rejects symbol", () => {
        expect(isFabricValue(Symbol("test"))).toBe(false);
      });
    });
  });

  describe("shallowFabricFromNativeValue", () => {
    describe("passes through JSON-encodable values", () => {
      it("passes through booleans", () => {
        expect(shallowFabricFromNativeValue(true)).toBe(true);
        expect(shallowFabricFromNativeValue(false)).toBe(false);
      });

      it("passes through strings", () => {
        expect(shallowFabricFromNativeValue("hello")).toBe("hello");
        expect(shallowFabricFromNativeValue("")).toBe("");
      });

      it("passes through finite numbers", () => {
        expect(shallowFabricFromNativeValue(42)).toBe(42);
        expect(shallowFabricFromNativeValue(-3.14)).toBe(-3.14);
        expect(shallowFabricFromNativeValue(0)).toBe(0);
      });

      it("converts negative zero to positive zero", () => {
        const result = shallowFabricFromNativeValue(-0);
        expect(result).toBe(0);
        expect(Object.is(result, -0)).toBe(false);
        expect(Object.is(result, 0)).toBe(true);
      });

      it("passes through null", () => {
        expect(shallowFabricFromNativeValue(null)).toBe(null);
      });

      it("passes through plain objects", () => {
        const obj = { a: 1, b: "two" };
        expect(shallowFabricFromNativeValue(obj)).toBe(obj);
      });

      it("passes through dense arrays", () => {
        const arr = [1, 2, 3];
        expect(shallowFabricFromNativeValue(arr)).toBe(arr);
      });

      it("passes through undefined", () => {
        expect(shallowFabricFromNativeValue(undefined)).toBe(undefined);
      });
    });

    describe("handles sparse arrays and undefined elements", () => {
      it("preserves sparse array holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        const result = shallowFabricFromNativeValue(sparse) as unknown[];
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
        const result = shallowFabricFromNativeValue(sparse) as unknown[];
        expect(result[0]).toBe("a");
        expect(1 in result).toBe(false);
        expect(2 in result).toBe(false);
        expect(result[3]).toBe("b");
        expect(4 in result).toBe(false);
        expect(result[5]).toBe("c");
        expect(result.length).toBe(6);
      });

      it("converts undefined elements to null", () => {
        const result = shallowFabricFromNativeValue([1, undefined, 3]);
        expect(result).toEqual([1, null, 3]);
      });

      it("throws for arrays with named properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(() => shallowFabricFromNativeValue(arr)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });

      it("throws for sparse arrays with named properties", () => {
        // Even if the sparse array could be densified, named props are not allowed
        const sparse = [] as unknown[] & { foo?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.foo = "bar";
        expect(() => shallowFabricFromNativeValue(sparse)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });
    });

    describe("throws for non-convertible values", () => {
      it("throws for NaN", () => {
        expect(() => shallowFabricFromNativeValue(NaN)).toThrow(
          "Cannot store non-finite number",
        );
      });

      it("throws for Infinity", () => {
        expect(() => shallowFabricFromNativeValue(Infinity)).toThrow(
          "Cannot store non-finite number",
        );
        expect(() => shallowFabricFromNativeValue(-Infinity)).toThrow(
          "Cannot store non-finite number",
        );
      });

      it("throws for bigint", () => {
        expect(() => shallowFabricFromNativeValue(BigInt(123))).toThrow(
          "Cannot store bigint",
        );
      });

      it("throws for symbol", () => {
        expect(() => shallowFabricFromNativeValue(Symbol("test"))).toThrow(
          "Cannot store symbol",
        );
      });

      it("throws for functions without toJSON", () => {
        expect(() => shallowFabricFromNativeValue(() => {})).toThrow(
          "Cannot store function per se",
        );
      });

      it("throws for class instances without toJSON", () => {
        class NoToJSON {}
        expect(() => shallowFabricFromNativeValue(new NoToJSON())).toThrow(
          "Cannot store instance per se",
        );
      });
    });

    describe("converts Error instances to @Error wrapper", () => {
      it("converts basic Error with name, message, and stack", () => {
        const error = new Error("test message");
        const result = shallowFabricFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result).toHaveProperty("@Error");
        expect(result["@Error"].name).toBe("Error");
        expect(result["@Error"].message).toBe("test message");
        expect(typeof result["@Error"].stack).toBe("string");
      });

      it("preserves Error subclass name", () => {
        const error = new TypeError("type error message");
        const result = shallowFabricFromNativeValue(error) as {
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
        const result = shallowFabricFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].message).toBe("with extras");
        expect(result["@Error"].code).toBe(404);
        expect(result["@Error"].detail).toBe("Not Found");
      });

      it("converts RangeError", () => {
        const error = new RangeError("out of range");
        const result = shallowFabricFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].name).toBe("RangeError");
        expect(result["@Error"].message).toBe("out of range");
      });

      it("converts SyntaxError", () => {
        const error = new SyntaxError("invalid syntax");
        const result = shallowFabricFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].name).toBe("SyntaxError");
        expect(result["@Error"].message).toBe("invalid syntax");
      });

      it("preserves cause property from Error constructor (ES2022)", () => {
        const cause = new Error("root cause");
        const error = new Error("wrapper", { cause });
        const result = shallowFabricFromNativeValue(error) as {
          "@Error": Record<string, unknown>;
        };

        expect(result["@Error"].message).toBe("wrapper");
        // cause is captured but not recursively converted by shallowFabricFromNativeValue
        // (shallow conversion) - the cause is still a raw Error here
        expect(result["@Error"].cause).toBe(cause);
      });
    });

    describe("converts via toJSON when available", () => {
      it("converts functions with toJSON", () => {
        const fn = () => {};
        (fn as any).toJSON = () => "converted function";
        expect(shallowFabricFromNativeValue(fn)).toBe("converted function");
      });

      it("converts class instances with toJSON", () => {
        class WithToJSON {
          toJSON() {
            return { converted: true };
          }
        }
        const result = shallowFabricFromNativeValue(new WithToJSON());
        expect(result).toEqual({ converted: true });
      });

      it("converts Date instances (which have toJSON)", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        expect(shallowFabricFromNativeValue(date)).toBe(
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
        const result = shallowFabricFromNativeValue(obj);
        expect(result).toEqual({ exposed: true });
      });

      it("converts arrays with toJSON", () => {
        const arr = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
        arr.toJSON = () => "custom array";
        expect(shallowFabricFromNativeValue(arr)).toBe("custom array");
      });

      it("throws if toJSON returns a non-fabric value", () => {
        class BadToJSON {
          toJSON() {
            return Symbol("bad");
          }
        }
        expect(() => shallowFabricFromNativeValue(new BadToJSON())).toThrow(
          "`toJSON()` on object returned something other than a fabric value",
        );
      });

      it("throws if toJSON returns a function", () => {
        class ReturnsFunction {
          toJSON() {
            return () => {};
          }
        }
        expect(() => shallowFabricFromNativeValue(new ReturnsFunction()))
          .toThrow(
            "`toJSON()` on object returned something other than a fabric value",
          );
      });

      it("throws if toJSON returns another instance", () => {
        class ReturnsInstance {
          toJSON() {
            return new Map();
          }
        }
        expect(() => shallowFabricFromNativeValue(new ReturnsInstance()))
          .toThrow(
            "`toJSON()` on object returned something other than a fabric value",
          );
      });
    });
  });

  describe("fabricFromNativeValue", () => {
    describe("passes through primitives", () => {
      it("passes through booleans", () => {
        expect(fabricFromNativeValue(true)).toBe(true);
        expect(fabricFromNativeValue(false)).toBe(false);
      });

      it("passes through strings", () => {
        expect(fabricFromNativeValue("hello")).toBe("hello");
      });

      it("passes through numbers", () => {
        expect(fabricFromNativeValue(42)).toBe(42);
      });

      it("passes through null", () => {
        expect(fabricFromNativeValue(null)).toBe(null);
      });

      it("passes through undefined at top level", () => {
        expect(fabricFromNativeValue(undefined)).toBe(undefined);
      });
    });

    describe("recursively processes arrays", () => {
      it("returns a new array", () => {
        const arr = [1, 2, 3];
        const result = fabricFromNativeValue(arr);
        expect(result).toEqual([1, 2, 3]);
        expect(result).not.toBe(arr);
      });

      it("converts nested instances via toJSON", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = fabricFromNativeValue([date]);
        expect(result).toEqual(["2024-01-15T12:00:00.000Z"]);
      });

      it("recursively processes nested arrays", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = fabricFromNativeValue([[date]]);
        expect(result).toEqual([["2024-01-15T12:00:00.000Z"]]);
      });
    });

    describe("recursively processes objects", () => {
      it("returns a new object", () => {
        const obj = { a: 1 };
        const result = fabricFromNativeValue(obj);
        expect(result).toEqual({ a: 1 });
        expect(result).not.toBe(obj);
      });

      it("converts nested instances via toJSON", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = fabricFromNativeValue({ date });
        expect(result).toEqual({ date: "2024-01-15T12:00:00.000Z" });
      });

      it("recursively processes nested objects", () => {
        const date = new Date("2024-01-15T12:00:00.000Z");
        const result = fabricFromNativeValue({ outer: { date } });
        expect(result).toEqual({ outer: { date: "2024-01-15T12:00:00.000Z" } });
      });

      it("omits undefined properties (matches JSON.stringify behavior)", () => {
        const result = fabricFromNativeValue({ a: 1, b: undefined, c: 3 });
        expect(result).toEqual({ a: 1, c: 3 });
        expect("b" in (result as object)).toBe(false);
      });

      it("omits nested undefined properties", () => {
        const result = fabricFromNativeValue({
          outer: { keep: 1, drop: undefined },
        });
        expect(result).toEqual({ outer: { keep: 1 } });
      });
    });

    describe("handles shared references (same object from multiple places)", () => {
      it("allows shared object references", () => {
        const shared = { value: 42 };
        const obj = { first: shared, second: shared };
        const result = fabricFromNativeValue(obj);
        expect(result).toEqual({ first: { value: 42 }, second: { value: 42 } });
      });

      it("allows shared array references", () => {
        const shared = [1, 2, 3];
        const obj = { a: shared, b: shared };
        const result = fabricFromNativeValue(obj);
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
        const result = fabricFromNativeValue(obj);
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
        const result = fabricFromNativeValue(obj) as {
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
        expect(() => fabricFromNativeValue(obj)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws when array references itself", () => {
        const arr: any[] = [1, 2];
        arr.push(arr);
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws for indirect circular reference", () => {
        const a: any = { name: "a" };
        const b: any = { name: "b" };
        a.b = b;
        b.a = a;
        expect(() => fabricFromNativeValue(a)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws when sparse array references itself", () => {
        const arr: any[] = [];
        arr[0] = 1;
        arr[2] = arr; // sparse array with circular reference at index 2
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Cannot store circular reference",
        );
      });

      it("throws when array with undefined references itself", () => {
        const arr: any[] = [1, undefined, null];
        arr[3] = arr; // array with undefined element + circular reference
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Cannot store circular reference",
        );
      });
    });

    describe("throws for non-fabric nested values", () => {
      it("throws for nested symbol", () => {
        expect(() => fabricFromNativeValue({ val: Symbol("test") })).toThrow(
          "Cannot store symbol",
        );
      });

      it("throws for nested bigint", () => {
        expect(() => fabricFromNativeValue([BigInt(123)])).toThrow(
          "Cannot store bigint",
        );
      });

      it("throws for deeply nested non-fabric value", () => {
        expect(() => fabricFromNativeValue({ a: { b: { c: Symbol("deep") } } }))
          .toThrow("Cannot store symbol");
      });
    });

    describe("throws for nested instances without toJSON", () => {
      it("throws for instance property in object", () => {
        class NoToJSON {}
        expect(() => fabricFromNativeValue({ a: 1, inst: new NoToJSON() }))
          .toThrow("Cannot store instance per se");
      });

      it("throws for instance element in array", () => {
        class NoToJSON {}
        expect(() => fabricFromNativeValue([1, new NoToJSON(), 3]))
          .toThrow("Cannot store instance per se");
      });
    });

    describe("converts nested Error instances to @Error wrapper", () => {
      it("converts Error property in object", () => {
        const error = new Error("nested error");
        const result = fabricFromNativeValue({ status: "failed", error }) as {
          status: string;
          error: { "@Error": Record<string, unknown> };
        };

        expect(result.status).toBe("failed");
        expect(result.error).toHaveProperty("@Error");
        expect(result.error["@Error"].message).toBe("nested error");
      });

      it("converts Error element in array", () => {
        const result = fabricFromNativeValue([
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
        const result = fabricFromNativeValue({
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

        const result = fabricFromNativeValue(outer) as {
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

        const result = fabricFromNativeValue(outer) as {
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
        const result = fabricFromNativeValue({ a: 1, fn: () => {}, b: 2 });
        expect(result).toEqual({ a: 1, b: 2 });
      });

      it("converts function elements in arrays to null", () => {
        const result = fabricFromNativeValue([1, () => {}, 3]);
        expect(result).toEqual([1, null, 3]);
      });

      it("converts nested function with toJSON via its toJSON method", () => {
        const fn = () => {};
        (fn as unknown as { toJSON: () => unknown }).toJSON = () =>
          "function with toJSON";
        const result = fabricFromNativeValue({ a: 1, fn, b: 2 });
        expect(result).toEqual({ a: 1, fn: "function with toJSON", b: 2 });
      });

      it("converts function with toJSON in array via its toJSON method", () => {
        const fn = () => {};
        (fn as unknown as { toJSON: () => unknown }).toJSON = () =>
          "converted fn";
        const result = fabricFromNativeValue([1, fn, 3]);
        expect(result).toEqual([1, "converted fn", 3]);
      });
    });

    describe("throws for top-level function", () => {
      it("throws when a bare function is passed (not nested)", () => {
        // This must throw, not return an internal symbol or other non-JSON value.
        expect(() => fabricFromNativeValue(() => {})).toThrow(
          "Cannot store function per se",
        );
      });
    });

    describe("handles sparse arrays and undefined elements", () => {
      it("preserves top-level sparse array holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        const result = fabricFromNativeValue(sparse) as unknown[];
        expect(result[0]).toBe(1);
        expect(1 in result).toBe(false); // hole preserved
        expect(result[2]).toBe(3);
        expect(result.length).toBe(3);
      });

      it("preserves nested sparse array holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = "a";
        sparse[2] = "c";
        const result = fabricFromNativeValue({ arr: sparse }) as {
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
        const result = fabricFromNativeValue([[sparse]]) as unknown[][][];
        const inner = result[0][0];
        expect(inner[0]).toBe(1);
        expect(1 in inner).toBe(false); // hole preserved
        expect(inner[2]).toBe(3);
      });

      it("converts undefined elements to null", () => {
        const result = fabricFromNativeValue([1, undefined, 3]);
        expect(result).toEqual([1, null, 3]);
      });

      it("converts toJSON-returning-undefined in arrays to null, not OMIT sentinel", () => {
        // Regression: when a nested object's toJSON() returns undefined inside
        // an array, the legacy path returned the internal OMIT symbol instead
        // of null. This leaked a Symbol into the result array.
        const objReturningUndefined = { toJSON: () => undefined };
        const result = fabricFromNativeValue(
          [1, objReturningUndefined, 3],
        ) as unknown[];
        expect(result[0]).toBe(1);
        expect(result[1]).toBe(null);
        expect(result[2]).toBe(3);
        // The critical check: no Symbol values in the result.
        expect(typeof result[1]).not.toBe("symbol");
      });

      it("recursively processes elements and preserves holes", () => {
        const sparse: unknown[] = [];
        sparse[0] = new Date("2024-01-15T12:00:00.000Z");
        sparse[2] = { nested: true };
        const result = fabricFromNativeValue(sparse) as unknown[];
        expect(result[0]).toBe("2024-01-15T12:00:00.000Z");
        expect(1 in result).toBe(false); // hole preserved
        expect(result[2]).toEqual({ nested: true });
      });
    });

    describe("throws for arrays with named properties", () => {
      it("throws for top-level array with named properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(() => fabricFromNativeValue(arr)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });

      it("throws for nested array with named properties", () => {
        const arr = [1, 2] as unknown[] & { extra?: number };
        arr.extra = 42;
        expect(() => fabricFromNativeValue({ data: arr })).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });

      it("throws for sparse array with named properties", () => {
        const sparse = [] as unknown[] & { name?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.name = "test";
        expect(() => fabricFromNativeValue(sparse)).toThrow(
          "Cannot store array with enumerable named properties",
        );
      });
    });
  });

  // --------------------------------------------------------------------------
  // freeze parameter (modern path only)
  // --------------------------------------------------------------------------

  describe("freeze parameter (modern path)", () => {
    beforeEach(() => {
      setDataModelConfig(true);
    });

    afterEach(() => {
      resetDataModelConfig();
    });

    describe("shallowFabricFromNativeValue", () => {
      it("freezes plain objects by default", () => {
        const result = shallowFabricFromNativeValue({ a: 1 });
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("freezes arrays by default", () => {
        const result = shallowFabricFromNativeValue([1, 2, 3]);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("does not freeze plain objects when freeze=false", () => {
        const result = shallowFabricFromNativeValue({ a: 1 }, false);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("does not freeze arrays when freeze=false", () => {
        const result = shallowFabricFromNativeValue([1, 2, 3], false);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("wraps Error even when freeze=false", () => {
        const error = new Error("test");
        const result = shallowFabricFromNativeValue(error, false);
        expect(result).not.toBe(error);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("primitives are unaffected by freeze parameter", () => {
        expect(shallowFabricFromNativeValue(42, false)).toBe(42);
        expect(shallowFabricFromNativeValue("hello", false)).toBe("hello");
        expect(shallowFabricFromNativeValue(true, false)).toBe(true);
        expect(shallowFabricFromNativeValue(null, false)).toBe(null);
        expect(shallowFabricFromNativeValue(undefined, false)).toBe(
          undefined,
        );
        expect(shallowFabricFromNativeValue(BigInt(42), false)).toBe(
          BigInt(42),
        );
      });

      it("does not freeze the original array", () => {
        const arr = [1, 2, 3];
        shallowFabricFromNativeValue(arr, true);
        expect(Object.isFrozen(arr)).toBe(false);
      });

      it("does not freeze the original plain object", () => {
        const obj = { a: 1, b: 2 };
        shallowFabricFromNativeValue(obj, true);
        expect(Object.isFrozen(obj)).toBe(false);
      });

      it("returns a frozen copy for arrays when freeze=true", () => {
        const arr = [1, 2, 3];
        const result = shallowFabricFromNativeValue(arr, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(arr);
      });

      it("returns a frozen copy for plain objects when freeze=true", () => {
        const obj = { a: 1, b: 2 };
        const result = shallowFabricFromNativeValue(obj, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(obj);
      });

      it("converts function with toJSON via modern path", () => {
        const fn = () => {};
        (fn as unknown as { toJSON: () => string }).toJSON = () =>
          "converted fn";
        expect(shallowFabricFromNativeValue(fn)).toBe("converted fn");
      });

      it("returns mutable shallow copy of frozen plain object when freeze=false", () => {
        const frozen = Object.freeze({ a: 1, b: "two" });
        const result = shallowFabricFromNativeValue(frozen, false) as Record<
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
        const result = shallowFabricFromNativeValue(
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
        const result = shallowFabricFromNativeValue(arr, false) as unknown[];
        expect(Object.isFrozen(result)).toBe(false);
        expect(result.length).toBe(3);
        expect(0 in result).toBe(true);
        expect(1 in result).toBe(false); // hole preserved
        expect(2 in result).toBe(true);
      });

      it("returns frozen shallow copy of mutable plain object when freeze=true", () => {
        const mutable = { x: 1, y: 2 };
        const result = shallowFabricFromNativeValue(mutable, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(mutable);
        // Original stays mutable.
        expect(Object.isFrozen(mutable)).toBe(false);
      });

      it("returns frozen shallow copy of mutable array when freeze=true", () => {
        const mutable = [10, 20, 30];
        const result = shallowFabricFromNativeValue(mutable, true);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result).not.toBe(mutable);
        expect(Object.isFrozen(mutable)).toBe(false);
      });

      it("returns already-frozen object as-is when freeze=true", () => {
        const frozen = Object.freeze({ a: 1 });
        const result = shallowFabricFromNativeValue(frozen, true);
        expect(result).toBe(frozen); // identity -- no copy needed
      });

      it("returns already-frozen array as-is when freeze=true", () => {
        const frozen = Object.freeze([1, 2]);
        const result = shallowFabricFromNativeValue(frozen, true);
        expect(result).toBe(frozen); // identity -- no copy needed
      });

      it("returns mutable object as-is when freeze=false", () => {
        const mutable = { a: 1 };
        const result = shallowFabricFromNativeValue(mutable, false);
        expect(result).toBe(mutable); // identity -- no copy needed
      });

      it("returns mutable array as-is when freeze=false", () => {
        const mutable = [1, 2];
        const result = shallowFabricFromNativeValue(mutable, false);
        expect(result).toBe(mutable); // identity -- no copy needed
      });

      it("preserves null prototype on objects when freeze=true", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        const result = shallowFabricFromNativeValue(obj, true) as Record<
          string,
          unknown
        >;
        expect(Object.getPrototypeOf(result)).toBe(null);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result.a).toBe(1);
      });

      it("preserves null prototype on objects when freeze=false", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.b = 2;
        Object.freeze(obj);
        const result = shallowFabricFromNativeValue(obj, false) as Record<
          string,
          unknown
        >;
        expect(Object.getPrototypeOf(result)).toBe(null);
        expect(Object.isFrozen(result)).toBe(false);
        expect(result.b).toBe(2);
      });

      it("converts native Uint8Array to FabricBytes", () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const result = shallowFabricFromNativeValue(bytes);
        expect(result).toBeInstanceOf(FabricBytes);
        expect((result as FabricBytes).slice()).toEqual(bytes);
      });

      it("converts native Uint8Array to frozen FabricBytes by default", () => {
        const bytes = new Uint8Array([10, 20]);
        const result = shallowFabricFromNativeValue(bytes);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("FabricBytes is always frozen (freeze parameter ignored)", () => {
        const bytes = new Uint8Array([10, 20]);
        const result = shallowFabricFromNativeValue(bytes, false);
        expect(result).toBeInstanceOf(FabricBytes);
        // FabricBytes extends FabricPrimitive -- always frozen.
        expect(Object.isFrozen(result)).toBe(true);
      });
    });

    describe("fabricFromNativeValue", () => {
      it("deep-freezes objects by default", () => {
        const result = fabricFromNativeValue({ a: { b: 1 } }) as Record<
          string,
          unknown
        >;
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.a)).toBe(true);
      });

      it("deep-freezes arrays by default", () => {
        const result = fabricFromNativeValue([[1, 2], [3, 4]]) as unknown[][];
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result[0])).toBe(true);
      });

      it("does not freeze objects when freeze=false", () => {
        const result = fabricFromNativeValue(
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
        const result = fabricFromNativeValue(
          [[1, 2], [3, 4]],
          false,
        ) as unknown[][];
        expect(Object.isFrozen(result)).toBe(false);
        expect(Object.isFrozen(result[0])).toBe(false);
      });

      it("allows mutation when freeze=false", () => {
        const result = fabricFromNativeValue({ a: 1 }, false) as Record<
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
        const result = fabricFromNativeValue(
          { error },
          false,
        ) as Record<string, unknown>;
        // Error should be wrapped into FabricError even without freezing.
        expect(result.error).not.toBe(error);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("still validates when freeze=false", () => {
        expect(() => fabricFromNativeValue(Symbol("bad"), false)).toThrow();
      });

      it("primitives are unaffected by freeze parameter", () => {
        expect(fabricFromNativeValue(42, false)).toBe(42);
        expect(fabricFromNativeValue("hello", false)).toBe("hello");
        expect(fabricFromNativeValue(null, false)).toBe(null);
      });

      it("does not freeze the original array", () => {
        const arr = [1, 2, 3];
        fabricFromNativeValue(arr, true);
        expect(Object.isFrozen(arr)).toBe(false);
      });

      it("does not freeze the original plain object", () => {
        const obj = { a: 1, b: 2 };
        fabricFromNativeValue(obj, true);
        expect(Object.isFrozen(obj)).toBe(false);
      });

      it("preserves null prototype on top-level object", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.x = 1;
        const result = fabricFromNativeValue(obj) as Record<string, unknown>;
        expect(Object.getPrototypeOf(result)).toBe(null);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result.x).toBe(1);
      });

      it("preserves null prototype on nested object", () => {
        const inner = Object.create(null) as Record<string, unknown>;
        inner.val = 42;
        const outer = { nested: inner };
        const result = fabricFromNativeValue(outer) as Record<
          string,
          Record<string, unknown>
        >;
        expect(Object.getPrototypeOf(result.nested)).toBe(null);
        expect(result.nested.val).toBe(42);
      });
    });
  });

  // =========================================================================
  // Error internals conversion (modern path): cause and custom properties must
  // be recursively converted to FabricValue before wrapping in FabricError
  // =========================================================================

  describe("Error internals deep conversion (modern path)", () => {
    beforeEach(() => {
      setDataModelConfig(true);
    });
    afterEach(() => {
      resetDataModelConfig();
    });

    it("converts Error with raw Error cause into nested FabricError", () => {
      const inner = new Error("inner");
      const outer = new Error("outer", { cause: inner });
      const result = fabricFromNativeValue(outer);

      // Top level should be a FabricError.
      expect(result).toBeInstanceOf(FabricError);
      const se = result as FabricError;
      expect(se.error.message).toBe("outer");

      // cause should also be a FabricError (not a raw Error).
      expect(se.error.cause).toBeInstanceOf(FabricError);
      const innerSe = se.error.cause as FabricError;
      expect(innerSe.error.message).toBe("inner");
    });

    it("converts deeply nested Error chain (3 levels)", () => {
      const root = new Error("root");
      const mid = new Error("mid", { cause: root });
      const top = new Error("top", { cause: mid });
      const result = fabricFromNativeValue(top) as FabricError;

      expect(result.error.message).toBe("top");
      const midSe = result.error.cause as FabricError;
      expect(midSe).toBeInstanceOf(FabricError);
      expect(midSe.error.message).toBe("mid");
      const rootSe = midSe.error.cause as FabricError;
      expect(rootSe).toBeInstanceOf(FabricError);
      expect(rootSe.error.message).toBe("root");
    });

    it("converts custom enumerable properties on Error", () => {
      const error = new Error("with props") as Error & {
        statusCode: number;
        details: { nested: string };
      };
      error.statusCode = 404;
      error.details = { nested: "value" };

      const result = fabricFromNativeValue(error) as FabricError;
      expect(result.error.message).toBe("with props");
      // Custom properties should be preserved and converted.
      const converted = result.error as unknown as Record<string, unknown>;
      expect(converted.statusCode).toBe(404);
      expect(converted.details).toEqual({ nested: "value" });
    });

    it("converts Error with non-Error cause (plain object)", () => {
      const cause = { code: "ENOENT", path: "/missing" };
      const error = new Error("file error", { cause });
      const result = fabricFromNativeValue(error) as FabricError;

      // cause should be a plain object (already valid FabricValue).
      expect(result.error.cause).toEqual({ code: "ENOENT", path: "/missing" });
      expect(Object.isFrozen(result.error.cause)).toBe(true);
    });

    it("preserves Error subclass through internals conversion", () => {
      const inner = new RangeError("bad range");
      const outer = new TypeError("bad type", { cause: inner });
      const result = fabricFromNativeValue(outer) as FabricError;

      expect(result.error).toBeInstanceOf(TypeError);
      expect(result.error.name).toBe("TypeError");
      const innerSe = result.error.cause as FabricError;
      expect(innerSe.error).toBeInstanceOf(RangeError);
      expect(innerSe.error.name).toBe("RangeError");
    });

    it("does not mutate the original Error's cause", () => {
      const inner = new Error("inner");
      const outer = new Error("outer", { cause: inner });
      fabricFromNativeValue(outer);

      // Original Error's cause should still be the raw Error, not FabricError.
      expect(outer.cause).toBe(inner);
      expect(outer.cause).not.toBeInstanceOf(FabricError);
    });

    it("handles Error with undefined cause (no conversion needed)", () => {
      const error = new Error("simple");
      const result = fabricFromNativeValue(error) as FabricError;
      expect(result.error.cause).toBeUndefined();
    });

    it("freezes the FabricError wrapper when freeze=true", () => {
      const error = new Error("freeze me", { cause: new Error("nested") });
      const result = fabricFromNativeValue(error);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("does not freeze FabricError wrapper when freeze=false", () => {
      const error = new Error("no freeze", { cause: new Error("nested") });
      const result = fabricFromNativeValue(error, false);
      expect(Object.isFrozen(result)).toBe(false);
      // But internals should still be converted.
      expect(result).toBeInstanceOf(FabricError);
      const se = result as FabricError;
      expect(se.error.cause).toBeInstanceOf(FabricError);
    });
  });
});
