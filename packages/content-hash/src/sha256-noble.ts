/**
 * Noble version of SHA256.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher } from "./interface.ts";

export type { IncrementalHasher, Sha256Fn } from "./interface.ts";

/**
 * Noble-specific incremental hasher. Noble notably only has a one-shot digest
 * function.
 */
class NobleHasher implements IncrementalHasher {
  #hasher = sha256.create();

  update(data: Uint8Array) {
    this.#hasher.update(data);
  }

  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding?: string): Uint8Array | string {
    const result = this.#hasher.digest();

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
 * Creates an incremental hasher.
 */
export function createHasherNoble(): IncrementalHasher {
  return new NobleHasher();
}

/**
 * Performs a hash on a single array.
 */
export function sha256Noble(payload: Uint8Array): Uint8Array {
  // Note: This whole function isn't just a re-`export` of `sha256()` from
  // Noble, because that `sha256()` has additional properties which we don't
  // want to expose as part of this module's interface.
  return sha256(payload);
}
