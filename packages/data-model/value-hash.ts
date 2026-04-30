/**
 * Content hash public API.
 *
 * Re-exports the modern (`value-hash-modern.ts`) implementation under the
 * stable names `hashOf` and `hashObjectFromJson`.
 */
import { hashOfModern } from "./value-hash-modern.ts";
import { FabricHash } from "./fabric-hash.ts";
import type { FabricValue } from "./interface.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Reconstructs a hash object from its JSON representation. */
export function hashObjectFromJson(source: { "/": string }): FabricHash {
  return FabricHash.fromString(source["/"]);
}

/** Compute a content hash for the given source value. */
export function hashOf(source: FabricValue): FabricHash {
  return hashOfModern(source);
}
