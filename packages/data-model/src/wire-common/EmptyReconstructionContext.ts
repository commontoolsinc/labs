/**
 * Empty `ReconstructionContext`: a singleton whose `getCell()` always throws.
 * Useful as a default for decode paths that aren't expected to encounter
 * `Cell` references (e.g. storage-boundary reads of values known to be
 * structurally flat).
 */

import type { FabricInstance } from "../interface.ts";
import type { ReconstructionContext } from "./interface.ts";
import { BaseReconstructionContext } from "./BaseReconstructionContext.ts";

/**
 * `ReconstructionContext` whose `getCell()` always throws. `shouldDeepFreeze`
 * is inherited from `BaseReconstructionContext` (defaults to `true`).
 */
export class EmptyReconstructionContext extends BaseReconstructionContext {
  readonly #getCellMessage: string;

  /**
   * Constructs an instance.
   *
   * @param shouldDeepFreeze - Should the result be deep-frozen?
   * @param getCellMessage - Message to use in `getCell()` throw. Defaults to a
   * generic message.
   */
  constructor(shouldDeepFreeze: boolean, getCellMessage?: string) {
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
 * Shared `EmptyReconstructionContext` instance with `.shouldDeepFreeze ===
 * true` and whose `getCell()` always throws. Pass this when a decoder wants a
 * context object but isn't expected to need cell reconstruction; if a cell ref
 * does turn up, the throw makes the unexpected reconstruction obvious instead
 * of silent.
 */
export const EMPTY_RECONSTRUCTION_CONTEXT: ReconstructionContext = Object
  .freeze(new EmptyReconstructionContext(true));
