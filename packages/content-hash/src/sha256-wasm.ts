/**
 * WASM version of SHA256.
 */

import { createSHA256, type IHasher } from "hash-wasm";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher } from "./interface.ts";

/**
 * Unique instance of the WASM hasher. We need to do this at module init time
 * because (a) `createSHA256()` is `async` for creation (but synchronous in
 * post-creation operation), and (b) a single instance can be reused
 * sequentially, and (b) we expose an entirely synchronous interface.
 */
let theHasher: IHasher | null = null;

/**
 * Promised result of the call to `initIfNecessaryAndPossible()` or `null` if
 * not yet called.
 */
let initResult: Promise<boolean> | null = null;

/**
 * Gets the hasher instance, or throws an error indicating that this module is
 * not usable.
 */
function getHasher(): IHasher {
  if (theHasher === null) {
    throw new Error("Cannot use `sha256-wasm` in this environment.");
  } else {
    return theHasher;
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
        theHasher = await createSHA256();
      } catch {
        // `hash-wasm` not available.
      }

      return theHasher !== null;
    })();
  }

  return initResult;
}

/**
 * WASM-specific incremental hasher.
 */
class WasmHasher implements IncrementalHasher {
  #chunks: Uint8Array[] = [];

  update(data: Uint8Array) {
    // Copy to avoid aliasing shared scratch buffers.
    this.#chunks.push(new Uint8Array(data));
  }

  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding?: string): Uint8Array | string {
    const hasher = getHasher();
    hasher.init();

    for (const chunk of this.#chunks) {
      hasher.update(chunk);
    }

    const result: Uint8Array = hasher.digest("binary");

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
  const hasher = getHasher();

  hasher.init();
  hasher.update(payload);
  return hasher.digest("binary");
}

/**
 * Creates an incremental hasher.
 */
export function createHasherWasm(): IncrementalHasher {
  return new WasmHasher();
}
