import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  isStorable,
  RECONSTRUCT,
  type ReconstructionContext,
  type StorableInstance,
} from "./storable-protocol.ts";

// ---------------------------------------------------------------------------
// Utility: safe property copy
// ---------------------------------------------------------------------------

/** Keys that must never be copied to prevent prototype pollution. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor"]);

/**
 * Copy own enumerable properties from `source` to `target`, skipping
 * prototype-sensitive keys (`__proto__`, `constructor`). When `noOverride`
 * is `true`, keys already present on `target` are also skipped.
 */
function copyOwnSafeProperties(
  source: object,
  target: Record<string, unknown>,
  noOverride = false,
): void {
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (noOverride && key in target) continue;
    target[key] = (source as Record<string, unknown>)[key];
  }
}

// ---------------------------------------------------------------------------
// Utility: Error class lookup
// ---------------------------------------------------------------------------

/** Map from Error subclass name to its constructor. */
const ERROR_CLASS_BY_TYPE: ReadonlyMap<string, ErrorConstructor> = new Map([
  ["TypeError", TypeError],
  ["RangeError", RangeError],
  ["SyntaxError", SyntaxError],
  ["ReferenceError", ReferenceError],
  ["URIError", URIError],
  ["EvalError", EvalError],
]);

/**
 * Return the `Error` constructor for the given type string (e.g. `"TypeError"`).
 * Falls back to the base `Error` constructor for unknown types.
 */
function errorClassFromType(type: string): ErrorConstructor {
  return ERROR_CLASS_BY_TYPE.get(type) ?? Error;
}

// ---------------------------------------------------------------------------
// Abstract base class for native-object wrappers
// ---------------------------------------------------------------------------

/**
 * Abstract base class for `StorableInstance` wrappers that bridge native JS
 * objects (Error, Map, Set, Date, Uint8Array) into the `StorableValue` layer.
 * Provides a common `toNativeValue()` method used by both the shallow and
 * deep unwrap functions, replacing their `instanceof` cascades with a single
 * `instanceof StorableNativeWrapper` check.
 */
export abstract class StorableNativeWrapper implements StorableInstance {
  abstract readonly typeTag: string;
  abstract [DECONSTRUCT](): StorableValue;

  /** Return the underlying native value, optionally frozen. */
  abstract toNativeValue(frozen: boolean): unknown;
}

// ---------------------------------------------------------------------------
// StorableError
// ---------------------------------------------------------------------------

/**
 * Wrapper for `Error` instances in the storable type system. Bridges native
 * `Error` (JS wild west) into the strongly-typed `StorableValue` layer by
 * implementing `StorableInstance`. The serialization layer handles
 * `StorableError` via the generic `StorableInstanceHandler` path.
 * See Section 1.4.1 of the formal spec.
 */
export class StorableError extends StorableNativeWrapper {
  /** The type tag used in the wire format. */
  readonly typeTag = "Error@1";

  constructor(
    /** The wrapped native `Error`. */
    readonly error: Error,
  ) {
    super();
  }

  /**
   * Deconstruct into essential state for serialization. Returns type, name,
   * message, stack, cause, and custom enumerable properties. Does NOT recurse
   * into nested values -- the serialization system handles that.
   *
   * `type` is the constructor name (e.g. "TypeError") used for reconstruction.
   * `name` is the `.name` property -- emitted as `null` when it equals `type`
   * (the common case) to avoid redundancy.
   */
  [DECONSTRUCT](): StorableValue {
    const type = this.error.constructor.name;
    const name = this.error.name;
    const state: Record<string, StorableValue> = {
      type,
      name: name === type ? null : name,
      message: this.error.message,
    };
    if (this.error.stack !== undefined) {
      state.stack = this.error.stack;
    }
    if (this.error.cause !== undefined) {
      state.cause = this.error.cause as StorableValue;
    }
    copyOwnSafeProperties(
      this.error,
      state as Record<string, unknown>,
      true,
    );
    return state as StorableValue;
  }

  toNativeValue(frozen: boolean): Error {
    if (frozen) Object.freeze(this.error);
    return this.error;
  }

  /**
   * Reconstruct a `StorableError` from its essential state. Nested values
   * in `state` have already been reconstructed by the serialization system.
   * Returns a `StorableError` wrapping the reconstructed `Error`; callers
   * who need the native `Error` use `nativeValueFromStorableValue()`.
   */
  static [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): StorableError {
    const s = state as Record<string, StorableValue>;
    const type = (s.type as string) ?? (s.name as string) ?? "Error";
    // null name means "same as type" (the common case optimization).
    const name = (s.name as string | null) ?? type;
    const message = (s.message as string) ?? "";

    const ErrorClass = errorClassFromType(type);
    const error = new ErrorClass(message);

    // Set name explicitly (covers custom names like "MyError", and the case
    // where type and name differ).
    if (error.name !== name) {
      error.name = name;
    }

    if (s.stack !== undefined) {
      error.stack = s.stack as string;
    }
    if (s.cause !== undefined) {
      error.cause = s.cause;
    }

    // Copy custom properties from state onto the error.
    const skip = new Set(["type", "name", "message", "stack", "cause"]);
    for (const key of Object.keys(s)) {
      if (!skip.has(key) && !UNSAFE_KEYS.has(key)) {
        (error as unknown as Record<string, unknown>)[key] = s[key];
      }
    }

    return new StorableError(error);
  }
}

