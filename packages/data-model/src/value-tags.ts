/**
 * The tag vocabulary -- the names a dispatch answers with when asked what a
 * value already is -- and the dispatches that answer with it, one per kind of
 * value a caller can be holding.
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
} from "./interface.ts";
import { isFabricArray, isFabricPlainObject } from "./type-check.ts";
import { toCompactDebugString } from "./value-debug.ts";
import {
  BaseFabricPrimitive,
  VALUE_TAG,
} from "@/fabric-bases/BaseFabricPrimitive.ts";

/**
 * Tags identifying the value types that this system recognizes for dispatch.
 * These are distinct from wire-format `TAGS`.
 *
 * Covers the following:
 * * **Native JS builtins**: standard JS types, primitives all represented by
 *   the type `Primitive`, and classes represented by their respective names.
 * * **`FabricPrimitive`s**: classes defined by this package which are
 *   considered equivalent to primitives (always frozen, pass through conversion
 *   unchanged) but aren't under the open-ended `FabricInstance` umbrella.
 * * **`FabricInstance`s**: container classes defined by this package, all
 *   represented by the type `FabricInstance`.
 */
export const VALUE_TAGS = Object.freeze(
  {
    Array: "Array",
    Object: "Object",
    Error: "Error",
    Map: "Map",
    Set: "Set",
    Date: "Date",
    Uint8Array: "Uint8Array",
    RegExp: "RegExp",
    EpochNsec: "EpochNsec",
    EpochDay: "EpochDay",
    Hash: "Hash",
    FabricBytes: "FabricBytes",
    FabricKeyPair: "FabricKeyPair",
    FabricRegExp: "FabricRegExp",
    FabricInstance: "FabricInstance",
    Primitive: "Primitive",
  } as const,
);

/** One of the tag strings. */
export type ValueTag = typeof VALUE_TAGS[keyof typeof VALUE_TAGS];

/**
 * Maps a `FabricPrimitive` to its tag. This `throw`s if it determines that the
 * given value is not valid (either a type lie or an unrecognized class).
 */
export function tagFromFabricPrimitive(value: FabricPrimitive): ValueTag {
  const result = tagFromFabricPrimitiveElseNull(value);

  if (result !== null) {
    return result;
  }

  const desc = toCompactDebugString(value, { backtickQuote: true });
  throw new Error(`Not a valid \`FabricPrimitive\`: ${desc}`);
}

/**
 * Maps a `FabricPrimitive` to its tag. This returns `null` if the given value
 * turns out not to be valid.
 */
export function tagFromFabricPrimitiveElseNull(
  value: FabricPrimitive,
): ValueTag | null {
  if (!(value instanceof BaseFabricPrimitive)) {
    return null;
  }

  const tag = value[VALUE_TAG];

  return ((typeof tag === "string") && Object.hasOwn(VALUE_TAGS, tag))
    ? tag
    : null;
}

/**
 * Maps a presumed valid `FabricValue` to its tag. This `throw`s if it
 * determines that the given value cannot possibly be valid. To be clear, this
 * function does not go out of its way to make a validity determination.
 */
export function tagFromFabricValue(value: FabricValue): ValueTag {
  const result = tagFromFabricValueElseNull(value);

  if (result !== null) {
    return result;
  }

  const desc = toCompactDebugString(value, { backtickQuote: true });
  throw new Error(`Not possibly a valid \`FabricValue\`: ${desc}`);
}

/**
 * Maps a presumed valid `FabricValue` to its tag. This returns `null` if it
 * determines that the given value cannot possibly be valid. To be clear, this
 * function does not go out of its way to make a validity determination.
 */
export function tagFromFabricValueElseNull(
  value: FabricValue,
): ValueTag | null {
  switch (typeof value) {
    case "function": {
      return null;
    }

    case "object": {
      if (value === null) {
        return VALUE_TAGS.Primitive;
      }
      break;
    }

    default: {
      return VALUE_TAGS.Primitive;
    }
  }

  if (isFabricArray(value)) {
    return VALUE_TAGS.Array;
  } else if (isFabricPlainObject(value)) {
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
 * **Note:** This function is intentionally _not_ `export`ed from the
 * `data-model` barrel.
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

    // `Error` and standard subclasses all map to the `Error` tag.
    case Error:
    case TypeError:
    case RangeError:
    case SyntaxError:
    case ReferenceError:
    case URIError:
    case EvalError: {
      return VALUE_TAGS.Error;
    }

    case Map: {
      return VALUE_TAGS.Map;
    }

    case Set: {
      return VALUE_TAGS.Set;
    }

    case Date: {
      return VALUE_TAGS.Date;
    }

    case Uint8Array: {
      return VALUE_TAGS.Uint8Array;
    }

    case RegExp: {
      return VALUE_TAGS.RegExp;
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
        return VALUE_TAGS.Error;
      }
      return null;
    }
  }
}

/**
 * Maps a JS value to its native-instance tag. Returns the tag string if the
 * value is a recognized convertible native instance, or `null` otherwise.
 * Non-object types (`null`, `undefined`, primitives) return `Primitive`.
 *
 * An array is tagged `Array` before anything else is consulted.
 * `Array.isArray()` is realm-agnostic and sees through both a subclass and a
 * severed prototype, so every array reaches array handling and is decided by
 * the array rule, which alone decides what an array may be.
 *
 * An error is recognized next, by `Error.isError()`, which holds through a
 * severed prototype and across realms; then a `FabricPrimitive`, by the tag
 * its instance carries; then a `FabricInstance`, by class. A null-prototype
 * object is tagged `Object`. What remains is decided by its class, read from
 * its prototype, through `tagFromNativeBuiltinClassElseNull()`.
 */
export function tagFromNativeValueElseNull(value: unknown): ValueTag | null {
  if (value === null || typeof value !== "object") {
    return VALUE_TAGS.Primitive;
  }

  // Arrays first, and unconditionally: see above.
  if (Array.isArray(value)) {
    return VALUE_TAGS.Array;
  } else if (Error.isError(value)) {
    return VALUE_TAGS.Error;
  } else if (value instanceof FabricPrimitive) {
    return tagFromFabricPrimitiveElseNull(value);
  } else if (value instanceof FabricInstance) {
    return VALUE_TAGS.FabricInstance;
  }

  const proto = Object.getPrototypeOf(value);

  // We treat a `null` prototype as type `Object`, because due to the checks
  // above, it can't be a cross-realm type of any sort we attempt to recognize.
  if (proto === null) {
    return VALUE_TAGS.Object;
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
