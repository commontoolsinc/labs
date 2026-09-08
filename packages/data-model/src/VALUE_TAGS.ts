/**
 * The tag vocabulary: the names a dispatch answers with when asked what a
 * value already is.
 *
 * Which classes a given dispatch recognizes varies with where that dispatch is
 * layered -- recognizing a `FabricBytes` means holding the `FabricBytes` class,
 * which not every module can. The vocabulary does not vary, so it is here
 * rather than inside any one of them.
 */

/**
 * Tags identifying the value types that this system recognizes for dispatch.
 * These are distinct from wire-format `TAGS`.
 *
 * Covers the following:
 * * **Native JS builtins**: standard JS types, all represented by the type
 *   `Primitive`.
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
