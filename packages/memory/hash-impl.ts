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
import { isDeno } from "@commontools/utils/env";
import { createSHA256, type IHasher } from "hash-wasm";
import { sha256 as nobleSha256 } from "merkle-reference";

/**
 * Which SHA-256 implementation is currently in use.
 */
export type HashImplementation = "node:crypto" | "hash-wasm" | "noble";

/**
 * Incremental SHA-256 hasher. Feed data via `update()`, finalize with
 * `digest()`. A hasher must not be reused after `digest()` is called.
 */
export interface IncrementalHasher {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
}

/**
 * All-at-once SHA-256: `(payload) => digest`.
 */
export type Sha256Fn = (payload: Uint8Array) => Uint8Array;

let activeHashImpl: HashImplementation = "noble";
let sha256Fn: Sha256Fn = nobleSha256;
let createHasher: () => IncrementalHasher;

// -- node:crypto (Deno/server) --
// deno-lint-ignore no-explicit-any
let nodeCrypto: any = null;

if (isDeno()) {
  try {
    nodeCrypto = await import("node:crypto");
    sha256Fn = (payload: Uint8Array): Uint8Array => {
      return nodeCrypto.createHash("sha256").update(payload).digest();
    };
    activeHashImpl = "node:crypto";
  } catch {
    // node:crypto not available
  }
}

// -- hash-wasm (browser) --
let wasmHasher: IHasher | null = null;

if (!nodeCrypto) {
  try {
    wasmHasher = await createSHA256();
    sha256Fn = (payload: Uint8Array): Uint8Array => {
      wasmHasher!.init();
      wasmHasher!.update(payload);
      return wasmHasher!.digest("binary");
    };
    activeHashImpl = "hash-wasm";
  } catch {
    // hash-wasm not available
  }
}

// -- Build the incremental hasher factory --

if (nodeCrypto) {
  const crypto = nodeCrypto;
  createHasher = (): IncrementalHasher => {
    const h = crypto.createHash("sha256");
    return {
      update(data: Uint8Array) {
        h.update(data);
      },
      digest(): Uint8Array {
        return h.digest();
      },
    };
  };
} else if (wasmHasher) {
  // hash-wasm's shared hasher is safe for synchronous sequential use.
  // But for incremental hashing we need a dedicated instance per hash
  // computation. Unfortunately createSHA256() is async. We work around
  // this by buffering chunks and using the shared hasher at digest time.
  const shared = wasmHasher;
  createHasher = (): IncrementalHasher => {
    const chunks: Uint8Array[] = [];
    return {
      update(data: Uint8Array) {
        // Copy to avoid aliasing shared scratch buffers from canonical-hash.ts.
        chunks.push(new Uint8Array(data));
      },
      digest(): Uint8Array {
        shared.init();
        for (const chunk of chunks) {
          shared.update(chunk);
        }
        return shared.digest("binary");
      },
    };
  };
} else {
  // Fallback: buffer chunks and hash all at once via noble.
  createHasher = (): IncrementalHasher => {
    const chunks: Uint8Array[] = [];
    return {
      update(data: Uint8Array) {
        // Copy to avoid aliasing shared scratch buffers from canonical-hash.ts.
        chunks.push(new Uint8Array(data));
      },
      digest(): Uint8Array {
        let totalLen = 0;
        for (const c of chunks) totalLen += c.length;
        const buf = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          buf.set(c, offset);
          offset += c.length;
        }
        return nobleSha256(buf);
      },
    };
  };
}

/**
 * Get the currently active SHA-256 implementation.
 */
export function getHashImplementation(): HashImplementation {
  return activeHashImpl;
}

/**
 * All-at-once SHA-256 hash.
 */
export { sha256Fn as sha256 };

/**
 * Create a new incremental SHA-256 hasher.
 */
export { createHasher };
