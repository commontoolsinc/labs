import type { FabricValue } from "@/interface.ts";
import type { FabricCodec } from "@/wire-common/interface.ts";
import type { Constructor } from "@commonfabric/utils/types";

/**
 * Sentinel returned by {@link CodecRegistry#codecFromValue} for a
 * self-representing value -- one that is its own wire form (encoded as-is, with
 * no codec and no tag).
 */
export const SELF_REP = "self-rep" as const;

/**
 * The primitive `type` keys the registry accepts: the `typeof` results that are
 * encodable `FabricValue` primitives, plus `"null"` for the `null` value.
 * `"object"` and `"function"` are deliberately excluded -- object values are
 * matched by class via {@link CodecRegistry#register}.
 */
export type PrimitiveTypeName =
  | "null"
  | "undefined"
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "symbol";

/**
 * Gets the constructor function ("class") of the given value, if any, for the
 * purposes of fast-path lookup.
 */
function constructorOf(
  value: FabricValue,
): Constructor | undefined {
  if (typeof value === "object") {
    if (value === null) {
      return undefined;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto === null) {
      return undefined;
    }

    return proto.constructor;
  } else if (value !== undefined) {
    // This gets the pseudo-constructor of a primitive. **Note:** `function` is
    // not included in the `FabricValue` union.
    return value.constructor as Constructor;
  } else {
    return undefined;
  }
}

/**
 * Registry of `FabricCodec`s. Provides tag-based lookup for decoding and
 * class-fast-path / linear-scan matching for encoding.
 */
export class CodecRegistry {
  /** Ordered list of codecs, scanned for encode matching. */
  readonly #codecs: FabricCodec[] = [];

  /** Tag -> codec map for O(1) decode dispatch. */
  readonly #tagMap = new Map<string, FabricCodec>();

  /** Class -> codec map for the O(1) encode fast path. */
  readonly #classMap = new Map<Constructor, FabricCodec>();

  /**
   * Primitive `type` -> codec map for the O(1) encode fast path on primitives.
   */
  readonly #primitiveCodecs = new Map<PrimitiveTypeName, FabricCodec>();

  /**
   * Primitive `type`s that are self-representing (encoded as-is).
   */
  readonly #selfRepTypes = new Set<PrimitiveTypeName>();

  /**
   * Registers a codec, indexing it by its `wireTypeTag` (for decode) and its
   * `uniqueHandledClass` (for encode). If either is `undefined`, then the codec
   * is left unregistered with the corresponding index. And whether or not it
   * has something `undefined`, it is added to the ordered list used by the
   * encode linear scan.
   */
  register(codec: FabricCodec): void {
    const uniqueClass = codec.uniqueHandledClass;
    if (uniqueClass !== undefined) {
      this.#classMap.set(uniqueClass, codec);
    }

    const tag = codec.wireTypeTag;
    if (tag !== undefined) {
      this.#tagMap.set(tag, codec);
    }
    this.#codecs.push(codec);
  }

  /**
   * Registers a codec for a primitive `type` (see {@link PrimitiveTypeName}).
   * Indexes the codec by its `wireTypeTag` (for decode) and by `type` (for the
   * O(1) encode fast path on primitives).
   */
  registerPrimitive(type: PrimitiveTypeName, codec: FabricCodec): void {
    this.#primitiveCodecs.set(type, codec);

    const tag = codec.wireTypeTag;
    if (tag !== undefined) {
      this.#tagMap.set(tag, codec);
    }
  }

  /**
   * Registers a primitive `type` (see {@link PrimitiveTypeName}) as
   * self-representing: a value of that type is its own wire form, so
   * {@link #codecFromValue} returns {@link SELF_REP} for it. A type may be both
   * self-representing and have a {@link #registerPrimitive} codec (e.g.
   * `"number"`: finite numbers are self-representing, special ones go through a
   * codec); the codec is tried first.
   */
  registerSelfRep(type: PrimitiveTypeName): void {
    this.#selfRepTypes.add(type);
  }

  /**
   * Finds how to encode the given value: a `FabricCodec` that can encode it,
   * {@link SELF_REP} if it is a self-representing primitive, or `undefined` if
   * neither matches (the caller falls through to structural handling for
   * arrays and plain objects, or fails for an unencodable value).
   */
  codecFromValue(
    value: FabricValue,
  ): FabricCodec | typeof SELF_REP | undefined {
    // Primitive fast path: dispatch on the value's primitive `type` key (its
    // `typeof`, or `"null"`). The type's codec is tried first, then
    // self-representation.
    let type: PrimitiveTypeName | undefined;
    const valueType = typeof value;
    switch (valueType) {
      case "bigint":
      case "boolean":
      case "number":
      case "string":
      case "symbol":
      case "undefined": {
        type = valueType;
        break;
      }
      case "object": {
        if (value === null) {
          type = "null";
        }
        break;
      }
      case "function": {
        // Not a `FabricValue`; nothing can encode it.
        return undefined;
      }
    }

    if (type !== undefined) {
      const codec = this.#primitiveCodecs.get(type);
      if (codec && codec.canEncode(value)) {
        return codec;
      }
      if (this.#selfRepTypes.has(type)) {
        return SELF_REP;
      }
      // No primitive match -- fall through to the class/scan below (retained
      // for now; primitives in the default registry never reach it).
    }

    // Class fast-path, then linear scan.
    const constructorFn = constructorOf(value);
    if (constructorFn) {
      const codec = this.#classMap.get(constructorFn);
      if (codec && codec.canEncode(value)) {
        return codec;
      }
    }

    for (const codec of this.#codecs) {
      if (codec.canEncode(value)) {
        return codec;
      }
    }

    return undefined;
  }

  /** Looks up a codec by tag for decoding. */
  codecFromTag(wireTypeTag: string): FabricCodec | undefined {
    return this.#tagMap.get(wireTypeTag);
  }
}
