/**
 * Answering what a JS value already is, so that conversion can decide what to
 * make of it. These tags name the value's own class, and are unrelated to the
 * tags a wire format writes, which say what it became.
 *
 * The question is harder than an `instanceof` because the answer must not be
 * forgeable, and must still be reachable for a value that did not come from
 * here. A class is read off the prototype rather than off the value, since an
 * own `constructor` property is ordinary data that would otherwise let a plain
 * record present itself as an `Error`. A value from another realm, or one
 * whose prototype has been severed, has to be recognized regardless, which is
 * why the constructor switch has fallbacks beneath it rather than standing
 * alone.
 */

import { FabricEpochDay } from "@/fabric-primitives/FabricEpochDay.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricInstance } from "./interface.ts";

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
 * Maps a constructor to its native-instance tag. Returns the tag string if
 * the constructor is a recognized type (JS builtins or system-defined
 * `FabricPrimitive`s), or `null` otherwise.
 *
 * Uses a `switch` on the constructor identity for O(1) dispatch (instead of
 * sequential `instanceof` checks). Falls back to `instanceof Error` on the
 * constructor's prototype to catch exotic `Error` subclasses. (Note:
 * `Error.isError()` doesn't work on prototype objects -- it only recognizes
 * actual `Error` instances, not the prototype chain -- so we use `instanceof`.)
 */
export function tagFromNativeClass(
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
    case FabricBytes:
      return NATIVE_TAGS.FabricBytes;
    case FabricEpochNsec:
      return NATIVE_TAGS.EpochNsec;
    case FabricEpochDay:
      return NATIVE_TAGS.EpochDay;
    case FabricHash:
      return NATIVE_TAGS.Hash;
    case FabricRegExp:
      return NATIVE_TAGS.FabricRegExp;

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
 * Maps a JS value to its native-instance tag. Returns the tag string if the
 * value is a recognized convertible native instance, or `null` otherwise.
 * Non-object types (`null`, `undefined`, primitives) return `Primitive`.
 *
 * An array is tagged `Array` before anything else is consulted.
 * `Array.isArray()` is realm-agnostic and sees through both a subclass and a
 * severed prototype, so every array reaches array handling and is decided by
 * the array rule, which alone decides what an array may be.
 *
 * Otherwise dispatches via the value's constructor (O(1) switch in
 * `tagFromNativeClass`, which matches `Error` subclasses via
 * `prototype instanceof Error`), falling back to native error detection for
 * values whose constructor is unreachable -- a severed prototype, or another
 * realm -- and to a prototype check for null-prototype objects.
 */
export function tagFromNativeValue(value: unknown): NativeTag | null {
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
    const tag = tagFromNativeClass(ctor);
    if (tag !== null) return tag;
  }

  // Fallbacks for values whose constructor wasn't recognized.

  // `Error`s with no reachable constructor -- e.g. one whose prototype has
  // been severed, or one from another realm. An ordinary subclass (including
  // `DOMException`) never gets here: `tagFromNativeClass()` matches it via
  // `prototype instanceof Error`.
  if (isNativeError(value)) return NATIVE_TAGS.Error;

  // `FabricInstance` values (object-like protocol types).
  if (value instanceof FabricInstance) return NATIVE_TAGS.FabricInstance;

  // Null-prototype objects (`Object.create(null)`), which have no constructor
  // to have been recognized. Tagged `Object` so the object rule decides them
  // by name, the same way an indirect array is tagged `Array`.
  if (proto === null) return NATIVE_TAGS.Object;

  return null;
}
