/**
 * Classifying a native value by what it actually is, across the cases where
 * the obvious check fails.
 *
 * A prototype can be severed, an `Error` can arrive from another realm or from
 * a subclass nobody here knows, an array can be an `Array` subclass, and an
 * object can have no prototype at all. Each still has a right answer, so these
 * cases are mostly the awkward shapes rather than the ordinary ones.
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
import { tagFromNativeValue } from "@/tag-from.ts";
import { isValidFabricNativeObject } from "@/validity-check.ts";
import {
  tagFromFabricPrimitive,
  tagFromNativeBuiltinClass,
} from "@/tag-from.ts";
import { FabricPrimitive } from "@/interface.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochDay } from "@/fabric-primitives/FabricEpochDay.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricKeyPair } from "@/fabric-primitives/FabricKeyPair.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { LAYER_CORPUS } from "./fabric-value-corpus.ts";

describe("tag-from", () => {
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
      // Recognized at the value level: `Error.isError()` reads the internal
      // slot, so an `Error` subclass is tagged before any class is read.
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

      expect(tagFromNativeBuiltinClass(MyArray)).toBe(null);
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

    describe("an array is decided by the array rule, whatever its prototype", () => {
      // A prototype can be re-pointed, so "an array's class is `Array`" is only
      // usually true. `Array.isArray()` is what is actually true of every array,
      // and it is why the array rule runs before any class is consulted -- in
      // both dispatches, since either one reporting an array as a convertible
      // `Date` would be a walk rebuilding it as one.
      for (
        const [label, value] of [
          ["an ordinary array", [1, 2]],
          [
            "an array whose `prototype` is `Date.prototype`",
            Object.setPrototypeOf([1, 2], Date.prototype),
          ],
          [
            "an array whose `prototype` is `Map.prototype`",
            Object.setPrototypeOf([1, 2], Map.prototype),
          ],
          [
            "an array whose prototype was severed",
            Object.setPrototypeOf([1, 2], null),
          ],
        ] as ReadonlyArray<[string, unknown]>
      ) {
        it(`tags ${label} \`Array\``, () => {
          expect(tagFromNativeValue(value)).toBe(VALUE_TAGS.Array);
        });

        it(`reports ${label} as no \`FabricNativeObject\``, () => {
          expect(isValidFabricNativeObject(value)).toBe(false);
        });
      }
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

  describe("tagFromNativeBuiltinClass()", () => {
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
        expect(tagFromNativeBuiltinClass(ctor)).toBe(VALUE_TAGS.Error);
      }
    });

    it("returns `Error` tag for exotic `Error` subclass constructor", () => {
      class ExoticError extends Error {}
      // Not in the switch, so the default arm's `prototype instanceof Error`
      // is what recognizes it.
      expect(tagFromNativeBuiltinClass(ExoticError)).toBe(VALUE_TAGS.Error);
    });

    it("returns correct tags for `Array`, `Object`, `Map`, `Set`, `Date`, `Uint8Array`", () => {
      expect(tagFromNativeBuiltinClass(Array)).toBe(VALUE_TAGS.Array);
      expect(tagFromNativeBuiltinClass(Object)).toBe(VALUE_TAGS.Object);
      expect(tagFromNativeBuiltinClass(Map)).toBe(VALUE_TAGS.Map);
      expect(tagFromNativeBuiltinClass(Set)).toBe(VALUE_TAGS.Set);
      expect(tagFromNativeBuiltinClass(Date)).toBe(VALUE_TAGS.Date);
      expect(tagFromNativeBuiltinClass(Uint8Array)).toBe(VALUE_TAGS.Uint8Array);
    });

    it("returns `RegExp` tag for `RegExp` constructor", () => {
      expect(tagFromNativeBuiltinClass(RegExp)).toBe(VALUE_TAGS.RegExp);
    });

    it("returns `null` for unrecognized constructors", () => {
      expect(tagFromNativeBuiltinClass(WeakMap)).toBe(null);
      expect(tagFromNativeBuiltinClass(Promise)).toBe(null);
    });

    it("returns `null` for a plain class", () => {
      class Plain {}
      expect(tagFromNativeBuiltinClass(Plain)).toBe(null);
    });

    describe("`toJSON()` is intentionally not supported", () => {
      it("returns `null` for a class with `toJSON` on its prototype", () => {
        class WithToJSON {
          toJSON() {
            return { x: 1 };
          }
        }
        expect(tagFromNativeBuiltinClass(WithToJSON)).toBe(null);
      });

      it("returns `null` for a subclass inheriting `toJSON`", () => {
        class Base {
          toJSON() {
            return "base";
          }
        }
        class Sub extends Base {}
        expect(tagFromNativeBuiltinClass(Sub)).toBe(null);
      });

      it("returns `Date` tag for `Date`, whose `toJSON` is not consulted", () => {
        expect(tagFromNativeBuiltinClass(Date)).toBe(VALUE_TAGS.Date);
      });
    });
  });

  describe("the value dispatch and the builtin class lookup", () => {
    // `tagFromNativeValue()` ends at `tagFromNativeBuiltinClass()`, asked of
    // the value's class, once the array, error, and fabric tests ahead of it
    // have declined. So a value none of those claim, and whose class that
    // lookup recognizes, gets that lookup's tag; and a fabric primitive gets
    // the tag its instance carries, its class being one the builtin lookup
    // declines. An array or an error is decided before its class is read,
    // and where the two would disagree -- an array whose prototype is
    // `Date.prototype` -- the value rule wins; the `tagFromNativeValue()`
    // group above holds those. The corpus holds every kind, and it is
    // partitioned here rather than inside a test so that each assertion
    // below is unconditional: a test that only asserts on one side of an
    // `if` skips the case it was written for.

    const fabricClasses = [
      FabricBytes,
      FabricEpochDay,
      FabricEpochNsec,
      FabricHash,
      FabricKeyPair,
      FabricRegExp,
    ];

    const objects = LAYER_CORPUS
      .filter(([, value]) => (value !== null) && (typeof value === "object"))
      .map(([label, value]) =>
        [
          label,
          value,
          Object.getPrototypeOf(value as object)?.constructor,
        ] as const
      );

    const decidedAhead = objects
      .filter(([, value]) => Array.isArray(value) || Error.isError(value));

    const builtinBacked = objects
      .filter(([, value, ctor]) =>
        !(Array.isArray(value) || Error.isError(value)) &&
        (typeof ctor === "function") &&
        (tagFromNativeBuiltinClass(ctor) !== null)
      );

    for (const [label, value, ctor] of builtinBacked) {
      it(`tags ${label} as the builtin lookup tags its class`, () => {
        expect(tagFromNativeValue(value)).toBe(tagFromNativeBuiltinClass(ctor));
      });
    }

    for (const cls of fabricClasses) {
      it(`tags a \`${cls.name}\` by its instance, its class unrecognized`, () => {
        // Asserted against the fabric classes by name rather than against
        // whatever the builtin lookup happens to decline, so a class the
        // corpus stopped carrying is a failure here rather than a silence.
        const carried = objects.filter(([, value]) => value instanceof cls);
        expect(carried.length).toBeGreaterThan(0);
        for (const [, value, ctor] of carried) {
          expect(tagFromNativeBuiltinClass(ctor)).toBe(null);
          expect(tagFromNativeValue(value)).not.toBe(null);
          expect(tagFromNativeValue(value))
            .toBe(tagFromFabricPrimitive(value as FabricPrimitive));
        }
      });
    }

    it("reaches values on every side of the split", () => {
      expect(decidedAhead.length).toBeGreaterThan(0);
      expect(builtinBacked.length).toBeGreaterThan(0);
      expect(fabricClasses.length).toBeGreaterThan(0);
    });
  });
});
