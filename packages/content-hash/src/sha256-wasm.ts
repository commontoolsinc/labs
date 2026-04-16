/**
 * WASM version of SHA256.
 */

import { createSHA256, type IHasher } from "hash-wasm";
import { BaseCollectingHasher } from "./BaseCollectingHasher.ts";
import {
  BaseSmallChunkUpdatingHasher,
} from "./BaseSmallChunkUpdatingHasher.ts";
import { InstancePool } from "./InstancePool.ts";
import type { IncrementalHasher } from "./interface.ts";

/**
 * How many hashers to have available for concurrent use.
 */
const HASHER_POOL_SIZE = 5;

/**
 * Pool of usable hasher instances. This is populated at module init time, a
 * tactic that is necessary since this module exposes a synchronous interface
 * for actual hashing (once loaded), whereas `hash-wasm` only allows
 * asynchronous hasher construction. Once constructed, though, hashers can be
 * used synchronously).
 */
class HasherPool extends InstancePool<IHasher> {
  protected override _initInstance(instance: IHasher) {
    instance.init();
  }
}

/** Unique instance of `HasherPool`. */
const hasherPool = new HasherPool();

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
 * Gets and initializes the unique one-shot hasher instance.
 */
function getOneShotHasher(): IHasher {
  const result = theOneShotHasher[0];
  result.init();
  return result;
}

/**
 * Throws an error indicating that this module is not usable, if it is not in
 * fact usable. Otherwise, does nothing.
 */
function assertUsable() {
  if (!moduleIsUsable) {
    throw new Error("Cannot use `sha256-wasm` in this environment.");
  }
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
        for (let i = 0; i < HASHER_POOL_SIZE; i++) {
          hasherPool.add(await createSHA256());
        }
        moduleIsUsable = true;
      } catch {
        // `hash-wasm` not available, or couldn't be fully initialized.
      }

      return moduleIsUsable;
    })();
  }

  return initResult;
}

/**
 * WASM-specific incremental hasher which collects chunks and performs a
 * one-shot digest at the end of processing.
 */
class WasmCollectingHasher extends BaseCollectingHasher {
  protected _digestChunks(
    _encoding: string | undefined,
    chunks: Uint8Array[],
  ): Uint8Array | string {
    const hasher = getOneShotHasher();

    for (const chunk of chunks) {
      hasher.update(chunk);
    }

    return hasher.digest("binary");
  }
}

/**
 * WASM-specific incremental hasher which has a direct hasher instance and
 * can `update()` it.
 */
class WasmUpdatingHasher extends BaseSmallChunkUpdatingHasher {
  #hasher: IHasher = hasherPool.acquire(this);

  protected _rawUpdate(data: Uint8Array) {
    this.#hasher.update(data);
  }

  protected _rawDigest(_encoding: string | undefined): Uint8Array {
    const hasher = this.#hasher;
    const result: Uint8Array = hasher.digest("binary");

    hasherPool.release(hasher);
    return result;
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
  assertUsable();
  return hasherPool.canAcquire()
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
  assertUsable();
  return new WasmCollectingHasher();
}
