/**
 * The dispatches that return a tag from the vocabulary in `interface.ts`, one
 * per kind of value a caller can be holding.
 *
 * Which classes a given dispatch recognizes varies with where it is layered:
 * recognizing a `FabricBytes` means holding the `FabricBytes` class, which not
 * every caller can. The vocabulary does not vary, so it is one constant there
 * rather than one inside each of them.
 */

import { constructorOfPrototype } from "@commonfabric/utils/objects";
import { isPlainObject, typeOfIncludingNull } from "@commonfabric/utils/types";

import {
  BaseFabricPrimitive,
  VALUE_TAG,
} from "@/fabric-bases/BaseFabricPrimitive.ts";
import {
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
  type FabricValueLayer,
} from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";

import {
  type ConvertibleJsValueTag,
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
  type FabricValueTag,
  VALUE_TAGS,
} from "./interface.ts";

/**
 * Maps a `FabricPrimitive` to its tag. This `throw`s if it determines that the
 * given value is not valid: a type lie, an instance of no primitive class, or
 * one reporting a tag that is not a primitive tag.
 */
export function tagOfFabricPrimitive(
  value: FabricPrimitive,
): FabricPrimitiveValueTag {
  const result = tagOfFabricPrimitiveElseNull(value);

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
export function tagOfFabricPrimitiveElseNull(
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
 * Maps a presumed valid `FabricValue` or `FabricValueLayer` to its tag, based
 * on a shallow evaluation of its type. This `throw`s if it determines that the
 * given value cannot possibly be valid.
 */
export function tagOfFabricValue(value: FabricValueLayer): FabricValueTag;
export function tagOfFabricValue(value: FabricValue): FabricValueTag;
export function tagOfFabricValue(value: FabricValueLayer): FabricValueTag {
  const result = tagOfFabricValueElseNull(value);

  if (result !== null) {
    return result;
  }

  const desc = toCompactDebugString(value, { backtickQuote: true });
  throw new Error(`Not possibly a valid \`FabricValue\`: ${desc}`);
}

/**
 * Maps a presumed valid `FabricValue` or `FabricValueLayer` to its tag, based
 * on a shallow evaluation of its type. This returns `null` if it determines
 * that the given value cannot possibly be valid. To be clear, this function
 * does not go out of its way to make a validity determination.
 */
export function tagOfFabricValueElseNull(
  value: FabricValueLayer,
): FabricValueTag;
export function tagOfFabricValueElseNull(value: FabricValue): FabricValueTag;
export function tagOfFabricValueElseNull(
  value: FabricValue | FabricValueLayer,
): FabricValueTag | null {
  const jsType = typeOfIncludingNull(value);

  if (jsType === VALUE_TAGS.function) {
    // A function is no `FabricValue`, so its tag is not one this returns.
    return null;
  } else if (jsType !== "object") {
    return jsType;
  }

  if (Array.isArray(value)) {
    return VALUE_TAGS.Array;
  } else if (isPlainObject(value)) {
    return VALUE_TAGS.Object;
  } else if (value instanceof FabricPrimitive) {
    return tagOfFabricPrimitiveElseNull(value);
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
 * question that arises inside this module: a caller holds values, and asks
 * `tagOfConvertibleJsValueElseNull()`.
 */
function tagOfNativeBuiltinClassElseNull(
  constructorFn: { prototype: unknown },
): ConvertibleJsValueTag | null {
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
 * Maps a presumed `FabricConvertibleJsValue` to its tag, based on a shallow
 * evaluation of its type. Returns the tag of a primitive, or that of a
 * recognized convertible native instance, or `null` for a function and for
 * any other object. To be clear, this function does not go out of its way to
 * make a validity determination.
 *
 * An array is tagged `Array` before anything else is consulted.
 * `Array.isArray()` is realm-agnostic and sees through both a subclass and a
 * severed prototype, so every array reaches array handling and is decided by
 * the array rule, which alone decides what an array may be.
 */
export function tagOfConvertibleJsValueElseNull(
  value: unknown,
): ConvertibleJsValueTag | null {
  const jsType = typeOfIncludingNull(value);

  if (jsType === VALUE_TAGS.function) {
    // A function is no `FabricConvertibleJsValue`, so its tag is not one this
    // returns.
    return null;
  } else if (jsType !== "object") {
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
    return tagOfFabricPrimitiveElseNull(value);
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

  return (ctor === undefined) ? null : tagOfNativeBuiltinClassElseNull(ctor);
}
