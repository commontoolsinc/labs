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
import {
  EMPTY_RECONSTRUCTION_CONTEXT,
} from "./empty-reconstruction-context.ts";

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

/**
 * Helper for `copyError()` and `FabricError.[DECONSTRUCT]()`, which copies
 * own enumerable properties from `source` to `target`, skipping
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
 * Creates a shallow copy of an `Error`, preserving `constructor()`, `.name`,
 * `.message`, `.stack`, `.cause`, and custom enumerable properties. Used by
 * `toNativeValue()` when the freeze state of the wrapped `Error` doesn't match
 * the requested state.
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
function errorClassFromType(type: string): ErrorConstructor {
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
 * Wrapper for `Error` instances in the fabric type system. Bridges native
 * `Error` (JS wild west) into the strongly-typed `FabricValue` layer by
 * implementing `FabricInstance`. The serialization layer handles
 * `FabricError` via the generic `FabricInstanceHandler` path.
 * See Section 1.4.1 of the formal spec.
 */
export class FabricError extends FabricNativeWrapper<Error> {
  /** @inheritDoc */
  readonly typeTag = TAGS.Error;

  constructor(
    /** The wrapped native `Error`. */
    readonly error: Error,
  ) {
    super();
  }

  /**
   * Deconstructs into essential state for serialization. Returns `.type`,
   * `.name`, `.message`, `.stack`, `.cause`, and custom enumerable properties.
   * Does NOT recurse into nested values -- the serialization system handles that.
   *
   * `type` is the constructor name (e.g. "TypeError") used for reconstruction.
   * `name` is the `.name` property -- emitted as `null` when it equals `type`
   * (the common case) to avoid redundancy.
   *
   * **Invariant**: By the time this method runs, `this.error.cause` and any
   * custom enumerable properties are already `FabricValue`. The conversion
   * layer (`convertErrorInternals()` in `fabric-value-modern.ts`) ensures
   * this by recursively converting `Error` internals before wrapping in
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

  /**
   * Deep-freezes in place. `Object.freeze` on the wrapped `Error` covers the
   * standard non-enumerable slots (`message`, `name`, `stack`); the only
   * deep-freeze gap is the (`FabricValue`-typed, per the `[DECONSTRUCT]`
   * invariant) `cause` and any custom enumerable own properties, which are
   * recursed via `subFreeze`. This freezes the existing instance -- it does
   * NOT rebuild and does NOT narrow to string-valued state (that narrowing
   * is a `deepClone()` stop-gap detail, not a `[DEEP_FREEZE]` requirement).
   */
  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    if (this.error.cause !== undefined) {
      subFreeze(this.error.cause as FabricValue);
    }
    for (const key of Object.keys(this.error)) {
      if (UNSAFE_KEYS.has(key) || key === "cause") continue;
      subFreeze(
        (this.error as unknown as Record<string, FabricValue>)[key],
      );
    }
    Object.freeze(this.error);
    return Object.freeze(this) as unknown as FabricValue;
  }

  /**
   * Side-effect-free check mirroring `[DEEP_FREEZE]`'s canonical form: this
   * wrapper and its wrapped `Error` are frozen, and the (`FabricValue`-typed)
   * `cause` plus any custom enumerable own properties are recursively
   * deep-frozen. Never throws.
   */
  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    if (!Object.isFrozen(this) || !Object.isFrozen(this.error)) {
      return false;
    }
    if (
      this.error.cause !== undefined &&
      !subIsDeepFrozen(this.error.cause as FabricValue)
    ) {
      return false;
    }
    for (const key of Object.keys(this.error)) {
      if (UNSAFE_KEYS.has(key) || key === "cause") continue;
      if (
        !subIsDeepFrozen(
          (this.error as unknown as Record<string, FabricValue>)[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }

  /** @inheritDoc */
  protected shallowUnfrozenClone(): FabricError {
    return new FabricError(this.error);
  }

  /** @inheritDoc */
  protected get wrappedValue(): Error {
    return this.error;
  }

  /** @inheritDoc */
  protected toNativeFrozen(): Error {
    return Object.freeze(copyError(this.error));
  }

  /** @inheritDoc */
  protected toNativeThawed(): Error {
    return copyError(this.error);
  }

  /** @inheritDoc */
  override deepClone(frozen: boolean): FabricError {
    // TODO(danfuzz): This is a partial implementation, meant to keep thins
    // working well enough as the modern data model gets fleshed out.
    // Ultimately, concrete classes should not have to implement this method at
    // all.

    if (frozen && isDeepFrozen(this)) {
      return this;
    }

    // This makes a result that just has the  string properties of the original.

    const state: Record<string, unknown> = this[DECONSTRUCT]() as Record<
      string,
      unknown
    >;

    for (const key in state) {
      if (typeof state[key] !== "string") {
        delete state[key];
      }
    }

    // `[RECONSTRUCT]` now honors `context.shouldDeepFreeze`. This clone path
    // owns its own frozenness decision (the `frozen ? deepFreeze : result`
    // below), so it must NOT have `[RECONSTRUCT]` pre-freeze: pass a context
    // whose `shouldDeepFreeze` matches this clone's `frozen` intent.
    const reconstructContext: ReconstructionContext = {
      getCell: EMPTY_RECONSTRUCTION_CONTEXT.getCell,
      shouldDeepFreeze: frozen,
    };
    const result = FabricError[RECONSTRUCT](state, reconstructContext);

    return frozen ? deepFreeze(result) : result;
  }

  /**
   * Reconstructs a `FabricError` from its essential state. Nested values
   * in `state` have already been reconstructed by the serialization system.
   * Returns a `FabricError` wrapping the reconstructed `Error`; callers
   * who need the native `Error` use `nativeFromFabricValue()`.
   */
  static [RECONSTRUCT](
    state: FabricValue,
    context: ReconstructionContext,
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

    const result = new FabricError(error);
    // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen form
    // via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
    return context.shouldDeepFreeze
      ? result[DEEP_FREEZE]((v) => deepFreeze(v)) as unknown as FabricError
      : result;
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
    return context.shouldDeepFreeze
      ? result[DEEP_FREEZE]((v) => deepFreeze(v)) as unknown as FabricRegExp
      : result;
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
