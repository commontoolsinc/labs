import {
  DECONSTRUCT,
  DEEP_FREEZE,
  FabricInstance,
  type FabricValue,
  IS_DEEP_FROZEN,
  RECONSTRUCT,
  type ReconstructionContext,
} from "./interface.ts";
import { deepFreeze, isDeepFrozen } from "./deep-freeze.ts";
import { NATIVE_TAGS, tagFromNativeValue } from "./native-type-tags.ts";
import { TAGS } from "./fabric-type-tags.ts";
import { FrozenMap, FrozenSet } from "./frozen-builtins.ts";
import { EmptyReconstructionContext } from "./empty-reconstruction-context.ts";

// ---------------------------------------------------------------------------
// Utility: native-instance type guard
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the value is a native JS object type that the fabric
 * system knows how to wrap. These are the "wild-west" instances that get
 * converted into `FabricNativeWrapper` subclasses, `FabricPrimitive` types,
 * or `FabricInstance` types by the conversion layer.
 *
 * Arrays, plain objects, objects with `toJSON()`, and system-defined special
 * primitives are recognized by `tagFromNativeValue()` but are NOT convertible
 * native instances -- they have their own handling paths in the conversion
 * layer.
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

// ---------------------------------------------------------------------------
// Utility: `Error` class lookup
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
 * Helper for `FabricError.[RECONSTRUCT]()`, which returns the `Error`
 * constructor for the given type string (e.g. `"TypeError"`). Falls back
 * to the base `Error` constructor for unknown types.
 */
export function errorClassFromType(type: string): ErrorConstructor {
  return ERROR_CLASS_BY_TYPE.get(type) ?? Error;
}

// ---------------------------------------------------------------------------
// Abstract base class for native-object wrappers
// ---------------------------------------------------------------------------

/**
 * Abstract base class for `FabricInstance` wrappers that bridge native JS
 * objects into the `FabricValue` layer.
 * Provides a common `toNativeValue()` method used by both the shallow and
 * deep unwrap functions, replacing their `instanceof` cascades with a single
 * `instanceof FabricNativeWrapper` check.
 */
export abstract class FabricNativeWrapper<T extends object>
  extends FabricInstance {
  /** The wire format tag for this wrapper's type (e.g. `TAGS.Error`). */
  abstract readonly typeTag: string;

  /** The wrapped native value, used by `toNativeValue` for freeze-state checks. */
  protected abstract get wrappedValue(): T;

  /** Converts the wrapped value to frozen form (only called on state mismatch). */
  protected abstract toNativeFrozen(): T;

  /** Converts the wrapped value to thawed form (only called on state mismatch). */
  protected abstract toNativeThawed(): T;

  /** Returns the underlying native value, optionally frozen. */
  toNativeValue(frozen: boolean): T {
    const value = this.wrappedValue;
    if (frozen === Object.isFrozen(value)) return value;
    return frozen ? this.toNativeFrozen() : this.toNativeThawed();
  }

  /** @inheritDoc */
  deepClone(_frozen: boolean): FabricInstance {
    throw new Error(
      `Cannot yet handle deep cloning of \`${this.constructor.name}\`.`,
    );
  }
}

// ---------------------------------------------------------------------------
// `FabricError`
// ---------------------------------------------------------------------------

/**
 * Reserved key set for `FabricError`'s extras bag: these names belong to the
 * fixed-schema slots (`type`, `name`, `message`, `stack`, `cause`) and cannot
 * be used as extras keys.
 */
const FABRIC_ERROR_RESERVED_KEYS: FrozenSet<string> = new FrozenSet([
  "type",
  "name",
  "message",
  "stack",
  "cause",
]);

/**
 * Structured state for constructing a `FabricError`. Spec slots are
 * `FabricValue`-typed; the optional `extras` carries any custom enumerable
 * properties (also in `FabricValue` form). After construction, extras are
 * accessed via map-like methods (`getExtra`, `setExtra`, etc.) on the
 * instance; they are not exposed as an own property.
 */
export type FabricErrorState = {
  /** Constructor name of the originating native `Error` (e.g. `"TypeError"`). */
  readonly type: string;
  /**
   * The `.name` property. Pass `null` (or omit) to mean "same as `type`"; the
   * resulting instance's `.name` is always a concrete string (`null` is a
   * wire-level optimization at the `[DECONSTRUCT]` boundary, not part of the
   * public API).
   */
  readonly name?: string | null | undefined;
  /** The `.message` property. */
  readonly message: string;
  /** The `.stack` property, or `undefined`. */
  readonly stack: string | undefined;
  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  readonly cause: FabricValue | undefined;
  /**
   * Optional iterable of custom enumerable own properties, in `FabricValue`
   * form. Keys must not collide with the fixed-schema slot names or with
   * prototype-sensitive keys.
   */
  readonly extras?:
    | Iterable<readonly [string, FabricValue]>
    | Readonly<Record<string, FabricValue>>
    | undefined;
};

