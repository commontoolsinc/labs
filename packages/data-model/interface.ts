/**
 * Type-only declarations and the `FabricInstance` base class for the fabric
 * data model. This file is intentionally free of runtime imports from other
 * data-model modules (only `import type` is used) so that it can be imported
 * by any module without creating circular dependencies.
 *
 * NOTE: `packages/api/index.ts` mirrors these types (and those from
 * `fabric-hash.ts`, `fabric-epoch.ts`) for the pattern compiler. Changes
 * here must be kept in sync with the corresponding declarations there.
 */

// ===========================================================================
// Fabric instance protocol (DECONSTRUCT / RECONSTRUCT / FabricInstance)
// ===========================================================================

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

// ===========================================================================
// Fabric primitive base class
// ===========================================================================

/**
 * Abstract base class for "special primitive" fabric types -- values that
 * behave like primitives in the fabric type system but are represented as
 * class instances for type safety and dispatch. Currently covers temporal
 * types (`FabricEpochNsec`, `FabricEpochDays`) and content IDs
 * (`FabricHash`).
 *
 * Analogous to `ExplicitTagValue` (which unifies `UnknownValue` and
 * `ProblematicValue`), this class enables a single `instanceof` check
 * where code needs to handle any special primitive uniformly.
 *
 * Instances are always frozen (like true primitives, they are immutable).
 * Each leaf subclass must call `Object.freeze(this)` at the end of its
 * constructor, after all fields are initialized. (Freezing in the base
 * constructor would prevent subclass field assignment.)
 *
 * See Section 1.4.5 and 1.4.6 of the formal spec.
 */
export abstract class FabricPrimitive {
  constructor() {}
}

// ===========================================================================
// Type definitions
// ===========================================================================

/**
 * A value that can be stored in the storage layer. This is similar to
 * `JSONValue` but is specifically intended for use at storage boundaries
 * (values going into or coming out of the database).
 *
 * Note: Once the `modernDataModel` experiment graduates and the rich path
 * becomes the default, `FabricValue = FabricDatum | undefined` will be a
 * redundant union (since `FabricDatum` includes `undefined`). The alias is
 * retained for compatibility and readability at call sites.
 */
export type FabricValue = FabricDatum | undefined;

/**
 * The full set of values that the storage layer can represent. This is the
 * strongly-typed "middle layer" of the three-layer architecture:
 *
 *   JavaScript "wild west" (unknown) <-> FabricValue <-> Serialized (Uint8Array)
 *
 * Most native JS object types (`Error`, `Map`, `Set`, `Uint8Array`) enter the
 * fabric layer via wrapper classes that implement `FabricInstance`. However,
 * fabric primitives (`FabricEpochNsec`, `FabricEpochDays`, `FabricHash`) and
 * `bigint` are direct members of `FabricDatum` without implementing
 * `FabricInstance`. Native `Date` is converted to `FabricEpochNsec` during
 * conversion.
 *
 * `undefined` is preserved when the `modernDataModel` flag is ON. When the
 * flag is OFF, `undefined` in arrays is converted to `null` and `undefined`
 * object properties are omitted -- matching legacy behavior.
 */
export type FabricDatum =
  // -- Primitives --
  | null
  | boolean
  | number
  | string
  | bigint
  // -- Fabric primitives (FabricEpochNsec, FabricEpochDays, FabricHash) --
  | FabricPrimitive
  // -- Containers --
  | FabricArray
  | FabricObject
  // -- Protocol types (Cell, Stream, UnknownValue, ProblematicValue,
  //    and native wrappers like FabricError at runtime) --
  | FabricInstance
  // -- Extended primitives (experimental: modernDataModel) --
  | undefined;

/** An array of fabric data. */
export interface FabricArray extends ArrayLike<FabricDatum> {}

/**
 * An object/record of fabric data.
 *
 * Note: `__proto__` and `constructor` properties are not currently guarded
 * against at the type level or at runtime in clone/conversion internals.
 * If prototype pollution becomes a concern, add boundary validation where
 * values enter the fabric system (e.g., `fabricFromNativeValue`).
 */
export interface FabricObject extends Record<string, FabricDatum> {}

