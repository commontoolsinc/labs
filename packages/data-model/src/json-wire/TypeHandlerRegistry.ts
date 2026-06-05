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
 * Registry of type handlers. Provides tag-based lookup for deserialization
 * and linear-scan matching for serialization.
 */
export class TypeHandlerRegistry {
  /** Ordered list of handlers for serialization matching. */
  readonly #codecs: FabricCodec[] = [];

  /** Tag -> handler map for O(1) deserialization dispatch. */
  readonly #tagMap = new Map<string, FabricCodec>();

  /** Class -> handler map for O(1) serialization dispatch. */
  readonly #classMap = new Map<Constructor, FabricCodec>();

  /**
   * Registers a handler. Handlers with non-empty tags are indexed for O(1)
   * deserialization lookup. Handlers with empty tags (like
   * `FabricInstanceHandler`) participate in serialization matching only.
   */
  register(codec: FabricCodec): void {
    const classSource = codec.uniqueHandledClass;
    if (classSource !== undefined) {
      this.#classMap.set(classSource, codec);
    }

    this.#tagMap.set(codec.wireTypeTag, codec);
    this.#codecs.push(codec);
  }

  /**
   * Finds a codec that can serialize the given value. Returns `undefined`
   * if no handler matches (the caller should fall through to structural
   * handling for primitives, arrays, and plain objects).
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
