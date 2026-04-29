/**
 * Content hash public API.
 *
 * Re-exports the modern (`value-hash-modern.ts`) implementation under the
 * stable names `hashOf`, `isHashObject`, `hashObjectFromJson`, and
 * `hashObjectFromString`.
 */
import { hashOfModern } from "./value-hash-modern.ts";
import { FabricHash } from "./fabric-hash.ts";
import type { FabricValue } from "./interface.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Content hash -- a hash-based reference to a value.
 *
 * The phantom type parameter `T` is kept for compatibility with generic call
 * sites; `FabricHash` ignores it (no phantom member).
 */
export type HashObject<T extends FabricValue = FabricValue> = FabricHash;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a hash object from its string representation. */
export function hashObjectFromString(source: string): HashObject {
  return FabricHash.fromString(source);
}

/** Type guard: returns true if the value is a content hash. */
export function isHashObject<T extends FabricValue>(
  value: unknown | HashObject<T>,
): value is HashObject<T> {
  return value instanceof FabricHash;
}

/** Reconstructs a hash object from its JSON representation. */
export function hashObjectFromJson(source: { "/": string }): HashObject {
  return FabricHash.fromString(source["/"]);
}

/** Compute a content hash for the given source value. */
export function hashOf<T extends FabricValue>(
  source: T,
): HashObject<T> {
  return hashOfModern(source);
}
