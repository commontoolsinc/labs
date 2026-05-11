import { BaseIncrementalHasher } from "./BaseIncrementalHasher.ts";

/**
 * When collecting chunks, size of the first chunk to collect into by default.
 */
const CHUNK_SIZE_FIRST = 1024;

/**
 * When collecting chunks, usual (and minimum) size of the chunks to collect
 * into after the initial chunk.
 */
const CHUNK_SIZE_USUAL = 65536;

/**
 * Base implementation of an `IncrementalHasher` which collects all data into
 * an array of chunks, for processing all at once when `digest()` is ultimately
 * called.
 */
export abstract class BaseCollectingHasher extends BaseIncrementalHasher {
  /** Finalized chunks. */
  #chunks: Uint8Array[] = [];

  /** Chunk in progress, if any. */
  #currentChunk: Uint8Array | null = null;

  /** Offset into `currentChunk` for next write. */
  #currentOffset = 0;

  /**
   * Performs a digest operation on the collected chunks using the underlying
   * hash implementation. Called by the base class. May ignore the `encoding`
   * and always return a `Uint8Array`.
   */
  protected abstract _digestChunks(
    encoding: string | undefined,
    chunks: Uint8Array[],
  ): Uint8Array | string;

  protected _rawUpdate(data: Uint8Array) {
    const length = data.length;

    this.#prepChunk(length);
    this.#currentChunk!.set(data, this.#currentOffset);
    this.#currentOffset += length;
  }

  protected _rawDigest(encoding: string | undefined): Uint8Array | string {
    let lastChunk = this.#currentChunk;
    if (lastChunk) {
      // Deal with the final (was in-progress) chunk.
      const lastLength = this.#currentOffset;
      if (lastLength !== lastChunk.length) {
        lastChunk = lastChunk.subarray(0, lastLength);
      }
      this.#chunks.push(lastChunk);
    }

    return this._digestChunks(encoding, this.#chunks);
  }

  /**
   * Arranges for there to be a `currentChunk` with enough room for the
   * indicated amount of data.
   */
  #prepChunk(length: number) {
    const current = this.#currentChunk;
    const offset = this.#currentOffset;

    if (current) {
      if (offset === current.length) {
        // Current chunk is exactly full. Add it to the list, and fall through
        // to set up a new one.
        this.#chunks.push(current);
      } else {
        const lengthLeft = current.length - offset;
        if (lengthLeft >= length) {
          // There's enough room in the current chunk for the new data.
          return;
        } else {
          // There's not enough room in the current chunk. Chop off the unused
          // part, add it to the list, and fall through to set up a new one.
          this.#chunks.push(current.subarray(0, offset));
        }
      }
    }

    // Need to create a new chunk.
    const baseLength = (this.#chunks.length === 0)
      ? CHUNK_SIZE_FIRST
      : CHUNK_SIZE_USUAL;
    const newLength = (length < (baseLength / 2)) ? baseLength : length * 2;

    const chunk = new Uint8Array(newLength);
    this.#currentChunk = chunk;
    this.#currentOffset = 0;
  }
}
