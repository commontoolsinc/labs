/**
 * Empty `ReconstructionContext`: a singleton whose `getCell()` always throws.
 * Useful as a default for decode paths that aren't expected to encounter
 * `Cell` references (e.g. storage-boundary reads of values known to be
 * structurally flat).
 */

import type { FabricInstance, ReconstructionContext } from "./interface.ts";

/**
 * Shared `ReconstructionContext` instance whose `getCell()` always throws.
 * Pass this when a decoder wants a context object but isn't expected to need
 * cell reconstruction; if a cell ref does turn up, the throw makes the
 * unexpected reconstruction obvious instead of silent.
 */
export const EMPTY_RECONSTRUCTION_CONTEXT: ReconstructionContext = Object
  .freeze({
    getCell(
      ref: { id: string; path: string[]; space: string },
    ): FabricInstance {
      throw new Error(
        `Cannot reconstruct cell reference \`${ref.id}\`: no runtime context provided.`,
      );
    },

    // The deep-frozen result is the safe default (mirrors
    // `cloneIfNecessary`'s `frozen` defaulting to `true`).
    shouldDeepFreeze: true,
  });
