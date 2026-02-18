import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  isStorable,
  RECONSTRUCT,
  type ReconstructionContext,
  type StorableInstance,
} from "./storable-protocol.ts";

/**
 * Wrapper for `Error` instances in the storable type system. Bridges native
 * `Error` (JS wild west) into the strongly-typed `StorableValue` layer by
 * implementing `StorableInstance`. The serialization layer handles
 * `StorableError` via the generic `StorableInstanceHandler` path.
 * See Section 1.4.1 of the formal spec.
 */
export class StorableError implements StorableInstance {
  /** The type tag used in the wire format. */
  readonly typeTag = "Error@1";

  constructor(
    /** The wrapped native `Error`. */
    readonly error: Error,
  ) {}

  /**
   * Deconstruct into essential state for serialization. Returns name, message,
   * stack, cause, and custom enumerable properties. Does NOT recurse into
   * nested values -- the serialization system handles that.
   */
  [DECONSTRUCT](): StorableValue {
    const state: Record<string, StorableValue> = {
      name: this.error.name,
      message: this.error.message,
    };
    if (this.error.stack !== undefined) {
      state.stack = this.error.stack;
    }
    if (this.error.cause !== undefined) {
      state.cause = this.error.cause as StorableValue;
    }
    // Copy custom enumerable properties, skipping prototype-sensitive keys.
    for (const key of Object.keys(this.error)) {
      if (
        !(key in state) && key !== "__proto__" && key !== "constructor"
      ) {
        state[key] = (this.error as unknown as Record<string, unknown>)[
          key
        ] as StorableValue;
      }
    }
    return state as StorableValue;
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

    return new StorableError(error);
  }
}

/**
 * Wrapper for `Map` instances. Stub -- `[DECONSTRUCT]` and `[RECONSTRUCT]`
 * throw until Map support is fully implemented.
 */
export class StorableMap implements StorableInstance {
  readonly typeTag = "Map@1";
  constructor(readonly map: Map<StorableValue, StorableValue>) {}

