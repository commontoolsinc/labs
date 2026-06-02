/**
 * Type-only declarations and the `FabricInstance` base class for the fabric
 * data model. This file is intentionally free of runtime imports from other
 * data-model modules (only `import type` is used) so that it can be imported
 * by any module without creating circular dependencies.
 *
 * NOTE: `packages/api/index.ts` mirrors these types (and those from
 * `fabric-primitives/FabricHash.ts`, `fabric-primitives/FabricEpochNsec.ts`)
 * for the pattern compiler. Changes here must be kept in sync with the
 * corresponding declarations there.
 */

//
// `FabricSpecialObject`
//

/**
 * Abstract base class for all fabric-system value types. This is the common
 * superclass of `FabricInstance` (protocol types with `[DECONSTRUCT]`/`[RECONSTRUCT]`)
 * and `FabricPrimitive` (immutable special primitives). It enables a single
 * `instanceof FabricSpecialObject` check wherever code needs to recognize any
 * fabric-system value without caring which branch of the hierarchy it
 * belongs to.
 */
export abstract class FabricSpecialObject {}

//
// Fabric instance protocol (`[DECONSTRUCT]` / `[RECONSTRUCT]` / `FabricInstance`)
//

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
 * Well-known symbol for deeply freezing a fabric instance in place. The method
 * freezes the instance's own internal slot(s) and recurses into any nested
 * `FabricValue`s via the provided `subFreeze` callback. This is an abstract
 * member of `FabricInstance`, so the generic `deepFreeze()` operates on any
 * `FabricInstance` by gating on `instanceof` against the abstract base and
 * invoking this member -- it does not enumerate concrete subclasses.
 * Distinct from `deepClone()`: `[DEEP_FREEZE]` freezes the existing instance
 * in place; `deepClone()` constructs a new instance.
 */
export const DEEP_FREEZE: unique symbol = Symbol.for("common.deepFreeze");

/**
 * Well-known symbol for checking whether a fabric instance is already deeply
 * frozen, without mutating it. The sibling-of-`[DEEP_FREEZE]` *check*: it
 * verifies the instance's own internal slot(s) are in canonical deep-frozen
 * form and recurses into any nested `FabricValue`s via the provided
 * `subIsDeepFrozen` callback, returning the boolean conjunction. This is an
 * abstract member of `FabricInstance`, so the generic deep-frozen type guard
 * operates on any `FabricInstance` by gating on `instanceof` against the
 * abstract base and invoking this member -- it does not enumerate concrete
 * subclasses.
 *
 * Unlike `[DEEP_FREEZE]`, this method is side-effect-free and never throws:
 * a not-in-canonical-deep-frozen-form instance answers `false`, it does not
 * crash. (`[DEEP_FREEZE]` is a mutator and uses "death before confusion" on
 * a malformed internal slot; a status check must not.)
 */
export const IS_DEEP_FROZEN: unique symbol = Symbol.for(
  "common.isDeepFrozen",
);

/**
 * Abstract base class for values that participate in the fabric protocol.
 * See Section 2.3 of the formal spec.
 *
 * This is the pure abstract protocol -- the `instanceof`-able contract that
 * external code is written against. Concrete fabric-instance classes in the
 * data-model extend `BaseFabricInstance` (a subclass of this one) rather
 * than this class directly; `BaseFabricInstance` is where shared
 * template-method scaffolding (such as `shallowClone()`) lives.
 *
 * Subclasses must implement `[DECONSTRUCT]()`, `[DEEP_FREEZE]()`,
 * `[IS_DEEP_FROZEN]()`, `deepClone()`, and `shallowClone()` (the latter is
 * normally inherited from `BaseFabricInstance`). Subclasses must also
 * define a static member `[RECONSTRUCT]()`.
 */
export abstract class FabricInstance extends FabricSpecialObject {
  /**
   * Returns the essential state of this instance as a `FabricValue`.
   * Implementations must NOT recursively deconstruct nested values -- the
   * serialization system handles that.
   */
  abstract [DECONSTRUCT](): FabricValue;

