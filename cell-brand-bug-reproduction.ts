/**
 * Minimal test case for OpaqueRef<Cell<T>> CELL_BRAND conflict
 *
 * PROBLEM: OpaqueRef<T> recursively wraps ALL properties of T (including [CELL_BRAND]).
 * When T is Cell<number>, this creates conflicting types for [CELL_BRAND]:
 *   - OpaqueCell<Cell<number>> has [CELL_BRAND]: "opaque"
 *   - { counter: OpaqueRef<Cell<number>> } creates [CELL_BRAND]: OpaqueRef<"cell">
 * The intersection reduces to 'never'.
 */

import { type Cell, type OpaqueRef } from "./packages/api/index.ts";

interface State {
  counter: Cell<number>;
}

// Accessing properties on OpaqueRef<Cell<T>> fails type-checking
function _reproducesBug(state: OpaqueRef<State>) {
  state.counter.set(state.counter.get() + 1);
  //            ^^^ Property 'set' does not exist on type 'never'
  //                                  ^^^ Property 'get' does not exist on type 'never'
  // ERROR: The intersection 'OpaqueRef<Cell<number>>' was reduced to 'never'
  // because property '[CELL_BRAND]' has conflicting types in some constituents.
}
