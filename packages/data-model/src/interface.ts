/**
 * The `FabricSpecialObject` class hierarchy and the conversion-layer types of
 * the fabric data model, together with the pattern-visible value types that
 * `api.ts` declares, re-exported here so that this module carries the whole
 * `FabricValue` vocabulary. It is intentionally free of runtime imports (only
 * `import type` is used) so that any module can import it without creating a
 * circular dependency.
 *
 * The classes here and the declarations in `api.ts` describe the same shapes,
 * and the assertions at the end of this file stop compiling when they drift.
 * The concrete classes under `fabric-primitives/` and `fabric-instances/`
 * carry the same kind of guard, each beside its own definition.
 */

import type {
  FabricArray,
  FabricContainerValue,
  FabricInstance as ApiFabricInstance,
  FabricPlainObject,
  FabricPrimitive as ApiFabricPrimitive,
  FabricSpecialObject as ApiFabricSpecialObject,
  FabricValue,
  NonNullableFabricValue,
} from "./api.ts";

//
// `FabricSpecialObject`
//

/**
 * Abstract base class for all fabric-system value types. This is the common
 * superclass of `FabricInstance` (object-like protocol types) and
 * `FabricPrimitive` (immutable special primitives). It enables a single
 * `instanceof FabricSpecialObject` check wherever code needs to recognize any
 * fabric-system value without caring which branch of the hierarchy it
 * belongs to.
 *
 * The `@commonfabric/FabricSpecialObject` member is a nominal brand, and
 * exists only in the type system: `declare` emits no runtime member, and
 * nothing ever reads the key. Without it the class is structurally empty, so
 * *every* object satisfies `FabricSpecialObject` — which in turn makes every
 * object satisfy `FabricValue`, since that union includes this type. The brand
 * is what makes `FabricValue` mean anything as a static claim.
 *
 * It is a well-known string key rather than a `unique symbol` because that
 * would require importing a symbol *value*, and this file is deliberately free
 * of runtime imports (see the file header). `api.ts` declares the identical
 * member, and the assertions at the end of this file stop compiling if the two
 * stop agreeing; a value branded by one would otherwise not satisfy the
 * other.
 */
export abstract class FabricSpecialObject {
  declare readonly "@commonfabric/FabricSpecialObject": true;
}

//
// `FabricInstance` protocol
//

/**
 * Abstract base class for values that participate in the fabric protocol.
 * See Section 2.3 of the formal spec.
 *
 * This is the pure abstract protocol -- the `instanceof`-able contract that
 * external code is written against. Concrete `FabricInstance` classes in the
 * data-model extend `BaseFabricInstance` (a subclass of this one) rather
 * than this class directly; `BaseFabricInstance` is where shared
 * template-method scaffolding (such as `shallowClone()`) lives.
 *
 * An instance holds all of its state privately and makes it reachable only
 * through members, so it has no own properties at all. A structural view of
 * one -- a spread, `Object.keys()`, a naive walk -- therefore sees nothing.
 * Mutable state is exposed as an accessor pair over a private field, whose
 * setter is responsible for honoring the instance's frozen state:
 * `Object.freeze()` bears only on own properties and so cannot enforce that
 * on its own.
 *
 * Subclasses must implement `deepClone()` and `shallowClone()`; both are
 * normally inherited from `BaseFabricInstance` as template methods, with the
 * subclass supplying the symbol-keyed clone core each one calls. The
 * freeze-protocol members `[DEEP_FREEZE]()` and `[IS_DEEP_FROZEN]()` are
 * declared on `BaseFabricInstance`, not here: they are implementation plumbing
 * and are kept off this pure-protocol class.
 */
