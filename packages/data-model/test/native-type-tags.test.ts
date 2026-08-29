/**
 * Classifying a native value by what it actually is, across the cases where
 * the obvious check fails.
 *
 * A prototype can be severed, an `Error` can arrive from another realm or from
 * a subclass nobody here knows, an array can be an `Array` subclass, and an
 * object can have no prototype at all. Each still has a right answer, so these
 * cases are mostly the awkward shapes rather than the ordinary ones --
 * including a run with `Error.isError` removed, to reach the fallback beneath
 * it.
 *
 * One group pins where the class is read FROM: a value's own `constructor`
 * property is data, and must not be able to present a plain record as an
 * `Error`. Another pins something the classifier deliberately does not do:
 * `toJSON()` has no bearing on what a value is. An object carrying one is
 * still an object and a class instance carrying one is still unrecognized,
 * whether the member is own or inherited.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { VALUE_TAGS } from "@/VALUE_TAGS.ts";
import {
  isNativeError,
  tagFromNativeClass,
  tagFromNativeValue,
} from "@/native-type-tags.ts";
import { isValidFabricNativeObject } from "@/type-check.ts";
import { tagFromNativeBuiltinClass } from "@/tagFromNativeBuiltinClass.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochDay } from "@/fabric-primitives/FabricEpochDay.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricKeyPair } from "@/fabric-primitives/FabricKeyPair.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { LAYER_CORPUS } from "./fabric-value-corpus.ts";

describe("native-type-tags", () => {
  describe("tagFromNativeValue()", () => {
    it("returns `Error` tag for standard `Error` subclasses", () => {
      const cases: [string, Error][] = [
        ["Error", new Error("test")],
        ["TypeError", new TypeError("test")],
        ["RangeError", new RangeError("test")],
        ["SyntaxError", new SyntaxError("test")],
        ["ReferenceError", new ReferenceError("test")],
        ["URIError", new URIError("test")],
        ["EvalError", new EvalError("test")],
      ];
      for (const [_name, value] of cases) {
        expect(tagFromNativeValue(value)).toBe(VALUE_TAGS.Error);
      }
    });

    it("returns `Error` tag for exotic `Error` subclass (custom class)", () => {
      class MyFancyError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = "MyFancyError";
        }
      }
      const exotic = new MyFancyError("exotic");
      // Recognized by class: `tagFromNativeClass()` walks the prototype chain,
      // so an `Error` subclass is tagged without reaching the value-level
      // fallbacks below.
      expect(tagFromNativeValue(exotic)).toBe(VALUE_TAGS.Error);
    });

    it("returns `Error` tag for an `Error` whose prototype was severed", () => {
      const severed = new Error("severed");
      Object.setPrototypeOf(severed, null);

      // No reachable constructor, so the class-level lookup yields nothing and
      // the `Error.isError()` fallback is what recognizes it.
      expect((severed as { constructor?: unknown }).constructor).toBe(
        undefined,
      );
      expect(tagFromNativeValue(severed)).toBe(VALUE_TAGS.Error);
    });

    it("returns `Array` tag for an `Array` subclass", () => {
      class MyArray extends Array {}

      expect(tagFromNativeClass(MyArray)).toBe(null);
      expect(tagFromNativeValue(new MyArray())).toBe(VALUE_TAGS.Array);
    });

    it("returns `Array` tag for an array whose prototype was severed", () => {
      const severed = [1, 2];
      Object.setPrototypeOf(severed, null);

      expect(tagFromNativeValue(severed)).toBe(VALUE_TAGS.Array);
    });

    it("returns `Map` tag for `Map` instances", () => {
      expect(tagFromNativeValue(new Map())).toBe(VALUE_TAGS.Map);
    });

    it("returns `Set` tag for `Set` instances", () => {
      expect(tagFromNativeValue(new Set())).toBe(VALUE_TAGS.Set);
    });

    it("returns `Date` tag for `Date` instances", () => {
      expect(tagFromNativeValue(new Date())).toBe(VALUE_TAGS.Date);
    });

    it("returns `Uint8Array` tag for `Uint8Array` instances", () => {
      expect(tagFromNativeValue(new Uint8Array())).toBe(
        VALUE_TAGS.Uint8Array,
      );
    });

    it("returns `Object` tag for plain objects", () => {
      expect(tagFromNativeValue({})).toBe(VALUE_TAGS.Object);
    });

    it("returns `Array` tag for arrays", () => {
      expect(tagFromNativeValue([])).toBe(VALUE_TAGS.Array);
    });

    it("returns `RegExp` tag for `RegExp` instances", () => {
      expect(tagFromNativeValue(/abc/)).toBe(VALUE_TAGS.RegExp);
    });

    it("returns `Object` tag for null-prototype objects (no constructor)", () => {
      const obj = Object.create(null);
      expect(tagFromNativeValue(obj)).toBe(VALUE_TAGS.Object);
    });

    it("classifies values when `Error.isError` is unavailable", () => {
      const descriptor = Object.getOwnPropertyDescriptor(Error, "isError");
      Object.defineProperty(Error, "isError", {
        value: undefined,
        writable: true,
        configurable: true,
      });

      try {
        expect(isNativeError(new Error("test"))).toBe(true);
        expect(tagFromNativeValue(Object.create(null))).toBe(
          VALUE_TAGS.Object,
        );
      } finally {
        if (descriptor) {
          Object.defineProperty(Error, "isError", descriptor);
        } else {
          delete (Error as { isError?: unknown }).isError;
        }
      }
    });

    it("returns `null` for class instances", () => {
      class Custom {}
      expect(tagFromNativeValue(new Custom())).toBe(null);
    });

    it("returns `Primitive` for functions", () => {
      expect(tagFromNativeValue(() => {})).toBe(VALUE_TAGS.Primitive);
    });

    describe("an own `constructor` property does not decide the class", () => {
      // An own `constructor` property is ordinary data that happens to share a
      // name with the thing that decides a value's class. Reading the class off
      // the value rather than off its prototype would let a plain record present
      // itself as an `Error` -- and be rebuilt as one, by a conversion doing
      // exactly what it was told.
      for (
        const [label, forged] of [
          ["`Error`", Error],
          ["`Map`", Map],
          ["`Date`", Date],
          ["`Uint8Array`", Uint8Array],
        ] as ReadonlyArray<[string, unknown]>
      ) {
        it(`returns \`Object\` for a record claiming ${label}`, () => {
          expect(tagFromNativeValue({ constructor: forged, a: 1 }))
            .toBe(VALUE_TAGS.Object);
        });

        it(`returns \`false\` from the membership check for one claiming ${label}`, () => {
          expect(isValidFabricNativeObject({ constructor: forged, a: 1 }))
            .toBe(false);
        });
      }

      it("reads an inherited `constructor`, which is the real one", () => {
        // The counterpart: what the prototype says IS the answer, so a value
        // whose class is reachable only through its prototype is tagged by it.
        expect(tagFromNativeValue(new Map())).toBe(VALUE_TAGS.Map);
        expect(isValidFabricNativeObject(new Map())).toBe(true);
      });
    });

    describe("`toJSON()` is intentionally not supported", () => {
      // `toJSON` is an ordinary property name here, with no say in what a value
      // is. These pin that at each of the shapes it can be carried on, because a
      // classifier that consulted it would let one assignment --
      // `Array.prototype.toJSON`, an own key on a record -- redirect values
      // wholesale.
      it("returns `Object` tag for a plain object carrying `toJSON()`", () => {
        expect(tagFromNativeValue({ toJSON: () => "converted" })).toBe(
          VALUE_TAGS.Object,
        );
      });

      it("returns `Array` tag for an array carrying an own `toJSON()`", () => {
        const arr = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
        arr.toJSON = () => "custom array";
        expect(tagFromNativeValue(arr)).toBe(VALUE_TAGS.Array);
      });

      it("returns `Array` tag despite an inherited `toJSON()`", () => {
        const proto = Array.prototype as unknown as Record<string, unknown>;
        try {
          proto.toJSON = () => "hijacked";
          const arr = [1, 2];
          expect(Object.hasOwn(arr, "toJSON")).toBe(false);
          expect(tagFromNativeValue(arr)).toBe(VALUE_TAGS.Array);
        } finally {
          delete proto.toJSON;
        }
      });

      it("returns `Array` tag for an `Array` subclass carrying `toJSON()`", () => {
        class ProtoJson extends Array {
          toJSON(): unknown[] {
            return [7, 8];
          }
        }
        expect(tagFromNativeValue(new ProtoJson())).toBe(VALUE_TAGS.Array);
      });

      it("returns `null` for a class instance carrying `toJSON()`", () => {
        class Custom {
          toJSON() {
            return { x: 1 };
          }
        }
        expect(tagFromNativeValue(new Custom())).toBe(null);
      });

      it("returns `Primitive` for a function carrying `toJSON()`", () => {
        const fn = Object.assign(() => {}, { toJSON: () => "converted" });
        expect(tagFromNativeValue(fn)).toBe(VALUE_TAGS.Primitive);
      });
    });
  });

  describe("tagFromNativeClass()", () => {
    it("returns `Error` tag for standard `Error` constructors", () => {
      const constructors = [
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        ReferenceError,
        URIError,
        EvalError,
      ];
      for (const ctor of constructors) {
        expect(tagFromNativeClass(ctor)).toBe(VALUE_TAGS.Error);
      }
    });

    it("returns `Error` tag for exotic `Error` subclass constructor", () => {
      class ExoticError extends Error {}
      // Constructor is ExoticError, not in the switch -- falls back to
      // Error.isError(prototype) check.
      expect(tagFromNativeClass(ExoticError)).toBe(VALUE_TAGS.Error);
    });

    it("returns correct tags for `Array`, `Object`, `Map`, `Set`, `Date`, `Uint8Array`", () => {
      expect(tagFromNativeClass(Array)).toBe(VALUE_TAGS.Array);
      expect(tagFromNativeClass(Object)).toBe(VALUE_TAGS.Object);
      expect(tagFromNativeClass(Map)).toBe(VALUE_TAGS.Map);
      expect(tagFromNativeClass(Set)).toBe(VALUE_TAGS.Set);
      expect(tagFromNativeClass(Date)).toBe(VALUE_TAGS.Date);
      expect(tagFromNativeClass(Uint8Array)).toBe(VALUE_TAGS.Uint8Array);
    });

    it("returns `RegExp` tag for `RegExp` constructor", () => {
      expect(tagFromNativeClass(RegExp)).toBe(VALUE_TAGS.RegExp);
    });

    it("returns `null` for unrecognized constructors", () => {
      expect(tagFromNativeClass(WeakMap)).toBe(null);
      expect(tagFromNativeClass(Promise)).toBe(null);
    });

    it("returns `null` for a plain class", () => {
      class Plain {}
      expect(tagFromNativeClass(Plain)).toBe(null);
    });

    describe("`toJSON()` is intentionally not supported", () => {
      it("returns `null` for a class with `toJSON` on its prototype", () => {
        class WithToJSON {
          toJSON() {
            return { x: 1 };
          }
        }
        expect(tagFromNativeClass(WithToJSON)).toBe(null);
      });

      it("returns `null` for a subclass inheriting `toJSON`", () => {
        class Base {
          toJSON() {
            return "base";
          }
        }
        class Sub extends Base {}
        expect(tagFromNativeClass(Sub)).toBe(null);
      });

      it("returns `Date` tag for `Date`, whose `toJSON` is not consulted", () => {
        expect(tagFromNativeClass(Date)).toBe(VALUE_TAGS.Date);
      });
    });
  });

  describe("the builtin lookup and the full class lookup", () => {
    // `tagFromNativeClass()` asks `tagFromNativeBuiltinClass()` first and its
    // own switch second, which is only sound because no class is answered by
    // both. Were one in both, the delegation order would silently decide its
    // tag -- and the builtin lookup's own fallback, which claims any `Error`
    // subclass, would reach a fabric class that happened to be one.
    const fabricClasses = [
      FabricBytes,
      FabricEpochDay,
      FabricEpochNsec,
      FabricHash,
      FabricKeyPair,
      FabricRegExp,
    ];

    const constructors = LAYER_CORPUS
      .filter(([, value]) => (value !== null) && (typeof value === "object"))
      .map(([label, value]) =>
        [label, Object.getPrototypeOf(value as object)?.constructor] as const
      )
      .filter(([, ctor]) => typeof ctor === "function");

    // Partitioned here rather than inside a test, so that each assertion below
    // is unconditional: a test that only asserts on one side of an `if` skips
    // the case it was written for.
    const builtinBacked = constructors
      .filter(([, ctor]) => tagFromNativeBuiltinClass(ctor) !== null);

    for (const [label, ctor] of builtinBacked) {
      it(`passes ${label} through the delegation unchanged`, () => {
        expect(tagFromNativeClass(ctor)).toBe(tagFromNativeBuiltinClass(ctor));
      });
    }

    for (const cls of fabricClasses) {
      it(`leaves \`${cls.name}\` to the fabric switch`, () => {
        // The disjointness the delegation rests on, asserted against the
        // fabric classes by name rather than against whatever the builtin
        // lookup happens to decline.
        expect(tagFromNativeBuiltinClass(cls)).toBe(null);
        expect(tagFromNativeClass(cls)).not.toBe(null);
      });
    }

    it("reaches classes on both sides of the split", () => {
      expect(builtinBacked.length).toBeGreaterThan(0);
      expect(fabricClasses.length).toBeGreaterThan(0);
    });
  });
});
