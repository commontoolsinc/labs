import type { FabricValue } from "./fabric-value.ts";

/**
 * Well-known symbol for deconstructing a fabric instance into its essential
 * state. The returned value may contain nested `FabricValue`s (including
 * other `FabricInstance`s); the serialization system handles recursion.
 * See Section 2.2 of the formal spec.
 */
export const DECONSTRUCT: unique symbol = Symbol.for("common.deconstruct");

/**
 * Well-known symbol for reconstructing a fabric instance from its essential
 * state. Static method on the class.
 * See Section 2.2 of the formal spec.
 */
export const RECONSTRUCT: unique symbol = Symbol.for("common.reconstruct");

/**
 * Abstract base class for values that participate in the fabric protocol.
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
export abstract class FabricInstance {
  /**
   * Returns the essential state of this instance as a `FabricValue`.
   * Implementations must NOT recursively deconstruct nested values -- the
   * serialization system handles that.
   */
  abstract [DECONSTRUCT](): FabricValue;

  /**
   * Returns a new unfrozen copy of this instance with the same data. Called
   * by `shallowClone()` when a new instance is needed.
   */
  protected abstract shallowUnfrozenClone(): FabricInstance;

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   *
   * When `frozen` is `true` and this instance is already frozen, returns
   * `this` (identity optimization -- freezing is idempotent). In all other
   * cases, creates a new instance via `shallowUnfrozenClone()` and freezes
   * it if requested.
   */
  shallowClone(frozen: boolean): FabricInstance {
    if (frozen && Object.isFrozen(this)) return this;
    const copy = this.shallowUnfrozenClone();
    // Cast needed: Object.freeze() returns Readonly<T>, which TS considers
    // incompatible with abstract class types due to protected members.
    return frozen ? Object.freeze(copy) as FabricInstance : copy;
  }
}

/**
 * Type guard: checks whether a value implements the fabric protocol.
 * See Section 2.6 of the formal spec.
 */
export function isFabricInstance(value: unknown): value is FabricInstance {
  return value instanceof FabricInstance;
}