/**
 * Wrapper for `Error` instances in the fabric type system. Bridges native
 * `Error` (JS wild west) into the strongly-typed `FabricValue` layer by
 * implementing `FabricInstance`. The publicly observable state is entirely
 * `FabricValue`-typed: fixed-schema slots (`type`, `name`, `message`,
 * `stack`, `cause`) plus a hidden extras bag accessed via map-like methods
 * (`getExtra`, `setExtra`, `hasExtra`, `deleteExtra`, `extraKeys`,
 * `extraEntries`). The native `Error` form is produced on demand by
 * `toNativeValue()`. Mutability of the extras bag tracks the instance's
 * frozen state: `setExtra` / `deleteExtra` throw when this instance is
 * frozen. The serialization layer handles `FabricError` via the generic
 * `FabricInstanceHandler` path. See Section 1.4.1 of the formal spec.
 */
export class FabricError extends FabricNativeWrapper<Error> {
  /** @inheritDoc */
  readonly typeTag = TAGS.Error;

  /** Constructor name of the originating native `Error` (e.g. `"TypeError"`). */
  readonly type: string;
  /** The `.name` property (always a concrete string). */
  readonly name: string;
  /** The `.message` property. */
  readonly message: string;
  /** The `.stack` property, or `undefined`. */
  readonly stack: string | undefined;
  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  readonly cause: FabricValue | undefined;

  /** Hidden bag of custom enumerable properties, in `FabricValue` form. */
  readonly #extras: Map<string, FabricValue>;

  /**
   * Cached lazy native projection. Built on first call to `wrappedValue` /
   * `toNativeValue()` and reused thereafter. Always deep-frozen when
   * populated (matching the typical use case); thawed copies are minted by
   * `toNativeThawed()` on demand.
   */
  #nativeFrozen: Error | undefined;

  /**
   * Constructs from a `FabricErrorState` record. All state values must
   * already be in `FabricValue` form -- the conversion layer
   * (`fabric-value-modern.ts`) is responsible for ensuring this when
   * constructing from a native `Error`. Use `FabricError.fromNativeError()`
   * for shallow conversion from a native `Error`.
   */
  constructor(state: FabricErrorState) {
    super();
    this.type = state.type;
    this.name = state.name ?? state.type;
    this.message = state.message;
    this.stack = state.stack;
    this.cause = state.cause;
    this.#extras = new Map();
    const extras = state.extras;
    if (extras !== undefined) {
      const entries: Iterable<readonly [string, FabricValue]> =
        Symbol.iterator in extras
          ? extras as Iterable<readonly [string, FabricValue]>
          : Object.entries(extras as Record<string, FabricValue>);
      for (const [key, value] of entries) {
        if (UNSAFE_KEYS.has(key) || FABRIC_ERROR_RESERVED_KEYS.has(key)) {
          continue;
        }
        this.#extras.set(key, value);
      }
    }
  }

  /**
   * Shallow conversion from a native `Error`. Used by the shallow conversion
   * layer (`shallowFabricFromNativeValueModern`). The error's `.cause` and
   * custom properties are stored as-is (cast to `FabricValue`); the deep
   * conversion path is responsible for converting them when needed.
   */
  static fromNativeError(error: Error): FabricError {
    const type = error.constructor.name;
    const name = error.name === type ? null : error.name;
    const extras: Array<[string, FabricValue]> = [];
    for (const key of Object.keys(error)) {
      if (UNSAFE_KEYS.has(key) || FABRIC_ERROR_RESERVED_KEYS.has(key)) {
        continue;
      }
      extras.push([
        key,
        (error as unknown as Record<string, FabricValue>)[key],
      ]);
    }
    return new FabricError({
      type,
      name,
      message: error.message,
      stack: error.stack,
      cause: error.cause as FabricValue | undefined,
      extras,
    });
  }

  /** Returns the value associated with `key`, or `undefined`. */
  getExtra(key: string): FabricValue | undefined {
    return this.#extras.get(key);
  }

  /** Returns `true` if `key` is present in the extras bag. */
  hasExtra(key: string): boolean {
    return this.#extras.has(key);
  }