/**
 * A single "layer" of fabric conversion -- the result of shallow conversion
 * via `shallowFabricFromNativeValue()`. Arrays and objects have the right
 * shape but their contents may still contain values requiring further
 * conversion (e.g., Error instances in a `cause` chain).
 */
export type FabricValueLayer =
  | FabricValue
  | unknown[]
  | Record<string, unknown>;

/**
 * Union of raw native JS **object** types that the fabric type system can
 * convert into `FabricInstance` wrappers. These are the inputs to the
 * "sausage grinder" -- `shallowFabricFromNativeValue()` accepts
 * `FabricValue | FabricNativeObject`, meaning callers can pass in either
 * already-fabric data or raw native JS objects. The conversion produces
 * `FabricInstance` wrappers (FabricError, FabricMap, etc.) that live
 * inside `FabricValue` via the `FabricInstance` arm of `FabricDatum`.
 *
 * `Blob` is included because `FabricUint8Array.toNativeValue(true)` returns
 * a `Blob` (immutable by nature) instead of a `Uint8Array`. The synchronous
 * serialization path throws on `Blob` since its data access methods are async.
 *
 * The `{ toJSON(): unknown }` arm covers objects (and functions) that are
 * convertible to fabric form via their `toJSON()` method. This is a legacy
 * conversion path but is included here so the `canBeStored()` type predicate
 * (`value is FabricValue | FabricNativeObject`) remains sound.
 *
 * Note: `bigint` is NOT included here -- it is a primitive (like `undefined`)
 * and belongs directly in `FabricDatum` without wrapping.
 */
export type FabricNativeObject =
  | Error
  | Map<unknown, unknown>
  | Set<unknown>
  | Date
  | RegExp
  | Uint8Array
  | Blob
  | { toJSON(): unknown };

// ===========================================================================
// Fabric protocol interfaces
// ===========================================================================

/**
 * A class that can reconstruct fabric instances from essential state. The
 * static `[RECONSTRUCT]` method is separate from the constructor to support
 * reconstruction-specific context and instance interning.
 * See Section 2.4 of the formal spec.
 */
export interface FabricClass<T extends FabricInstance> {
  /**
   * Reconstruct an instance from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system. May return
   * an existing instance (interning) rather than creating a new one.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}

/**
 * A converter that can reconstruct arbitrary values (not necessarily
 * `FabricInstance`s) from essential state. Used for built-in JS types like
 * `Error` that participate in the serialization protocol but don't implement
 * `FabricInstance`. See Section 1.4.1 of the formal spec.
 */
export interface FabricValueConverter<T> {
  /**
   * Reconstruct a value from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}

/**
 * The minimal interface that `[RECONSTRUCT]` implementations may depend on.
 * Provided by the `Runtime` in practice, but defined as an interface here to
 * avoid a circular dependency between the fabric protocol and the runner.
 * See Section 2.5 of the formal spec.
 */
export interface ReconstructionContext {
  /** Resolve a cell reference. Used by types that need to intern or look up
   *  existing instances during reconstruction. */
  getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;
}

/**
 * Public boundary interface for serialization contexts. Encodes fabric
 * values into a serialized form and decodes them back. The type parameter
 * `SerializedForm` is the boundary type: `string` for JSON contexts,
 * `Uint8Array` for binary contexts.
 *
 * This is the only interface external callers need. Internal tree-walking
 * machinery is private to the context implementation.
 */
export interface SerializationContext<SerializedForm = unknown> {
  /** Whether failed reconstructions produce `ProblematicValue` instead of
   *  throwing. @default false */
  readonly lenient: boolean;

  /** Encode a fabric value into serialized form for boundary crossing. */
  encode(value: FabricValue): SerializedForm;

  /** Decode a serialized form back into a fabric value. */
  decode(
    data: SerializedForm,
    runtime: ReconstructionContext,
  ): FabricValue;
}

/**
 * Configuration for experimental data model features gated behind
 * `RuntimeOptions.experimental`. Uses ambient (module-level) state so that
 * deep call sites can check flags without parameter threading.
 *
 * See Section 1 of the formal spec (`docs/specs/space-model-formal-spec/`).
 */
export interface ExperimentalDataModelConfig {
  /** When `true`, fabric value functions use the extended type system
   *  (bigint, Map, Set, Uint8Array, Date, etc.). */
  modernDataModel: boolean;
}
