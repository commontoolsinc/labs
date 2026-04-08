/**
 * Noble version of SHA256.
 */

import { sha256 } from "merkle-reference";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher } from "./interface.ts";

export type { IncrementalHasher, Sha256Fn } from "./interface.ts";

/**
 * Performs a hash on a single array.
 */
export const sha256Noble = sha256;

/**
 * Creates an incremental hasher.
 */
export function createHasherNoble(): IncrementalHasher {
  return new NobleHasher();
}

/**
 * Noble-specific incremental hasher. Noble notably only has a one-shot digest
 * function.
 */
class NobleHasher implements IncrementalHasher {
  #chunks: Uint8Array[] = [];

  update(data: Uint8Array) {
    // Copy to avoid aliasing shared scratch buffers.
    this.#chunks.push(new Uint8Array(data));
  }

  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
  digest(encoding?: string): Uint8Array | string {
    let totalLen = 0;
    for (const c of this.#chunks) totalLen += c.length;
    const buf = new Uint8Array(totalLen);

    let offset = 0;
    for (const c of this.#chunks) {
      buf.set(c, offset);
      offset += c.length;
    }

    const result = sha256(buf);

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
