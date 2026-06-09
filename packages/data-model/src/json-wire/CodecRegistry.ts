import type { FabricValue } from "@/interface.ts";
import type { FabricCodec } from "@/wire-common/interface.ts";
import type { Constructor } from "@commonfabric/utils/types";

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
   * Finds a codec that can encode the given value. Returns `undefined` if none
   * matches (the caller should fall through to structural handling for
   * primitives, arrays, and plain objects).
   */
  codecFromValue(value: FabricValue): FabricCodec | undefined {
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
