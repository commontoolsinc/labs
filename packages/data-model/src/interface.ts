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
 * superclass of `FabricInstance` (object-like protocol types) and
 * `FabricPrimitive` (immutable special primitives). It enables a single
 * `instanceof FabricSpecialObject` check wherever code needs to recognize any
 * fabric-system value without caring which branch of the hierarchy it
 * belongs to.
 */
export abstract class FabricSpecialObject {}

//
// Fabric instance protocol
//

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
   * true`, produces a frozen instance with maximal structural sharing, including
   * returning `this` if it is already deep-frozen. When `frozen === false`,
   * produces a deeply-mutable instance with no visible shared reference
   * structure with the original.
   *
   * The concrete template-method implementation lives on
   * `BaseFabricInstance` (deferring to the `[DEEP_CLONE_CORE]` sibling,
   * mirroring the `shallowClone()`/`[SHALLOW_UNFROZEN_CLONE]()` split); this
   * declaration just pins the protocol surface so that callers can invoke it
   * through a `FabricInstance` reference.
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
 * `undefined` is preserved.
 *
 * `symbol` values are restricted at runtime to **registry-interned** symbols
 * -- those for which `Symbol.keyFor(s)` returns a string. These are
 * portable across realms and processes via their registry key. Unique
 * symbols (`Symbol(desc)`) are not portable and are rejected at the fabric
 * boundary. TypeScript's `symbol` type cannot distinguish the two, so the
 * gate is a runtime one. Note also that the fabric-value path
 * separately rejects all symbols at the entrance (relaxation deferred to a
 * follow-up); the type union admits `symbol` so the lower layers (hashing,
 * JSON encoding) can be written and tested ahead of that gate change.
 *
 * **Deep-frozen honesty (mandatory).** A `FabricValue` must report its frozen
 * state truthfully and permanently. In particular, a fabric record or array is
 * data-only: it must not expose an own accessor (getter/setter) whose result
 * can contradict, or change after, the value's frozen state -- once a
 * `FabricValue` graph is deeply frozen, its contents are fixed. (For a
 * `FabricInstance`, the analogous obligation is on its `[IS_DEEP_FROZEN]`
 * report; see `BaseFabricInstance`.) `isDeepFrozen()` /
 * `isDeepFrozenFabricValue()` rely on this to cache deep-frozen proofs by root
 * identity without re-validating; a value that violates it can corrupt
 * data-model invariants, as any broken contract can.
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
  | FabricPlainObject
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
export interface FabricPlainObject extends Record<string, FabricValue> {}

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
 * convertible to fabric form via their `toJSON()` method. This is a
 * `toJSON()`-based conversion path, included here so the
 * `isFabricCompatible()` type predicate
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
