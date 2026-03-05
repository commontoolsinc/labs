import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  isStorableInstance,
  type ReconstructionContext,
  type StorableInstance,
} from "./storable-protocol.ts";
import { ExplicitTagStorable } from "./explicit-tag-storable.ts";
import { ProblematicStorable } from "./problematic-storable.ts";

/**
 * JSON-compatible wire format value. This is the intermediate tree
 * representation used during serialization tree walking -- NOT the final
 * serialized form (which is `string`). Internal to the JSON implementation.
 */
export type JsonWireValue =
  | null
  | boolean
  | number
  | string
  | JsonWireValue[]
  | { [key: string]: JsonWireValue };
import {
  StorableEpochDays,
  StorableEpochNsec,
} from "./storable-native-instances.ts";
import { TAGS } from "./type-tags.ts";
import {
  bigintFromMinimalTwosComplement,
  bigintToMinimalTwosComplement,
  fromBase64url,
  toUnpaddedBase64url,
} from "./bigint-encoding.ts";

/**
 * Narrow interface for what type handlers need from the encoding context
 * during tree walking. Contains only the tag-wrapping and tag-lookup methods
 * needed by handler serialize/deserialize implementations.
 *
 * This is NOT a public interface -- it exists to type the `codec` parameter
 * passed to type handlers by the internal tree-walking engine.
 */
export interface TypeHandlerCodec {
  /** Wrap a tag and state into the wire format's tagged representation. */
  wrapTag(tag: string, state: JsonWireValue): JsonWireValue;
  /** Get the wire format tag for a storable instance's type. */
  getTagFor(value: StorableInstance): string;
}

/**
 * Interface for per-type serialize/deserialize handlers. Each handler knows
 * how to serialize values of its type and how to deserialize them from a
 * specific tag. Handlers are registered in a `TypeHandlerRegistry`.
 * See Section 4.5 of the formal spec.
 */
export interface TypeHandler {
  /** The wire format tag this handler deserializes from, e.g. `TAGS.Error`. */
  readonly tag: string;

  /**
   * Returns `true` if this handler can serialize the given value. Called
   * during serialization to find the right handler via linear scan. Order
   * matters: more specific handlers should be checked first.
   */
  canSerialize(value: StorableValue): boolean;

  /**
   * Serialize the value. Only called after `canSerialize` returned `true`.
   * The handler is responsible for tag wrapping via `codec.wrapTag()` and for
   * recursively serializing nested values via the provided `recurse` callback.
   */
  serialize(
    value: StorableValue,
    codec: TypeHandlerCodec,
    recurse: (v: StorableValue) => JsonWireValue,
  ): JsonWireValue;

  /**
   * Deserialize a value from its wire format state. The state has already been
   * unwrapped (tag stripped) but inner values have NOT been recursively
   * deserialized -- the handler must call `recurse` on nested values.
   */
  deserialize(
    state: JsonWireValue,
    runtime: ReconstructionContext,
    recurse: (v: JsonWireValue) => StorableValue,
  ): StorableValue;
}

/**
 * Registry of type handlers. Provides tag-based lookup for deserialization
 * and linear-scan matching for serialization.
 */
export class TypeHandlerRegistry {
  /** Ordered list of handlers for serialization matching. */
  private readonly handlers: TypeHandler[] = [];

  /** Tag -> handler map for O(1) deserialization dispatch. */
  private readonly tagMap = new Map<string, TypeHandler>();

  /** Register a handler. Handlers with non-empty tags are indexed for
   *  O(1) deserialization lookup. Handlers with empty tags (like
   *  `StorableInstanceHandler`) participate in serialization matching only. */
  register(handler: TypeHandler): void {
    this.handlers.push(handler);
    if (handler.tag !== "") {
      this.tagMap.set(handler.tag, handler);
    }
  }

  /**
   * Find a handler that can serialize the given value. Returns `undefined`
   * if no handler matches (the caller should fall through to structural
   * handling for primitives, arrays, and plain objects).
   */
  findSerializer(value: StorableValue): TypeHandler | undefined {
    for (const handler of this.handlers) {
      if (handler.canSerialize(value)) {
        return handler;
      }
    }
    return undefined;
  }

