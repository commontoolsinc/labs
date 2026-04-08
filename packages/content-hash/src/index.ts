/**
 * Shared SHA-256 hashing module. Provides both an all-at-once function
 * and an incremental hasher factory, using the best available
 * implementation for the current environment.
 *
 * Priority:
 * 1. `node:crypto` (Deno/server) -- hardware-accelerated via OpenSSL
 * 2. `hash-wasm` (browser) -- WASM, ~3x faster than pure JS
 * 3. `merkle-reference`'s `sha256` (fallback) -- pure JS via @noble/hashes
 */

import { isDeno } from "@commonfabric/utils/env";
import { sha256 as nobleSha256 } from "merkle-reference";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { IncrementalHasher, Sha256Fn } from "./interface.ts";
import { canUseWasm, createHasherWasm, sha256Wasm } from "./sha256-wasm.ts";

export type { IncrementalHasher, Sha256Fn } from "./interface.ts";

let sha256Fn: Sha256Fn = nobleSha256;
let createHasher: (() => IncrementalHasher);
let setupComplete: boolean = false;

// Try the Deno setup, if we seem to be running in a Deno environment.
if (isDeno()) {
  try {
    const denoVersion = await import("./sha256-deno.ts");
    sha256Fn = denoVersion.sha256Deno;
    createHasher = denoVersion.createHasherDeno;
    setupComplete = true;
  } catch {
    // node:crypto not available
  }
}

// Try `hash-wasm` if we didn't succeed in getting the Deno setup to work.
if (!setupComplete && canUseWasm()) {
  sha256Fn = sha256Wasm;
  createHasher = createHasherWasm;
  setupComplete = true;
}

// Fallback on Noble if all the previous stuff failed.
if (!setupComplete) {
  // Fallback: buffer chunks and hash all at once via noble.
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
      const result = nobleSha256(buf);

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

  createHasher = (): IncrementalHasher => {
    return new NobleHasher();
  };
}

/**
 * All-at-once SHA-256 hash.
 */
export { sha256Fn as sha256 };

/**
 * Create a new incremental SHA-256 hasher.
 */
export { createHasher };
