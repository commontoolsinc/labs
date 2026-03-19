import { StorableEpochDays, StorableEpochNsec } from "./storable-epoch.ts";
import { StorableContentId } from "./storable-content-id.ts";
import { isStorableInstance } from "./storable-protocol.ts";

/**
 * Canonical type tags for the `/<Type>@<Version>` wire format. Collected in a
 * single frozen object so that use sites are type-checked for valid tag
 * reference, and literal strings don't end up bit-rotting inadvertently.
 *
 * Constant names are un-versioned as a baseline. If and when we need to support
 * multiple versions of a type, the current one stays unmarked and old versions
 * get a `V1` suffix (or similar).
 *
 * See Section 5.2 of the formal spec.
 */
export const TAGS = Object.freeze(
  {
    // -- Instance types (deserialized via class registry) --
    Error: "Error@1",
    Map: "Map@1",
    Set: "Set@1",
    EpochNsec: "EpochNsec@1",
    EpochDays: "EpochDays@1",
    Bytes: "Bytes@1",
    RegExp: "RegExp@1",

    // -- Primitive type handlers --
    BigInt: "BigInt@1",
    Undefined: "Undefined@1",

    // -- Structural / meta tags (serialization format) --
    quote: "quote",
    hole: "hole",
    object: "object",
  } as const,
);

// ---------------------------------------------------------------------------
// Native-instance tag lookup utilities
// ---------------------------------------------------------------------------

/**
 * Tags identifying classes that the storable system recognizes for dispatch.
 * These are distinct from wire-format `TAGS` -- they identify *what the value
 * is*, not what storable type it becomes after conversion.
 *
 * Covers two categories:
 * - **Native JS builtins**: Array, Object, Error, Map, Set, Date, Uint8Array.
 * - **System-defined value types**: StorableEpochNsec, StorableEpochDays,
 *   StorableContentId -- classes defined by this system that behave like
 *   primitives (always frozen, pass through conversion unchanged) but aren't
 *   under the open-ended `StorableInstance` umbrella.
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
    ContentId: "ContentId",
    HasToJSON: "HasToJSON",
    StorableInstance: "StorableInstance",
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
    case StorableEpochNsec:
      return NATIVE_TAGS.EpochNsec;
    case StorableEpochDays:
      return NATIVE_TAGS.EpochDays;
    case StorableContentId:
      return NATIVE_TAGS.ContentId;

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

    // StorableInstance values (protocol types with [DECONSTRUCT]).
    if (isStorableInstance(value)) return NATIVE_TAGS.StorableInstance;

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
