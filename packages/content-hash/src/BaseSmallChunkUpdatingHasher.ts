import { BaseIncrementalHasher } from "./BaseIncrementalHasher.ts";

/**
 * Size of the small-data buffer.
 */
const SMALLS_SIZE = 256;

/**
 * Base implementation of an `IncrementalHasher` which ephemerally collects
 * small-size `update()`s to pass along to an underlying `update()` which also
 * gets called directly for larger-size chunks.
 *
 * Using this base class is a win if (a) multiple small-size updates are common,
 * and (b) a small amount of extra byte copying wins over direct calls to the
 * underlying hasher's `update()`. This implementation modestly penalizes use
 * patterns where instances are used in a "one-shot" style (or a "couple-shots"
 * style), but probably not enough to matter, especially for larger payloads..
 */
export abstract class BaseSmallChunkUpdatingHasher
  extends BaseIncrementalHasher {
  #smalls = new Uint8Array(SMALLS_SIZE);
  #smallsOffset: number = 0;

  override digest(): Uint8Array;
  override digest(encoding: "base64url"): string;
  override digest(encoding: string | undefined): Uint8Array | string;
  override digest(encoding?: string | undefined): Uint8Array | string {
    this.#updateFromSmalls();
    return super.digest(encoding);
  }

  override update(data: Uint8Array) {
    const length = data.length;

    if (length <= SMALLS_SIZE) {
      const smallsOffset = this.#smallsOffset;

      if (length <= (SMALLS_SIZE - smallsOffset)) {
        // The given `data` fits in the space available in `#smalls`. Note:
        // We accept that in the case where the instance is done, a call that
        // ends up here won't throw the "already done" error.
        this.#smalls.set(data, smallsOffset);
        this.#smallsOffset += length;
        return;
      }
    }

    // `data` is too big to fit in the available `#smalls` space (even if it
    // would have fit if `#smalls` were emptier).

    this.#updateFromSmalls();
    super.update(data);
  }

  #updateFromSmalls() {
    const smallsOffset = this.#smallsOffset;

    if (smallsOffset === 0) {
      return;
    }

    const smalls = this.#smalls;
    const smallsFinal = (smallsOffset === smalls.length)
      ? smalls
      : smalls.subarray(0, smallsOffset);

    this._rawUpdate(smallsFinal);
    this.#smallsOffset = 0;
  }
}
