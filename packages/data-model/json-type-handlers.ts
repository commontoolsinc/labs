import type { FabricValue } from "./fabric-value.ts";
import { DECONSTRUCT, type FabricInstance } from "./fabric-instance.ts";
import {
  isFabricInstance,
  type ReconstructionContext,
} from "./fabric-protocol.ts";
import { ExplicitTagValue } from "./explicit-tag-value.ts";
import { ProblematicValue } from "./problematic-value.ts";

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
import { FabricEpochDays, FabricEpochNsec } from "./fabric-epoch.ts";
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
  /** Get the wire format tag for a fabric instance's type. */
  getTagFor(value: FabricInstance): string;
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
  canSerialize(value: FabricValue): boolean;

  /**
   * Serialize the value. Only called after `canSerialize` returned `true`.
   * The handler is responsible for tag wrapping via `codec.wrapTag()` and for
   * recursively serializing nested values via the provided `recurse` callback.
   */
  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue;

  /**
   * Deserialize a value from its wire format state. The state has already been
   * unwrapped (tag stripped) but inner values have NOT been recursively
   * deserialized -- the handler must call `recurse` on nested values.
   */
  deserialize(
    state: JsonWireValue,
    runtime: ReconstructionContext,
    recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue;
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
  findSerializer(value: FabricValue): TypeHandler | undefined {
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
// Utility: ProblematicValue factory
// ---------------------------------------------------------------------------

/**
 * Create a `ProblematicValue` for a deserialization failure. The type tag
 * is preserved for round-tripping; the message provides human-readable
 * diagnostics.
 */
function makeProblematic(
  tag: string,
  state: JsonWireValue,
  message: string,
): ProblematicValue {
  return new ProblematicValue(tag, state as FabricValue, message);
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

  canSerialize(value: FabricValue): boolean {
    return value === undefined;
  },

  serialize(
    _value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    return codec.wrapTag(TAGS.Undefined, null);
  },

  deserialize(
    _state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
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

  canSerialize(value: FabricValue): boolean {
    return typeof value === "bigint";
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const bytes = bigintToMinimalTwosComplement(value as bigint);
    const b64 = toUnpaddedBase64url(bytes);
    return codec.wrapTag(TAGS.BigInt, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
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
 * Handler for `FabricEpochNsec`. Serializes to a flat base64 string encoding
 * the underlying bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/EpochNsec@1": "<base64>" }`. FabricEpochNsec is a direct
 * member of FabricDatum (not a FabricInstance), so this handler uses
 * `instanceof` directly.
 * See Section 5.3 of the formal spec.
 */
export const EpochNsecHandler: TypeHandler = {
  tag: TAGS.EpochNsec,

  canSerialize(value: FabricValue): boolean {
    return value instanceof FabricEpochNsec;
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const nsec = (value as FabricEpochNsec).value;
    const bytes = bigintToMinimalTwosComplement(nsec);
    const b64 = toUnpaddedBase64url(bytes);
    return codec.wrapTag(TAGS.EpochNsec, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
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
      return new FabricEpochNsec(bigint) as unknown as FabricValue;
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
 * Handler for `FabricEpochDays`. Serializes to a flat base64 string encoding
 * the underlying bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/EpochDays@1": "<base64>" }`. FabricEpochDays is a direct
 * member of FabricDatum (not a FabricInstance), so this handler uses
 * `instanceof` directly. Same flat encoding approach as `EpochNsecHandler`.
 * See Section 5.3 of the formal spec.
 */
export const EpochDaysHandler: TypeHandler = {
  tag: TAGS.EpochDays,

  canSerialize(value: FabricValue): boolean {
    return value instanceof FabricEpochDays;
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const days = (value as FabricEpochDays).value;
    const bytes = bigintToMinimalTwosComplement(days);
    const b64 = toUnpaddedBase64url(bytes);
    return codec.wrapTag(TAGS.EpochDays, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
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
      return new FabricEpochDays(bigint) as unknown as FabricValue;
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
 * Handler for `FabricInstance` values (custom protocol types, including
 * `FabricError` and `ExplicitTagValue` subtypes). Serializes via
 * `[DECONSTRUCT]` and the codec's tag methods. Deserialization is not
 * dispatched via this handler's tag (since each instance type has its own
 * tag like `TAGS.Error`); instead, the deserializer falls back to the class
 * registry for those tags.
 */
export const StorableInstanceHandler: TypeHandler = {
  // This tag is not used for deserialization dispatch -- FabricInstance
  // types are looked up by their individual tags. The handler is registered
  // for serialization matching only.
  tag: "",

  canSerialize(value: FabricValue): boolean {
    return isFabricInstance(value);
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const inst = value as FabricInstance;

    // ExplicitTagValue (UnknownValue, ProblematicValue): use
    // preserved typeTag and re-serialize their stored state.
    if (inst instanceof ExplicitTagValue) {
      const serializedState = recurse(inst.state);
      return codec.wrapTag(inst.typeTag, serializedState);
    }

    // General FabricInstance: use DECONSTRUCT and codec for tag.
    const state = inst[DECONSTRUCT]();
    const tag = codec.getTagFor(inst);
    const serializedState = recurse(state);
    return codec.wrapTag(tag, serializedState);
  },

  deserialize(
    _state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    // Not reached via tag dispatch -- FabricInstance deserialization is
    // handled by the class registry fallback in deserialize().
    throw new Error("StorableInstanceHandler.deserialize should not be called");
  },
};

/**
 * Create a registry with the built-in type handlers. The order matters for
 * serialization: `EpochNsec` and `EpochDays` are checked first (direct
 * FabricDatum members that need `instanceof`-based matching), then
 * `FabricInstance` (generic protocol types), then `bigint` and `undefined`.
 * Primitives (null, boolean, number, string), arrays, and plain objects are
 * handled as fallthrough in the serializer after no handler matches.
 */
export function createDefaultRegistry(): TypeHandlerRegistry {
  const registry = new TypeHandlerRegistry();
  // EpochNsec/EpochDays first -- they are direct FabricDatum members matched
  // by instanceof, and must be checked before the generic StorableInstanceHandler.
  registry.register(EpochNsecHandler);
  registry.register(EpochDaysHandler);
  // FabricInstance (generic -- checked via isFabricInstance brand).
  // Covers FabricError, UnknownValue, ProblematicValue, etc.
  registry.register(StorableInstanceHandler);
  // Primitives that need tagged encoding (can't be expressed in JSON natively).
  registry.register(BigIntHandler);
  registry.register(UndefinedHandler);
  return registry;
}
