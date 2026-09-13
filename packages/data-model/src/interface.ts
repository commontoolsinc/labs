/**
 * The `FabricSpecialObject` class hierarchy and the conversion-layer types of
 * the fabric data model, together with the pattern-visible value types that
 * `api.ts` declares, re-exported here so that this module carries the whole
 * `FabricValue` vocabulary. It is intentionally free of runtime imports (only
 * `import type` is used) so that any module can import it without creating a
 * circular dependency.
 *
 * The classes here and the declarations in `api.ts` describe the same shapes,
 * and `api-agreement.ts` stops compiling when they drift. The concrete classes
 * under `fabric-primitives/` and `fabric-instances/` carry the same kind of
 * guard, each beside its own definition.
 */

import type {
  FabricArray,
  FabricPlainObject,
  FabricValue,
  FabricValuePlus,
} from "./api.ts";

// We re-`export` all the _types_ from `./api.ts`, so that they're consistently
// available internally to `data-model` without having to `import ... from
// "./api.ts"`.
export type * from "./api.ts";

//
// "Layer" types
//
// A layer type is a `FabricValue`-like type whose claim stops at the root
// container. `FabricValueLayer` leaves what the root holds untyped, and the
// `Mutable*Layer` types keep what it holds as ordinary `FabricValue`s but
// leave the root itself writable. In each case the root still carries the
// other `FabricValue` restrictions on its kind of container (e.g., for an
// array, no synthetic keys and no named properties other than `length`).
//

/**
 * Single "layer" of fabric conversion -- the result of shallow conversion
 * via `shallowFabricFromNativeValue()`. Arrays and objects have the right
 * shape but their contents may still contain values requiring further
 * conversion (e.g., `Error` instances in a `.cause` chain).
 */
export type FabricValueLayer = FabricValuePlus<
  unknown[] | Record<string, unknown>
>;

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

//
// Types for dealing with native (non-fabric, a/k/a "wild west") values
//

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
export type FabricConvertibleValue = FabricValuePlus<FabricNativeObject>;

//
// Abstract base classes
//
// The _class_ definitions corresponding to the _interface_ definitions in
// `api.ts` of `FabricSpecialObject` and its only two direct subclasses.
//

/**
 * Common base class for `FabricInstance` and `FabricPrimitive`, which are the
 * only two kinds of `FabricValue` beyond the JavaScript built-ins. The two
 * differ along one axis: whether the data model treats an instance as a
 * primitive. A `FabricPrimitive` is treated the way a built-in `string` or
 * `number` is; a `FabricInstance` is treated the way an `object` is. What
 * follows from that, and what a caller sees of it, is that a `FabricInstance`
 * may hold and expose arbitrary outgoing `FabricValue` references, and a
 * `FabricPrimitive` may not. Enables a single `instanceof FabricSpecialObject`
 * check wherever code needs to recognize any fabric-system value without
 * caring which branch of the hierarchy it belongs to.
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
 * member, and `api-agreement.ts` stops compiling if the two stop agreeing; a
 * value branded by one would otherwise not satisfy the other.
 */
export abstract class FabricSpecialObject {
  declare readonly "@commonfabric/FabricSpecialObject": true;
}

/**
 * Abstract base class for the `FabricValue`s that participate in the fabric
 * protocol as non-primitives. An instance may hold and expose arbitrary
 * outgoing `FabricValue` references, and is mutable until frozen.
 * `FabricSpecialObject` says how this differs from `FabricPrimitive`. See
 * Section 2.3 of the formal spec.
 *
 * This is the pure abstract protocol -- the `instanceof`-able contract that
 * external code is written against. Concrete `FabricInstance` classes in the
 * data-model extend `BaseFabricInstance` (a subclass of this one) rather
 * than this class directly; `BaseFabricInstance` is where shared
 * template-method scaffolding (such as `shallowClone()`) lives.
 *
 * An instance holds all of its state privately and makes it reachable only
 * through members, so it has no enumerable own properties. A structural view
 * of one -- a spread, `Object.keys()`, a naive walk -- therefore sees nothing.
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

/**
 * Abstract base class for the `FabricValue`s that participate in the fabric
 * protocol as primitives: values that behave like primitives in the fabric
 * type system but are represented as class instances for type safety and
 * dispatch. Covers temporal types, content IDs, byte sequences, and similar.
 * `FabricSpecialObject` says how this differs from `FabricInstance`.
 *
 * This class enables a single `instanceof` check where code needs to handle
 * any `FabricPrimitive` uniformly.
 *
 * Instances are always frozen (like true primitives, they are immutable), pass
 * through the native conversions unchanged, and hold no arbitrary outgoing
 * `FabricValue` reference. `BaseFabricPrimitive` freezes each instance at
 * construction; a subclass keeps its state in private fields, which the freeze
 * does not reach.
 *
 * See Section 1.4.6 of the formal spec.
 */
export abstract class FabricPrimitive extends FabricSpecialObject {
  /** Constructs an instance. */
  constructor() {
    super();
  }
}
