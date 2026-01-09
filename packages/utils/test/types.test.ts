import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isBoolean,
  isFunction,
  isInstance,
  isNumber,
  isObject,
  isRecord,
  isString,
  Mutable,
} from "@commontools/utils/types";

type ImmutableObj<T> = {
  readonly prop: T;
};

function mutate<T>(value: T, callback: (v: Mutable<T>) => void) {
  callback(value as Mutable<T>);
}

describe("types", () => {
  describe("Mutable", () => {
    it("Enables mutation on nested `{ readonly prop: T }`", () => {
      const schema: ImmutableObj<ImmutableObj<number>> = { prop: { prop: 5 } };
      mutate(schema, (schema) => {
        schema.prop.prop = 10;
      });
    });
    it("Enables mutation on nested `Readonly<T>`", () => {
      const schema: Readonly<{
        prop: Readonly<{
          prop: number;
        }>;
      }> = { prop: { prop: 5 } };
      mutate(schema, (schema) => {
        schema.prop.prop = 10;
      });
    });
    it("Enables mutation on `ReadonlyArray`", () => {
      const schema: ReadonlyArray<number> = [1, 2, 3];
      mutate(schema, (schema) => {
        schema[1] = 100;
      });
    });
    it("Enables mutation on `readonly T[]`", () => {
      const schema: readonly number[] = [1, 2, 3];
      mutate(schema, (schema) => {
        schema[1] = 100;
      });
    });
    it("Enables mutation on `ReadonlyArray` nested in `Readonly<T>`", () => {
      const schema: Readonly<{
        prop: ReadonlyArray<number>;
      }> = { prop: [1, 2, 3] };
      mutate(schema, (schema) => {
        schema.prop[1] = 100;
      });
    });
    it("Passes through for primitive types", () => {
      const _: Mutable<null> = null;
      const __: Mutable<number> = 5;
      const ___: Mutable<string> = "hi";
    });
  });

  describe("isRecord", () => {
    it("returns true for plain objects", () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
    });

    it("returns true for arrays", () => {
      expect(isRecord([])).toBe(true);
      expect(isRecord([1, 2, 3])).toBe(true);
    });

    it("returns true for class instances", () => {
      expect(isRecord(new Date())).toBe(true);
      expect(isRecord(new Map())).toBe(true);
    });

    it("returns false for null", () => {
      expect(isRecord(null)).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isRecord(undefined)).toBe(false);
      expect(isRecord(42)).toBe(false);
      expect(isRecord("string")).toBe(false);
      expect(isRecord(true)).toBe(false);
      expect(isRecord(Symbol("test"))).toBe(false);
    });

    it("returns false for functions", () => {
      expect(isRecord(() => {})).toBe(false);
    });
  });

  describe("isFunction", () => {
    it("returns true for arrow functions", () => {
      expect(isFunction(() => {})).toBe(true);
      expect(isFunction((x: number) => x * 2)).toBe(true);
    });

    it("returns true for function declarations", () => {
      expect(isFunction(function () {})).toBe(true);
      expect(isFunction(function named() {})).toBe(true);
    });

    it("returns true for async functions", () => {
      expect(isFunction(async () => {})).toBe(true);
    });

    it("returns true for class constructors", () => {
      expect(isFunction(class {})).toBe(true);
    });

    it("returns false for non-functions", () => {
      expect(isFunction({})).toBe(false);
      expect(isFunction([])).toBe(false);
      expect(isFunction(null)).toBe(false);
      expect(isFunction(undefined)).toBe(false);
      expect(isFunction(42)).toBe(false);
      expect(isFunction("string")).toBe(false);
    });
  });

  describe("isInstance", () => {
    it("returns true for class instances", () => {
      expect(isInstance(new Date())).toBe(true);
      expect(isInstance(new Map())).toBe(true);
      expect(isInstance(new Set())).toBe(true);
      expect(isInstance(/regex/)).toBe(true);
    });

    it("returns true for custom class instances", () => {
      class MyClass {}
      expect(isInstance(new MyClass())).toBe(true);
    });

    it("returns false for plain objects", () => {
      expect(isInstance({})).toBe(false);
      expect(isInstance({ a: 1 })).toBe(false);
    });

    it("returns false for arrays", () => {
      expect(isInstance([])).toBe(false);
      expect(isInstance([1, 2, 3])).toBe(false);
    });

    it("returns false for null", () => {
      expect(isInstance(null)).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isInstance(undefined)).toBe(false);
      expect(isInstance(42)).toBe(false);
      expect(isInstance("string")).toBe(false);
      expect(isInstance(true)).toBe(false);
    });

    it("returns false for Object.create(null)", () => {
      expect(isInstance(Object.create(null))).toBe(false);
    });
  });

  describe("isObject", () => {
    it("returns true for plain objects", () => {
      expect(isObject({})).toBe(true);
      expect(isObject({ a: 1 })).toBe(true);
    });

    it("returns true for class instances", () => {
      expect(isObject(new Date())).toBe(true);
      expect(isObject(new Map())).toBe(true);
    });

    it("returns false for arrays", () => {
      expect(isObject([])).toBe(false);
      expect(isObject([1, 2, 3])).toBe(false);
    });

    it("returns false for null", () => {
      expect(isObject(null)).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isObject(undefined)).toBe(false);
      expect(isObject(42)).toBe(false);
      expect(isObject("string")).toBe(false);
      expect(isObject(true)).toBe(false);
    });

    it("returns false for functions", () => {
      expect(isObject(() => {})).toBe(false);
    });
  });

  describe("isNumber", () => {
    it("returns true for finite numbers", () => {
      expect(isNumber(0)).toBe(true);
      expect(isNumber(42)).toBe(true);
      expect(isNumber(-3.14)).toBe(true);
      expect(isNumber(Number.MAX_VALUE)).toBe(true);
    });

    it("returns false for Infinity", () => {
      expect(isNumber(Infinity)).toBe(false);
      expect(isNumber(-Infinity)).toBe(false);
    });

    it("returns false for NaN", () => {
      expect(isNumber(NaN)).toBe(false);
    });

    it("returns false for non-numbers", () => {
      expect(isNumber("42")).toBe(false);
      expect(isNumber(null)).toBe(false);
      expect(isNumber(undefined)).toBe(false);
      expect(isNumber({})).toBe(false);
    });
  });

  describe("isString", () => {
    it("returns true for strings", () => {
      expect(isString("")).toBe(true);
      expect(isString("hello")).toBe(true);
      expect(isString(`template`)).toBe(true);
    });

    it("returns false for non-strings", () => {
      expect(isString(42)).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString(undefined)).toBe(false);
      expect(isString({})).toBe(false);
      expect(isString([])).toBe(false);
    });
  });

  describe("isBoolean", () => {
    it("returns true for booleans", () => {
      expect(isBoolean(true)).toBe(true);
      expect(isBoolean(false)).toBe(true);
    });

    it("returns false for non-booleans", () => {
      expect(isBoolean(0)).toBe(false);
      expect(isBoolean(1)).toBe(false);
      expect(isBoolean("true")).toBe(false);
      expect(isBoolean(null)).toBe(false);
      expect(isBoolean(undefined)).toBe(false);
    });
  });
});
