import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { isCanonicalDataUnavailable } from "@/fabric-instances/data-unavailable-brand.ts";
import { FabricInstance } from "./interface.ts";

// SES replaces the host Error constructor with a tamed one that does not
// currently expose Error.isError(). Capture the native brand check before
// lockdown so errors minted by either side of that boundary remain
// recognizable without relying on spoofable shape or display-tag checks.
const nativeErrorIsError = (Error as typeof Error & {
  isError?: (candidate: unknown) => boolean;
}).isError?.bind(Error);

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
 * Additionally, `HasToJSON` is a synthetic tag for values whose class provides
 * a `toJSON()` method but isn't otherwise recognized.
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
    EpochDays: "EpochDays",
    HasToJSON: "HasToJSON",
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
 * Maps a constructor to its native-instance tag. Returns the tag string if
 * the constructor is a recognized type (JS builtins or system-defined
 * special primitives), or `null` otherwise.
 *
 * Uses a `switch` on the constructor identity for O(1) dispatch (instead of
 * sequential `instanceof` checks). Falls back to `instanceof Error` on the
 * constructor's prototype to catch exotic `Error` subclasses, and checks for
 * `toJSON()` on the prototype for unrecognized classes. (Note:
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
    case FabricEpochDays:
      return NATIVE_TAGS.EpochDays;
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
      // Unrecognized class whose prototype has a toJSON() method.
      if (
        constructorFn.prototype !== null &&
        constructorFn.prototype !== undefined &&
        hasToJSON(constructorFn.prototype as object)
      ) {
        return NATIVE_TAGS.HasToJSON;
      }
      return null;
  }
}

/**
 * Maps a JS value to its native-instance tag. Returns the tag string if the
 * value is a recognized convertible native instance, or `null` otherwise.
 * Non-object types (`null`, `undefined`, primitives) return `Primitive`.
 *
 * Dispatches via the value's constructor (O(1) switch in `tagFromNativeClass`).
 * Falls back to a pre-SES captured `Error.isError()` for foreign-branded
 * errors; cross-realm arrays use `Array.isArray()`, and null-prototype objects
 * use a prototype check.
 *
 * For tags that have pass-through handling (`Object`, `Array`) or no dedicated
 * handler (`null`), a per-instance `hasToJSON()` check upgrades the tag to
 * `HasToJSON`. Dedicated types (`Error`, `Date`, `Map`, etc.) and `HasToJSON` from
 * `tagFromNativeClass()` are returned as-is.
 */
export function tagFromNativeValue(value: unknown): NativeTag | null {
  if (value === null || typeof value !== "object") {
    return NATIVE_TAGS.Primitive;
  }
  // Guard: null-prototype objects or exotic objects may not have a function
  // constructor.
  const ctor = value.constructor;
  let tag: NativeTag | null = null;

  if (typeof ctor === "function") {
    tag = tagFromNativeClass(ctor);
  }

  // `tagFromNativeClass()` handles dedicated types (`Error`, `Date`, `Map`, etc.) and
  // returns `HasToJSON` for classes whose prototype has `toJSON()`. For those,
  // return immediately -- no instance-level override needed.
  if (
    tag !== null && tag !== NATIVE_TAGS.Object && tag !== NATIVE_TAGS.Array
  ) {
    return tag;
  }

  // Fallbacks for values whose constructor wasn't recognized (tag === null).
  if (tag === null) {
    // Split bundles can duplicate the FabricInstance base while sharing the
    // canonical DataUnavailable private brand. Recognize that control value
    // before the realm-specific base-class identity check below.
    if (isCanonicalDataUnavailable(value)) {
      return NATIVE_TAGS.FabricInstance;
    }

    // Other Fabric protocol values are already valid and must be recognized
    // before consulting realm-specific native helpers.
    if (value instanceof FabricInstance) return NATIVE_TAGS.FabricInstance;

    // Foreign/SES `Error` instances and exotic subclasses. Use the native
    // intrinsic captured before SES replaced the active Error constructor.
    if (nativeErrorIsError?.(value)) {
      return NATIVE_TAGS.Error;
    }

    // Cross-realm arrays may have a different constructor.
    if (Array.isArray(value)) tag = NATIVE_TAGS.Array;

    // Null-prototype objects (`Object.create(null)`).
    if (tag === null) {
      const proto = Object.getPrototypeOf(value);
      if (proto === null) tag = NATIVE_TAGS.Object;
    }
  }

  // For `Object`, `Array`, and still-null tags: a per-instance `toJSON()` method
  // overrides to `HasToJSON`. This catches plain objects with `toJSON()` as an own
  // property, arrays with `toJSON()` added, and unrecognized class instances
  // whose prototype wasn't caught by `tagFromNativeClass()`.
  if (hasToJSON(value)) return NATIVE_TAGS.HasToJSON;

  return tag;
}

/** Checks whether a value has a callable `toJSON()` method. */
function hasToJSON(value: object): boolean {
  return "toJSON" in value &&
    typeof (value as { toJSON: unknown }).toJSON === "function";
}