  /**
   * Sets `key` to `value` in the extras bag. Throws if this instance is
   * frozen, if `key` is a fixed-schema slot name, or if `key` is a
   * prototype-sensitive key (`__proto__`, `constructor`).
   */
  setExtra(key: string, value: FabricValue): void {
    if (Object.isFrozen(this)) {
      throw new Error("Cannot modify frozen FabricError");
    }
    if (UNSAFE_KEYS.has(key)) {
      throw new Error(`Cannot use unsafe key in FabricError extras: ${key}`);
    }
    if (FABRIC_ERROR_RESERVED_KEYS.has(key)) {
      throw new Error(
        `Cannot use fixed-schema slot name in FabricError extras: ${key}`,
      );
    }
    this.#extras.set(key, value);
  }

  /**
   * Removes `key` from the extras bag, returning `true` if it was present.
   * Throws if this instance is frozen.
   */
  deleteExtra(key: string): boolean {
    if (Object.isFrozen(this)) {
      throw new Error("Cannot modify frozen FabricError");
    }
    return this.#extras.delete(key);
  }

  /** Returns the number of entries in the extras bag. */
  get extraSize(): number {
    return this.#extras.size;
  }

  /** Returns the keys present in the extras bag. */
  extraKeys(): IterableIterator<string> {
    return this.#extras.keys();
  }

  /** Returns the `[key, value]` entries in the extras bag. */
  extraEntries(): IterableIterator<[string, FabricValue]> {
    return this.#extras.entries();
  }

  /**
   * Deconstructs into essential state for serialization. Returns a flat
   * record with `type`, `name`, `message`, `stack`, `cause`, and custom
   * enumerable properties from the extras bag. Does NOT recurse into nested
   * values -- the serialization system handles that.
   *
   * `name` is emitted as `null` when it equals `type` (the common case) to
   * avoid redundancy.
   */
  [DECONSTRUCT](): FabricValue {
    const state: Record<string, FabricValue> = {
      type: this.type,
      name: this.name === this.type ? null : this.name,
      message: this.message,
    };
    if (this.stack !== undefined) {
      state.stack = this.stack;
    }
    if (this.cause !== undefined) {
      state.cause = this.cause;
    }
    for (const [key, value] of this.#extras) {
      state[key] = value;
    }
    return state as FabricValue;
  }

