/**
 * Null `LiveEnvironment`: a singleton whose `getCell()` always throws.
 * Useful as a default for decode paths that aren't expected to encounter
 * `Cell` references (e.g. storage-boundary reads of values known to be
 * structurally flat).
 */

import { backtickQuote } from "@commonfabric/utils/markdown";
import type { FabricInstance } from "@/interface.ts";
import type { LiveEnvironment } from "./interface.ts";
import { BaseLiveEnvironment } from "./BaseLiveEnvironment.ts";

/**
 * `LiveEnvironment` whose `getCell()` always throws. `shouldDeepFreeze`
 * is inherited from `BaseLiveEnvironment` (defaults to `true`).
 */
export class NullLiveEnvironment extends BaseLiveEnvironment {
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
    this.#getCellMessage = getCellMessage ?? "no live environment provided.";
  }

  override getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance {
    throw new Error(
      `Cannot decode cell reference ${
        backtickQuote(ref.id)
      }: ${this.#getCellMessage}`,
    );
  }
}

/**
 * Shared `NullLiveEnvironment` instance with `.shouldDeepFreeze ===
 * true` and whose `getCell()` always throws. Pass this when a decoder wants a
 * context object but isn't expected to need cell decoding; if a cell ref
 * does turn up, the throw makes the unexpected decode obvious instead
 * of silent.
 */
export const NULL_LIVE_ENVIRONMENT: LiveEnvironment = Object
  .freeze(new NullLiveEnvironment(true));