export abstract class FabricInstance extends FabricSpecialObject {
  /**
   * Returns a new deep clone of this instance with equivalent data but no
   * shared structure for any unfrozen data in the original. When `frozen ===
   * true`, produces a frozen instance with maximal structural sharing,
   * including returning `this` if it is already deep-frozen. When `frozen ===
   * false`, produces a deeply-mutable instance with no visible shared reference
   * structure with the original.
   *
   * The concrete template-method implementation lives on `BaseFabricInstance`
   * (deferring to the `[DEEP_CLONE_CORE]` sibling, mirroring the
   * `shallowClone()`/`[SHALLOW_UNFROZEN_CLONE]()` split); this declaration just
   * pins the protocol surface so that callers can invoke it through a
   * `FabricInstance` reference.
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
// `FabricPrimitive` base class
//

/**
 * Abstract base class for "special primitive" fabric types -- values that
 * behave like primitives in the fabric type system but are represented as
 * class instances for type safety and dispatch. Covers temporal types,
 * content IDs, byte sequences, and similar.
 *
 * This class enables a single `instanceof` check where code needs to handle
 * any `FabricPrimitive` uniformly.
 *
 * Instances are always frozen (like true primitives, they are immutable).
 * Each leaf subclass must call `Object.freeze(this)` at the end of its
 * constructor, after all fields are initialized. (Freezing in the base
 * constructor would prevent subclass field assignment.)
 *
 * See Section 1.4.6 of the formal spec.
 */
export abstract class FabricPrimitive extends FabricSpecialObject {
  /** Constructs an instance. */
  constructor() {
    super();
  }
}

//
// Type definitions
//

/**
 * The pattern-visible fabric value types, declared in `api.ts` and re-exported
 * here so that this module carries the whole `FabricValue` vocabulary. `api.ts`
 * is where they have to be declared: it reaches patterns by being inlined into
 * the type module the pattern compiler serves, and so may name no import,
 * which makes it the leaf of this pair.
 */
export type {
  FabricArray,
  FabricContainerValue,
  FabricPlainObject,
  FabricValue,
  NonNullableFabricValue,
};

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

/** A mutable array root whose elements remain `FabricValue`s. */
export type MutableFabricArrayLayer = FabricValue[];

/** A mutable record root whose values remain `FabricValue`s. */
export type MutableFabricPlainObjectLayer = Record<string, FabricValue>;

/**
 * A `FabricContainerValue` with a mutable root. Nested containers remain
 * ordinary (readonly) `FabricValue`s, so this models a single construction
 * layer rather than a deep thaw. A `FabricInstance` arm passes through
 * unchanged: an instance's mutability is its own frozen state to report, not
 * something a type can layer over it.
 */
export type MutableFabricContainerValueLayer =
  | FabricInstance
  | MutableFabricArrayLayer
  | MutableFabricPlainObjectLayer;

/**
 * A `FabricValue` with a mutable root container. Nested containers remain
 * ordinary (readonly) `FabricValue`s, so this models a single construction
 * layer rather than a deep thaw.
 */
export type MutableFabricValueLayer =
  | Exclude<FabricValue, FabricArray | FabricPlainObject>
  | MutableFabricArrayLayer
  | MutableFabricPlainObjectLayer;

/**
 * Union of raw native JS **object** types that the fabric type system can
 * convert into `FabricInstance` wrappers or `FabricPrimitive` values. These
 * are the inputs to the "sausage grinder" -- `shallowFabricFromNativeValue()`
 * accepts `unknown`, so callers can hand it `FabricValue`s or raw native JS
 * objects alike, and whatever it cannot represent is rejected there rather
 * than excluded by the signature. The conversion produces `FabricInstance`
 * wrappers or `FabricPrimitive` values that live inside `FabricValue`.
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
  | Uint8Array;

/**
 * A `FabricValue`, a `FabricNativeObject`, or a deep tree thereof -- the values
 * that convert to and from fabric form. This is the precondition of
 * `fabricFromNativeValue()` (which fails on anything else), the result of
 * `nativeFromFabricValue()`, and what `isValidFabricConvertibleValue()` tests
 * for.
 *
 * Distinct from `FabricValue`: containers here may hold `FabricNativeObject`s.
 * Converting a `FabricError` yields an `Error`, so an array of them is an array
 * of natives, which has no `FabricValue` name.
 */
export type FabricConvertibleValue =
  | FabricValue
  | FabricNativeObject
  | readonly FabricConvertibleValue[]
  | { readonly [key: string]: FabricConvertibleValue };

//
// Agreement with the pattern-visible declarations
//

/** Whether `A` and `B` are mutually assignable. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compiles only when its argument is `true`. */
type MustBeTrue<T extends true> = T;

// Compile-time checks that the abstract base classes above and the
// declarations in `api.ts` -- which is what a pattern compiles against --
// describe the same shape.
//
// Mutual assignability, not `satisfies`. A one-way check passes when the class
// carries a member the declaration omits, since the extra member only makes
// the class more assignable; that is the direction a pattern feels, because
// the member it cannot reach is the one missing from the declaration. Both
// directions have to be asserted for a member added on either side alone to
// fail here.
type _SpecialObjectAgrees = MustBeTrue<
  Same<FabricSpecialObject, ApiFabricSpecialObject>
>;
type _InstanceAgrees = MustBeTrue<Same<FabricInstance, ApiFabricInstance>>;
type _PrimitiveAgrees = MustBeTrue<Same<FabricPrimitive, ApiFabricPrimitive>>;
