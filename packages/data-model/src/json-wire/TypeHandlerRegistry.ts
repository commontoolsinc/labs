import type { FabricValue } from "../interface.ts";
import type { TypeHandler } from "./interface.ts";

/**
 * Registry of type handlers. Provides tag-based lookup for deserialization
 * and linear-scan matching for serialization.
 */
export class TypeHandlerRegistry {
  /** Ordered list of handlers for serialization matching. */
  readonly #handlers: TypeHandler[] = [];

  /** Tag -> handler map for O(1) deserialization dispatch. */
  readonly #tagMap = new Map<string, TypeHandler>();

  /** Class -> handler map for O(1) serialization dispatch. */
  readonly #classMap = new Map<() => any, TypeHandler>();

  /**
   * Registers a handler. Handlers with non-empty tags are indexed for O(1)
   * deserialization lookup. Handlers with empty tags (like
   * `FabricInstanceHandler`) participate in serialization matching only.
   */
  register(handler: TypeHandler): void {
    this.#handlers.push(handler);

    const classSource = handler.classSource;
    if (classSource !== undefined) {
      this.#classMap.set(classSource, handler);
    }
    const wireTypeTag = handler.wireTypeTag;
    if (wireTypeTag !== undefined) {
      this.#tagMap.set(wireTypeTag, handler);
    }
  }

  /**
   * Finds a handler that can serialize the given value. Returns `undefined`
   * if no handler matches (the caller should fall through to structural
   * handling for primitives, arrays, and plain objects).
   */
  findSerializer(value: FabricValue): TypeHandler | undefined {
    const constructorFn = value?.constructor;
    if (constructorFn) {
      const handler = this.#classMap.get(constructorFn);
      if (handler && handler.canSerialize(value)) {
        return handler;
      }
    }

    for (const handler of this.#handlers) {
      if (handler.canSerialize(value)) {
        return handler;
      }
    }

    return undefined;
  }

  /** Looks up a handler by tag for deserialization. */
  getDeserializer(wireTypeTag: string): TypeHandler | undefined {
    return this.#tagMap.get(wireTypeTag);
  }
}
