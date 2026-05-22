/**
 * Empty `ReconstructionContext`: a singleton whose `getCell()` always throws.
 * Useful as a default for decode paths that aren't expected to encounter
 * `Cell` references (e.g. storage-boundary reads of values known to be
 * structurally flat).
 */

import type { FabricInstance, ReconstructionContext } from "./interface.ts";
import { BaseReconstructionContext } from "./BaseReconstructionContext.ts";

/**
 * `ReconstructionContext` whose `getCell()` always throws. `shouldDeepFreeze`
 * is inherited from `BaseReconstructionContext` (defaults to `true`).
 *
 * Both constructor arguments are optional and default so that
 * `new EmptyReconstructionContext()` is byte-identical to the historical
 * singleton: `shouldDeepFreeze` defaults to `true` (via the base class) and
 * the `getCell()` throw message defaults to the original literal. Callers
 * that need a different frozenness intent (e.g. a clone path that owns its
 * own freeze decision) or a situation-appropriate throw message pass them
 * explicitly.
 */
export class EmptyReconstructionContext extends BaseReconstructionContext {
  readonly #getCellMessage: string;

  constructor(shouldDeepFreeze?: boolean, getCellMessage?: string) {
    super(shouldDeepFreeze);
    this.#getCellMessage = getCellMessage ?? "no runtime context provided.";
  }

  override getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance {
    throw new Error(
      `Cannot reconstruct cell reference \`${ref.id}\`: ${this.#getCellMessage}`,
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
