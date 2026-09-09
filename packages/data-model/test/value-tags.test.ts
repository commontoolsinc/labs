/**
 * The tag vocabulary and each dispatch that answers with it.
 *
 * The fabric-side dispatches take a value already typed as a `FabricValue` or
 * a `FabricPrimitive`, and their cases are about what each declines: a type
 * lie, a class outside the vocabulary, and a primitive whose reported tag is
 * not one the vocabulary holds. One group cross-checks them against the
 * native-side dispatch over the whole corpus, on the values membership
 * accepts, which is where the two are required to agree.
 *
 * The native-side cases classify a value by what it actually is, across the
 * cases where the obvious check fails. A prototype can be severed, an `Error`
 * can arrive from another realm or from a subclass nobody here knows, an
 * array can be an `Array` subclass, and an object can have no prototype at
 * all. Each still has a right answer, so these cases are mostly the awkward
 * shapes rather than the ordinary ones.
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

import {
  BaseFabricPrimitive,
  VALUE_TAG,
} from "@/fabric-bases/BaseFabricPrimitive.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochDay } from "@/fabric-primitives/FabricEpochDay.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { codecClasses } from "@/fabric-primitives/index.ts";
import { FabricKeyPair } from "@/fabric-primitives/FabricKeyPair.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricPrimitive, type FabricValue } from "@/interface.ts";
import {
  isValidFabricNativeObject,
  isValidFabricValueLayer,
} from "@/validity-check.ts";
import {
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
  JS_TYPE_VALUE_TAGS,
  type JsTypeValueTag,
  tagFromFabricPrimitive,
  tagFromFabricPrimitiveElseNull,
  tagFromFabricValue,
  tagFromFabricValueElseNull,
  tagFromNativeBuiltinClassElseNull,
  tagFromNativeValueElseNull,
  VALUE_TAGS,
} from "@/value-tags.ts";
import { LAYER_CORPUS } from "./fabric-value-corpus.ts";

/**
 * A `BaseFabricPrimitive` subclass whose reported tag is one the vocabulary
 * holds, though it is not the class the tag names: the dispatch reads the tag
 * and does not check it against the class.
 */
class TaggedProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return FABRIC_PRIMITIVE_VALUE_TAGS.FabricHash;
  }
}

/** A `BaseFabricPrimitive` subclass reporting a tag the vocabulary lacks. */
class MistaggedProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return "Bogus" as FabricPrimitiveValueTag;
  }
}

/**
 * A `BaseFabricPrimitive` subclass reporting a tag the vocabulary holds but
 * no primitive may report, which the getter's type refuses and a cast lets
 * through.
 */
class NonPrimitiveTagProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return VALUE_TAGS.JsError as FabricPrimitiveValueTag;
  }
}

/** A subclass of a production primitive that supplies no tag of its own. */
class SubBytes extends FabricBytes {}

/**
 * A `BaseFabricPrimitive` subclass reporting a name the vocabulary inherits
 * rather than declares, which a `tag in VALUE_TAGS` test would accept.
 */
class InheritedNameProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return "toString" as FabricPrimitiveValueTag;
  }
}

/** A `BaseFabricPrimitive` subclass reporting something that is no string. */
class UntaggedProbe extends BaseFabricPrimitive {
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return undefined as unknown as FabricPrimitiveValueTag;
  }
}

/**
 * A direct `FabricPrimitive` subclass, bypassing `BaseFabricPrimitive`, which
 * no production class does.
 */
class RoguePrimitive extends FabricPrimitive {}

/** One value of each JS primitive type, labeled, with the tag it takes. */
const JS_PRIMITIVE_TAGS: ReadonlyArray<
  [string, FabricValue, JsTypeValueTag]
> = [
  ["a bigint", 42n, VALUE_TAGS.bigint],
  ["a boolean", true, VALUE_TAGS.boolean],
  ["`null`", null, VALUE_TAGS.null],
  ["a number", 42, VALUE_TAGS.number],
  ["a string", "x", VALUE_TAGS.string],
  ["a symbol", Symbol.for("s"), VALUE_TAGS.symbol],
  ["`undefined`", undefined, VALUE_TAGS.undefined],
];

/**
 * One value of each JS type `typeof` decides, labeled, with the tag it takes:
 * the primitives above, and a function, which is no `FabricValue`.
 */
