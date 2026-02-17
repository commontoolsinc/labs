import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  isStorable,
  RECONSTRUCT,
  type ReconstructionContext,
  type StorableConverter,
  type StorableInstance,
} from "./storable-protocol.ts";
import type { SerializationContext } from "./serialization-context.ts";
import type { SerializedForm } from "./json-serialization-context.ts";
import { UnknownStorable } from "./unknown-storable.ts";
import { ProblematicStorable } from "./problematic-storable.ts";

/**
 * Interface for per-type serialize/deserialize handlers. Each handler knows
 * how to serialize values of its type and how to deserialize them from a
 * specific tag. Handlers are registered in a `TypeHandlerRegistry`.
 * See Section 4.5 of the formal spec.
 */
export interface TypeHandler {
  /** The wire format tag this handler deserializes from, e.g. `"Error@1"`. */
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
// Built-in type handlers
// ---------------------------------------------------------------------------

/**
 * Handler for `Error` instances. Serializes to `Error@1` tag with name,
 * message, stack, cause, and custom enumerable properties. Deserializes by
 * constructing the appropriate Error subclass. See Section 1.4.1 of the
 * formal spec.
 */
export const ErrorHandler: TypeHandler = {
  tag: "Error@1",

  canSerialize(value: StorableValue): boolean {
    return value instanceof Error;
  },

  serialize(
    value: StorableValue,
    context: SerializationContext<SerializedForm>,
    recurse: (v: StorableValue) => SerializedForm,
  ): SerializedForm {
    const err = value as Error;
    const state: Record<string, SerializedForm> = {
      name: recurse(err.name),
      message: recurse(err.message),
    };
    if (err.stack !== undefined) {
      state.stack = recurse(err.stack);
    }
    if (err.cause !== undefined) {
      state.cause = recurse(err.cause as StorableValue);
    }
    // Copy custom enumerable properties, skipping prototype-sensitive keys.
    for (const key of Object.keys(err)) {
      if (
        !(key in state) && key !== "__proto__" && key !== "constructor"
      ) {
        state[key] = recurse(
          (err as unknown as Record<string, unknown>)[key] as StorableValue,
        );
      }
    }
    return context.encode("Error@1", state as SerializedForm);
  },

  deserialize(
    state: SerializedForm,
    context: SerializationContext<SerializedForm>,
    runtime: ReconstructionContext,
    recurse: (v: SerializedForm) => StorableValue,
  ): StorableValue {
    const s = recurse(state) as Record<string, StorableValue>;

    // In lenient mode, catch reconstruction failures.
    if ("lenient" in context && (context as { lenient: boolean }).lenient) {
      try {
        return ErrorConverter[RECONSTRUCT](s, runtime) as StorableValue;
      } catch (e: unknown) {
        return new ProblematicStorable(
          "Error@1",
          s as unknown as StorableValue,
          e instanceof Error ? e.message : String(e),
        ) as unknown as StorableValue;
      }
    }

    return ErrorConverter[RECONSTRUCT](s, runtime) as StorableValue;
  },
};

/**
 * Converter for `Error@1`. Creates an `Error` (or subclass based on
 * `name`) from the deconstructed state.
 */
export const ErrorConverter: StorableConverter<Error> = {
  [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): Error {
    const s = state as Record<string, StorableValue>;
    const name = (s.name as string) ?? "Error";
    const message = (s.message as string) ?? "";

    // Construct the appropriate Error subclass based on name.
    let error: Error;
    switch (name) {
      case "TypeError":
        error = new TypeError(message);
        break;
      case "RangeError":
        error = new RangeError(message);
        break;
      case "SyntaxError":
        error = new SyntaxError(message);
        break;
      case "ReferenceError":
        error = new ReferenceError(message);
        break;
      case "URIError":
        error = new URIError(message);
        break;
      case "EvalError":
        error = new EvalError(message);
        break;
      default:
        error = new Error(message);
        break;
    }

    // Set name explicitly (covers custom names like "MyError").
    if (error.name !== name) {
      error.name = name;
    }

    if (s.stack !== undefined) {
      error.stack = s.stack as string;
    }
    if (s.cause !== undefined) {
      error.cause = s.cause;
    }

    // Copy custom enumerable properties, skipping prototype-sensitive keys.
    for (const key of Object.keys(s)) {
      if (
        key !== "name" && key !== "message" && key !== "stack" &&
        key !== "cause" && key !== "__proto__" && key !== "constructor"
      ) {
        (error as unknown as Record<string, unknown>)[key] = s[key];
      }
    }

    return error;
  },
};

/**
 * Handler for `undefined`. Serializes to `Undefined@1` tag with `null` state.
 * See Section 1.4.1 of the formal spec.
 */
export const UndefinedHandler: TypeHandler = {
  tag: "Undefined@1",

  canSerialize(value: StorableValue): boolean {
    return value === undefined;
  },

  serialize(
    _value: StorableValue,
    context: SerializationContext<SerializedForm>,
    _recurse: (v: StorableValue) => SerializedForm,
  ): SerializedForm {
    return context.encode("Undefined@1", null);
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
 * Handler for `StorableInstance` values (custom protocol types, including
 * `UnknownStorable` and `ProblematicStorable`). Serializes via `[DECONSTRUCT]`
 * and the context's tag/encode methods. Deserialization for this handler is
 * not used via the tag map (since many tags map to this handler); instead,
 * the serializer falls back to the class registry for unknown tags.
 */
export const StorableInstanceHandler: TypeHandler = {
  // This tag is not used for deserialization dispatch -- StorableInstance
  // types are looked up by their individual tags. The handler is registered
  // for serialization matching only.
  tag: "",

  canSerialize(value: StorableValue): boolean {
    return isStorable(value);
  },

  serialize(
    value: StorableValue,
    context: SerializationContext<SerializedForm>,
    recurse: (v: StorableValue) => SerializedForm,
  ): SerializedForm {
    const inst = value as unknown as StorableInstance;

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
 * Create a registry with all built-in type handlers. The order matters for
 * serialization: `StorableInstance` is checked first (most specific), then
 * `Error`, then `undefined`. Primitives, arrays, and plain objects are
 * handled as fallthrough in the serializer after no handler matches.
 */
export function createDefaultRegistry(): TypeHandlerRegistry {
  const registry = new TypeHandlerRegistry();
  // StorableInstance first (most specific -- checked via isStorable brand).
  registry.register(StorableInstanceHandler);
  // Error before undefined (Error is a broader instanceof check).
  registry.register(ErrorHandler);
  // undefined last among handlers.
  registry.register(UndefinedHandler);
  return registry;
}