  [DECONSTRUCT](): StorableValue {
    throw new Error("StorableMap: not yet implemented");
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
 * throw until Set support is fully implemented.
 */
export class StorableSet implements StorableInstance {
  readonly typeTag = "Set@1";
  constructor(readonly set: Set<StorableValue>) {}

  [DECONSTRUCT](): StorableValue {
    throw new Error("StorableSet: not yet implemented");
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
 * throw until Date support is fully implemented.
 */
export class StorableDate implements StorableInstance {
  readonly typeTag = "Date@1";
  constructor(readonly date: Date) {}

  [DECONSTRUCT](): StorableValue {
    throw new Error("StorableDate: not yet implemented");
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
 */
export class StorableUint8Array implements StorableInstance {
  readonly typeTag = "Bytes@1";
  constructor(readonly bytes: Uint8Array) {}

  [DECONSTRUCT](): StorableValue {
    throw new Error("StorableUint8Array: not yet implemented");
  }

  static [RECONSTRUCT](
    _state: StorableValue,
    _context: ReconstructionContext,
  ): StorableUint8Array {
    throw new Error("StorableUint8Array: not yet implemented");
  }
}

// ---------------------------------------------------------------------------
// Frozen collection types
// ---------------------------------------------------------------------------

/**
 * Effectively-immutable `Map` wrapper. Extends `Map` so that `instanceof Map`
 * checks still pass, but all mutation methods throw. Returned by
 * `nativeValueFromStorableValue()` for `StorableMap` to preserve the
 * immutability guarantee across the StorableValue -> native round-trip.
 *
 * See Section 2.9 of the formal spec (frozen built-in types).
 */
export class FrozenMap<K, V> extends Map<K, V> {
  #frozen: boolean;

  constructor(entries?: Iterable<readonly [K, V]> | null) {
    // Call super() with no arguments to avoid Map constructor calling
    // this.set() before the #frozen field is initialized.
    super();
    this.#frozen = false;
    if (entries) {
      for (const [k, v] of entries) {
        super.set(k, v);
      }
    }
    this.#frozen = true;
  }

  override set(key: K, value: V): this {
    if (this.#frozen) throw new TypeError("Cannot mutate a FrozenMap");
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    if (this.#frozen) throw new TypeError("Cannot mutate a FrozenMap");
    return super.delete(key);
  }

  override clear(): void {
    if (this.#frozen) throw new TypeError("Cannot mutate a FrozenMap");
    super.clear();
  }
}

/**
 * Effectively-immutable `Set` wrapper. Extends `Set` so that `instanceof Set`
 * checks still pass, but all mutation methods throw. Returned by
 * `nativeValueFromStorableValue()` for `StorableSet` to preserve the
 * immutability guarantee across the StorableValue -> native round-trip.
 *
 * See Section 2.9 of the formal spec (frozen built-in types).
 */
export class FrozenSet<T> extends Set<T> {
  #frozen: boolean;

  constructor(values?: Iterable<T> | null) {
    // Call super() with no arguments to avoid Set constructor calling
    // this.add() before the #frozen field is initialized.
    super();
    this.#frozen = false;
    if (values) {
      for (const v of values) {
        super.add(v);
      }
    }
    this.#frozen = true;
  }

  override add(value: T): this {
    if (this.#frozen) throw new TypeError("Cannot mutate a FrozenSet");
    return super.add(value);
  }

  override delete(value: T): boolean {
    if (this.#frozen) throw new TypeError("Cannot mutate a FrozenSet");
    return super.delete(value);
  }

  override clear(): void {
    if (this.#frozen) throw new TypeError("Cannot mutate a FrozenSet");
    super.clear();
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
 * Note: `bigint` is NOT included here -- it is a primitive (like `undefined`)
 * and belongs directly in `StorableDatum` without wrapping.
 */
export type StorableNativeObject =
  | Error
  | Map<unknown, unknown>
  | Set<unknown>
  | Date
  | Uint8Array;

// ---------------------------------------------------------------------------
// Unwrapping: StorableValue -> native JS types
// ---------------------------------------------------------------------------

/**
 * Shallow unwrap: if the top-level value is a native-wrapping
 * `StorableInstance` (StorableError, StorableMap, etc.), return the
 * underlying native type. Other values (primitives, arrays, objects,
 * non-native `StorableInstance` values) pass through as-is.
 *
 * `StorableMap` -> `FrozenMap`, `StorableSet` -> `FrozenSet` to preserve
 * immutability across the boundary. Error, Date, and Uint8Array are
 * returned as-is (they don't have the same mutation concerns as
 * collections).
 */
export function nativeValueFromStorableValue(
  value: StorableValue,
): unknown {
  if (value instanceof StorableError) return value.error;
  if (value instanceof StorableMap) {
    return new FrozenMap(value.map);
  }
  if (value instanceof StorableSet) {
    return new FrozenSet(value.set);
  }
  if (value instanceof StorableDate) return value.date;
  if (value instanceof StorableUint8Array) return value.bytes;

  return value;
}

/**
 * Deep unwrap: recursively walk a `StorableValue` tree, unwrapping any
 * native-wrapping `StorableInstance` values (StorableError, StorableMap,
 * etc.) to their underlying native types. Arrays and objects are copied
 * (not frozen). Non-native `StorableInstance` values (Cell, Stream,
 * UnknownStorable, etc.) pass through as-is.
 *
 * `StorableMap` -> `FrozenMap`, `StorableSet` -> `FrozenSet` to preserve
 * immutability across the boundary.
 */
export function deepNativeValueFromStorableValue(
  value: StorableValue,
): unknown {
  // Native wrappers -> native types.
  if (value instanceof StorableError) return value.error;
  if (value instanceof StorableMap) return new FrozenMap(value.map);
  if (value instanceof StorableSet) return new FrozenSet(value.set);
  if (value instanceof StorableDate) return value.date;
  if (value instanceof StorableUint8Array) return value.bytes;

  // Other StorableInstance (Cell, Stream, UnknownStorable, etc.) -- pass through.
  if (isStorable(value)) return value;

  // Primitives pass through.
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  // Arrays -- recursively unwrap elements. Output is not frozen.
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        // Preserve sparse holes.
        result.length = i + 1;
      } else {
        result[i] = deepNativeValueFromStorableValue(
          value[i] as StorableValue,
        );
      }
    }
    return result;
  }

  // Objects -- recursively unwrap values. Output is not frozen.
  // Skip prototype-sensitive keys to prevent prototype pollution.
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (key !== "__proto__" && key !== "constructor") {
      result[key] = deepNativeValueFromStorableValue(val as StorableValue);
    }
  }
  return result;
}
