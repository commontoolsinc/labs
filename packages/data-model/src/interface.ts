/**
 * Type-only declarations, the `FabricInstance` base class, and the protocol
 * symbols keyed on a fabric class, for the fabric data model. This file is
 * intentionally free of runtime imports from other
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
 * Well-known symbol for binding the static getter
 * `FabricClassWithJsonCodec[JSON_CODEC]` on a `FabricPrimitive` class.
 *
 * A `FabricPrimitive`'s codec is bound per wire format, not once for all of
 * them, because these classes are where the formats disagree. `FabricBytes`
 * encodes to a base64url string, which is JSON's answer and nobody else's: a
 * format that carries bytes natively wants a different codec, or none, and
 * says so by looking up a different symbol.
 *
 * What differs can be the _kind_ of codec and not merely the state it
 * produces, which is why the binding is per format rather than a property of
 * the class. `FabricRegExp` decomposes into a record of strings under JSON,
 * which has no pattern type of its own to terminate into.
 *
 * That is what separates these from a `FabricInstance`'s codec, bound to the
 * generic `[CODEC]`: an instance's codec only decomposes an instance into
 * other `FabricValue`s and leaves every terminal decision to whatever walks
 * the result, so one binding serves every format.
 *
 * It lives here, with the type universe, rather than beside either the classes
 * that bind it or the format that reads it. Both of those have importers in
 * the other direction, and this module imports nothing, so a symbol here is
 * reachable from anywhere without closing a cycle.
 */
export const JSON_CODEC: unique symbol = Symbol("data-model.jsonCodec");

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
 * of runtime imports (see the file header). `packages/api/index.ts` declares
 * the identical member; the two must agree exactly, or a value branded by one
 * will not satisfy the other.
 */
export abstract class FabricSpecialObject {
  declare readonly "@commonfabric/FabricSpecialObject": true;
}

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
  /** Constructs an instance. */
  constructor() {
    super();
  }
}

//
// Type definitions
//

/**
 * The full set of values that the fabric storage layer can represent. This is
 * the strongly-typed "middle layer" of the three-layer architecture:
 *
 *     JavaScript "wild west" (`unknown`)
 *       <-> `FabricValue`
 *       <-> serialized (`Uint8Array`)
 *
 * Most native JS object types enter the fabric layer via wrapper classes that
 * extend `FabricInstance`; other special values extend `FabricPrimitive`. Both
 * of those reach `FabricValue` through the common `FabricSpecialObject` arm.
 * The non-object values (`bigint` and the other scalars) are direct members of
 * the union instead, not routed through that arm. Some native types are
 * converted to fabric primitives during conversion.
 *
 * `undefined` is preserved.
 *
 * `symbol` values are restricted at runtime to **registry-interned** symbols --
 * those for which `Symbol.keyFor(s)` returns a string. These are portable
 * across realms and processes via their registry key. Unique symbols
 * (`Symbol(desc)`) are not portable and are rejected at the fabric boundary.
 * TypeScript's `symbol` type cannot distinguish the two, so the gate is a
 * runtime one, and it is the same gate at every point a symbol is admitted or
 * refused: `Symbol.keyFor(value) !== undefined`.
 *
 * **Deep-frozen honesty (mandatory).** A `FabricValue` must report its frozen
 * state truthfully and permanently. In particular, a fabric record or array is
 * data-only: it must not expose an own accessor (getter/setter) whose result
 * can contradict, or change after, the value's frozen state -- once a
 * `FabricValue` graph is deeply frozen, its contents are fixed. (For a
 * `FabricInstance`, the analogous obligation is on its `[IS_DEEP_FROZEN]`
 * report; see `BaseFabricInstance`.) The rest of the system -- the data model
 * in general and `isDeepFrozen()` specifically, but also the entire codebase
 * that _uses_ the data model -- relies on this to cache deep-frozen proofs by
 * root identity without re-validating; a value that violates it can corrupt
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

/** A fabric value other than `null` or `undefined`. */
export type NonNullableFabricValue = NonNullable<FabricValue>;

/** Read-only array of fabric values. */
export interface FabricArray extends ReadonlyArray<FabricValue> {}

/**
 * Object/record of fabric values.
 *
 * The names `__proto__` and `constructor` are refused at the boundaries where
 * values enter or leave storage, so no `FabricPlainObject` carries one. The
 * type cannot say as much -- a string index signature admits every string --
 * so the guarantee is the boundary's, not TypeScript's. Note the internal copy
 * loops are unguarded and rely on it: they rebuild records by assignment,
 * which for `__proto__` would repoint the copy's prototype rather than
 * creating a property.
 */
export interface FabricPlainObject
  extends Readonly<Record<string, FabricValue>> {}

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

/** A mutable array root whose elements remain fabric values. */
export type MutableFabricArrayLayer = FabricValue[];

/** A mutable record root whose values remain fabric values. */
export type MutableFabricPlainObjectLayer = Record<string, FabricValue>;

/**
 * A fabric value with a mutable root container. Nested containers remain
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
 * accepts `unknown`, so callers can hand it already-fabric data or raw native
 * JS objects alike, and whatever it cannot represent is rejected there rather
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
 * `nativeFromFabricValue()`, and what `isFabricCompatible()` tests for.
 *
 * Distinct from `FabricValue`: containers here may hold `FabricNativeObject`s.
 * Converting a `FabricError` yields an `Error`, so an array of them is an array
 * of natives, which has no `FabricValue` name.
 */
export type FabricOrConvertibleNativeValue =
  | FabricValue
  | FabricNativeObject
  | readonly FabricOrConvertibleNativeValue[]
  | { readonly [key: string]: FabricOrConvertibleNativeValue };
