import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  isStorableInstance,
  RECONSTRUCT,
  type ReconstructionContext,
  type StorableInstance,
} from "./storable-protocol.ts";
import type { SerializationContext } from "./serialization-context.ts";
import type { SerializedForm } from "./json-serialization-context.ts";
import { UnknownStorable } from "./unknown-storable.ts";
import { ProblematicStorable } from "./problematic-storable.ts";
import { TAGS } from "./type-tags.ts";

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
   * The handler is responsible for encoding via `context.encode()` and for
   * recursively serializing nested values via the provided `recurse` callback.
   */
  serialize(
    value: StorableValue,
    context: SerializationContext<SerializedForm>,
    recurse: (v: StorableValue) => SerializedForm,
  ): SerializedForm;

  /**
   * Deserialize a value from its wire format state. The state has already been
   * decoded (tag stripped) but inner values have NOT been recursively
   * deserialized -- the handler must call `recurse` on nested values.
   */
  deserialize(
    state: SerializedForm,
    context: SerializationContext<SerializedForm>,
    runtime: ReconstructionContext,
    recurse: (v: SerializedForm) => StorableValue,
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
  state: SerializedForm,
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
    context: SerializationContext<SerializedForm>,
    _recurse: (v: StorableValue) => SerializedForm,
  ): SerializedForm {
    return context.encode(TAGS.Undefined, null);
  },

  deserialize(
    _state: SerializedForm,
    _context: SerializationContext<SerializedForm>,
    _runtime: ReconstructionContext,
    _recurse: (v: SerializedForm) => StorableValue,
  ): StorableValue {
    return undefined;
  },
};

/**
 * Handler for `bigint`. Serializes to `TAGS.BigInt` tag with the string
 * representation as state (since JSON has no native bigint type).
 * Wire format: `{ "/BigInt@1": "12345" }`.
 */
export const BigIntHandler: TypeHandler = {
  tag: TAGS.BigInt,

  canSerialize(value: StorableValue): boolean {
    return typeof value === "bigint";
  },

  serialize(
    value: StorableValue,
    context: SerializationContext<SerializedForm>,
    _recurse: (v: StorableValue) => SerializedForm,
  ): SerializedForm {
    return context.encode(TAGS.BigInt, String(value) as SerializedForm);
  },

  deserialize(
    state: SerializedForm,
    _context: SerializationContext<SerializedForm>,
    _runtime: ReconstructionContext,
    _recurse: (v: SerializedForm) => StorableValue,
  ): StorableValue {
    if (typeof state !== "string") {
      return makeProblematic(
        TAGS.BigInt,
        state,
        `bigint: expected string state, got ${typeof state}`,
      );
    }
    return BigInt(state);
  },
};

/**
 * Handler for `StorableInstance` values (custom protocol types, including
 * `StorableError`, `UnknownStorable`, and `ProblematicStorable`). Serializes
 * via `[DECONSTRUCT]` and the context's tag/encode methods. Deserialization
 * is not dispatched via this handler's tag (since each instance type has its
 * own tag like `TAGS.Error`); instead, the serializer falls back to the
 * class registry for those tags.
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
    context: SerializationContext<SerializedForm>,
    recurse: (v: StorableValue) => SerializedForm,
  ): SerializedForm {
    const inst = value as StorableInstance;

    // UnknownStorable and ProblematicStorable: use preserved typeTag
    // and re-serialize their stored state.
    if (inst instanceof UnknownStorable) {
      const serializedState = recurse(inst.state);
      return context.encode(inst.typeTag, serializedState);
    }
    if (inst instanceof ProblematicStorable) {
      const serializedState = recurse(inst.state);
      return context.encode(inst.typeTag, serializedState);
    }

    // General StorableInstance: use DECONSTRUCT and context for tag.
    const state = inst[DECONSTRUCT]();
    const tag = context.getTagFor(inst);
    const serializedState = recurse(state);
    return context.encode(tag, serializedState);
  },

  deserialize(
    _state: SerializedForm,
    _context: SerializationContext<SerializedForm>,
    _runtime: ReconstructionContext,
    _recurse: (v: SerializedForm) => StorableValue,
  ): StorableValue {
    // Not reached via tag dispatch -- StorableInstance deserialization is
    // handled by the class registry fallback in deserialize().
    throw new Error("StorableInstanceHandler.deserialize should not be called");
  },
};

/**
 * Create a registry with the built-in type handlers. The order matters for
 * serialization: `StorableInstance` is checked first (most specific), then
 * `bigint` and `undefined`. Primitives (null, boolean, number, string),
 * arrays, and plain objects are handled as fallthrough in the serializer
 * after no handler matches.
 */
export function createDefaultRegistry(): TypeHandlerRegistry {
  const registry = new TypeHandlerRegistry();
  // StorableInstance first (most specific -- checked via isStorableInstance brand).
  // This now covers all native wrappers (StorableError, etc.) since they
  // implement StorableInstance.
  registry.register(StorableInstanceHandler);
  // Primitives that need tagged encoding (can't be expressed in JSON natively).
  registry.register(BigIntHandler);
  registry.register(UndefinedHandler);
  return registry;
}
