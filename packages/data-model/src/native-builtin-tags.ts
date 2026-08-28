/**
 * Recognizing the native JS builtins, which is the part of the dispatch that
 * needs no class this system defines.
 *
 * It is separate for the sake of where its callers sit. Recognizing a
 * `FabricBytes` means holding the `FabricBytes` class, and a concrete fabric
 * class reaches the codecs and, through them, the instance bases -- so a module
 * that asks about the fabric classes is layered above them. `type-check.ts` is
 * layered *below* them, and still has to be able to tell a `Date` from a `Map`
 * from an ordinary class instance. What it can ask is here; the rest is in
 * `native-type-tags.ts`, which asks this and then its own.
 *
 * What this file must not import is any module that knows a fabric class, since
 * that is the whole of what its callers cannot reach. `native-tags.ts` is
 * below even this one and is fine; anything else deserves a second look.
 */

import type { FabricNativeObject } from "./interface.ts";
import { constructorFromObject } from "@commonfabric/utils/objects";

import { NATIVE_TAGS, type NativeTag } from "./native-tags.ts";

/**
 * Checks whether a value is a native `Error`.
 *
 * `Error.isError()` recognizes errors from other realms when the engine
 * provides it. Engines without it fall back to `instanceof`, which recognizes
 * errors that share the current realm's prototype hierarchy.
 */
export function isNativeError(value: unknown): value is Error {
  const isError = (Error as { isError?: (value: unknown) => boolean }).isError;
  return typeof isError === "function"
    ? isError(value)
    : value instanceof Error;
}

/**
 * Maps a constructor to its tag, for the native JS builtins alone. Returns
 * `null` for anything else, a fabric class included -- `tagFromNativeClass()`
 * is what knows those.
 *
 * Uses a `switch` on the constructor identity for dispatch (instead of
 * sequential `instanceof` checks). Falls back to `instanceof Error` on the
 * constructor's prototype to catch exotic `Error` subclasses. (Note:
 * `Error.isError()` doesn't work on prototype objects -- it only recognizes
 * actual `Error` instances, not the prototype chain -- so we use `instanceof`.)
 */
export function tagFromNativeBuiltinClass(
  constructorFn: { prototype: unknown },
): NativeTag | null {
  switch (constructorFn) {
    // The two commonest by a distance, and a `switch` on object identity
    // compares in order, so they are asked first.
    case Object:
      return NATIVE_TAGS.Object;
    case Array:
      return NATIVE_TAGS.Array;

    // `Error` and standard subclasses all map to the `Error` tag.
    case Error:
    case TypeError:
    case RangeError:
    case SyntaxError:
    case ReferenceError:
    case URIError:
    case EvalError:
      return NATIVE_TAGS.Error;

    case Map:
      return NATIVE_TAGS.Map;
    case Set:
      return NATIVE_TAGS.Set;
    case Date:
      return NATIVE_TAGS.Date;
    case Uint8Array:
      return NATIVE_TAGS.Uint8Array;
    case RegExp:
      return NATIVE_TAGS.RegExp;

    default:
      // Catch exotic `Error` subclasses (e.g. custom subclasses with
      // non-standard constructors). Guard against non-function values
      // (e.g. null-prototype objects where `constructor()` is undefined).
      if (
        typeof constructorFn === "function" &&
        constructorFn.prototype instanceof Error
      ) {
        return NATIVE_TAGS.Error;
      }
      return null;
  }
}

/**
 * Returns `true` if the value is a `FabricNativeObject`: one of the
 * "wild-west" native JS instances that the conversion layer wraps into a
 * `FabricNativeWrapper` subclass, a `FabricPrimitive`, or a `FabricInstance`.
 *
 * Arrays, plain objects, and system-defined `FabricPrimitive`s are recognized
 * by `tagFromNativeValue()` but are _not_ `FabricNativeObject`s -- they have
 * their own handling paths in the conversion layer.
 *
 * Membership is not convertibility: a `Map` and a `Set` are members whose
 * fabric form has yet to be built.
 *
 * This function is a TypeScript type guard for `FabricNativeObject`.
 */
export function isValidFabricNativeObject(
  value: unknown,
): value is FabricNativeObject {
  if (value === null || typeof value !== "object") return false;

  // Arrays first, and unconditionally, exactly as the full dispatch does it.
  // An array's class is USUALLY `Array`, whose tag is not one of the six
  // below -- but a prototype can be re-pointed, and an array wearing
  // `Date.prototype` would otherwise be reported as a convertible `Date`.
  // `Array.isArray()` sees through that, and through a subclass and a severed
  // prototype besides, which is why the array rule alone decides what an array
  // may be.
  if (Array.isArray(value)) return false;

  const ctor = constructorFromObject(value);
  const tag = (ctor !== undefined) ? tagFromNativeBuiltinClass(ctor) : null;

  switch (tag ?? (isNativeError(value) ? NATIVE_TAGS.Error : null)) {
    case NATIVE_TAGS.Error:
    case NATIVE_TAGS.Map:
    case NATIVE_TAGS.Set:
    case NATIVE_TAGS.Date:
    case NATIVE_TAGS.Uint8Array:
    case NATIVE_TAGS.RegExp:
      return true;
    default:
      return false;
  }
}
