import type { FabricValue } from "../interface.ts";
import type { TypeHandler } from "./json-wire-types.ts";

/**
 * Registry of type handlers. Provides tag-based lookup for deserialization
 * and linear-scan matching for serialization.
 */
export class TypeHandlerRegistry {
  /** Ordered list of handlers for serialization matching. */
  private readonly handlers: TypeHandler[] = [];

  /** Tag -> handler map for O(1) deserialization dispatch. */
  private readonly tagMap = new Map<string, TypeHandler>();

  /** Registers a handler. Handlers with non-empty tags are indexed for
   *  O(1) deserialization lookup. Handlers with empty tags (like
   *  `FabricInstanceHandler`) participate in serialization matching only. */
  register(handler: TypeHandler): void {
    this.handlers.push(handler);
    if (handler.tag !== "") {
      this.tagMap.set(handler.tag, handler);
    }
  }

  /**
   * Finds a handler that can serialize the given value. Returns `undefined`
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

  /** Looks up a handler by tag for deserialization. */
  getDeserializer(tag: string): TypeHandler | undefined {
    return this.tagMap.get(tag);
  }
}
