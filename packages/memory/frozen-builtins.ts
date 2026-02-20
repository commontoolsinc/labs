/**
 * Effectively-immutable wrappers for built-in collection types (`Map`, `Set`,
 * `Date`). Each extends the native class so `instanceof` checks still pass,
 * but all mutation methods throw. Used by the storable-value unwrap layer to
 * preserve immutability guarantees across the StorableValue -> native
 * round-trip.
 *
 * See Section 2.9 of the formal spec (frozen built-in types).
 */

// ---------------------------------------------------------------------------
// FrozenMap
// ---------------------------------------------------------------------------

/**
 * Effectively-immutable `Map` wrapper. Extends `Map` so that `instanceof Map`
 * checks still pass, but all mutation methods throw. Returned by
 * `nativeValueFromStorableValue()` for `StorableMap` to preserve the
 * immutability guarantee across the StorableValue -> native round-trip.
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
    if (Object.isFrozen(this)) throw new TypeError("Cannot mutate a FrozenMap");
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    if (Object.isFrozen(this)) throw new TypeError("Cannot mutate a FrozenMap");
    return super.delete(key);
  }

  override clear(): void {
    if (Object.isFrozen(this)) throw new TypeError("Cannot mutate a FrozenMap");
    super.clear();
  }
}

// ---------------------------------------------------------------------------
// FrozenSet
// ---------------------------------------------------------------------------

/**
 * Effectively-immutable `Set` wrapper. Extends `Set` so that `instanceof Set`
 * checks still pass, but all mutation methods throw. Returned by
 * `nativeValueFromStorableValue()` for `StorableSet` to preserve the
 * immutability guarantee across the StorableValue -> native round-trip.
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
    if (Object.isFrozen(this)) throw new TypeError("Cannot mutate a FrozenSet");
    return super.add(value);
  }

  override delete(value: T): boolean {
    if (Object.isFrozen(this)) {
      throw new TypeError("Cannot mutate a FrozenSet");
    }
    return super.delete(value);
  }

  override clear(): void {
    if (Object.isFrozen(this)) throw new TypeError("Cannot mutate a FrozenSet");
    super.clear();
  }
}

// ---------------------------------------------------------------------------
// FrozenDate
// ---------------------------------------------------------------------------

/**
 * Effectively-immutable `Date` wrapper. Extends `Date` so that
 * `instanceof Date` checks still pass, but all `set*()` mutation methods
 * throw. `Object.freeze()` alone cannot protect Date because the mutators
 * modify the internal `[[DateValue]]` slot, not own properties.
 */
export class FrozenDate extends Date {
  constructor(value: number | string | Date) {
    super(value instanceof Date ? value.getTime() : value);
    Object.freeze(this);
  }

  #throw(): never {
    throw new TypeError("Cannot mutate a FrozenDate");
  }

  override setTime(_time: number): number {
    this.#throw();
  }
  override setMilliseconds(_ms: number): number {
    this.#throw();
  }
  override setUTCMilliseconds(_ms: number): number {
    this.#throw();
  }
  override setSeconds(_sec: number, _ms?: number): number {
    this.#throw();
  }
  override setUTCSeconds(_sec: number, _ms?: number): number {
    this.#throw();
  }
  override setMinutes(_min: number, _sec?: number, _ms?: number): number {
    this.#throw();
  }
  override setUTCMinutes(_min: number, _sec?: number, _ms?: number): number {
    this.#throw();
  }
  override setHours(
    _hours: number,
    _min?: number,
    _sec?: number,
    _ms?: number,
  ): number {
    this.#throw();
  }
  override setUTCHours(
    _hours: number,
    _min?: number,
    _sec?: number,
    _ms?: number,
  ): number {
    this.#throw();
  }
  override setDate(_date: number): number {
    this.#throw();
  }
  override setUTCDate(_date: number): number {
    this.#throw();
  }
  override setMonth(_month: number, _date?: number): number {
    this.#throw();
  }
  override setUTCMonth(_month: number, _date?: number): number {
    this.#throw();
  }
  override setFullYear(
    _year: number,
    _month?: number,
    _date?: number,
  ): number {
    this.#throw();
  }
  override setUTCFullYear(
    _year: number,
    _month?: number,
    _date?: number,
  ): number {
    this.#throw();
  }
  /** @deprecated Legacy method; guarded for completeness. */
  setYear(_year: number): number {
    this.#throw();
  }
}
