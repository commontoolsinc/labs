/**
 * Base class for `ReconstructionContext` implementations. Centralizes the
 * `shouldDeepFreeze` getter so every context declares the (required) member
 * via a single shared implementation instead of repeating it.
 */

import type { FabricInstance } from "./interface.ts";
import type { ReconstructionContext } from "./wire-common/interface.ts";

/**
 * Abstract base that supplies the `shouldDeepFreeze` getter from a
 * constructor argument. Subclasses implement `getCell()` for their own
 * boundary semantics; they inherit `shouldDeepFreeze` for free.
 */
export abstract class BaseReconstructionContext
  implements ReconstructionContext {
  readonly #shouldDeepFreeze: boolean;

  constructor(shouldDeepFreeze: boolean) {
    this.#shouldDeepFreeze = shouldDeepFreeze;
  }

  /**
   * Whether a reconstruction call should produce a deep-frozen result. See
   * `ReconstructionContext.shouldDeepFreeze`.
   */
  get shouldDeepFreeze(): boolean {
    return this.#shouldDeepFreeze;
  }

  /** Resolves a cell reference. Subclass-specific. */
  abstract getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;
}