  /** Look up a handler by tag for deserialization. */
  getDeserializer(tag: string): TypeHandler | undefined {
    return this.tagMap.get(tag);
  }
}

// ---------------------------------------------------------------------------
// Utility: ProblematicStorable factory
// ---------------------------------------------------------------------------

/**
 * Create a `ProblematicStorable` for a deserialization failure. The type tag
 * is preserved for round-tripping; the message provides human-readable
 * diagnostics.
 */
function makeProblematic(
  tag: string,
  state: JsonWireValue,
  message: string,
): ProblematicStorable {
  return new ProblematicStorable(tag, state as StorableValue, message);
}

// ---------------------------------------------------------------------------
// Built-in type handlers
// ---------------------------------------------------------------------------

/**
 * Handler for `undefined`. Serializes to `TAGS.Undefined` tag with `null`
 * state. See Section 1.4.1 of the formal spec.
 */
export const UndefinedHandler: TypeHandler = {
  tag: TAGS.Undefined,

  canSerialize(value: StorableValue): boolean {
    return value === undefined;
  },

  serialize(
    _value: StorableValue,
    codec: TypeHandlerCodec,
    _recurse: (v: StorableValue) => JsonWireValue,
  ): JsonWireValue {
    return codec.wrapTag(TAGS.Undefined, null);
  },

  deserialize(
    _state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => StorableValue,
  ): StorableValue {
    return undefined;
  },
};

/**
 * Handler for `bigint`. Serializes to `TAGS.BigInt` tag with an unpadded
 * base64 string encoding the bigint's two's-complement big-endian byte
 * representation. Wire format: `{ "/BigInt@1": "<base64>" }`.
 *
 * The byte encoding is the same one used by the canonical hash (Section 3.7
 * of the byte-level spec): minimal two's-complement big-endian, with sign
 * extension as needed.
 */
