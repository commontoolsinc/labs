/**
 * Base class for `LiveEnvironment` implementations. Centralizes the
 * `shouldDeepFreeze` getter so every live environment declares the (required)
 * member via a single shared implementation instead of repeating it.
 */

import type { FabricInstance } from "@/interface.ts";
import type { LiveEnvironment } from "./interface.ts";

/**
 * Abstract base that supplies the `shouldDeepFreeze` getter from a
 * constructor argument. Subclasses implement `getCell()` for their own
 * boundary semantics; they inherit `shouldDeepFreeze` for free.
 */
export abstract class BaseLiveEnvironment implements LiveEnvironment {
  readonly #shouldDeepFreeze: boolean;

  /**
   * Constructs an instance which reports `shouldDeepFreeze` for the frozenness
   * of what it decodes.
   */
  constructor(shouldDeepFreeze: boolean) {
    this.#shouldDeepFreeze = shouldDeepFreeze;
  }

  //
  // Subclass contract
  //

  /** Resolves a cell reference. Subclass-specific. */
  abstract getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;

  //
  // Instance members
  //

  /**
   * Whether a decode call should produce a deep-frozen result. See
   * `LiveEnvironment.shouldDeepFreeze`.
   */
  get shouldDeepFreeze(): boolean {
    return this.#shouldDeepFreeze;
  }
}