  /**
   * Deeply freezes this instance in place: freezes this instance's own
   * internal slot(s) and recurses into each nested `FabricValue` by calling
   * the provided `subFreeze` callback on it. Implementations must NOT import
   * or call `deepFreeze()` directly -- recursion is handed through the
   * callback so that the freeze utility's caching / cycle-detection
   * bookkeeping is preserved and no import cycle is introduced.
   *
   * Returns the (now deeply-frozen) value. Freeze-in-place implementations
   * return `this`.
   */
  abstract [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue;

  /**
   * Indicates whether this instance is already deeply frozen, without
   * mutating it. Checks this instance's own internal slot(s) are in
   * canonical deep-frozen form and recurses into each nested `FabricValue`
   * via the provided `subIsDeepFrozen` callback, returning the boolean
   * conjunction. Implementations must NOT import or call the deep-frozen
   * type guard directly -- recursion is handed through the callback,
   * mirroring `[DEEP_FREEZE]`'s callback shape and avoiding an import cycle.
   *
   * Side-effect-free and must not throw: an instance that is not in
   * canonical deep-frozen form returns `false`.
   */
  abstract [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean;

  /**
   * Returns a new deep clone of this instance with equivalent data but no
   * shared structure for any unfrozen data in the original. When `frozen ===
   * true`, produces a frozen instance with maximal structural sharing, including
   * returning `this` if it is already deep-frozen. When `frozen === false`,
   * produces a deeply-mutable instance with no visible shared reference
   * structure with the original.
   *
   * TODO(danfuzz): This method should grow a base implementation on
   * `BaseFabricInstance` which defers to a `protected abstract` sibling,
   * mirroring the `shallowClone()`/`shallowUnfrozenClone()` split.
   */
  abstract deepClone(frozen: boolean): FabricInstance;

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   * The concrete template-method implementation lives on
   * `BaseFabricInstance`; this declaration just pins the protocol surface so
   * that callers can invoke it through a `FabricInstance` reference.
   */
  abstract shallowClone(frozen: boolean): FabricInstance;
}

//
// Fabric primitive base class
//

/**
 * Abstract base class for "special primitive" fabric types -- values that
 * behave like primitives in the fabric type system but are represented as
 * class instances for type safety and dispatch. Covers temporal types,
 * content IDs, byte sequences, and similar.
 *
 * Analogous to `ExplicitTagValue`, this class enables a single
 * `instanceof` check where code needs to handle any special primitive
 * uniformly.
 *
 * Instances are always frozen (like true primitives, they are immutable).
 * Each leaf subclass must call `Object.freeze(this)` at the end of its
 * constructor, after all fields are initialized. (Freezing in the base
 * constructor would prevent subclass field assignment.)
 *
 * See Section 1.4.5 and 1.4.6 of the formal spec.
 */
export abstract class FabricPrimitive extends FabricSpecialObject {
  constructor() {
    super();
  }
}

//
// Type definitions
//

/**
 * The full set of values that the fabric storage layer can represent. This
 * is the strongly-typed "middle layer" of the three-layer architecture:
 *
 *   JavaScript "wild west" (`unknown`) <-> `FabricValue` <-> Serialized (`Uint8Array`)
 *
 * Most native JS object types enter the fabric layer via wrapper classes
 * that extend `FabricInstance`; other special values extend `FabricPrimitive`.
 * Both of those reach `FabricValue` through the common `FabricSpecialObject`
 * arm. The non-object values (`bigint` and the other scalars) are direct
 * members of the union instead, not routed through that arm. Some native types
 * are converted to fabric primitives during conversion.
 *
 * `undefined` is preserved when the `modernDataModel` flag is ON. When the
 * flag is OFF, `undefined` in arrays is converted to `null` and `undefined`
 * object properties are omitted -- matching legacy behavior.
 *
 * `symbol` values are restricted at runtime to **registry-interned** symbols
 * -- those for which `Symbol.keyFor(s)` returns a string. These are
 * portable across realms and processes via their registry key. Unique
 * symbols (`Symbol(desc)`) are not portable and are rejected at the fabric
 * boundary. TypeScript's `symbol` type cannot distinguish the two, so the
 * gate is a runtime one. Note also that the modern fabric-value path
 * separately rejects all symbols at the entrance (relaxation deferred to a
 * follow-up); the type union admits `symbol` so the lower layers (hashing,
 * JSON encoding) can be written and tested ahead of that gate change.
 */
export type FabricValue =
  // -- Primitives --
  | null
  | boolean
  | number
  | string
  | bigint
  | symbol
  // -- Fabric special objects --
  | FabricSpecialObject
  // -- Containers --
  | FabricArray
  | FabricObject
  // -- undefined --
  | undefined;

/** Array of fabric values. */
export interface FabricArray extends ArrayLike<FabricValue> {}

/**
 * Object/record of fabric values.
 *
 * Note: `.__proto__` and `constructor()` properties are not currently guarded
 * against at the type level or at runtime in clone/conversion internals.
 * If prototype pollution becomes a concern, add boundary validation where
 * values enter the fabric system (e.g., `fabricFromNativeValue()`).
 */
export interface FabricObject extends Record<string, FabricValue> {}

/**
 * Single "layer" of fabric conversion -- the result of shallow conversion
 * via `shallowFabricFromNativeValue()`. Arrays and objects have the right
 * shape but their contents may still contain values requiring further
 * conversion (e.g., `Error` instances in a `.cause` chain).
 */
export type FabricValueLayer =
  | FabricValue
  | unknown[]
  | Record<string, unknown>;

/**
 * Union of raw native JS **object** types that the fabric type system can
 * convert into `FabricInstance` wrappers or `FabricPrimitive` values. These
 * are the inputs to the "sausage grinder" -- `shallowFabricFromNativeValue()`
 * accepts `FabricValue | FabricNativeObject`, meaning callers can pass in
 * either already-fabric data or raw native JS objects. The conversion
 * produces `FabricInstance` wrappers or `FabricPrimitive` values that live
 * inside `FabricValue`.
 *
 * The `{ toJSON(): unknown }` arm covers objects (and functions) that are
 * convertible to fabric form via their `toJSON()` method. This is a legacy
 * conversion path but is included here so the `isFabricCompatible()` type predicate
 * (`value is FabricValue | FabricNativeObject`) remains sound.
 *
 * Note: `bigint` is NOT included here -- it is a primitive (like `undefined`)
 * and belongs directly in `FabricValue` without wrapping.
 */
export type FabricNativeObject =
  | Error
  | Map<unknown, unknown>
  | Set<unknown>
  | Date
  | RegExp
  | Uint8Array
  | { toJSON(): unknown };

//
// Fabric protocol interfaces
//

/**
 * Interface for classes that can reconstruct fabric instances from essential
 * state. The static `[RECONSTRUCT]` method is separate from the constructor
 * to support reconstruction-specific context and instance interning.
 * See Section 2.4 of the formal spec.
 */
export interface FabricClass<T extends FabricInstance> {
  /**
   * Reconstructs an instance from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system. May return
   * an existing instance (interning) rather than creating a new one.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}

/**
 * Converter that can reconstruct arbitrary values (not necessarily
 * `FabricInstance`s) from essential state. Used for built-in JS types like
 * `Error` that participate in the serialization protocol but don't implement
 * `FabricInstance`. See Section 1.4.1 of the formal spec.
 */
export interface FabricValueConverter<T> {
  /**
   * Reconstructs a value from essential state. Nested values in `state`
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
  /** Resolves a cell reference. Used by types that need to intern or look up
   *  existing instances during reconstruction. */
  getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;

  /**
   * Signals whether a reconstruction call should produce a deep-frozen
   * result: `true` means the reconstructed value should be deep-frozen,
   * `false` means a mutable result is acceptable. Same contract as `frozen`
   * passed to `cloneIfNecessary()` (see `value-clone.ts`):
   * `shouldDeepFreeze === true` corresponds to
   * `cloneIfNecessary(value, { frozen: true })`.
   *
   * Required (not optional): every context declares it. Contexts get it for
   * free by extending `BaseReconstructionContext`, which centralizes the
   * getter; the `cloneIfNecessary`-style `true` default lives there.
   *
   * Enforcement: the concrete `[RECONSTRUCT]` implementations query this and
   * abide by it — they produce a deep-frozen result when it is `true`. The
   * one place this is *not* applied is the class-registry fallback
   * call-site wrap (`json-encoding-context.ts`'s `cls[RECONSTRUCT]` path);
   * that call-site deep-freeze is a separate follow-on's responsibility and
   * is intentionally NOT covered here. The per-implementation honoring is
   * sufficient for correctness regardless: each impl freezes its own output
   * when asked.
   */
  readonly shouldDeepFreeze: boolean;
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

  /** Encodes a fabric value into serialized form for boundary crossing. */
  encode(value: FabricValue): SerializedForm;

  /** Decodes a serialized form back into a fabric value. */
  decode(
    data: SerializedForm,
    runtime: ReconstructionContext,
  ): FabricValue;
}
