/**
 * Empty `ReconstructionContext`: a singleton whose `getCell()` always throws.
 * Useful as a default for decode paths that aren't expected to encounter
 * `Cell` references (e.g. storage-boundary reads of values known to be
 * structurally flat).
 */

import type { FabricInstance, ReconstructionContext } from "./interface.ts";
import { BaseReconstructionContext } from "./base-reconstruction-context.ts";

/**
 * `ReconstructionContext` whose `getCell()` always throws. `shouldDeepFreeze`
 * is inherited from `BaseReconstructionContext` (defaults to `true`).
 */
class EmptyReconstructionContext extends BaseReconstructionContext {
  override getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance {
    throw new Error(
      `Cannot reconstruct cell reference \`${ref.id}\`: no runtime context provided.`,
    );
  }
}

/**
 * Shared `ReconstructionContext` instance whose `getCell()` always throws.
 * Pass this when a decoder wants a context object but isn't expected to need
 * cell reconstruction; if a cell ref does turn up, the throw makes the
 * unexpected reconstruction obvious instead of silent.
 */
export const EMPTY_RECONSTRUCTION_CONTEXT: ReconstructionContext = Object
  .freeze(new EmptyReconstructionContext());