// ---------------------------------------------------------------------------
// Stub native wrappers: Map, Set, Date, Uint8Array
// ---------------------------------------------------------------------------

/**
 * Wrapper for `Map` instances. Stub -- `[DECONSTRUCT]` and `[RECONSTRUCT]`
 * throw until Map support is fully implemented. Extra properties beyond the
 * wrapped collection are not supported on non-Error wrappers.
 */
export class StorableMap extends StorableNativeWrapper {
  readonly typeTag = "Map@1";
  constructor(readonly map: Map<StorableValue, StorableValue>) {
    super();
  }

  [DECONSTRUCT](): StorableValue {
    throw new Error("StorableMap: not yet implemented");
  }

  toNativeValue(frozen: boolean): Map<StorableValue, StorableValue> {
    return frozen ? new FrozenMap(this.map) : new Map(this.map);
  }

  static [RECONSTRUCT](
    _state: StorableValue,
    _context: ReconstructionContext,
  ): StorableMap {
    throw new Error("StorableMap: not yet implemented");
  }
}

/**
 * Wrapper for `Set` instances. Stub -- `[DECONSTRUCT]` and `[RECONSTRUCT]`
 * throw until Set support is fully implemented. Extra properties beyond the
 * wrapped collection are not supported on non-Error wrappers.
 */
export class StorableSet extends StorableNativeWrapper {
  readonly typeTag = "Set@1";
  constructor(readonly set: Set<StorableValue>) {
    super();
  }

  [DECONSTRUCT](): StorableValue {
    throw new Error("StorableSet: not yet implemented");
  }

  toNativeValue(frozen: boolean): Set<StorableValue> {
    return frozen ? new FrozenSet(this.set) : new Set(this.set);
  }

  static [RECONSTRUCT](
    _state: StorableValue,
    _context: ReconstructionContext,
  ): StorableSet {
    throw new Error("StorableSet: not yet implemented");
  }
}

/**
 * Wrapper for `Date` instances. Stub -- `[DECONSTRUCT]` and `[RECONSTRUCT]`
 * throw until Date support is fully implemented. Extra properties beyond the
 * wrapped value are not supported on non-Error wrappers.
 */
export class StorableDate extends StorableNativeWrapper {
  readonly typeTag = "Date@1";
  constructor(readonly date: Date) {
    super();
  }

  [DECONSTRUCT](): StorableValue {
    throw new Error("StorableDate: not yet implemented");
  }

  toNativeValue(frozen: boolean): Date {
    return frozen ? new FrozenDate(this.date.getTime()) : this.date;
  }

  static [RECONSTRUCT](
    _state: StorableValue,
    _context: ReconstructionContext,
  ): StorableDate {
    throw new Error("StorableDate: not yet implemented");
  }
}

/**
 * Wrapper for `Uint8Array` instances. Stub -- `[DECONSTRUCT]` and
 * `[RECONSTRUCT]` throw until Uint8Array support is fully implemented.
 * Extra properties beyond the wrapped value are not supported on non-Error
 * wrappers.
 */
export class StorableUint8Array extends StorableNativeWrapper {
  readonly typeTag = "Bytes@1";
  constructor(readonly bytes: Uint8Array) {
    super();
  }

  [DECONSTRUCT](): StorableValue {
    throw new Error("StorableUint8Array: not yet implemented");
  }

  /**
   * When `frozen` is true, returns a `Blob` (immutable by nature) instead of
   * a `Uint8Array` (which `Object.freeze()` cannot protect -- typed arrays
   * allow element mutation even when frozen). Callers must handle the Blob's
   * async API (e.g. `blob.arrayBuffer()`). When `frozen` is false, returns
   * the `Uint8Array` directly.
   */
  toNativeValue(frozen: boolean): Blob | Uint8Array {
    if (frozen) return new Blob([this.bytes as BlobPart]);
    return this.bytes;
  }

  static [RECONSTRUCT](
    _state: StorableValue,
    _context: ReconstructionContext,
  ): StorableUint8Array {
    throw new Error("StorableUint8Array: not yet implemented");
  }
}

// ---------------------------------------------------------------------------
// Frozen built-in types
// ---------------------------------------------------------------------------

/**
 * Effectively-immutable `Map` wrapper. Extends `Map` so that `instanceof Map`
 * checks still pass, but all mutation methods throw. Returned by
 * `nativeValueFromStorableValue()` for `StorableMap` to preserve the
 * immutability guarantee across the StorableValue -> native round-trip.
 *
 * Uses `Object.freeze(this)` after population; mutation overrides check
 * `Object.isFrozen(this)`.
 *
 * See Section 2.9 of the formal spec (frozen built-in types).
 */
