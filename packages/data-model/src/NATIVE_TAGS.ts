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
    FabricKeyPair: "FabricKeyPair",
    FabricRegExp: "FabricRegExp",
    FabricInstance: "FabricInstance",
    Primitive: "Primitive",
  } as const,
);

/** One of the native-instance tag strings. */
export type NativeTag = typeof NATIVE_TAGS[keyof typeof NATIVE_TAGS];
