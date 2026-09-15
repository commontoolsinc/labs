/**
 * The tag vocabulary: the names a dispatch returns when asked what a value
 * already is. The dispatches themselves are in `impl.ts`; this module imports
 * nothing, so that a class which reports a tag of its own can name the
 * vocabulary without reaching the dispatches, which recognize that class.
 */

/**
 * The tags a `FabricPrimitive` reports, one per primitive class this package
 * defines. These are the only tags a `[VALUE_TAG]` getter may return, and the
 * only ones the primitive dispatch accepts from one.
 */
export const FABRIC_PRIMITIVE_VALUE_TAGS = Object.freeze(
  {
    FabricEpochNsec: "FabricEpochNsec",
    FabricEpochDay: "FabricEpochDay",
    FabricHash: "FabricHash",
    FabricBytes: "FabricBytes",
    FabricKeyPair: "FabricKeyPair",
    FabricRegExp: "FabricRegExp",
  } as const,
);

/** One of the `FabricPrimitive` tag strings. */
export type FabricPrimitiveValueTag =
  typeof FABRIC_PRIMITIVE_VALUE_TAGS[keyof typeof FABRIC_PRIMITIVE_VALUE_TAGS];

/**
 * The tags of the JS primitive types (all of them other than `object` and
 * `function`), plus `null`.
 *
 * **Note:** This is intentionally not `export`ed; it's just a convenience for
 * keeping this file DRY-er.
 */
const JS_PRIMITIVE_TYPE_VALUE_TAGS = Object.freeze(
  {
    bigint: "bigint",
    boolean: "boolean",
    null: "null",
    number: "number",
    string: "string",
    symbol: "symbol",
    undefined: "undefined",
  } as const,
);

/**
 * The tags of all JS types other than `object`, plus `null`: the vocabulary of
 * `typeOfIncludingNull()`, less `object`.
 */
export const JS_TYPE_VALUE_TAGS = Object.freeze(
  {
    function: "function",
    ...JS_PRIMITIVE_TYPE_VALUE_TAGS,
  } as const,
);

/** One of the JS type tag strings. */
export type JsTypeValueTag =
  typeof JS_TYPE_VALUE_TAGS[keyof typeof JS_TYPE_VALUE_TAGS];

/** The tags for all primitive types, either JS-builtin or `FabricPrimitive`. */
export const PRIMITIVE_VALUE_TAGS = Object.freeze(
  {
    ...JS_PRIMITIVE_TYPE_VALUE_TAGS,
    FabricEpochNsec: "FabricEpochNsec",
    FabricEpochDay: "FabricEpochDay",
    FabricHash: "FabricHash",
    FabricBytes: "FabricBytes",
    FabricKeyPair: "FabricKeyPair",
    FabricRegExp: "FabricRegExp",
  } as const,
);

/** Tag for any primitive type, either JS-builtin or `FabricPrimitive`. */
export type PrimitiveValueTag =
  typeof PRIMITIVE_VALUE_TAGS[keyof typeof PRIMITIVE_VALUE_TAGS];

/** Tags for all values that could possibly be valid `FabricValue`s. */
export const FABRIC_VALUE_TAGS = Object.freeze(
  {
    Array: "Array",
    FabricInstance: "FabricInstance",
    Object: "Object",
    ...PRIMITIVE_VALUE_TAGS,
  } as const,
);

/** Tag for any value that could possibly be a valid `FabricValue`. */
export type FabricValueTag =
  typeof FABRIC_VALUE_TAGS[keyof typeof FABRIC_VALUE_TAGS];

/**
 * Tags identifying the value types that this system recognizes for dispatch.
 * These are distinct from wire-format `TAGS`.
 *
 * Covers the following:
 * * **JS types**: every primitive and a function, each represented by its
 *   `typeof` name, plus `null`. These are `JS_TYPE_VALUE_TAGS`, which this
 *   table includes whole.
 * * **Native JS builtins**: arrays and plain objects represented by `Array`
 *   and `Object`, and classes represented by their respective names under a
 *   `Js` prefix.
 * * **`FabricPrimitive`s**: classes defined by this package which are
 *   considered equivalent to primitives (always frozen, pass through conversion
 *   unchanged) but aren't under the open-ended `FabricInstance` umbrella. These
 *   are `FABRIC_PRIMITIVE_VALUE_TAGS`, which this table includes whole.
 * * **`FabricInstance`s**: container classes defined by this package, all
 *   represented by the type `FabricInstance`.
 */
export const VALUE_TAGS = Object.freeze(
  {
    Array: "Array",
    FabricInstance: "FabricInstance",
    JsDate: "JsDate",
    JsError: "JsError",
    JsMap: "JsMap",
    JsRegExp: "JsRegExp",
    JsSet: "JsSet",
    JsUint8Array: "JsUint8Array",
    Object: "Object",
    ...FABRIC_PRIMITIVE_VALUE_TAGS,
    ...JS_TYPE_VALUE_TAGS,
  } as const,
);

/** One of the tag strings. */
export type ValueTag = typeof VALUE_TAGS[keyof typeof VALUE_TAGS];