export class FrozenMap<K, V> extends Map<K, V> {
  constructor(entries?: Iterable<readonly [K, V]> | null) {
    super();
    if (entries) {
      for (const [k, v] of entries) {
        super.set(k, v);
      }
    }
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

/**
 * Effectively-immutable `Set` wrapper. Extends `Set` so that `instanceof Set`
 * checks still pass, but all mutation methods throw. Returned by
 * `nativeValueFromStorableValue()` for `StorableSet` to preserve the
 * immutability guarantee across the StorableValue -> native round-trip.
 *
 * Uses `Object.freeze(this)` after population; mutation overrides check
 * `Object.isFrozen(this)`.
 *
 * See Section 2.9 of the formal spec (frozen built-in types).
 */
export class FrozenSet<T> extends Set<T> {
  constructor(values?: Iterable<T> | null) {
    super();
    if (values) {
      for (const v of values) {
        super.add(v);
      }
    }
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

/**
 * Effectively-immutable `Date` wrapper. Extends `Date` so that
 * `instanceof Date` checks still pass, but all `set*()` mutation methods
 * throw. `Object.freeze()` alone cannot protect Date because the mutators
 * modify the internal `[[DateValue]]` slot, not own properties.
 *
 * See Section 2.9 of the formal spec (frozen built-in types).
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
}

// ---------------------------------------------------------------------------
// StorableNativeObject type
// ---------------------------------------------------------------------------

/**
 * Union of raw native JS **object** types that the storable type system can
 * convert into `StorableInstance` wrappers. These are the inputs to the
 * "sausage grinder" -- `toStorableValue()` accepts
 * `StorableValue | StorableNativeObject`, meaning callers can pass in either
 * already-storable data or raw native JS objects. The conversion produces
 * `StorableInstance` wrappers (StorableError, StorableMap, etc.) that live
 * inside `StorableValue` via the `StorableInstance` arm of `StorableDatum`.
 *
 * `Blob` is included because `StorableUint8Array.toNativeValue(true)` returns
 * a `Blob` (immutable by nature) instead of a `Uint8Array`. The synchronous
 * serialization path throws on `Blob` since its data access methods are async.
 *
 * Note: `bigint` is NOT included here -- it is a primitive (like `undefined`)
 * and belongs directly in `StorableDatum` without wrapping.
 */
export type StorableNativeObject =
  | Error
  | Map<unknown, unknown>
  | Set<unknown>
  | Date
  | Uint8Array
  | Blob;

// ---------------------------------------------------------------------------
// Unwrapping: StorableValue -> native JS types
// ---------------------------------------------------------------------------

/**
 * Shallow unwrap: if the top-level value is a `StorableNativeWrapper`, call
 * its `toNativeValue()` method. Other values (primitives, arrays, objects,
 * non-native `StorableInstance` values) pass through as-is.
 *
 * When `frozen` is true (the default), collections are returned as FrozenMap /
 * FrozenSet. When false, mutable copies are returned instead.
 */
export function nativeValueFromStorableValue(
  value: StorableValue,
  frozen = true,
): unknown {
  if (value instanceof StorableNativeWrapper) {
    return value.toNativeValue(frozen);
  }
  return value;
}

/**
 * Deep unwrap: recursively walk a `StorableValue` tree, unwrapping any
 * `StorableNativeWrapper` values to their underlying native types via
 * `toNativeValue()`. Arrays and objects are copied (not frozen). Non-native
 * `StorableInstance` values (Cell, Stream, UnknownStorable, etc.) pass
 * through as-is.
 *
 * When `frozen` is true (the default), collections are returned as FrozenMap /
 * FrozenSet. When false, mutable copies are returned instead.
 */
export function deepNativeValueFromStorableValue(
  value: StorableValue,
  frozen = true,
): unknown {
  // Native wrappers -> native types.
  if (value instanceof StorableNativeWrapper) {
    return value.toNativeValue(frozen);
  }

  // Other StorableInstance (Cell, Stream, UnknownStorable, etc.) -- pass through.
  if (isStorable(value)) return value;

  // Storable primitives (null, undefined, boolean, number, string, bigint)
  // pass through. Note: `symbol` and `function` are NOT storable and cannot
  // reach here because the `StorableValue` type excludes them.
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  // Arrays -- recursively unwrap elements.
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        // Preserve sparse holes.
        result.length = i + 1;
      } else {
        result[i] = deepNativeValueFromStorableValue(
          value[i] as StorableValue,
          frozen,
        );
      }
    }
    return result;
  }

  // Objects -- recursively unwrap values.
  // Skip prototype-sensitive keys to prevent prototype pollution.
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!UNSAFE_KEYS.has(key)) {
      result[key] = deepNativeValueFromStorableValue(
        val as StorableValue,
        frozen,
      );
    }
  }
  return result;
}