  /**
   * Deep-freezes in place. Freezes this instance and recurses into the
   * `FabricValue`-typed `cause` and extras-bag values via `subFreeze`. The
   * extras bag's mutation methods are gated by this instance's frozen state,
   * so freezing `this` is sufficient -- there is no separate `Object.freeze`
   * on the bag itself (a `Map` ignores `Object.freeze` for `set`/`delete`).
   * There is no native-`Error` slot to freeze -- the native projection is a
   * derivation produced on demand, not stored as canonical state.
   */
  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    if (this.cause !== undefined) {
      subFreeze(this.cause);
    }
    for (const value of this.#extras.values()) {
      subFreeze(value);
    }
    return Object.freeze(this) as unknown as FabricValue;
  }

  /**
   * Side-effect-free check mirroring `[DEEP_FREEZE]`'s canonical form: this
   * instance is frozen, and the `cause` plus each value in the extras bag
   * are recursively deep-frozen. Never throws.
   */
  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    if (!Object.isFrozen(this)) return false;
    if (this.cause !== undefined && !subIsDeepFrozen(this.cause)) {
      return false;
    }
    for (const value of this.#extras.values()) {
      if (!subIsDeepFrozen(value)) return false;
    }
    return true;
  }

  /** @inheritDoc */
  protected shallowUnfrozenClone(): FabricError {
    return new FabricError({
      type: this.type,
      name: this.name,
      message: this.message,
      stack: this.stack,
      cause: this.cause,
      extras: this.#extras,
    });
  }

  /**
   * Returns the cached native projection, building it on first access. The
   * cached projection is always deep-frozen; `toNativeValue(false)` uses
   * `toNativeThawed()` to mint a thawed copy each time.
   */
  protected get wrappedValue(): Error {
    if (this.#nativeFrozen === undefined) {
      this.#nativeFrozen = this.#buildNativeError(true);
    }
    return this.#nativeFrozen;
  }

  /** @inheritDoc */
  protected toNativeFrozen(): Error {
    return this.wrappedValue;
  }

  /** @inheritDoc */
  protected toNativeThawed(): Error {
    return this.#buildNativeError(false);
  }

  /**
   * Builds a fresh native `Error` from this `FabricError`'s state. `cause`
   * and extras are copied through as-is (no recursive unwrap). Callers that
   * need recursive unwrap should use `nativeFromFabricValue()`.
   */
  #buildNativeError(frozen: boolean): Error {
    const ErrorClass = errorClassFromType(this.type);
    const error = new ErrorClass(this.message);
    if (error.name !== this.name) error.name = this.name;
    if (this.stack !== undefined) error.stack = this.stack;
    if (this.cause !== undefined) error.cause = this.cause;
    for (const [key, value] of this.#extras) {
      (error as unknown as Record<string, unknown>)[key] = value;
    }
    return frozen ? Object.freeze(error) : error;
  }

  /** @inheritDoc */
  override deepClone(frozen: boolean): FabricError {
    if (frozen && isDeepFrozen(this)) return this;

    // `[RECONSTRUCT]` honors `context.shouldDeepFreeze`. This clone path owns
    // its own frozenness decision via the wrapper `frozen ? deepFreeze :
    // result` below, so pre-freezing inside `[RECONSTRUCT]` would be
    // redundant when `frozen` is true and wrong when it is false. Match
    // contexts to this clone's intent.
    const reconstructContext = new EmptyReconstructionContext(
      frozen,
      "no runtime context (FabricError deep-clone path).",
    );
    const result = FabricError[RECONSTRUCT](
      this[DECONSTRUCT](),
      reconstructContext,
    );
    return frozen ? deepFreeze(result) : result;
  }

  /**
   * Reconstructs a `FabricError` from its essential state (flat record).
   * Nested values in `state` have already been reconstructed by the
   * serialization system.
   */
  static [RECONSTRUCT](
    state: FabricValue,
    context: ReconstructionContext,
  ): FabricError {
    const s = state as Record<string, FabricValue>;
    const type = (s.type as string) ?? (s.name as string) ?? "Error";
    // null name means "same as type" (the wire-level optimization).
    const name = (s.name as string | null | undefined) ?? type;
    const message = (s.message as string) ?? "";
    const stack = s.stack as string | undefined;
    const cause = s.cause;

    const extras: Array<[string, FabricValue]> = [];
    for (const key of Object.keys(s)) {
      if (FABRIC_ERROR_RESERVED_KEYS.has(key) || UNSAFE_KEYS.has(key)) {
        continue;
      }
      extras.push([key, s[key]]);
    }

    const result = new FabricError({
      type,
      name,
      message,
      stack,
      cause,
      extras,
    });
    // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen form
    // via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
    return context.shouldDeepFreeze ? deepFreeze(result) : result;
  }
}

// ---------------------------------------------------------------------------
// Stub native wrappers: `Map`, `Set`, `Date`, `Uint8Array`
// ---------------------------------------------------------------------------

/**
 * Wrapper for `Map` instances. Stub -- `[DECONSTRUCT]` and `[RECONSTRUCT]`
 * throw until `Map` support is fully implemented. Extra properties beyond the
 * wrapped collection are not supported on non-`Error` wrappers.
 */
export class FabricMap
  extends FabricNativeWrapper<Map<FabricValue, FabricValue>> {
  /** @inheritDoc */
  readonly typeTag = TAGS.Map;
  constructor(readonly map: Map<FabricValue, FabricValue>) {
    super();
  }

  [DECONSTRUCT](): FabricValue {
    throw new Error("FabricMap: not yet implemented");
  }

  /**
   * Stub -- throws until `Map` support is fully implemented. `FabricMap` is
   * not yet used and is being reworked separately; the protocol methods are
   * deliberately left as throwing stubs (per Dan's PR #3612 review).
   */
  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    throw new Error("FabricMap: not yet implemented");
  }

  /**
   * Stub -- throws until `Map` support is fully implemented. See
   * `[DEEP_FREEZE]` above.
   */
  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("FabricMap: not yet implemented");
  }

  /** @inheritDoc */
  protected shallowUnfrozenClone(): FabricMap {
    return new FabricMap(this.map);
  }

  /** @inheritDoc */
  protected get wrappedValue(): Map<FabricValue, FabricValue> {
    return this.map;
  }

  /** @inheritDoc */
  protected toNativeFrozen(): FrozenMap<FabricValue, FabricValue> {
    return new FrozenMap(this.map);
  }

  /** @inheritDoc */
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
 * throw until `Set` support is fully implemented. Extra properties beyond the
 * wrapped collection are not supported on non-`Error` wrappers.
 */
export class FabricSet extends FabricNativeWrapper<Set<FabricValue>> {
  /** @inheritDoc */
  readonly typeTag = TAGS.Set;
  constructor(readonly set: Set<FabricValue>) {
    super();
  }

