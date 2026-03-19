import type { FabricInstance } from "./storable-instance.ts";
import type { FabricEpochDays, FabricEpochNsec } from "./storable-epoch.ts";

/**
 * A value that can be stored in the storage layer. This is similar to
 * `JSONValue` but is specifically intended for use at storage boundaries
 * (values going into or coming out of the database).
 *
 * Note: Once the `richStorableValues` experiment graduates and the rich path
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
 * storable layer via wrapper classes that implement `FabricInstance`. However,
 * temporal types (`FabricEpochNsec`, `FabricEpochDays`) and `bigint` are
 * direct members of `FabricDatum` without implementing `FabricInstance`.
 * Native `Date` is converted to `FabricEpochNsec` during conversion.
 *
 * `undefined` is preserved when the `richStorableValues` flag is ON. When the
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
  // -- Temporal primitives --
  | FabricEpochNsec
  | FabricEpochDays
  // -- Containers --
  | FabricArray
  | FabricObject
  // -- Protocol types (Cell, Stream, UnknownStorable, ProblematicStorable,
  //    and native wrappers like StorableError at runtime) --
  | FabricInstance
  // -- Extended primitives (experimental: richStorableValues) --
  | undefined;

/** An array of storable data. */
export interface FabricArray extends ArrayLike<FabricDatum> {}

/**
 * An object/record of storable data.
 *
 * Note: `__proto__` and `constructor` properties are not currently guarded
 * against at the type level or at runtime in clone/conversion internals.
 * If prototype pollution becomes a concern, add boundary validation where
 * values enter the storable system (e.g., `storableFromNativeValue`).
 */
export interface FabricObject extends Record<string, FabricDatum> {}

/**
 * A single "layer" of storable conversion -- the result of shallow conversion
 * via `shallowStorableFromNativeValue()`. Arrays and objects have the right
 * shape but their contents may still contain values requiring further
 * conversion (e.g., Error instances in a `cause` chain).
 */
export type FabricValueLayer =
  | FabricValue
  | unknown[]
  | Record<string, unknown>;

/**
 * Union of raw native JS **object** types that the storable type system can
 * convert into `FabricInstance` wrappers. These are the inputs to the
 * "sausage grinder" -- `shallowStorableFromNativeValue()` accepts
 * `FabricValue | FabricNativeObject`, meaning callers can pass in either
 * already-storable data or raw native JS objects. The conversion produces
 * `FabricInstance` wrappers (StorableError, StorableMap, etc.) that live
 * inside `FabricValue` via the `FabricInstance` arm of `FabricDatum`.
 *
 * `Blob` is included because `StorableUint8Array.toNativeValue(true)` returns
 * a `Blob` (immutable by nature) instead of a `Uint8Array`. The synchronous
 * serialization path throws on `Blob` since its data access methods are async.
 *
 * The `{ toJSON(): unknown }` arm covers objects (and functions) that are
 * convertible to storable form via their `toJSON()` method. This is a legacy
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