const JS_TYPE_TAGS: ReadonlyArray<[string, unknown, JsTypeValueTag]> = [
  ...JS_PRIMITIVE_TAGS,
  ["a function", () => {}, VALUE_TAGS.function],
];

/** One instance of each production primitive class, with the tag it carries. */
const FABRIC_PRIMITIVE_TAGS: ReadonlyArray<
  [FabricPrimitive, FabricPrimitiveValueTag]
> = [
  [new FabricBytes(new Uint8Array([1])), VALUE_TAGS.FabricBytes],
  [new FabricEpochDay(0n), VALUE_TAGS.FabricEpochDay],
  [new FabricEpochNsec(0n), VALUE_TAGS.FabricEpochNsec],
  [new FabricHash(new Uint8Array(32), "fid1"), VALUE_TAGS.FabricHash],
  [
    new FabricKeyPair(
      "ExampleAlgorithm",
      new Uint8Array([1]),
      new Uint8Array([2]),
    ),
    VALUE_TAGS.FabricKeyPair,
  ],
  [new FabricRegExp(/a/), VALUE_TAGS.FabricRegExp],
];

describe("value-tags", () => {
  describe("VALUE_TAGS", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(VALUE_TAGS)).toBe(true);
    });

    it("holds every `FabricPrimitive` tag", () => {
      for (const [key, tag] of Object.entries(FABRIC_PRIMITIVE_VALUE_TAGS)) {
        expect(VALUE_TAGS[key as keyof typeof VALUE_TAGS]).toBe(tag);
      }
    });

    it("holds every JS type tag", () => {
      for (const [key, tag] of Object.entries(JS_TYPE_VALUE_TAGS)) {
        expect(VALUE_TAGS[key as keyof typeof VALUE_TAGS]).toBe(tag);
      }
    });

    it("names each tag by its own string", () => {
      // A reported tag is accepted by asking whether the table has it as a
      // key, which holds only while every tag is also a key.

      for (const [key, tag] of Object.entries(VALUE_TAGS)) {
        expect(tag).toBe(key);
      }
    });
  });

  describe("JS_TYPE_VALUE_TAGS", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(JS_TYPE_VALUE_TAGS)).toBe(true);
    });

    for (const [label, value, tag] of JS_TYPE_TAGS) {
      it(`names the tag of ${label} by its \`typeof\` name, or \`null\``, () => {
        expect(tag).toBe((value === null) ? "null" : typeof value);
      });
    }

    it("holds the tag of each JS type and nothing else", () => {
      // The sample table is the domain only while it covers every type, so
      // the two are held equal rather than the table being trusted.

      expect(new Set(JS_TYPE_TAGS.map(([, , tag]) => tag))).toEqual(
        new Set(Object.values(JS_TYPE_VALUE_TAGS)),
      );
    });
  });

  describe("tagFromFabricPrimitive()", () => {
    for (const [value, tag] of FABRIC_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for a \`${value.constructor.name}\``, () => {
        expect(tagFromFabricPrimitive(value)).toBe(tag);
      });
    }

    it("is asked about every registered primitive class", () => {
      // The table above is the domain only while it is the roster, so the two
      // are held equal rather than the table being trusted.

      const tabled = new Set(
        FABRIC_PRIMITIVE_TAGS.map(([value]) => value.constructor),
      );
      expect(tabled).toEqual(new Set(codecClasses()));
    });

    it("returns a distinct tag for each registered primitive class", () => {
      const tags = FABRIC_PRIMITIVE_TAGS.map(([value]) =>
        tagFromFabricPrimitive(value)
      );
      expect(new Set(tags).size).toBe(FABRIC_PRIMITIVE_TAGS.length);
    });

    it("returns every primitive tag across the registered classes", () => {
      // The subset is the roster's tags and nothing else, held from both
      // sides: a tag no class reports, or a class reporting a tag outside
      // the subset, fails here.

      const tags = FABRIC_PRIMITIVE_TAGS.map(([value]) =>
        tagFromFabricPrimitive(value)
      );
      expect(new Set(tags)).toEqual(
        new Set(Object.values(FABRIC_PRIMITIVE_VALUE_TAGS)),
      );
    });

    it("returns the parent's tag for a subclass that supplies none", () => {
      // The getter is inherited like any other member. Whether that is what
      // such a subclass means is the subclass's concern; the dispatch reads
      // what it reports.

      expect(tagFromFabricPrimitive(new SubBytes(new Uint8Array([1]))))
        .toBe(FABRIC_PRIMITIVE_VALUE_TAGS.FabricBytes);
    });

    it("returns the tag a subclass reports, whatever its class", () => {
      expect(tagFromFabricPrimitive(new TaggedProbe())).toBe(
        VALUE_TAGS.FabricHash,
      );
    });

    it("throws for a `FabricPrimitive` that is not a `BaseFabricPrimitive`", () => {
      expect(() => tagFromFabricPrimitive(new RoguePrimitive())).toThrow(
        "Not a valid `FabricPrimitive`",
      );
    });

    it("throws for a reported tag the vocabulary lacks", () => {
      expect(() => tagFromFabricPrimitive(new MistaggedProbe())).toThrow(
        "Not a valid `FabricPrimitive`",
      );
    });

    it("throws for a reported tag outside the primitive subset", () => {
      expect(() => tagFromFabricPrimitive(new NonPrimitiveTagProbe())).toThrow(
        "Not a valid `FabricPrimitive`",
      );
    });

    it("throws for a type lie", () => {
      expect(() => tagFromFabricPrimitive({} as FabricPrimitive)).toThrow(
        "Not a valid `FabricPrimitive`",
      );
    });
  });

  describe("tagFromFabricPrimitiveElseNull()", () => {
    for (const [value, tag] of FABRIC_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for a \`${value.constructor.name}\``, () => {
        expect(tagFromFabricPrimitiveElseNull(value)).toBe(tag);
      });
    }

    it("returns `null` for a `FabricPrimitive` that is not a `BaseFabricPrimitive`", () => {
      expect(tagFromFabricPrimitiveElseNull(new RoguePrimitive())).toBe(null);
    });

    it("returns `null` for a reported tag the vocabulary lacks", () => {
      expect(tagFromFabricPrimitiveElseNull(new MistaggedProbe())).toBe(null);
    });

    it("returns `null` for a reported tag outside the primitive subset", () => {
      // `JsError` is a tag, but not one a primitive may report; a primitive
      // reporting it would otherwise be rebuilt as an error by conversion.

      expect(tagFromFabricPrimitiveElseNull(new NonPrimitiveTagProbe()))
        .toBe(null);
    });

    it("returns `null` for a reported tag that is only an inherited name", () => {
      expect(tagFromFabricPrimitiveElseNull(new InheritedNameProbe())).toBe(
        null,
      );
    });

    it("returns `null` for a reported tag that is no string", () => {
      expect(tagFromFabricPrimitiveElseNull(new UntaggedProbe())).toBe(null);
    });

    it("returns `null` for a type lie", () => {
      expect(tagFromFabricPrimitiveElseNull({} as FabricPrimitive)).toBe(null);
      expect(tagFromFabricPrimitiveElseNull(null as unknown as FabricPrimitive))
        .toBe(null);
    });
  });

  describe("tagFromFabricValue()", () => {
    for (const [label, value, tag] of JS_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for ${label}`, () => {
        expect(tagFromFabricValue(value)).toBe(tag);
      });
    }

    it("returns `Array` for an array", () => {
      expect(tagFromFabricValue([])).toBe(VALUE_TAGS.Array);
      expect(tagFromFabricValue([1, [2]])).toBe(VALUE_TAGS.Array);
    });

    it("returns `Object` for a plain object", () => {
      expect(tagFromFabricValue({})).toBe(VALUE_TAGS.Object);
      expect(tagFromFabricValue({ a: 1 })).toBe(VALUE_TAGS.Object);
    });

    it("returns `Object` for a null-prototype object", () => {
      // The narrowing this rests on asks a shape question rather than the
      // membership one, so a record membership refuses is still an `Object`
      // here. That is the looseness the function's doc comment reserves.

      const obj = Object.create(null) as FabricValue;
      expect(tagFromFabricValue(obj)).toBe(VALUE_TAGS.Object);
    });

    for (const [value, tag] of FABRIC_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for a \`${value.constructor.name}\``, () => {
        expect(tagFromFabricValue(value)).toBe(tag);
      });
    }

    it("returns `FabricInstance` for each `FabricInstance` kind", () => {
      expect(tagFromFabricValue(FabricError.fromNativeError(new Error("x"))))
        .toBe(VALUE_TAGS.FabricInstance);
      expect(tagFromFabricValue(new FabricMap(new Map([["a", 1]]))))
        .toBe(VALUE_TAGS.FabricInstance);
    });

    it("throws for a function", () => {
      expect(() => tagFromFabricValue((() => {}) as unknown as FabricValue))
        .toThrow("Not possibly a valid `FabricValue`");
    });

    it("throws for a class instance outside the vocabulary", () => {
      expect(() => tagFromFabricValue(new Date() as unknown as FabricValue))
        .toThrow("Not possibly a valid `FabricValue`");
      expect(() => tagFromFabricValue(new Map() as unknown as FabricValue))
        .toThrow("Not possibly a valid `FabricValue`");
    });

    it("throws for a primitive whose reported tag the vocabulary lacks", () => {
      expect(() => tagFromFabricValue(new MistaggedProbe())).toThrow(
        "Not possibly a valid `FabricValue`",
      );
    });
  });

  describe("tagFromFabricValueElseNull()", () => {
    for (const [label, value, tag] of JS_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for ${label}`, () => {
        expect(tagFromFabricValueElseNull(value)).toBe(tag);
      });
    }

    it("returns `Array` for an array and `Object` for a plain object", () => {
      expect(tagFromFabricValueElseNull([1])).toBe(VALUE_TAGS.Array);
      expect(tagFromFabricValueElseNull({ a: 1 })).toBe(VALUE_TAGS.Object);
    });

    for (const [value, tag] of FABRIC_PRIMITIVE_TAGS) {
      it(`returns \`${tag}\` for a \`${value.constructor.name}\``, () => {
        expect(tagFromFabricValueElseNull(value)).toBe(tag);
      });
    }

    it("returns `FabricInstance` for a `FabricInstance`", () => {
      expect(
        tagFromFabricValueElseNull(FabricError.fromNativeError(new Error("x"))),
      ).toBe(VALUE_TAGS.FabricInstance);
    });

    it("returns `null` for a function", () => {
      expect(tagFromFabricValueElseNull((() => {}) as unknown as FabricValue))
        .toBe(null);
    });

    it("returns `null` for a class instance outside the vocabulary", () => {
      expect(tagFromFabricValueElseNull(new Date() as unknown as FabricValue))
        .toBe(null);
      expect(tagFromFabricValueElseNull(/x/ as unknown as FabricValue))
        .toBe(null);
    });

    it("returns `null` for a primitive whose reported tag the vocabulary lacks", () => {
      expect(tagFromFabricValueElseNull(new MistaggedProbe())).toBe(null);
      expect(tagFromFabricValueElseNull(new NonPrimitiveTagProbe())).toBe(null);
      expect(tagFromFabricValueElseNull(new RoguePrimitive())).toBe(null);
    });
  });

  describe("the fabric dispatch and the native dispatch", () => {
    // On a value membership accepts, the two dispatches are asked the same
    // question from different sides -- one of a value typed as a `FabricValue`,
    // one of an `unknown` -- and must give the same answer. Where membership
    // refuses a value the fabric dispatch owes nothing, so those are held out
    // rather than asserted either way. The partition is made here so that
    // each assertion below is unconditional.

    const accepted = LAYER_CORPUS
      .filter(([, value]) => isValidFabricValueLayer(value));
    const refused = LAYER_CORPUS
      .filter(([, value]) => !isValidFabricValueLayer(value));

    for (const [label, value] of accepted) {
      it(`tags ${label} the same from either side`, () => {
        const fabric = tagFromFabricValue(value as FabricValue);
        expect(fabric).toBe(tagFromNativeValueElseNull(value));
        expect(fabric).toBe(tagFromFabricValueElseNull(value as FabricValue));
      });
    }

    it("reaches values on both sides of membership", () => {
      expect(accepted.length).toBeGreaterThan(0);
      expect(refused.length).toBeGreaterThan(0);
    });
  });

  describe("tagFromNativeValueElseNull()", () => {
    for (const [label, value, tag] of JS_TYPE_TAGS) {
      it(`returns \`${tag}\` for ${label}`, () => {
        expect(tagFromNativeValueElseNull(value)).toBe(tag);
      });
    }

    it("returns `JsError` tag for standard `Error` subclasses", () => {
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
        expect(tagFromNativeValueElseNull(value)).toBe(VALUE_TAGS.JsError);
      }
    });

    it("returns `JsError` tag for exotic `Error` subclass (custom class)", () => {
      class MyFancyError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = "MyFancyError";
        }
      }
      const exotic = new MyFancyError("exotic");
      // Recognized at the value level: `Error.isError()` reads the internal
      // slot, so an `Error` subclass is tagged before any class is read.
      expect(tagFromNativeValueElseNull(exotic)).toBe(VALUE_TAGS.JsError);
    });

    it("returns `JsError` tag for an `Error` whose prototype was severed", () => {
      const severed = new Error("severed");
      Object.setPrototypeOf(severed, null);

      // No reachable constructor, so the class-level lookup yields nothing and
      // the `Error.isError()` fallback is what recognizes it.
      expect((severed as { constructor?: unknown }).constructor).toBe(
        undefined,
      );
      expect(tagFromNativeValueElseNull(severed)).toBe(VALUE_TAGS.JsError);
    });

    it("returns `Array` tag for an `Array` subclass", () => {
      class MyArray extends Array {}

      expect(tagFromNativeBuiltinClassElseNull(MyArray)).toBe(null);
      expect(tagFromNativeValueElseNull(new MyArray())).toBe(VALUE_TAGS.Array);
    });

    it("returns `Array` tag for an array whose prototype was severed", () => {
      const severed = [1, 2];
      Object.setPrototypeOf(severed, null);

      expect(tagFromNativeValueElseNull(severed)).toBe(VALUE_TAGS.Array);
    });

    it("returns `JsMap` tag for `Map` instances", () => {
      expect(tagFromNativeValueElseNull(new Map())).toBe(VALUE_TAGS.JsMap);
    });

    it("returns `JsSet` tag for `Set` instances", () => {
      expect(tagFromNativeValueElseNull(new Set())).toBe(VALUE_TAGS.JsSet);
    });

    it("returns `JsDate` tag for `Date` instances", () => {
      expect(tagFromNativeValueElseNull(new Date())).toBe(VALUE_TAGS.JsDate);
    });

    it("returns `JsUint8Array` tag for `Uint8Array` instances", () => {
      expect(tagFromNativeValueElseNull(new Uint8Array())).toBe(
        VALUE_TAGS.JsUint8Array,
      );
    });

    it("returns `Object` tag for plain objects", () => {
      expect(tagFromNativeValueElseNull({})).toBe(VALUE_TAGS.Object);
    });

    it("returns `Array` tag for arrays", () => {
      expect(tagFromNativeValueElseNull([])).toBe(VALUE_TAGS.Array);
    });

    it("returns `JsRegExp` tag for `RegExp` instances", () => {
      expect(tagFromNativeValueElseNull(/abc/)).toBe(VALUE_TAGS.JsRegExp);
    });

    it("returns `Object` tag for null-prototype objects (no constructor)", () => {
      const obj = Object.create(null);
      expect(tagFromNativeValueElseNull(obj)).toBe(VALUE_TAGS.Object);
    });

    it("returns `null` for class instances", () => {
      class Custom {}
      expect(tagFromNativeValueElseNull(new Custom())).toBe(null);
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
          expect(tagFromNativeValueElseNull({ constructor: forged, a: 1 }))
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
        expect(tagFromNativeValueElseNull(new Map())).toBe(VALUE_TAGS.JsMap);
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
          expect(tagFromNativeValueElseNull(value)).toBe(VALUE_TAGS.Array);
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
        expect(tagFromNativeValueElseNull({ toJSON: () => "converted" })).toBe(
          VALUE_TAGS.Object,
        );
      });

      it("returns `Array` tag for an array carrying an own `toJSON()`", () => {
        const arr = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
        arr.toJSON = () => "custom array";
        expect(tagFromNativeValueElseNull(arr)).toBe(VALUE_TAGS.Array);
      });

      it("returns `Array` tag despite an inherited `toJSON()`", () => {
        const proto = Array.prototype as unknown as Record<string, unknown>;
        try {
          proto.toJSON = () => "hijacked";
          const arr = [1, 2];
          expect(Object.hasOwn(arr, "toJSON")).toBe(false);
          expect(tagFromNativeValueElseNull(arr)).toBe(VALUE_TAGS.Array);
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
        expect(tagFromNativeValueElseNull(new ProtoJson())).toBe(
          VALUE_TAGS.Array,
        );
      });

      it("returns `null` for a class instance carrying `toJSON()`", () => {
        class Custom {
          toJSON() {
            return { x: 1 };
          }
        }
        expect(tagFromNativeValueElseNull(new Custom())).toBe(null);
      });

      it("returns `function` for a function carrying `toJSON()`", () => {
        const fn = Object.assign(() => {}, { toJSON: () => "converted" });
        expect(tagFromNativeValueElseNull(fn)).toBe(VALUE_TAGS.function);
      });
    });
  });

  describe("tagFromNativeBuiltinClassElseNull()", () => {
    it("returns `JsError` tag for standard `Error` constructors", () => {
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
        expect(tagFromNativeBuiltinClassElseNull(ctor)).toBe(
          VALUE_TAGS.JsError,
        );
      }
    });

    it("returns `JsError` tag for exotic `Error` subclass constructor", () => {
      class ExoticError extends Error {}
      // Not in the switch, so the default arm's `prototype instanceof Error`
      // is what recognizes it.
      expect(tagFromNativeBuiltinClassElseNull(ExoticError)).toBe(
        VALUE_TAGS.JsError,
      );
    });

    it("returns correct tags for `Array`, `Object`, `Map`, `Set`, `Date`, `Uint8Array`", () => {
      expect(tagFromNativeBuiltinClassElseNull(Array)).toBe(VALUE_TAGS.Array);
      expect(tagFromNativeBuiltinClassElseNull(Object)).toBe(VALUE_TAGS.Object);
      expect(tagFromNativeBuiltinClassElseNull(Map)).toBe(VALUE_TAGS.JsMap);
      expect(tagFromNativeBuiltinClassElseNull(Set)).toBe(VALUE_TAGS.JsSet);
      expect(tagFromNativeBuiltinClassElseNull(Date)).toBe(VALUE_TAGS.JsDate);
      expect(tagFromNativeBuiltinClassElseNull(Uint8Array)).toBe(
        VALUE_TAGS.JsUint8Array,
      );
    });

    it("returns `JsRegExp` tag for `RegExp` constructor", () => {
      expect(tagFromNativeBuiltinClassElseNull(RegExp)).toBe(
        VALUE_TAGS.JsRegExp,
      );
    });

    it("returns `null` for unrecognized constructors", () => {
      expect(tagFromNativeBuiltinClassElseNull(WeakMap)).toBe(null);
      expect(tagFromNativeBuiltinClassElseNull(Promise)).toBe(null);
    });

    it("returns `null` for a plain class", () => {
      class Plain {}
      expect(tagFromNativeBuiltinClassElseNull(Plain)).toBe(null);
    });

    describe("`toJSON()` is intentionally not supported", () => {
      it("returns `null` for a class with `toJSON` on its prototype", () => {
        class WithToJSON {
          toJSON() {
            return { x: 1 };
          }
        }
        expect(tagFromNativeBuiltinClassElseNull(WithToJSON)).toBe(null);
      });

      it("returns `null` for a subclass inheriting `toJSON`", () => {
        class Base {
          toJSON() {
            return "base";
          }
        }
        class Sub extends Base {}
        expect(tagFromNativeBuiltinClassElseNull(Sub)).toBe(null);
      });

      it("returns `JsDate` tag for `Date`, whose `toJSON` is not consulted", () => {
        expect(tagFromNativeBuiltinClassElseNull(Date)).toBe(VALUE_TAGS.JsDate);
      });
    });
  });

  describe("the value dispatch and the builtin class lookup", () => {
    // `tagFromNativeValueElseNull()` ends at
    // `tagFromNativeBuiltinClassElseNull()`, asked of the value's class, once
    // the array, error, and fabric tests ahead of it have declined. So a value
    // none of those claim, and whose class that lookup recognizes, gets that
    // lookup's tag; and a fabric primitive gets the tag its instance carries,
    // its class being one the builtin lookup declines. An array or an error is
    // decided before its class is read, and where the two would disagree -- an
    // array whose prototype is `Date.prototype` -- the value rule wins; the
    // `tagFromNativeValueElseNull()` group above holds those. The corpus holds
    // every kind, and it is partitioned here rather than inside a test so that
    // each assertion below is unconditional: a test that only asserts on one
    // side of an `if` skips the case it was written for.

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
        (tagFromNativeBuiltinClassElseNull(ctor) !== null)
      );

    for (const [label, value, ctor] of builtinBacked) {
      it(`tags ${label} as the builtin lookup tags its class`, () => {
        expect(tagFromNativeValueElseNull(value)).toBe(
          tagFromNativeBuiltinClassElseNull(ctor),
        );
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
          expect(tagFromNativeBuiltinClassElseNull(ctor)).toBe(null);
          expect(tagFromNativeValueElseNull(value)).not.toBe(null);
          expect(tagFromNativeValueElseNull(value))
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
