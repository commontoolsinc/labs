/**
 * Content hash public API.
 *
 * Re-exports the modern (`value-hash-modern.ts`) implementation under the
 * stable name `hashOf`.
 */
import { hashOfModern, hashOfModernAsString } from "./value-hash-modern.ts";
import { FabricHash } from "./fabric-hash.ts";
import type { FabricValue } from "./interface.ts";

/**
 * Computes the SHA-256 hash of a `FabricValue`. Returns a `FabricHash` with
 * algorithm tag `fid1` ("Fabric ID, Version 1").
 *
 * Caches results for primitives (LRU) and deep-frozen objects (`WeakMap`).
 */
export function hashOf(value: FabricValue): FabricHash {
  return hashOfModern(value);
}

/**
 * Like `hashOf()`, except always returns a plain string of the hash, encoded as
 * base64url (no `<type>:` prefix).
 */
export function hashStringOf(value: FabricValue): string {
  return hashOfModernAsString(value);
}
