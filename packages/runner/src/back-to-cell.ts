/**
 * Symbols and utilities for converting values back to cells.
 * These symbols are attached to objects during schema validation
 * to enable conversion back to cells when needed.
 */

import type { Cell } from "./cell.ts";

/**
 * Symbol to retrieve a cell from a value.
 * When present on an object, calling the function at this symbol
 * returns the cell that the value was derived from.
 *
 * TODO(seefeld): key this on a WeakMap from value to cell instead of a symbol
 * attached to the value. Carrying it as a property is what forces every value
 * that needs a back-pointer to be an object with a reachable surface — see
 * `createOpaquePresence()` in schema.ts, which has to project an empty object
 * where a fresh symbol per value would say exactly as much and expose nothing.
 */
export const toCell = Symbol("toCell");

/**
 * Type representing the internal structure of values that can be
 * converted back to cells.
 */
export type BackToCellInternals = {
  [toCell]: () => Cell<unknown>;
};

/**
 * Type representing a value that has been annotated with back-to-cell symbols.
 */
export type WithBackToCell<T> = T & BackToCellInternals;
