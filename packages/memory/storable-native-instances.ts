import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  isStorableInstance,
  RECONSTRUCT,
  type ReconstructionContext,
  type StorableInstance,
} from "./storable-protocol.ts";
import { TAGS } from "./type-tags.ts";
import { FrozenDate, FrozenMap, FrozenSet } from "./frozen-builtins.ts";

// ---------------------------------------------------------------------------
// Utility: native-instance type guard
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the value is a native JS object type that the storable
 * system knows how to wrap (Error, Map, Set, Date, Uint8Array). These are
 * the "wild-west" instances that get converted into `StorableNativeWrapper`
 * subclasses by the conversion layer.
 */
export function isConvertibleNativeInstance(value: object): boolean {
  return (
    Error.isError(value) ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Date ||
    value instanceof Uint8Array
  );
}

// ---------------------------------------------------------------------------
// Utility: safe property copy
// ---------------------------------------------------------------------------

/** Keys that must never be copied to prevent prototype pollution. */
export const UNSAFE_KEYS: FrozenSet<string> = new FrozenSet([
  "__proto__",
  "constructor",
]);

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
// Utility: freeze-state matching
// ---------------------------------------------------------------------------

/**
 * Return `value` if its freeze state already matches `frozen`, otherwise
 * shallow-copy via `copy` and optionally freeze the result. This is the
 * common "match frozenness" pattern used by `toNativeValue()` implementations:
 * never mutate the original, create a copy only when the freeze state differs.
 */
function matchFrozenness<T extends object>(
  value: T,
  frozen: boolean,
  copy: (v: T) => T,
): T {
  const isFrozen = Object.isFrozen(value);
  if (frozen === isFrozen) return value;
  const result = copy(value);
  if (frozen) Object.freeze(result);
  return result;
}

/**
 * Create a shallow copy of an Error, preserving constructor, name, message,
 * stack, cause, and custom enumerable properties. Used by `toNativeValue()`
 * when the freeze state of the wrapped Error doesn't match the requested state.
 */
