/**
 * The tag vocabulary -- the names a dispatch returns when asked what a value
 * already is -- and the dispatches that return them, one per kind of value a
 * caller can be holding.
 *
 * Which classes a given dispatch recognizes varies with where it is layered:
 * recognizing a `FabricBytes` means holding the `FabricBytes` class, which not
 * every caller can. The vocabulary does not vary, so it is one constant here
 * rather than one inside each of them.
 */

import { constructorOfPrototype } from "@commonfabric/utils/objects";

import {
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";
import { isFabricArray, isFabricPlainObject } from "./type-check.ts";
import { toCompactDebugString } from "./value-debug.ts";
import {
  BaseFabricPrimitive,
  VALUE_TAG,
} from "@/fabric-bases/BaseFabricPrimitive.ts";

/**
 * The tags a `FabricPrimitive` reports, one per primitive class this package
 * defines. These are the only tags a `[VALUE_TAG]` getter may return, and the
 * only ones the primitive dispatch accepts from one.
 */
export const FABRIC_PRIMITIVE_VALUE_TAGS = Object.freeze(
  {
    FabricEpochNsec: "FabricEpochNsec",
    FabricEpochDay: "FabricEpochDay",
    FabricHash: "FabricHash",
    FabricBytes: "FabricBytes",
    FabricKeyPair: "FabricKeyPair",
    FabricRegExp: "FabricRegExp",
  } as const,
);

/** One of the `FabricPrimitive` tag strings. */
export type FabricPrimitiveValueTag =
  typeof FABRIC_PRIMITIVE_VALUE_TAGS[keyof typeof FABRIC_PRIMITIVE_VALUE_TAGS];

/**
 * The tags of the JS primitive types (all of them other than `object` and
 * `function`), plus `null`.
 *
 * **Note:** This is intentionally not `export`ed; it's just a convenience for
 * keeping this file DRY-er.
 */
const JS_PRIMITIVE_TYPE_VALUE_TAGS = Object.freeze(
  {
    bigint: "bigint",
    boolean: "boolean",
    null: "null",
    number: "number",
    string: "string",
    symbol: "symbol",
    undefined: "undefined",
  } as const,
);

/**
 * The tags of all JS types other than `object`, plus `null`.
 */
export const JS_TYPE_VALUE_TAGS = Object.freeze(
  {
    function: "function",
    ...JS_PRIMITIVE_TYPE_VALUE_TAGS,
  } as const,
);

/** One of the JS type tag strings. */
export type JsTypeValueTag =
  typeof JS_TYPE_VALUE_TAGS[keyof typeof JS_TYPE_VALUE_TAGS];

/** The tags for all primitive types, either JS-builtin or `FabricPrimitive`. */
export const PRIMITIVE_VALUE_TAGS = Object.freeze(
  {
    ...JS_PRIMITIVE_TYPE_VALUE_TAGS,
    FabricEpochNsec: "FabricEpochNsec",
    FabricEpochDay: "FabricEpochDay",
    FabricHash: "FabricHash",
    FabricBytes: "FabricBytes",
    FabricKeyPair: "FabricKeyPair",
    FabricRegExp: "FabricRegExp",
  } as const,
);

/** Tag for any primitive type, either JS-builtin or `FabricPrimitive`. */
export type PrimitiveValueTag =
  typeof PRIMITIVE_VALUE_TAGS[keyof typeof PRIMITIVE_VALUE_TAGS];

/** Tags for all values that could possibly be valid `FabricValue`s. */
export const FABRIC_VALUE_TAGS = Object.freeze(
  {
    Array: "Array",
    FabricInstance: "FabricInstance",
    Object: "Object",
    ...PRIMITIVE_VALUE_TAGS,
  } as const,
);

/** Tag for any value that could possibly be a valid `FabricValue`. */
export type FabricValueTag =
  typeof FABRIC_VALUE_TAGS[keyof typeof FABRIC_VALUE_TAGS];

/**
 * Tags identifying the value types that this system recognizes for dispatch.
 * These are distinct from wire-format `TAGS`.
 *
 * Covers the following:
 * * **JS types**: every primitive and a function, each represented by its
 *   `typeof` name, plus `null`. These are `JS_TYPE_VALUE_TAGS`, which this
 *   table includes whole.
 * * **Native JS builtins**: arrays and plain objects represented by `Array`
 *   and `Object`, and classes represented by their respective names under a
 *   `Js` prefix.
 * * **`FabricPrimitive`s**: classes defined by this package which are
 *   considered equivalent to primitives (always frozen, pass through conversion
 *   unchanged) but aren't under the open-ended `FabricInstance` umbrella. These
 *   are `FABRIC_PRIMITIVE_VALUE_TAGS`, which this table includes whole.
 * * **`FabricInstance`s**: container classes defined by this package, all
 *   represented by the type `FabricInstance`.
 */
export const VALUE_TAGS = Object.freeze(
  {
    Array: "Array",
    FabricInstance: "FabricInstance",
    JsDate: "JsDate",
    JsError: "JsError",
    JsMap: "JsMap",
    JsRegExp: "JsRegExp",
    JsSet: "JsSet",
    JsUint8Array: "JsUint8Array",
    Object: "Object",
    ...FABRIC_PRIMITIVE_VALUE_TAGS,
    ...JS_TYPE_VALUE_TAGS,
  } as const,
);

/** One of the tag strings. */
export type ValueTag = typeof VALUE_TAGS[keyof typeof VALUE_TAGS];

/**
 * Maps a `FabricPrimitive` to its tag. This `throw`s if it determines that the
 * given value is not valid: a type lie, an instance of no primitive class, or
 * one reporting a tag that is not a primitive tag.
 */
export function tagFromFabricPrimitive(
  value: FabricPrimitive,
): FabricPrimitiveValueTag {
  const result = tagFromFabricPrimitiveElseNull(value);

  if (result !== null) {
    return result;
  }

  const desc = toCompactDebugString(value, { backtickQuote: true });
  throw new Error(`Not a valid \`FabricPrimitive\`: ${desc}`);
}

/**
 * Maps a `FabricPrimitive` to its tag. This returns `null` if the given value
 * turns out not to be valid: a type lie, an instance of no primitive class, or
 * one reporting a tag that is not a primitive tag.
 */
export function tagFromFabricPrimitiveElseNull(
  value: FabricPrimitive,
): FabricPrimitiveValueTag | null {
  if (!(value instanceof BaseFabricPrimitive)) {
    return null;
  }

  const tag = value[VALUE_TAG];

  return ((typeof tag === "string") &&
      Object.hasOwn(FABRIC_PRIMITIVE_VALUE_TAGS, tag))
    ? tag
    : null;
}

/**
 * Maps a value to its JS type tag, which is decided by `typeof` alone: the
 * `typeof` name of a non-object, and the `null` tag for the value `null`.
 * Returns `object` for any other object, which has no JS type tag; its tag is
 * a question for `tagFromFabricValue()` or `tagFromNativeValueElseNull()`.
 */
export function jsTagFromValue(value: unknown): JsTypeValueTag | "object" {
  return (value === null) ? VALUE_TAGS.null : typeof value;
}

/**
 * Maps a presumed valid `FabricValue` to its tag, based on a shallow evaluation
 * of its type. This `throw`s if it determines that the given value cannot
 * possibly be valid.
 */
export function tagFromFabricValue(value: FabricValueLayer): FabricValueTag;
export function tagFromFabricValue(value: FabricValue): FabricValueTag;
export function tagFromFabricValue(value: FabricValueLayer): FabricValueTag {
  const result = tagFromFabricValueElseNull(value);

  if (result !== null) {
    return result;
  }

  const desc = toCompactDebugString(value, { backtickQuote: true });
  throw new Error(`Not possibly a valid \`FabricValue\`: ${desc}`);
}

/**
 * Maps a presumed valid `FabricValue` to its tag, based on a shallow evaluation
 * of its type. This returns `null` if it determines that the given value cannot
 * possibly be valid. To be clear, this function does not go out of its way to
 * make a validity determination.
 */
export function tagFromFabricValueElseNull(
  value: FabricValueLayer,
): FabricValueTag;
export function tagFromFabricValueElseNull(value: FabricValue): FabricValueTag;
export function tagFromFabricValueElseNull(
  value: FabricValue | FabricValueLayer,
): FabricValueTag | null {
  // Note: A `FabricValueLayer` isn't necessarily a `FabricValue`. However, all
  // the type checks called only operate at a layer level, and so this lie is
  // moot. TODO(danfuzz): Update the called predicates so they actually accept
  // `FabricValueLayer` per their type declarations.
  const fabVal = value as FabricValue;

  const jsType = jsTagFromValue(value);

  if (jsType === VALUE_TAGS.function) {
    // A function is no `FabricValue`, so its tag is not one this returns.
    return null;
  } else if (jsType !== "object") {
    return jsType;
  }

  if (isFabricArray(fabVal)) {
    return VALUE_TAGS.Array;
  } else if (isFabricPlainObject(fabVal)) {
    return VALUE_TAGS.Object;
  } else if (value instanceof FabricPrimitive) {
    return tagFromFabricPrimitiveElseNull(value);
  } else if (value instanceof FabricInstance) {
    return VALUE_TAGS.FabricInstance;
  } else {
    return null;
  }
}

/**
 * Maps a constructor to its tag, for the native JS builtins alone. Returns
 * `null` for anything else, a fabric class included.
 *
 * Answering this needs no class this system defines, and this function holds
 * none. A concrete fabric class reaches the codecs and, through them, the
 * instance bases, so a module holding one in order to recognize it would close
 * a cycle with everything layered below those bases. A fabric primitive is
 * recognized by the tag its instance carries instead.
 *
 * Recognition is by constructor identity, which is a per-realm question:
 * another realm's `Date` is a different `Date`, and is not this one. Values
 * from another realm are outside what this is asked about, so no brand check
 * stands behind the identity comparison. A cross-realm value that did arrive
 * would come back `null` -- unrecognized rather than misidentified, which is
 * the direction an unhandled case should fail in.
 *
 * This is asked of a class already read from a prototype, which is a
 * question that arises inside this package: a caller elsewhere holds values,
 * and asks `tagFromNativeValueElseNull()`.
 */
export function tagFromNativeBuiltinClassElseNull(
  constructorFn: { prototype: unknown },
): ValueTag | null {
  // A `switch` on constructor identity, rather than sequential `instanceof`
  // checks.
  switch (constructorFn) {
    // The two commonest by a distance, and a `switch` on object identity
    // compares in order, so they are asked first.
    case Object: {
      return VALUE_TAGS.Object;
    }

    case Array: {
      return VALUE_TAGS.Array;
    }

    // `Error` and standard subclasses all map to the `JsError` tag.
    case Error:
    case TypeError:
    case RangeError:
    case SyntaxError:
    case ReferenceError:
    case URIError:
    case EvalError: {
      return VALUE_TAGS.JsError;
    }

    case Map: {
      return VALUE_TAGS.JsMap;
    }

    case Set: {
      return VALUE_TAGS.JsSet;
    }

    case Date: {
      return VALUE_TAGS.JsDate;
    }

    case Uint8Array: {
      return VALUE_TAGS.JsUint8Array;
    }

    case RegExp: {
      return VALUE_TAGS.JsRegExp;
    }

    default: {
      // Catch exotic `Error` subclasses (e.g. custom subclasses with
      // non-standard constructors). `Error.isError()` is no use here: it
      // recognizes actual `Error` instances, not a prototype chain, and what
      // is in hand is a constructor. Guard against non-function values too
      // (e.g. null-prototype objects where `constructor()` is undefined).
      if (
        typeof constructorFn === "function" &&
        constructorFn.prototype instanceof Error
      ) {
        return VALUE_TAGS.JsError;
      }
      return null;
    }
  }
}

/**
 * Maps a JS value to its tag. Returns the tag of a primitive or a function,
 * or that of a recognized convertible native instance, or `null` for any
 * other object.
 *
 * An array is tagged `Array` before anything else is consulted.
 * `Array.isArray()` is realm-agnostic and sees through both a subclass and a
 * severed prototype, so every array reaches array handling and is decided by
 * the array rule, which alone decides what an array may be.
 */
export function tagFromNativeValueElseNull(value: unknown): ValueTag | null {
  const jsType = jsTagFromValue(value);

  if (jsType !== "object") {
    return jsType;
  }

  // Arrays first, and unconditionally: see above.
  if (Array.isArray(value)) {
    return VALUE_TAGS.Array;
  }

  const proto = Object.getPrototypeOf(value);

  if (proto === Object.prototype) {
    return VALUE_TAGS.Object;
  } else if (Error.isError(value)) {
    return VALUE_TAGS.JsError;
  } else if (proto === null) {
    // After the `isError()` check above, the only recognized possibility of a
    // null-proto object is a plain object.
    return VALUE_TAGS.Object;
  } else if (value instanceof FabricPrimitive) {
    return tagFromFabricPrimitiveElseNull(value);
  } else if (value instanceof FabricInstance) {
    return VALUE_TAGS.FabricInstance;
  }

  // The class is read from the PROTOTYPE, not from the value. What is being
  // asked is which class the value is an instance of, and that is a fact about
  // its prototype; an own `constructor` property is ordinary data that happens
  // to share the name, and must not decide the value's type. Reading it off
  // the value would let `{constructor: Error}` -- a plain record -- be tagged
  // `Error` and silently rebuilt as one.
  const ctor = constructorOfPrototype(proto);

  return (ctor === undefined) ? null : tagFromNativeBuiltinClassElseNull(ctor);
}
