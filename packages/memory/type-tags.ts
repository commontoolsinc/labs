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
 * Tags identifying native JS types that the storable system can convert.
 * These are distinct from wire-format `TAGS` -- they identify *what the native
 * value is*, not what storable type it becomes after conversion. For example,
 * a `Date` is identified as `NATIVE_TAGS.Date` here; the conversion layer
 * decides it becomes a `StorableEpochNsec` with wire tag `TAGS.EpochNsec`.
 */
export const NATIVE_TAGS = Object.freeze(
  {
    Error: "Error",
    Map: "Map",
    Set: "Set",
    Date: "Date",
    Uint8Array: "Uint8Array",
  } as const,
);

/** One of the native-instance tag strings. */
export type NativeTag = typeof NATIVE_TAGS[keyof typeof NATIVE_TAGS];

/**
 * Canonical mapping from a native JS constructor to its native-instance tag.
 * Returns the tag string if the constructor is a recognized convertible native
 * type, or `null` otherwise.
 *
 * Uses a `switch` on the constructor identity for O(1) dispatch (instead of
 * sequential `instanceof` checks). For Error subclasses not covered by the
 * switch, returns `null` -- callers that need `Error.isError()` fallback
 * should handle that separately.
 */
export function tagFromNativeClass(
  constructorFn: Function,
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

    case Map:
      return NATIVE_TAGS.Map;
    case Set:
      return NATIVE_TAGS.Set;
    case Date:
      return NATIVE_TAGS.Date;
    case Uint8Array:
      return NATIVE_TAGS.Uint8Array;

    default:
      return null;
  }
}

/**
 * Canonical mapping from a native JS object value to its native-instance tag.
 * Returns the tag string if the value is a recognized convertible native
 * instance, or `null` otherwise.
 *
 * Dispatches via the value's constructor (O(1) switch). For exotic Error
 * subclasses whose constructor isn't in the switch, falls back to
 * `Error.isError()`.
 */
export function tagFromNativeValue(value: object): NativeTag | null {
  const tag = tagFromNativeClass(value.constructor);
  if (tag !== null) return tag;

  // Fallback for exotic Error subclasses (e.g. DOMException, custom
  // subclasses with non-standard constructors).
  if (Error.isError(value)) return NATIVE_TAGS.Error;

  return null;
}
