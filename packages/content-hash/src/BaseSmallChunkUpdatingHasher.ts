import { BaseIncrementalHasher } from "./BaseIncrementalHasher.ts";

/**
 * Size of the small-data buffer.
 */
const SMALLS_SIZE = 256;

/**
 * Base implementation of an `IncrementalHasher` which ephemerally collects
 * small-size `update()`s to pass along to an underlying `update()` which also
 * gets called directly for larger-size chunks.
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

  update(data: Uint8Array) {
    const length = data.length;

    if (length <= SMALLS_SIZE) {
      const smallsOffset = this.#smallsOffset;

      if (length <= (SMALLS_SIZE - smallsOffset)) {
        this.#smalls.set(data, smallsOffset);
        this.#smallsOffset += length;
        return;
      }
    }

    this.#updateFromSmalls();
    this._rawUpdate(data);
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

  protected abstract _rawUpdate(data: Uint8Array): void;
}
