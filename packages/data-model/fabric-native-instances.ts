import {
  DECONSTRUCT,
  FabricInstance,
  type FabricValue,
  RECONSTRUCT,
  type ReconstructionContext,
} from "./interface.ts";

import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { TAGS } from "./fabric-type-tags.ts";
import { FrozenMap, FrozenSet } from "./frozen-builtins.ts";

// ---------------------------------------------------------------------------
// Utility: native-instance type guard
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the value is a native JS object type that the fabric
 * system knows how to wrap (Error, Map, Set, Date, Uint8Array). These are
 * the "wild-west" instances that get converted into `FabricNativeWrapper`
 * subclasses or `FabricInstance` types by the conversion layer.
 *
 * Arrays, plain objects, objects with `toJSON()`, and system-defined special
 * primitives (EpochNsec, EpochDays, ContentHash) are recognized by
 * `tagFromNativeValue()` but are NOT convertible native instances -- they
 * have their own handling paths in the conversion layer.
 */
export function isConvertibleNativeInstance(value: object): boolean {
  switch (tagFromNativeValue(value)) {
    case NATIVE_TAGS.Error:
    case NATIVE_TAGS.Map:
    case NATIVE_TAGS.Set:
    case NATIVE_TAGS.Date:
    case NATIVE_TAGS.Uint8Array:
    case NATIVE_TAGS.RegExp:
      return true;
    default:
      return false;
  }
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
 * Abstract base class for `FabricInstance` wrappers that bridge native JS
 * objects (Error, Map, Set, Uint8Array) into the `FabricValue` layer.
 * Provides a common `toNativeValue()` method used by both the shallow and
 * deep unwrap functions, replacing their `instanceof` cascades with a single
 * `instanceof FabricNativeWrapper` check.
 */
export abstract class FabricNativeWrapper<T extends object>
  extends FabricInstance {
  abstract readonly typeTag: string;

  /** The wrapped native value, used by `toNativeValue` for freeze-state checks. */
  protected abstract get wrappedValue(): T;

  /** Convert the wrapped value to frozen form (only called on state mismatch). */
  protected abstract toNativeFrozen(): T;

  /** Convert the wrapped value to thawed form (only called on state mismatch). */
  protected abstract toNativeThawed(): T;

  /** Return the underlying native value, optionally frozen. */
  toNativeValue(frozen: boolean): T {
    const value = this.wrappedValue;
    if (frozen === Object.isFrozen(value)) return value;
    return frozen ? this.toNativeFrozen() : this.toNativeThawed();
  }
}

// ---------------------------------------------------------------------------
// FabricError
// ---------------------------------------------------------------------------

/**
 * Wrapper for `Error` instances in the fabric type system. Bridges native
 * `Error` (JS wild west) into the strongly-typed `FabricValue` layer by
 * implementing `FabricInstance`. The serialization layer handles
 * `FabricError` via the generic `StorableInstanceHandler` path.
 * See Section 1.4.1 of the formal spec.
 */
export class FabricError extends FabricNativeWrapper<Error> {
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
   * custom enumerable properties are already `FabricValue`. The conversion
   * layer (`convertErrorInternals()` in `fabric-value-modern.ts`) ensures
   * this by recursively converting Error internals before wrapping in
   * `FabricError`. The `as FabricValue` casts below are therefore safe.
   */
  [DECONSTRUCT](): FabricValue {
    const type = this.error.constructor.name;
    const name = this.error.name;
    const state: Record<string, FabricValue> = {
      type,
      name: name === type ? null : name,
      message: this.error.message,
    };
    if (this.error.stack !== undefined) {
      state.stack = this.error.stack;
    }
    if (this.error.cause !== undefined) {
      state.cause = this.error.cause as FabricValue;
    }
    copyOwnSafeProperties(
      this.error,
      state as Record<string, unknown>,
      true,
    );
    return state as FabricValue;
  }

  protected shallowUnfrozenClone(): FabricError {
    return new FabricError(this.error);
  }

  protected get wrappedValue(): Error {
    return this.error;
  }

  protected toNativeFrozen(): Error {
    return Object.freeze(copyError(this.error));
  }

  protected toNativeThawed(): Error {
    return copyError(this.error);
  }

  /**
   * Reconstruct a `FabricError` from its essential state. Nested values
   * in `state` have already been reconstructed by the serialization system.
   * Returns a `FabricError` wrapping the reconstructed `Error`; callers
   * who need the native `Error` use `nativeFromFabricValue()`.
   */
  static [RECONSTRUCT](
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricError {
    const s = state as Record<string, FabricValue>;
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

    return new FabricError(error);
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
export class FabricMap
  extends FabricNativeWrapper<Map<FabricValue, FabricValue>> {
  readonly typeTag = TAGS.Map;
  constructor(readonly map: Map<FabricValue, FabricValue>) {
    super();
  }

  [DECONSTRUCT](): FabricValue {
    throw new Error("FabricMap: not yet implemented");
  }

  protected shallowUnfrozenClone(): FabricMap {
    return new FabricMap(this.map);
  }

  protected get wrappedValue(): Map<FabricValue, FabricValue> {
    return this.map;
  }

  protected toNativeFrozen(): FrozenMap<FabricValue, FabricValue> {
    return new FrozenMap(this.map);
  }

  protected toNativeThawed(): Map<FabricValue, FabricValue> {
    return new Map(this.map);
  }

  static [RECONSTRUCT](
    _state: FabricValue,
    _context: ReconstructionContext,
  ): FabricMap {
    throw new Error("FabricMap: not yet implemented");
  }
}

/**
 * Wrapper for `Set` instances. Stub -- `[DECONSTRUCT]` and `[RECONSTRUCT]`
 * throw until Set support is fully implemented. Extra properties beyond the
 * wrapped collection are not supported on non-Error wrappers.
 */
export class FabricSet extends FabricNativeWrapper<Set<FabricValue>> {
  readonly typeTag = TAGS.Set;
  constructor(readonly set: Set<FabricValue>) {
    super();
  }

  [DECONSTRUCT](): FabricValue {
    throw new Error("FabricSet: not yet implemented");
  }

  protected shallowUnfrozenClone(): FabricSet {
    return new FabricSet(this.set);
  }

  protected get wrappedValue(): Set<FabricValue> {
    return this.set;
  }

  protected toNativeFrozen(): FrozenSet<FabricValue> {
    return new FrozenSet(this.set);
  }

  protected toNativeThawed(): Set<FabricValue> {
    return new Set(this.set);
  }

  static [RECONSTRUCT](
    _state: FabricValue,
    _context: ReconstructionContext,
  ): FabricSet {
    throw new Error("FabricSet: not yet implemented");
  }
}

/**
 * Wrapper for `RegExp` instances in the fabric type system. Bridges native
 * `RegExp` (JS wild west) into the strongly-typed `FabricValue` layer by
 * implementing `FabricInstance`. The essential state is
 * `{ source, flags, flavor }`.
 * See Section 1.4.1 of the formal spec.
 */
export class FabricRegExp extends FabricNativeWrapper<RegExp> {
  /** The type tag used in the wire format (`TAGS.RegExp`). */
  readonly typeTag = TAGS.RegExp;

  constructor(
    /** The wrapped native `RegExp`. */
    readonly regex: RegExp,
    /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
    readonly flavor: string = "es2025",
  ) {
    super();
  }

  /**
   * Deconstruct into essential state for serialization. Returns
   * `{ source, flags, flavor }` -- the values needed to reconstruct the
   * RegExp. Extra enumerable properties on the RegExp cause rejection.
   */
  [DECONSTRUCT](): FabricValue {
    rejectExtraRegExpProperties(this.regex);
    return {
      source: this.regex.source,
      flags: this.regex.flags,
      flavor: this.flavor,
    } as FabricValue;
  }

  protected shallowUnfrozenClone(): FabricRegExp {
    return new FabricRegExp(this.regex, this.flavor);
  }

  protected get wrappedValue(): RegExp {
    return this.regex;
  }

  /**
   * Return a frozen copy of the RegExp. A frozen RegExp has an immutable
   * `lastIndex`, so stateful methods (`exec()`, `test()`) won't work
   * correctly -- but that matches the "death before confusion" principle.
   */
  protected toNativeFrozen(): RegExp {
    return Object.freeze(new RegExp(this.regex));
  }

  protected toNativeThawed(): RegExp {
    return new RegExp(this.regex);
  }

  /**
   * Reconstruct a `FabricRegExp` from its essential state
   * (`{ source, flags, flavor }`).
   */
  static [RECONSTRUCT](
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricRegExp {
    const s = state as Record<string, FabricValue>;
    const source = (s.source as string) ?? "";
    const flags = (s.flags as string) ?? "";
    const flavor = (s.flavor as string) ?? "es2025";
    return new FabricRegExp(new RegExp(source, flags), flavor);
  }
}

/**
 * Reject RegExp instances with extra enumerable properties. The built-in
 * `lastIndex` property is not enumerable, so `Object.keys()` won't see it.
 * Any enumerable own property is therefore user-added and causes rejection.
 */
function rejectExtraRegExpProperties(regex: RegExp): void {
  if (Object.keys(regex).length > 0) {
    throw new Error(
      "Cannot store RegExp with extra enumerable properties",
    );
  }
}

/**
 * Wrapper for `Uint8Array` instances. Stub -- `[DECONSTRUCT]` and
 * `[RECONSTRUCT]` throw until Uint8Array support is fully implemented.
 * Extra properties beyond the wrapped value are not supported on non-Error
 * wrappers.
 */
export class FabricUint8Array extends FabricNativeWrapper<Blob | Uint8Array> {
  readonly typeTag = TAGS.Bytes;
  constructor(readonly bytes: Uint8Array) {
    super();
  }

  [DECONSTRUCT](): FabricValue {
    throw new Error("FabricUint8Array: not yet implemented");
  }

  protected shallowUnfrozenClone(): FabricUint8Array {
    return new FabricUint8Array(this.bytes);
  }

  protected get wrappedValue(): Uint8Array {
    return this.bytes;
  }

  /**
   * Returns a `Blob` (immutable by nature). `Uint8Array` cannot be frozen
   * per the JS spec, so the base class freeze-state check always delegates
   * here when `frozen=true`.
   */
  protected toNativeFrozen(): Blob {
    return new Blob([this.bytes as BlobPart]);
  }

  protected toNativeThawed(): Uint8Array {
    return this.bytes;
  }

  static [RECONSTRUCT](
    _state: FabricValue,
    _context: ReconstructionContext,
  ): FabricUint8Array {
    throw new Error("FabricUint8Array: not yet implemented");
  }
}
