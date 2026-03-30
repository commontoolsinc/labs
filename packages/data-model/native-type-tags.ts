import { FabricEpochDays, FabricEpochNsec } from "./fabric-epoch.ts";
import { FabricHash } from "./fabric-hash.ts";
import { FabricBytes } from "./fabric-bytes.ts";
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
    ContentHash: "ContentHash",
    HasToJSON: "HasToJSON",
    FabricBytes: "FabricBytes",
    FabricInstance: "FabricInstance",
    Primitive: "Primitive",
  } as const,
);

/** One of the native-instance tag strings. */
export type NativeTag = typeof NATIVE_TAGS[keyof typeof NATIVE_TAGS];

/**
 * Canonical mapping from a constructor to its native-instance tag. Returns the
 * tag string if the constructor is a recognized type (JS builtins or
 * system-defined special primitives), or `null` otherwise.
 *
 * Uses a `switch` on the constructor identity for O(1) dispatch (instead of
 * sequential `instanceof` checks). Falls back to `instanceof Error` on the
 * constructor's prototype to catch exotic Error subclasses, and checks for
 * `toJSON()` on the prototype for unrecognized classes. (Note:
 * `Error.isError()` doesn't work on prototype objects -- it only recognizes
 * actual Error instances, not the prototype chain -- so we use `instanceof`.)
 */
export function tagFromNativeClass(
  constructorFn: { prototype: unknown },
): NativeTag | null {
  switch (constructorFn) {
    // Error and standard subclasses all map to the Error tag.
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
    case FabricEpochNsec:
      return NATIVE_TAGS.EpochNsec;
    case FabricEpochDays:
      return NATIVE_TAGS.EpochDays;
    case FabricHash:
      return NATIVE_TAGS.ContentHash;
    case FabricBytes:
      return NATIVE_TAGS.FabricBytes;

    default:
      // Catch exotic Error subclasses (e.g. custom subclasses with
      // non-standard constructors). Guard against non-function values
      // (e.g. null-prototype objects where .constructor is undefined).
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
 * Canonical mapping from a JS value to its native-instance tag. Returns the
 * tag string if the value is a recognized convertible native instance, or
 * `null` otherwise. Non-object types (null, undefined, primitives) return
 * `Primitive`.
 *
 * Dispatches via the value's constructor (O(1) switch in `tagFromNativeClass`).
 * Falls back to `Error.isError()` for exotic Error subclasses, `Array.isArray`
 * for cross-realm arrays, and prototype check for null-prototype objects.
 *
 * For tags that have pass-through handling (`Object`, `Array`) or no dedicated
 * handler (`null`), a per-instance `hasToJSON` check upgrades the tag to
 * `HasToJSON`. Dedicated types (Error, Date, Map, etc.) and `HasToJSON` from
 * `tagFromNativeClass` are returned as-is.
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

  // tagFromNativeClass handles dedicated types (Error, Date, Map, etc.) and
  // returns HasToJSON for classes whose prototype has toJSON(). For those,
  // return immediately -- no instance-level override needed.
  if (
    tag !== null && tag !== NATIVE_TAGS.Object && tag !== NATIVE_TAGS.Array
  ) {
    return tag;
  }

  // Fallbacks for values whose constructor wasn't recognized (tag === null).
  if (tag === null) {
    // Exotic Error subclasses (e.g. DOMException).
    if (Error.isError(value)) return NATIVE_TAGS.Error;

    // FabricInstance values (protocol types with [DECONSTRUCT]).
    if (value instanceof FabricInstance) return NATIVE_TAGS.FabricInstance;

    // Cross-realm arrays may have a different constructor.
    if (Array.isArray(value)) tag = NATIVE_TAGS.Array;

    // Null-prototype objects (Object.create(null)).
    if (tag === null) {
      const proto = Object.getPrototypeOf(value);
      if (proto === null) tag = NATIVE_TAGS.Object;
    }
  }

  // For Object, Array, and still-null tags: a per-instance toJSON() method
  // overrides to HasToJSON. This catches plain objects with toJSON as an own
  // property, arrays with toJSON added, and unrecognized class instances
  // whose prototype wasn't caught by tagFromNativeClass.
  if (hasToJSON(value)) return NATIVE_TAGS.HasToJSON;

  return tag;
}

/** Checks whether a value has a callable `toJSON()` method. */
function hasToJSON(value: object): boolean {
  return "toJSON" in value &&
    typeof (value as { toJSON: unknown }).toJSON === "function";
}
