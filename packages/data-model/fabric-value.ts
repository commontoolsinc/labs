import type { StorableInstance } from "./storable-instance.ts";
import type { StorableEpochDays, StorableEpochNsec } from "./storable-epoch.ts";

/**
 * A value that can be stored in the storage layer. This is similar to
 * `JSONValue` but is specifically intended for use at storage boundaries
 * (values going into or coming out of the database).
 *
 * Note: Once the `richStorableValues` experiment graduates and the rich path
 * becomes the default, `StorableValue = StorableDatum | undefined` will be a
 * redundant union (since `StorableDatum` includes `undefined`). The alias is
 * retained for compatibility and readability at call sites.
 */
export type StorableValue = StorableDatum | undefined;

/**
 * The full set of values that the storage layer can represent. This is the
 * strongly-typed "middle layer" of the three-layer architecture:
 *
 *   JavaScript "wild west" (unknown) <-> StorableValue <-> Serialized (Uint8Array)
 *
 * Most native JS object types (`Error`, `Map`, `Set`, `Uint8Array`) enter the
 * storable layer via wrapper classes that implement `StorableInstance`. However,
 * temporal types (`StorableEpochNsec`, `StorableEpochDays`) and `bigint` are
 * direct members of `StorableDatum` without implementing `StorableInstance`.
 * Native `Date` is converted to `StorableEpochNsec` during conversion.
 *
 * `undefined` is preserved when the `richStorableValues` flag is ON. When the
 * flag is OFF, `undefined` in arrays is converted to `null` and `undefined`
 * object properties are omitted -- matching legacy behavior.
 */
export type StorableDatum =
  // -- Primitives --
  | null
  | boolean
  | number
  | string
  | bigint
  // -- Temporal primitives --
  | StorableEpochNsec
  | StorableEpochDays
  // -- Containers --
  | StorableArray
  | StorableObject
  // -- Protocol types (Cell, Stream, UnknownStorable, ProblematicStorable,
  //    and native wrappers like StorableError at runtime) --
  | StorableInstance
  // -- Extended primitives (experimental: richStorableValues) --
  | undefined;

/** An array of storable data. */
export interface StorableArray extends ArrayLike<StorableDatum> {}

/**
 * An object/record of storable data.
 *
 * Note: `__proto__` and `constructor` properties are not currently guarded
 * against at the type level or at runtime in clone/conversion internals.
 * If prototype pollution becomes a concern, add boundary validation where
 * values enter the storable system (e.g., `storableFromNativeValue`).
 */
export interface StorableObject extends Record<string, StorableDatum> {}
