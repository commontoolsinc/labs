import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isStorableValue, toStorableValue } from "../src/value-codec.ts";

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

      it("accepts arrays", () => {
        expect(isStorableValue([])).toBe(true);
        expect(isStorableValue([1, 2, 3])).toBe(true);
        expect(isStorableValue([{ a: 1 }, { b: 2 }])).toBe(true);
      });

      // TODO(@danfuzz): These should return false once the TODOs are resolved
      it("accepts undefined (TODO: should be false)", () => {
        expect(isStorableValue(undefined)).toBe(true);
      });

      it("accepts NaN (TODO: should be false)", () => {
        expect(isStorableValue(NaN)).toBe(true);
      });
    });

    describe("returns false for non-JSON-encodable values", () => {
      it("rejects Infinity", () => {
        expect(isStorableValue(Infinity)).toBe(false);
        expect(isStorableValue(-Infinity)).toBe(false);
      });

      it("rejects negative zero", () => {
        expect(isStorableValue(-0)).toBe(false);
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

      it("passes through null", () => {
        expect(toStorableValue(null)).toBe(null);
      });

      it("passes through plain objects", () => {
        const obj = { a: 1, b: "two" };
        expect(toStorableValue(obj)).toBe(obj);
      });

      it("passes through arrays", () => {
        const arr = [1, 2, 3];
        expect(toStorableValue(arr)).toBe(arr);
      });

      // TODO(@danfuzz): This should throw once the TODO is resolved
      it("passes through undefined (TODO: should throw)", () => {
        expect(toStorableValue(undefined)).toBe(undefined);
      });
    });

    describe("converts NaN to null (TODO: should throw)", () => {
      it("converts NaN to null", () => {
        expect(toStorableValue(NaN)).toBe(null);
      });
    });

    describe("throws for non-convertible values", () => {
      it("throws for Infinity", () => {
        expect(() => toStorableValue(Infinity)).toThrow(
          "Cannot store non-finite number or negative zero",
        );
        expect(() => toStorableValue(-Infinity)).toThrow(
          "Cannot store non-finite number or negative zero",
        );
      });

      it("throws for negative zero", () => {
        expect(() => toStorableValue(-0)).toThrow(
          "Cannot store non-finite number or negative zero",
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

      it("throws if toJSON returns a non-storable value", () => {
        class BadToJSON {
          toJSON() {
            return Symbol("bad");
          }
        }
        expect(() => toStorableValue(new BadToJSON())).toThrow(
          "`toJSON()` on object returned something other than a `JSONValue`",
        );
      });

      it("throws if toJSON returns a function", () => {
        class ReturnsFunction {
          toJSON() {
            return () => {};
          }
        }
        expect(() => toStorableValue(new ReturnsFunction())).toThrow(
          "`toJSON()` on object returned something other than a `JSONValue`",
        );
      });

      it("throws if toJSON returns another instance", () => {
        class ReturnsInstance {
          toJSON() {
            return new Map();
          }
        }
        expect(() => toStorableValue(new ReturnsInstance())).toThrow(
          "`toJSON()` on object returned something other than a `JSONValue`",
        );
      });
    });
  });
});
