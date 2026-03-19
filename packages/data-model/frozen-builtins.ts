/**
 * Effectively-immutable wrappers for built-in collection types (`Map`, `Set`).
 * Each extends the native class so `instanceof` checks still pass,
 * but all mutation methods throw. Used by the fabric-value unwrap layer to
 * preserve immutability guarantees across the FabricValue -> native
 * round-trip.
 *
 * See Section 2.9 of the formal spec (frozen built-in types).
 */

// ---------------------------------------------------------------------------
// Shared freeze guard
// ---------------------------------------------------------------------------

/**
 * Throw `TypeError` if `obj` is frozen. Called by mutation overrides in the
 * `Frozen*` classes to enforce immutability.
 */
function throwIfFrozen(obj: object): void {
  if (Object.isFrozen(obj)) {
    throw new TypeError(`Cannot mutate a ${obj.constructor.name}`);
  }
}

// ---------------------------------------------------------------------------
// FrozenMap
// ---------------------------------------------------------------------------

/**
 * Effectively-immutable `Map` wrapper. Extends `Map` so that `instanceof Map`
 * checks still pass, but all mutation methods throw. Returned by
 * `nativeValueFromFabricValue()` for `FabricMap` to preserve the
 * immutability guarantee across the FabricValue -> native round-trip.
 *
 * Uses `Object.freeze(this)` after population; mutation overrides check
 * `Object.isFrozen(this)`.
 */
export class FrozenMap<K, V> extends Map<K, V> {
  constructor(entries?: Iterable<readonly [K, V]> | null) {
    super(entries);
    Object.freeze(this);
  }

  override set(key: K, value: V): this {
    throwIfFrozen(this);
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    throwIfFrozen(this);
    return super.delete(key);
  }

  override clear(): void {
    throwIfFrozen(this);
    super.clear();
  }
}

// ---------------------------------------------------------------------------
// FrozenSet
// ---------------------------------------------------------------------------

/**
 * Effectively-immutable `Set` wrapper. Extends `Set` so that `instanceof Set`
 * checks still pass, but all mutation methods throw. Returned by
 * `nativeValueFromFabricValue()` for `FabricSet` to preserve the
 * immutability guarantee across the FabricValue -> native round-trip.
 *
 * Uses `Object.freeze(this)` after population; mutation overrides check
 * `Object.isFrozen(this)`.
 */
export class FrozenSet<T> extends Set<T> {
  constructor(values?: Iterable<T> | null) {
    super(values);
    Object.freeze(this);
  }

  override add(value: T): this {
    throwIfFrozen(this);
    return super.add(value);
  }

  override delete(value: T): boolean {
    throwIfFrozen(this);
    return super.delete(value);
  }

  override clear(): void {
    throwIfFrozen(this);
    super.clear();
  }
}
