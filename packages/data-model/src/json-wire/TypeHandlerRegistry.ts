import type { FabricValue } from "../interface.ts";
import type { TypeHandler } from "./interface.ts";

/**
 * Gets the constructor function ("class") of the given value, if any, for the
 * purposes of fast-path lookup.
 */
function constructorOf(
  value: FabricValue,
): ((...args: any[]) => any) | undefined {
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
    return value.constructor as (...args: any[]) => any;
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
  readonly #handlers: TypeHandler[] = [];

  /** Tag -> handler map for O(1) deserialization dispatch. */
  readonly #tagMap = new Map<string, TypeHandler>();

  /** Class -> handler map for O(1) serialization dispatch. */
  readonly #classMap = new Map<(...args: any[]) => any, TypeHandler>();

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
    const constructorFn = constructorOf(value);
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
