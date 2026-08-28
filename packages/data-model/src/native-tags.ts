/**
 * The tag vocabulary, and the shape every dispatch that produces one shares.
 *
 * A tag names a value's own class. Which classes a given dispatch recognizes
 * varies with where that dispatch is layered -- recognizing a `FabricBytes`
 * means holding the `FabricBytes` class, which not every module can -- but the
 * vocabulary does not vary, and neither does the step of reading a value's
 * class. Both are here, so that neither has a home implying one dispatch is
 * the real one.
 *
 * Nothing here imports a value from this package, and nothing here knows any
 * class by name. That is the property this file exists to have, and it is worth
 * checking before adding an import.
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

/**
 * The class the given value is an instance of, or `undefined` where there is
 * none to read. This is the intricate step of every tag dispatch, and the only
 * one they can share: which classes are recognizable differs by layer, and the
 * guard rules a dispatch applies before looking are its own, but reading the
 * class is one question with one right answer.
 *
 * The constructor is read from the _prototype_, not from the value. What is
 * being asked is which class the value is an instance of, and that is a fact
 * about its prototype; an own `constructor` property is ordinary data that
 * happens to share the name, and must not decide the value's type. Reading it
 * off the value would let `{constructor: Error}` -- a plain record -- be tagged
 * `Error` and silently rebuilt as one.
 *
 * `undefined` comes back for a null-prototype object, which has no constructor
 * to find, and for an exotic one whose constructor is not callable.
 *
 * @param value The value whose class is wanted.
 */
export function classOfNativeValue(
  value: object,
): { prototype: unknown } | undefined {
  const proto = Object.getPrototypeOf(value);
  const ctor = proto === null ? undefined : proto.constructor;

  return (typeof ctor === "function") ? ctor : undefined;
}
