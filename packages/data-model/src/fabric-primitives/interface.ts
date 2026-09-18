/**
 * The vocabularies that range over the concrete primitive classes, one entry
 * per class in each: the tag a class reports to the `tagOf*()` dispatches, the
 * tag its codec writes to the wire, and the name it has in the schema `type`
 * vocabulary. They are nominally distinct, and an entry in one need not match
 * the class's entry in another. Adding a primitive means adding to each, and
 * they sit together so that one visit does it.
 *
 * The schema `type` vocabulary is defined in `api.ts` and re-exported here. A
 * pattern compiles against that module, which can import nothing, and the
 * `FabricPrimitive` declaration there names the vocabulary's type.
 *
 * This module's one import is `api.ts`, which imports nothing, so that any
 * module can import this one without creating a circular dependency. The
 * classes themselves import it, which is why the list of them is in `index.ts`
 * and not here.
 */

export {
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  type FabricPrimitiveSchemaType,
  isFabricPrimitiveSchemaType,
} from "@/api.ts";

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
    FabricUnavailable: "FabricUnavailable",
  } as const,
);

/** One of the `FabricPrimitive` tag strings. */
export type FabricPrimitiveValueTag =
  typeof FABRIC_PRIMITIVE_VALUE_TAGS[keyof typeof FABRIC_PRIMITIVE_VALUE_TAGS];

/**
 * Canonical codec tags for the primitive classes, in `<Type>@<Version>` form.
 * These tags are for wire formats in which instances of (one or more of) these
 * classes have no protocol-specific form. `CODEC_TYPE_TAGS` includes them all.
 */
export const FABRIC_PRIMITIVE_CODEC_TYPE_TAGS = Object.freeze(
  {
    /** Constant for class `FabricBytes`. */
    Bytes: "Bytes@1",

    /** Constant for class `FabricEpochDay`. */
    EpochDay: "EpochDay@1",

    /** Constant for class `FabricEpochNsec`. */
    EpochNsec: "EpochNsec@1",

    /** Constant for class `FabricHash`. */
    Hash: "Hash@1",

    /** Constant for class `FabricKeyPair`. */
    KeyPair: "KeyPair@1",

    /** Constant for class `FabricRegExp`. */
    RegExp: "RegExp@1",

    /** Constant for class `FabricUnavailable`. */
    Unavailable: "Unavailable@1",
  } as const,
);
