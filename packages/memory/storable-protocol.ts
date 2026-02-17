import type { StorableValue } from "./interface.ts";

/**
 * Well-known symbol for deconstructing a storable instance into its essential
 * state. The returned value may contain nested `StorableValue`s (including
 * other `StorableInstance`s); the serialization system handles recursion.
 * See Section 2.2 of the formal spec.
 */
export const DECONSTRUCT: unique symbol = Symbol.for("common.deconstruct");

/**
 * Well-known symbol for reconstructing a storable instance from its essential
 * state. Static method on the class.
 * See Section 2.2 of the formal spec.
 */
export const RECONSTRUCT: unique symbol = Symbol.for("common.reconstruct");

/**
 * A value that knows how to deconstruct itself into essential state for
 * serialization. The presence of `[DECONSTRUCT]` serves as the brand -- no
 * separate marker is needed. See Section 2.3 of the formal spec.
 */
export interface StorableInstance {
  /**
   * Returns the essential state of this instance as a `StorableValue`.
   * Implementations must NOT recursively deconstruct nested values -- the
   * serialization system handles that.
   */
  [DECONSTRUCT](): StorableValue;
}

/**
 * A class that can reconstruct storable instances from essential state. The
 * static `[RECONSTRUCT]` method is separate from the constructor to support
 * reconstruction-specific context and instance interning.
 * See Section 2.4 of the formal spec.
 */
export interface StorableClass<T extends StorableInstance> {
  /**
   * Reconstruct an instance from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system. May return
   * an existing instance (interning) rather than creating a new one.
   */
  [RECONSTRUCT](state: StorableValue, context: ReconstructionContext): T;
}

/**
 * A converter that can reconstruct arbitrary values (not necessarily
 * `StorableInstance`s) from essential state. Used for built-in JS types like
 * `Error` that participate in the serialization protocol but don't implement
 * `StorableInstance`. See Section 1.4.1 of the formal spec.
 */
export interface StorableConverter<T> {
  /**
   * Reconstruct a value from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system.
   */
  [RECONSTRUCT](state: StorableValue, context: ReconstructionContext): T;
}

/**
 * The minimal interface that `[RECONSTRUCT]` implementations may depend on.
 * Provided by the `Runtime` in practice, but defined as an interface here to
 * avoid a circular dependency between the storable protocol and the runner.
 * See Section 2.5 of the formal spec.
 */
export interface ReconstructionContext {
  /** Resolve a cell reference. Used by types that need to intern or look up
   *  existing instances during reconstruction. */
  getCell(
    ref: { id: string; path: string[]; space: string },
  ): StorableInstance;
}

/**
 * Type guard: checks whether a value implements the storable protocol. The
 * presence of `[DECONSTRUCT]` is the brand. See Section 2.6 of the formal spec.
 */
export function isStorable(value: unknown): value is StorableInstance {
  return value != null &&
    typeof value === "object" &&
    DECONSTRUCT in value;
}