export const BigIntHandler: TypeHandler = {
  tag: TAGS.BigInt,

  canSerialize(value: StorableValue): boolean {
    return typeof value === "bigint";
  },

  serialize(
    value: StorableValue,
    codec: TypeHandlerCodec,
    _recurse: (v: StorableValue) => JsonWireValue,
  ): JsonWireValue {
    const bytes = bigintToMinimalTwosComplement(value as bigint);
    const b64 = toUnpaddedBase64url(bytes);
    return codec.wrapTag(TAGS.BigInt, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => StorableValue,
  ): StorableValue {
    if (typeof state !== "string") {
      return makeProblematic(
        TAGS.BigInt,
        state,
        `bigint: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      return bigintFromMinimalTwosComplement(bytes);
    } catch {
      return makeProblematic(
        TAGS.BigInt,
        state,
        `bigint: invalid base64: ${state}`,
      );
    }
  },
};

/**
 * Handler for `StorableEpochNsec`. Serializes to a flat base64 string encoding
 * the underlying bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/EpochNsec@1": "<base64>" }`. StorableEpochNsec is a direct
 * member of StorableDatum (not a StorableInstance), so this handler uses
 * `instanceof` directly.
 * See Section 5.3 of the formal spec.
 */
export const EpochNsecHandler: TypeHandler = {
  tag: TAGS.EpochNsec,

  canSerialize(value: StorableValue): boolean {
    return value instanceof StorableEpochNsec;
  },

  serialize(
    value: StorableValue,
    codec: TypeHandlerCodec,
    _recurse: (v: StorableValue) => JsonWireValue,
  ): JsonWireValue {
    const nsec = (value as StorableEpochNsec).value;
    const bytes = bigintToMinimalTwosComplement(nsec);
    const b64 = toUnpaddedBase64url(bytes);
    return codec.wrapTag(TAGS.EpochNsec, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => StorableValue,
  ): StorableValue {
    if (typeof state !== "string") {
      return makeProblematic(
        TAGS.EpochNsec,
        state,
        `EpochNsec: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      const bigint = bigintFromMinimalTwosComplement(bytes);
      return new StorableEpochNsec(bigint) as unknown as StorableValue;
    } catch {
      return makeProblematic(
        TAGS.EpochNsec,
        state,
        `EpochNsec: invalid base64: ${state}`,
      );
    }
  },
};

/**
 * Handler for `StorableEpochDays`. Serializes to a flat base64 string encoding
 * the underlying bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/EpochDays@1": "<base64>" }`. StorableEpochDays is a direct
 * member of StorableDatum (not a StorableInstance), so this handler uses
 * `instanceof` directly. Same flat encoding approach as `EpochNsecHandler`.
 * See Section 5.3 of the formal spec.
 */
export const EpochDaysHandler: TypeHandler = {
  tag: TAGS.EpochDays,

  canSerialize(value: StorableValue): boolean {
    return value instanceof StorableEpochDays;
  },

  serialize(
    value: StorableValue,
    codec: TypeHandlerCodec,
    _recurse: (v: StorableValue) => JsonWireValue,
  ): JsonWireValue {
    const days = (value as StorableEpochDays).value;
    const bytes = bigintToMinimalTwosComplement(days);
    const b64 = toUnpaddedBase64url(bytes);
    return codec.wrapTag(TAGS.EpochDays, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => StorableValue,
  ): StorableValue {
    if (typeof state !== "string") {
      return makeProblematic(
        TAGS.EpochDays,
        state,
        `EpochDays: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      const bigint = bigintFromMinimalTwosComplement(bytes);
      return new StorableEpochDays(bigint) as unknown as StorableValue;
    } catch {
      return makeProblematic(
        TAGS.EpochDays,
        state,
        `EpochDays: invalid base64: ${state}`,
      );
    }
  },
};

/**
 * Handler for `StorableInstance` values (custom protocol types, including
 * `StorableError` and `ExplicitTagStorable` subtypes). Serializes via
 * `[DECONSTRUCT]` and the codec's tag methods. Deserialization is not
 * dispatched via this handler's tag (since each instance type has its own
 * tag like `TAGS.Error`); instead, the deserializer falls back to the class
 * registry for those tags.
 */
export const StorableInstanceHandler: TypeHandler = {
  // This tag is not used for deserialization dispatch -- StorableInstance
  // types are looked up by their individual tags. The handler is registered
  // for serialization matching only.
  tag: "",

  canSerialize(value: StorableValue): boolean {
    return isStorableInstance(value);
  },

  serialize(
    value: StorableValue,
    codec: TypeHandlerCodec,
    recurse: (v: StorableValue) => JsonWireValue,
  ): JsonWireValue {
    const inst = value as StorableInstance;

    // ExplicitTagStorable (UnknownStorable, ProblematicStorable): use
    // preserved typeTag and re-serialize their stored state.
    if (inst instanceof ExplicitTagStorable) {
      const serializedState = recurse(inst.state);
      return codec.wrapTag(inst.typeTag, serializedState);
    }

    // General StorableInstance: use DECONSTRUCT and codec for tag.
    const state = inst[DECONSTRUCT]();
    const tag = codec.getTagFor(inst);
    const serializedState = recurse(state);
    return codec.wrapTag(tag, serializedState);
  },

  deserialize(
    _state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => StorableValue,
  ): StorableValue {
    // Not reached via tag dispatch -- StorableInstance deserialization is
    // handled by the class registry fallback in deserialize().
    throw new Error("StorableInstanceHandler.deserialize should not be called");
  },
};

/**
 * Create a registry with the built-in type handlers. The order matters for
 * serialization: `EpochNsec` and `EpochDays` are checked first (direct
 * StorableDatum members that need `instanceof`-based matching), then
 * `StorableInstance` (generic protocol types), then `bigint` and `undefined`.
 * Primitives (null, boolean, number, string), arrays, and plain objects are
 * handled as fallthrough in the serializer after no handler matches.
 */
export function createDefaultRegistry(): TypeHandlerRegistry {
  const registry = new TypeHandlerRegistry();
  // EpochNsec/EpochDays first -- they are direct StorableDatum members matched
  // by instanceof, and must be checked before the generic StorableInstanceHandler.
  registry.register(EpochNsecHandler);
  registry.register(EpochDaysHandler);
  // StorableInstance (generic -- checked via isStorableInstance brand).
  // Covers StorableError, UnknownStorable, ProblematicStorable, etc.
  registry.register(StorableInstanceHandler);
  // Primitives that need tagged encoding (can't be expressed in JSON natively).
  registry.register(BigIntHandler);
  registry.register(UndefinedHandler);
  return registry;
}
