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
 * Abstract base class for values that participate in the storable protocol.
 * See Section 2.3 of the formal spec.
 *
 * Subclasses must implement:
 * - `[DECONSTRUCT]()` -- returns essential state for serialization.
 * - `shallowUnfrozenClone()` -- returns a new unfrozen copy of this instance.
 *
 * `shallowClone(frozen)` is an effectively-final method that manages the
 * frozenness contract:
 * - `shallowClone(true)` on a frozen instance returns `this` (identity).
 * - `shallowClone(true)` on an unfrozen instance returns a frozen clone.
 * - `shallowClone(false)` always returns a new unfrozen clone -- even if the
 *   instance is already unfrozen. The caller gets a distinct, mutable object.
 */
export abstract class StorableInstance {
  /**
   * Returns the essential state of this instance as a `StorableValue`.
   * Implementations must NOT recursively deconstruct nested values -- the
   * serialization system handles that.
   */
  abstract [DECONSTRUCT](): StorableValue;

  /**
   * Returns a new unfrozen copy of this instance with the same data. Called
   * by `shallowClone()` when a new instance is needed.
   */
  protected abstract shallowUnfrozenClone(): StorableInstance;

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   *
   * When `frozen` is `true` and this instance is already frozen, returns
   * `this` (identity optimization -- freezing is idempotent). In all other
   * cases, creates a new instance via `shallowUnfrozenClone()` and freezes
   * it if requested.
   */
  shallowClone(frozen: boolean): StorableInstance {
    if (frozen && Object.isFrozen(this)) return this;
    const copy = this.shallowUnfrozenClone();
    // Cast needed: Object.freeze() returns Readonly<T>, which TS considers
    // incompatible with abstract class types due to protected members.
    return frozen ? Object.freeze(copy) as StorableInstance : copy;
  }
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
 * Type guard: checks whether a value implements the storable protocol.
 * See Section 2.6 of the formal spec.
 */
export function isStorableInstance(value: unknown): value is StorableInstance {
  return value instanceof StorableInstance;
}

/**
 * Public boundary interface for serialization contexts. Encodes storable
 * values into a serialized form and decodes them back. The type parameter
 * `SerializedForm` is the boundary type: `string` for JSON contexts,
 * `Uint8Array` for binary contexts.
 *
 * This is the only interface external callers need. Internal tree-walking
 * machinery is private to the context implementation.
 */
export interface SerializationContext<SerializedForm = unknown> {
  /** Whether failed reconstructions produce `ProblematicStorable` instead of
   *  throwing. @default false */
  readonly lenient: boolean;

  /** Encode a storable value into serialized form for boundary crossing. */
  encode(value: StorableValue): SerializedForm;

  /** Decode a serialized form back into a storable value. */
  decode(
    data: SerializedForm,
    runtime: ReconstructionContext,
  ): StorableValue;
}
