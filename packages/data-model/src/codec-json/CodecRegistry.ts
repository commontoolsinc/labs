import type { FabricValue } from "@/interface.ts";
import type { FabricCodec } from "@/codec-common/interface.ts";
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
 * matched by class via {@link CodecRegistry#register}, while admitted callable
 * factories use {@link CodecRegistry#registerCallable}.
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
 * Gets the constructor function ("class") of the given value, if any, for
 * class-based codec lookup.
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
    // This gets the pseudo-constructor of a primitive. Callable factories are
    // returned from the dedicated function branch before reaching this helper.
    return value.constructor as Constructor;
  } else {
    return undefined;
  }
}

/**
 * Registry of `FabricCodec`s. Provides tag-based lookup for decoding, and
 * callable-factory, primitive-type, and class matching for encoding.
 */
export class CodecRegistry {
  /** Tag -> codec map for O(1) decode dispatch. */
  readonly #tagMap = new Map<string, FabricCodec>();

  /** Class -> codec map for O(1) encode dispatch on object values. */
  readonly #classMap = new Map<Constructor, FabricCodec>();

  /** The one codec allowed to inspect callable Fabric values. */
  #callableCodec: FabricCodec | undefined;

  /**
   * Primitive `type` -> codec map for O(1) encode dispatch on primitives.
   */
  readonly #primitiveCodecs = new Map<PrimitiveTypeName, FabricCodec>();

  /**
   * Primitive `type`s that are self-representing (encoded as-is).
   */
  readonly #selfRepTypes = new Set<PrimitiveTypeName>();

  /**
   * Registers a codec, indexing it by its `recognizedTypeTag` (for decode) and
   * its `uniqueHandledClass` (for encode dispatch). Either may be `undefined`,
   * in which case the codec is left unindexed for the corresponding lookup;
   * note that a codec with no `uniqueHandledClass` is unreachable for encoding.
   */
  register(codec: FabricCodec): void {
    const uniqueClass = codec.uniqueHandledClass;
    if (uniqueClass !== undefined) {
      this.#classMap.set(uniqueClass, codec);
    }

    const tag = codec.recognizedTypeTag;
    if (tag !== undefined) {
      this.#tagMap.set(tag, codec);
    }
  }

  /**
   * Registers a codec for a primitive `type` (see {@link PrimitiveTypeName}).
   * Indexes the codec by its `recognizedTypeTag` (for decode) and by `type`
   * (for O(1) encode dispatch on primitives).
   */
  registerPrimitive(type: PrimitiveTypeName, codec: FabricCodec): void {
    this.#primitiveCodecs.set(type, codec);

    const tag = codec.recognizedTypeTag;
    if (tag !== undefined) {
      this.#tagMap.set(tag, codec);
    }
  }

  /**
   * Registers the dedicated callable-factory codec. Functions are not a
   * primitive type and never participate in constructor dispatch; this slot is
   * the only encoding path for callable Fabric values.
   */
  registerCallable(codec: FabricCodec): void {
    this.#callableCodec = codec;

    const tag = codec.recognizedTypeTag;
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
    // Primitive dispatch on the value's primitive `type` key (its `typeof`, or
    // `"null"`). The type's codec is tried first, then self-representation.
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
        const codec = this.#callableCodec;
        if (codec && codec.canEncode(value)) {
          return codec;
        }
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
      // No primitive match -- fall through to the class lookup below.
    }

    // Match by the value's exact constructor.
    const constructorFn = constructorOf(value);
    if (constructorFn) {
      const codec = this.#classMap.get(constructorFn);
      if (codec && codec.canEncode(value)) {
        return codec;
      }
    }

    return undefined;
  }

  /** Looks up a codec by tag for decoding. */
  codecFromTag(typeTag: string): FabricCodec | undefined {
    return this.#tagMap.get(typeTag);
  }
}
