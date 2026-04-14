/**
 * WASM version of SHA256.
 */

import { createSHA256, type IHasher } from "hash-wasm";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher } from "./interface.ts";

/**
 * How many hashers to have available for concurrent use.
 */
const HASHER_CACHE_SIZE = 5;

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
 * Pool of usable hasher instances. This array is populated at module init
 * time, a tactic that is necessary since this module exposes a synchronous
 * interface for actual hashing (once loaded), whereas `hash-wasm` only allows
 * asynchronous hasher construction. Once constructed, though, hashers can be
 * used synchronously).
 */
const theHashers: IHasher[] = [];

/**
 * Finalization registry used to re-pool instances that were in use but whose
 * "public" facet (a `WasmUpdatingHasher`) never ended up releasing the
 * instance.
 */
const hasherRepooler = new FinalizationRegistry((hasher: IHasher) => {
  if (theHashers.indexOf(hasher) === -1) {
    theHashers.push(hasher);
  }
});

/**
 * A hasher instance which _isn't_ allowed to be acquired for concurrent use.
 * This is the one used to serve one-shot hash requests.
 */
const theOneShotHasher: IHasher[] = [];

/**
 * Promised result of the call to `initIfNecessaryAndPossible()` or `null` if
 * not yet called.
 */
let initResult: Promise<boolean> | null = null;

/**
 * Is this module actually usable?
 */
let moduleIsUsable: boolean = false;

/**
 * Is there an available hasher that could be acquired?
 */
function canAcquireHasher(): boolean {
  return theHashers.length !== 0;
}

/**
 * Gets a freshly-initialized hasher instance, or throws an error indicating
 * that this module is not usable.
 */
function acquireHasher(owner: WasmUpdatingHasher): IHasher {
  if (theHashers.length === 0) {
    throw new Error("Too many concurrent hashers.");
  }

  const result = theHashers.pop()!;
  result.init();

  hasherRepooler.register(owner, result, result);

  return result;
}

/**
 * Releases a previously-acquired hasher, or adds one to the pool.
 */
function releaseHasher(hasher: IHasher) {
  hasherRepooler.unregister(hasher);
  theHashers.push(hasher);
}

/**
 * Gets and initializes the unique one-shot hasher instance.
 */
function getOneShotHasher(): IHasher {
  if (!moduleIsUsable) {
    throw new Error("Cannot use `sha256-wasm` in this environment.");
  }

  const result = theOneShotHasher[0];
  result.init();
  return result;
}

/**
 * Performs module-level setup if (a) possible and (b) not already done. Returns
 * (a promise to) `true` if initialization was successful, `false` if not.
 */
export function initWasm() {
  if (!initResult) {
    initResult = (async () => {
      try {
        theOneShotHasher.push(await createSHA256());
        for (let i = 0; i < HASHER_CACHE_SIZE; i++) {
          theHashers.push(await createSHA256());
        }
      } catch {
        // `hash-wasm` not available, or couldn't be fully initialized.
        theOneShotHasher.length = 0;
        theHashers.length = 0;
      }

      moduleIsUsable = theHashers.length !== 0;
      return moduleIsUsable;
    })();
  }

  return initResult;
}

/**
 * Base for WASM-specific incremental hashers.
 */
abstract class BaseWasmHasher implements IncrementalHasher {
  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding?: string): Uint8Array | string {
    const result = this._rawDigest();

    switch (encoding) {
      case "base64url": {
        return toUnpaddedBase64url(result);
      }
      case undefined: {
        return result;
      }
      default: {
        throw new Error(`Unknown encoding: ${encoding}`);
      }
    }
  }

  abstract update(data: Uint8Array): void;
  protected abstract _rawDigest(): Uint8Array;
}

/**
 * WASM-specific incremental hasher which collects chunks and performs a
 * one-shot digest at the end of processing.
 */
class WasmCollectingHasher extends BaseWasmHasher {
  /** Finalized chunks. */
  #chunks: Uint8Array[] = [];

  /** Chunk in progress, if any. */
  #currentChunk: Uint8Array | null = null;

  /** Offset into `currentChunk` for next write. */
  #currentOffset = 0;

  update(data: Uint8Array) {
    const length = data.length;

    this.#prepChunk(length);
    this.#currentChunk!.set(data, this.#currentOffset);
    this.#currentOffset += length;
  }

  protected _rawDigest(): Uint8Array {
    const hasher = getOneShotHasher();

    for (const chunk of this.#chunks) {
      hasher.update(chunk);
    }

    let lastChunk = this.#currentChunk;
    if (lastChunk) {
      // Deal with the final (was in-progress) chunk.
      const lastLength = this.#currentOffset;
      if (lastLength !== lastChunk.length) {
        lastChunk = lastChunk.subarray(0, lastLength);
      }
      hasher.update(lastChunk);
    }

    return hasher.digest("binary");
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

/**
 * WASM-specific incremental hasher which has a direct hasher instance and
 * can `update()` it.
 */
class WasmUpdatingHasher extends BaseWasmHasher {
  #hasher: IHasher | null = acquireHasher(this);

  update(data: Uint8Array) {
    this.#getHasher().update(data);
  }

  protected _rawDigest(): Uint8Array {
    const hasher = this.#getHasher();
    const result: Uint8Array = hasher.digest("binary");

    releaseHasher(hasher);
    this.#hasher = null;
    return result;
  }

  #getHasher(): IHasher {
    const hasher = this.#hasher;

    if (!hasher) {
      throw new Error("Already digested.");
    }

    return hasher;
  }
}

/**
 * Performs a hash on a single array.
 */
export function sha256Wasm(payload: Uint8Array): Uint8Array {
  const hasher = getOneShotHasher();

  hasher.update(payload);
  return hasher.digest("binary");
}

/**
 * Creates an incremental hasher.
 */
export function createHasherWasm(): IncrementalHasher {
  return canAcquireHasher()
    ? new WasmUpdatingHasher()
    : new WasmCollectingHasher();
}

/**
 * Creates a collecting incremental hasher. This is exported just for
 * testing. (We don't need to do this for the updating hasher, because it gets
 * sufficiently tested via `createHasherWasm()` and would fail the concurrency
 * test anyway because there aren't enough pooled instances to satisfy the
 * concurrency required by the test.)
 */
export function createHasherWasmCollecting(): IncrementalHasher {
  return new WasmCollectingHasher();
}
