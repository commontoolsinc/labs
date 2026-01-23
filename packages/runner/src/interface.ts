import { ConsoleMethod } from "./harness/console.ts";

/**
 * A value that can be stored in the storage layer. This is similar to
 * `JSONValue` but is specifically intended for use at storage boundaries
 * (values going into or coming out of the database).
 *
 * `undefined` is allowed at the top level to indicate removal of a stored value.
 */
export type StorableValue = StorableDatum | undefined;

/**
 * A storable value that is definitely present (not `undefined`). This is the
 * type used for nested values within arrays and objects, where `undefined`
 * is not a valid JSON value.
 */
export type StorableDatum =
  | null
  | boolean
  | number
  | string
  | StorableArray
  | StorableObject;

/** An array of storable data. */
export interface StorableArray extends ArrayLike<StorableDatum> {}

/** An object/record of storable data. */
export interface StorableObject extends Record<string, StorableDatum> {}

export type ConsoleMessage = {
  metadata: { charmId?: string; recipeId?: string; space?: string } | undefined;
  method: ConsoleMethod;
  args: any[];
};
