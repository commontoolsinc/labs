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
import { createSHA256, type IHasher } from "hash-wasm";
import { sha256 as nobleSha256 } from "merkle-reference";
import { toUnpaddedBase64url } from "./base64url.ts";

/**
 * Incremental SHA-256 hasher. Feed data via `update()`, finalize with
 * `digest()`. A hasher must not be reused after `digest()` is called.
 */
export interface IncrementalHasher {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
  digest(encoding: "base64url"): string;
}

/**
 * All-at-once SHA-256: `(payload) => digest`.
 */
export type Sha256Fn = (payload: Uint8Array) => Uint8Array;

let sha256Fn: Sha256Fn = nobleSha256;
let createHasher: () => IncrementalHasher;

// -- node:crypto (Deno/server) --
// deno-lint-ignore no-explicit-any
let nodeCrypto: any = null;

if (isDeno()) {
  try {
    nodeCrypto = await import("node:crypto");
    sha256Fn = (payload: Uint8Array): Uint8Array => {
      // node:crypto digest() returns Buffer (a Uint8Array subclass); normalize
      // to plain Uint8Array so downstream equality checks work correctly.
      const buf = nodeCrypto.createHash("sha256").update(payload).digest();
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    };
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
  } catch {
    // hash-wasm not available
  }
}

// -- Build the incremental hasher factory --

if (nodeCrypto) {
  class NodeHasher implements IncrementalHasher {
    #hasher = nodeCrypto.createHash("sha256");
    update(data: Uint8Array) {
      this.#hasher.update(data);
    }
    digest(): Uint8Array;
    digest(encoding: "base64url"): string;
    digest(encoding?: string): Uint8Array | string {
      switch (encoding) {
        case "base64url": {
          return this.#hasher.digest(encoding);
        }
        case undefined: {
          // node:crypto digest() returns Buffer; normalize to plain Uint8Array.
          const buf = this.#hasher.digest();
          return new Uint8Array(
            buf.buffer,
            buf.byteOffset,
            buf.byteLength,
          );
        }
        default: {
          throw new Error(`Unknown encoding: ${encoding}`);
        }
      }
    }
  }

  createHasher = (): IncrementalHasher => {
    return new NodeHasher();
  };
} else if (wasmHasher) {
  // hash-wasm's shared hasher is safe for synchronous sequential use.
  // But for incremental hashing we need a dedicated instance per hash
  // computation. Unfortunately createSHA256() is async. We work around
  // this by buffering chunks and using the shared hasher at digest time.
  const shared = wasmHasher;

  class WasmHasher implements IncrementalHasher {
    #chunks: Uint8Array[] = [];
    update(data: Uint8Array) {
      // Copy to avoid aliasing shared scratch buffers.
      this.#chunks.push(new Uint8Array(data));
    }
    digest(): Uint8Array;
    digest(encoding: "base64url"): string;
    digest(encoding?: string): Uint8Array | string {
      shared.init();
      for (const chunk of this.#chunks) {
        shared.update(chunk);
      }
      const result: Uint8Array = shared.digest("binary");

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
    return new WasmHasher();
  };
} else {
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
