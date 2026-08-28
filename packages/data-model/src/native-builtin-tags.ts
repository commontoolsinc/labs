/**
 * The tag vocabulary, and the half of the dispatch that recognizes a value
 * needing no fabric class to recognize it: the native JS builtins.
 *
 * This exists as its own module because of where its callers sit. Recognizing
 * a `FabricBytes` means holding the `FabricBytes` class, and a concrete fabric
 * class reaches the codecs and, through them, the instance bases -- so a module
 * that asks about the fabric classes is layered above them. `type-check.ts` is
 * layered *below* them, and still has to be able to recognize a `Date` from a
 * `Map` from an ordinary class instance. What it can ask is here; the rest, in
 * `native-type-tags.ts`, which builds on this.
 *
 * Nothing here imports a value from this package. That is the property the
 * split exists to have, and it is worth checking before adding an import.
 */

import type { FabricNativeObject } from "./interface.ts";

/**
 * Tags identifying classes that the fabric system recognizes for dispatch.
 * These are distinct from wire-format `TAGS` -- they identify *what the value
 * is*, not what fabric type it becomes after conversion.
 *
 * Covers two categories:
 * - **Native JS builtins**: standard JS types that the fabric system converts.
 * - **System-defined value types**: classes defined by this system that
 *   behave like primitives (always frozen, pass through conversion
 *   unchanged) but aren't under the open-ended `FabricInstance` umbrella.
 *
 * Both categories are named here even though only the first is dispatched to
 * here, a tag being one vocabulary whichever half of the dispatch produces it.
 */
export const NATIVE_TAGS = Object.freeze(
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

/** One of the native-instance tag strings. */
export type NativeTag = typeof NATIVE_TAGS[keyof typeof NATIVE_TAGS];

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
 * Maps a constructor to its native-instance tag, for the native JS builtins
 * alone. Returns `null` for anything else, a fabric class included --
 * `tagFromNativeClass()` is what knows those.
 *
 * Uses a `switch` on the constructor identity for O(1) dispatch (instead of
 * sequential `instanceof` checks). Falls back to `instanceof Error` on the
 * constructor's prototype to catch exotic `Error` subclasses. (Note:
 * `Error.isError()` doesn't work on prototype objects -- it only recognizes
 * actual `Error` instances, not the prototype chain -- so we use `instanceof`.)
 */
export function tagFromNativeBuiltinClass(
  constructorFn: { prototype: unknown },
): NativeTag | null {
  switch (constructorFn) {
    // `Error` and standard subclasses all map to the `Error` tag.
    case Error:
    case TypeError:
    case RangeError:
    case SyntaxError:
    case ReferenceError:
    case URIError:
    case EvalError:
      return NATIVE_TAGS.Error;

    case Array:
      return NATIVE_TAGS.Array;
    case Object:
      return NATIVE_TAGS.Object;
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
 * Walks a value to its class and asks the given lookup what that class is,
 * which is the shape both value dispatches have. The lookup is a parameter so
 * that this module can run the walk over the builtins alone while
 * `tagFromNativeValue()` runs it over every class the system knows -- one walk,
 * asked two ways, rather than two walks that have to be kept in step.
 *
 * A value whose class the lookup does not recognize comes back `null`, which
 * leaves the fallbacks a caller wants to the caller. The one fallback applied
 * here is native error detection, since a value whose constructor is
 * unreachable -- a severed prototype, or another realm -- is still an error and
 * is decided the same way by both.
 *
 * An array is tagged `Array` before anything else is consulted.
 * `Array.isArray()` is realm-agnostic and sees through both a subclass and a
 * severed prototype, so every array reaches array handling and is decided by
 * the array rule, which alone decides what an array may be. Non-object types
 * (`null`, `undefined`, primitives) are tagged `Primitive`.
 *
 * @param value The value to tag.
 * @param tagFromClass The class lookup to consult.
 */
export function tagFromNativeValueUsing(
  value: unknown,
  tagFromClass: (constructorFn: { prototype: unknown }) => NativeTag | null,
): NativeTag | null {
  if (value === null || typeof value !== "object") {
    return NATIVE_TAGS.Primitive;
  }

  // Arrays first, and unconditionally: see above.
  if (Array.isArray(value)) {
    return NATIVE_TAGS.Array;
  }

  // The constructor is read from the _prototype_, not from the value. What is
  // being asked is which class the value is an instance of, and that is a fact
  // about its prototype; an own `constructor` property is ordinary data that
  // happens to share the name, and must not decide the value's type. Reading
  // it off the value would let `{constructor: Error}` -- a plain record -- be
  // tagged `Error` and silently rebuilt as one.
  //
  // Guard: a null-prototype object has no constructor to find, and an exotic
  // one may not have a callable one.
  const proto = Object.getPrototypeOf(value);
  const ctor = proto === null ? undefined : proto.constructor;

  if (typeof ctor === "function") {
    const tag = tagFromClass(ctor);
    if (tag !== null) return tag;
  }

  // `Error`s with no reachable constructor -- e.g. one whose prototype has
  // been severed, or one from another realm. An ordinary subclass (including
  // `DOMException`) never gets here: the class lookup matches it via
  // `prototype instanceof Error`.
  if (isNativeError(value)) return NATIVE_TAGS.Error;

  return null;
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
  switch (tagFromNativeValueUsing(value, tagFromNativeBuiltinClass)) {
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