  [DECONSTRUCT](): FabricValue {
    throw new Error("FabricSet: not yet implemented");
  }

  /**
   * Stub -- throws until `Set` support is fully implemented. `FabricSet` is
   * not yet used and is being reworked separately; the protocol methods are
   * deliberately left as throwing stubs (per Dan's PR #3612 review).
   */
  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    throw new Error("FabricSet: not yet implemented");
  }

  /**
   * Stub -- throws until `Set` support is fully implemented. See
   * `[DEEP_FREEZE]` above.
   */
  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("FabricSet: not yet implemented");
  }

  /** @inheritDoc */
  protected shallowUnfrozenClone(): FabricSet {
    return new FabricSet(this.set);
  }

  /** @inheritDoc */
  protected get wrappedValue(): Set<FabricValue> {
    return this.set;
  }

  /** @inheritDoc */
  protected toNativeFrozen(): FrozenSet<FabricValue> {
    return new FrozenSet(this.set);
  }

  /** @inheritDoc */
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
  /** @inheritDoc */
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
   * Deconstructs into essential state for serialization. Returns
   * `{ source, flags, flavor }` -- the values needed to reconstruct the
   * `RegExp`. Extra enumerable properties on the `RegExp` cause rejection.
   */
  [DECONSTRUCT](): FabricValue {
    rejectExtraRegExpProperties(this.regex);
    return {
      source: this.regex.source,
      flags: this.regex.flags,
      flavor: this.flavor,
    } as FabricValue;
  }

  /**
   * Deep-freezes in place. The deep-frozen form of a `FabricRegExp` is one
   * whose wrapped `RegExp` is frozen (an immutable `.lastIndex`, so stateful
   * methods won't mutate it -- matching `toNativeFrozen()`'s semantics).
   * `Object.freeze` fully immutabilizes a `RegExp` in place (unlike `Map` /
   * `Set`, whose mutating methods bypass property descriptors), so this
   * freezes `this.regex` directly rather than requiring it pre-frozen --
   * which lets a freshly-`[RECONSTRUCT]`ed `FabricRegExp` flow through the
   * deserialize-boundary `deepFreeze()` wrap without a fix-up step. There
   * are no `FabricValue` children to recurse.
   */
  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    Object.freeze(this.regex);
    return Object.freeze(this) as unknown as FabricValue;
  }

  /**
   * Side-effect-free check mirroring `[DEEP_FREEZE]`'s canonical form: this
   * wrapper and its wrapped `RegExp` are frozen. There are no `FabricValue`
   * children to recurse. An unfrozen wrapped `RegExp` answers `false` --
   * never throws.
   */
  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this) && Object.isFrozen(this.regex);
  }

  /** @inheritDoc */
  protected shallowUnfrozenClone(): FabricRegExp {
    return new FabricRegExp(this.regex, this.flavor);
  }

  /** @inheritDoc */
  protected get wrappedValue(): RegExp {
    return this.regex;
  }

  /**
   * Returns a frozen copy of the `RegExp`. A frozen `RegExp` has an immutable
   * `.lastIndex`, so stateful methods (`exec()`, `test()`) won't work
   * correctly -- but that matches the "death before confusion" principle.
   */
  protected toNativeFrozen(): RegExp {
    return Object.freeze(new RegExp(this.regex));
  }

  /** @inheritDoc */
  protected toNativeThawed(): RegExp {
    return new RegExp(this.regex);
  }

  /**
   * Reconstructs a `FabricRegExp` from its essential state
   * (`{ source, flags, flavor }`).
   */
  static [RECONSTRUCT](
    state: FabricValue,
    context: ReconstructionContext,
  ): FabricRegExp {
    const s = state as Record<string, FabricValue>;
    const source = (s.source as string) ?? "";
    const flags = (s.flags as string) ?? "";
    const flavor = (s.flavor as string) ?? "es2025";
    const result = new FabricRegExp(new RegExp(source, flags), flavor);
    // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen form
    // via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
    return context.shouldDeepFreeze ? deepFreeze(result) : result;
  }
}

/**
 * Helper for `FabricRegExp.[DECONSTRUCT]()`, which rejects `RegExp` instances
 * with extra enumerable properties. The built-in `.lastIndex` property is not
 * enumerable, so `Object.keys()` won't see it. Any enumerable own property
 * is therefore user-added and causes rejection.
 */
function rejectExtraRegExpProperties(regex: RegExp): void {
  if (Object.keys(regex).length > 0) {
    throw new Error(
      "Cannot store RegExp with extra enumerable properties",
    );
  }
}
