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
import type { IncrementalHasher, Sha256Fn } from "./interface.ts";
import { createHasherNoble, sha256Noble } from "./sha256-noble.ts";
import { canUseWasm, createHasherWasm, sha256Wasm } from "./sha256-wasm.ts";

export type { IncrementalHasher, Sha256Fn } from "./interface.ts";

let sha256Fn: Sha256Fn;
let createHasher: () => IncrementalHasher;
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

// Use Noble if none of the previous were successfully set up.
if (!setupComplete) {
  sha256Fn = sha256Noble;
  createHasher = createHasherNoble;
  setupComplete = true;
}

/**
 * All-at-once SHA-256 hash.
 */
export { sha256Fn as sha256 };

/**
 * Create a new incremental SHA-256 hasher.
 */
export { createHasher };