function copyError(error: Error): Error {
  const copy = new (error.constructor as ErrorConstructor)(error.message);
  if (copy.name !== error.name) copy.name = error.name;
  if (error.stack !== undefined) copy.stack = error.stack;
  if (error.cause !== undefined) copy.cause = error.cause;
  copyOwnSafeProperties(
    error,
    copy as unknown as Record<string, unknown>,
    true,
  );
  return copy;
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
  /** The type tag used in the wire format (`TAGS.Error`). */
  readonly typeTag = TAGS.Error;

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
   *
   * **Invariant**: By the time this method runs, `this.error.cause` and any
   * custom enumerable properties are already `StorableValue`. The conversion
   * layer (`convertErrorInternals()` in `rich-storable-value.ts`) ensures
   * this by recursively converting Error internals before wrapping in
   * `StorableError`. The `as StorableValue` casts below are therefore safe.
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
    return matchFrozenness(this.error, frozen, copyError);
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
  readonly typeTag = TAGS.Map;
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
  readonly typeTag = TAGS.Set;
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
  readonly typeTag = TAGS.Date;
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
  readonly typeTag = TAGS.Bytes;
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
// Unwrapping: StorableValue -> native JS types
// ---------------------------------------------------------------------------

/**
 * Shallow unwrap: if the top-level value is a `StorableNativeWrapper`, call
 * its `toNativeValue()` method. Other values (primitives, arrays, objects,
 * non-native `StorableInstance` values) pass through as-is, but their freeze
 * state is adjusted to match the `frozen` argument.
 *
 * The freeze-state contract: the output's freeze state ALWAYS matches `frozen`.
 * - `frozen === true` and value is already frozen -> return as-is.
 * - `frozen === true` and value is unfrozen -> return a frozen copy.
 * - `frozen === false` and value is frozen -> return an unfrozen copy.
 * - `frozen === false` and value is unfrozen -> return as-is.
 * Primitives are inherently immutable and always pass through unchanged.
 */
export function nativeValueFromStorableValue(
  value: StorableValue,
  frozen = true,
): unknown {
  if (value instanceof StorableNativeWrapper) {
    return value.toNativeValue(frozen);
  }

  // Primitives (null, undefined, boolean, number, string, bigint) are
  // inherently immutable -- no freeze adjustment needed.
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  // Non-native StorableInstance values (Cell, Stream, UnknownStorable, etc.)
  // pass through unchanged -- spreading would strip their prototype/methods,
  // and their freeze state is an internal concern of the wrapper.
  if (isStorableInstance(value)) return value;

  // For arrays and plain objects: ensure the freeze state matches `frozen`.
  const isFrozen = Object.isFrozen(value);
  if (frozen === isFrozen) return value; // already matches

  if (frozen) {
    // Value is unfrozen but caller wants frozen -> freeze a shallow copy.
    if (Array.isArray(value)) {
      return Object.freeze([...value]);
    }
    return Object.freeze({ ...value });
  }

  // Value is frozen but caller wants unfrozen -> shallow copy.
  if (Array.isArray(value)) {
    return [...value];
  }
  return { ...(value as Record<string, unknown>) };
}

/**
 * Deep unwrap: recursively walk a `StorableValue` tree, unwrapping any
 * `StorableNativeWrapper` values to their underlying native types via
 * `toNativeValue()`. Non-native `StorableInstance` values (Cell, Stream,
 * UnknownStorable, etc.) pass through as-is.
 *
 * The freeze-state contract: the output's freeze state ALWAYS matches `frozen`.
 * Arrays and objects are copied and frozen/unfrozen accordingly. For
 * `StorableError`, the inner Error's `cause` and custom properties are also
 * recursively unwrapped (since they may contain `StorableInstance` wrappers).
 *
 * When `frozen` is true (the default), collections are returned as FrozenMap /
 * FrozenSet and plain objects/arrays are frozen. When false, mutable copies are
 * returned.
 */
export function deepNativeValueFromStorableValue(
  value: StorableValue,
  frozen = true,
): unknown {
  // StorableError: deep-unwrap the inner Error's internals (cause, custom
  // properties) since they may contain StorableInstance wrappers.
  if (value instanceof StorableError) {
    return deepUnwrapError(value.error, frozen);
  }

  // Other native wrappers (Map, Set, Date, Uint8Array) -> native types.
  if (value instanceof StorableNativeWrapper) {
    return value.toNativeValue(frozen);
  }

  // Other StorableInstance (Cell, Stream, UnknownStorable, etc.) -- pass through.
  if (isStorableInstance(value)) return value;

  // Storable primitives (null, undefined, boolean, number, string, bigint)
  // pass through. Note: `symbol` and `function` are NOT storable and cannot
  // reach here because the `StorableValue` type excludes them.
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  // Arrays -- recursively unwrap elements, then freeze if requested.
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
    if (frozen) Object.freeze(result);
    return result;
  }

  // Objects -- recursively unwrap values, then freeze if requested.
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
  if (frozen) Object.freeze(result);
  return result;
}

/**
 * Deep-unwrap an Error's internals: recursively unwrap `cause` and custom
 * enumerable properties that may contain `StorableInstance` wrappers. Creates
 * a copy of the Error to avoid mutating the stored value. Freezes the result
 * when `frozen` is true.
 */
function deepUnwrapError(error: Error, frozen: boolean): Error {
  const copy = new (error.constructor as ErrorConstructor)(error.message);
  if (copy.name !== error.name) copy.name = error.name;
  if (error.stack !== undefined) copy.stack = error.stack;

  // Recursively unwrap cause.
  if (error.cause !== undefined) {
    copy.cause = deepNativeValueFromStorableValue(
      error.cause as StorableValue,
      frozen,
    );
  }

  // Recursively unwrap custom enumerable properties.
  const SKIP = new Set(["name", "message", "stack", "cause"]);
  for (const key of Object.keys(error)) {
    if (SKIP.has(key) || UNSAFE_KEYS.has(key)) continue;
    (copy as unknown as Record<string, unknown>)[key] =
      deepNativeValueFromStorableValue(
        (error as unknown as Record<string, unknown>)[key] as StorableValue,
        frozen,
      );
  }

  if (frozen) Object.freeze(copy);
  return copy;
}
