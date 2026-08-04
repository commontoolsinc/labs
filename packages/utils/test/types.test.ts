import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isBoolean,
  isFiniteNumber,
  isFunction,
  isInstance,
  isNumber,
  isObject,
  isPlainContainer,
  isPlainObject,
  isReadonlyRecord,
  isRecord,
  isString,
  isUnsafeObjectKey,
  Mutable,
  unsafeObjectKeyIn,
} from "@commonfabric/utils/types";

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

  describe("isReadonlyRecord", () => {
    it("returns true for frozen records", () => {
      expect(isReadonlyRecord(Object.freeze({ a: 1 }))).toBe(true);
    });

    it("has the same runtime domain as isRecord", () => {
      for (
        const value of [
          {},
          [],
          new Date(),
          null,
          undefined,
          42,
          "string",
          true,
          Symbol("test"),
          () => {},
        ]
      ) {
        expect(isReadonlyRecord(value)).toBe(isRecord(value));
      }
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

  describe("isPlainObject", () => {
    it("returns true for object literals", () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
      expect(isPlainObject(new Object())).toBe(true);
    });

    it("returns true for null-prototype objects", () => {
      expect(isPlainObject(Object.create(null))).toBe(true);
    });

    it("excludes null-prototype objects when asked to", () => {
      // The narrower question -- "is this rooted at `Object.prototype`?" --
      // for a caller to which a null-prototype object is not merely a
      // different shape but something it must not treat as a record.
      expect(isPlainObject(Object.create(null), false)).toBe(false);
      expect(isPlainObject(Object.create(null), true)).toBe(true);
    });

    it("answers the same either way for everything else", () => {
      class MyClass {}
      for (const value of [{}, { a: 1 }, [], new Date(), new MyClass(), null]) {
        expect(isPlainObject(value, false)).toBe(isPlainObject(value, true));
      }
    });

    it("returns false for arrays and class instances", () => {
      class MyClass {}
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject([1, 2, 3])).toBe(false);
      expect(isPlainObject(new Date())).toBe(false);
      expect(isPlainObject(new Map())).toBe(false);
      expect(isPlainObject(/regex/)).toBe(false);
      expect(isPlainObject(new MyClass())).toBe(false);
      expect(isPlainObject(Object.create({}))).toBe(false);
    });

    it("returns false for null, primitives, and functions", () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
      expect(isPlainObject(42)).toBe(false);
      expect(isPlainObject("string")).toBe(false);
      expect(isPlainObject(true)).toBe(false);
      expect(isPlainObject(Symbol("test"))).toBe(false);
      expect(isPlainObject(() => {})).toBe(false);
    });
  });

  describe("isPlainContainer", () => {
    it("returns true for plain objects", () => {
      expect(isPlainContainer({})).toBe(true);
      expect(isPlainContainer({ a: 1 })).toBe(true);
      expect(isPlainContainer(new Object())).toBe(true);
    });

    it("returns true for null-prototype objects", () => {
      expect(isPlainContainer(Object.create(null))).toBe(true);
    });

    it("returns true for arrays", () => {
      expect(isPlainContainer([])).toBe(true);
      expect(isPlainContainer([1, 2, 3])).toBe(true);
      // Sparse arrays.
      // deno-lint-ignore no-sparse-arrays
      expect(isPlainContainer([1, , 3])).toBe(true);
      // Frozen arrays.
      expect(isPlainContainer(Object.freeze([]))).toBe(true);
    });

    it("returns true for frozen plain objects", () => {
      expect(isPlainContainer(Object.freeze({}))).toBe(true);
      expect(isPlainContainer(Object.freeze({ a: 1 }))).toBe(true);
    });

    it("returns false for class instances", () => {
      class MyClass {}
      expect(isPlainContainer(new MyClass())).toBe(false);
      expect(isPlainContainer(new Date())).toBe(false);
      expect(isPlainContainer(new Map())).toBe(false);
      expect(isPlainContainer(new Set())).toBe(false);
      expect(isPlainContainer(new Error("x"))).toBe(false);
      expect(isPlainContainer(/regex/)).toBe(false);
    });

    it("returns false for objects with a non-Object/non-null prototype", () => {
      // `Object.create({})` produces an object whose prototype is another
      // plain object, which puts it outside the "plain" definition.
      expect(isPlainContainer(Object.create({}))).toBe(false);
    });

    it("returns false for null, primitives, and functions", () => {
      expect(isPlainContainer(null)).toBe(false);
      expect(isPlainContainer(undefined)).toBe(false);
      expect(isPlainContainer(42)).toBe(false);
      expect(isPlainContainer(42n)).toBe(false);
      expect(isPlainContainer("string")).toBe(false);
      expect(isPlainContainer(true)).toBe(false);
      expect(isPlainContainer(Symbol("test"))).toBe(false);
      expect(isPlainContainer(() => {})).toBe(false);
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
      expect(isFiniteNumber(Infinity)).toBe(false);
      expect(isFiniteNumber(-Infinity)).toBe(false);
    });

    it("returns false for NaN", () => {
      expect(isFiniteNumber(NaN)).toBe(false);
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

  describe("isUnsafeObjectKey", () => {
    it("returns true for prototype-pollution keys", () => {
      expect(isUnsafeObjectKey("__proto__")).toBe(true);
      expect(isUnsafeObjectKey("constructor")).toBe(true);
    });

    it("returns false for ordinary keys", () => {
      expect(isUnsafeObjectKey("id")).toBe(false);
      expect(isUnsafeObjectKey("space")).toBe(false);
      expect(isUnsafeObjectKey("path")).toBe(false);
      expect(isUnsafeObjectKey("")).toBe(false);
    });

    it("returns false for near-miss keys that are not in the set", () => {
      // Only `__proto__` and `constructor` are unsafe — not every
      // prototype-adjacent name.
      expect(isUnsafeObjectKey("prototype")).toBe(false);
      expect(isUnsafeObjectKey("proto")).toBe(false);
      expect(isUnsafeObjectKey("toString")).toBe(false);
      expect(isUnsafeObjectKey("hasOwnProperty")).toBe(false);
    });

    it("is backstopped by the runtime keeping `__proto__` inert", () => {
      // Deno neutralises `__proto__`: assigning it lands a plain own property
      // and leaves the prototype alone. That is the layer beneath
      // isUnsafeObjectKey(), which filters the key at trust boundaries.
      const target: Record<string, unknown> = {};
      const untrustedKey = "__proto__";
      try {
        target[untrustedKey] = { polluted: true };
        expect(Object.hasOwn(target, untrustedKey)).toBe(true);
        expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
      } catch (e) {
        console.error(
          "This runtime lets a `__proto__` assignment reach the prototype " +
            "chain. Whoever rolled the Deno version that changed this must " +
            "investigate the security implications: every place that copies " +
            "untrusted keys onto an object without filtering them through " +
            "isUnsafeObjectKey() is now open to prototype pollution.",
        );
        throw e;
      }
    });
  });

  describe("unsafeObjectKeyIn", () => {
    it("returns the offending name for a reserved own key", () => {
      const withProto = { other: 1 } as Record<string, unknown>;
      Object.defineProperty(withProto, "__proto__", {
        value: 1,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(unsafeObjectKeyIn(withProto)).toBe("__proto__");
      expect(unsafeObjectKeyIn({ ["constructor"]: 1 })).toBe("constructor");
    });

    it("returns `undefined` for ordinary objects", () => {
      expect(unsafeObjectKeyIn({})).toBe(undefined);
      expect(unsafeObjectKeyIn({ a: 1, prototype: 2, toString: 3 })).toBe(
        undefined,
      );
    });

    it("returns `undefined` for an inherited reserved name", () => {
      // Every object inherits `constructor`, and most inherit `__proto__`.
      // Only an OWN property is the value's own data, and only that can fail
      // to survive a copy.
      expect(unsafeObjectKeyIn(Object.create({ constructor: 1 }))).toBe(
        undefined,
      );
    });

    it("is needed because assignment loses the key where the accessor is standard", () => {
      // The companion to the `__proto__`-is-inert test above, from the other
      // side. Deno neutralises the accessor, so a copy loop there is safe and
      // no test can see the hazard. A realm that keeps the accessor -- every
      // browser, and this repo ships `data-model` to browsers -- loses the
      // property and mutates the copy instead. That is what makes these names
      // uncarryable HERE, and the day no realm behaves this way is the day the
      // restriction can go.
      const saved = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "__proto__",
      );
      try {
        Object.defineProperty(Object.prototype, "__proto__", {
          configurable: true,
          get(this: object) {
            return Object.getPrototypeOf(this);
          },
          set(this: object, v: unknown) {
            // Spec-faithful: the setter is a no-op unless the value is an
            // object or `null`. A primitive-valued `__proto__` assignment
            // silently does nothing at all -- the key is still lost, but the
            // prototype is untouched.
            if ((typeof v === "object") || (typeof v === "function")) {
              Object.setPrototypeOf(this, v as object | null);
            }
          },
        });

        const copy: Record<string, unknown> = {};
        copy["__proto__"] = { marker: true };

        expect(Object.hasOwn(copy, "__proto__")).toBe(false);
        expect(Object.getPrototypeOf(copy)).not.toBe(Object.prototype);

        // A primitive value loses the key without touching the prototype:
        // the same data loss, a quieter failure.
        const primitive: Record<string, unknown> = {};
        primitive["__proto__"] = "payload";
        expect(Object.hasOwn(primitive, "__proto__")).toBe(false);
        expect(Object.getPrototypeOf(primitive)).toBe(Object.prototype);
      } finally {
        if (saved === undefined) {
          delete (Object.prototype as Record<string, unknown>)["__proto__"];
        } else {
          Object.defineProperty(Object.prototype, "__proto__", saved);
        }
      }
    });
  });
});
