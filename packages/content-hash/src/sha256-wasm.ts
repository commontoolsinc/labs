/**
 * WASM version of SHA256.
 */

import { createSHA256, type IHasher } from "hash-wasm";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher } from "./interface.ts";

/**
 * How many hashers to have available for concurrent use.
 */
const HASHER_CACHE_SIZE = 30;

/**
 * Cache of usable hasher instances. This array is populated at module init
 * time, a tactic that is necessary since this module exposes a synchronous
 * interface for actual hashing (once loaded), whereas `hash-wasm` only allows
 * asynchronous hasher construction. Once constructed, though, hashers can be
 * used synchronously).
 */
const theHashers: IHasher[] = [];

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
 * Gets a freshly-initialized hasher instance, or throws an error indicating
 * that this module is not usable.
 *
 */
function acquireHasher(): IHasher {
  if (!moduleIsUsable) {
    throw new Error("Cannot use `sha256-wasm` in this environment.");
  } else if (theHashers.length === 0) {
    throw new Error("Too many concurrent hashers.");
  }

  const result = theHashers.pop()!;
  result.init();
  return result;
}

/**
 * Releases a previously-acquired hasher, or adds one to the pool.
 */
function releaseHasher(hasher: IHasher) {
  theHashers.push(hasher);
}

/**
 * Performs module-level setup if (a) possible and (b) not already done. Returns
 * (a promise to) `true` if initialization was successful, `false` if not.
 */
export function initWasm() {
  if (!initResult) {
    initResult = (async () => {
      try {
        for (let i = 0; i < HASHER_CACHE_SIZE; i++) {
          theHashers.push(await createSHA256());
        }
      } catch {
        // `hash-wasm` not available, or couldn't be fully initialized.
        theHashers.length = 0;
      }

      moduleIsUsable = (theHashers.length !== 0);
      return moduleIsUsable;
    })();
  }

  return initResult;
}

/**
 * WASM-specific incremental hasher.
 */
class WasmHasher implements IncrementalHasher {
  #hasher: IHasher | null = acquireHasher();

  #getHasher(): IHasher {
    const hasher = this.#hasher;

    if (!hasher) {
      throw new Error("Already digested.");
    }

    return hasher;
  }

  update(data: Uint8Array) {
    this.#getHasher().update(data);
  }

  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding?: string): Uint8Array | string {
    const hasher = this.#getHasher();
    const result: Uint8Array = hasher.digest("binary");

    releaseHasher(hasher);
    this.#hasher = null;

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
}

/**
 * Performs a hash on a single array.
 */
export function sha256Wasm(payload: Uint8Array): Uint8Array {
  const hasher = acquireHasher();

  hasher.update(payload);
  const result = hasher.digest("binary");
  releaseHasher(hasher);

  return result;
}

/**
 * Creates an incremental hasher.
 */
export function createHasherWasm(): IncrementalHasher {
  return new WasmHasher();
}
