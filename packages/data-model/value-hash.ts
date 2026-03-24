/**
 * Content identifier dispatch layer.
 *
 * Provides the public API for content identification (hashing): `hashOf`,
 * `isHashObject`, `hashObjectFromJson`, `fromString`. Dispatches between
 * canonical hashing (value-hash-modern.ts) and legacy merkle-reference
 * (value-hash-legacy.ts) based on a runtime flag.
 *
 * Follows the same inline-flag-test dispatch pattern used by
 * `fabric-value.ts`.
 */
import { modernHash } from "./value-hash-modern.ts";
import { FabricHash } from "./fabric-hash.ts";
import { fromBase64url } from "./bigint-encoding.ts";
import {
  hashObjectFromJsonLegacy,
  fromStringLegacy,
  Reference,
  referLegacyCached,
} from "./value-hash-legacy.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Type constraint for content identifier referents — i.e., any value
 * including `null` but _not_ `undefined`.
 * Used by `HashObject<T>` and related generic types.
 */
export type DefinedReferent = NonNullable<unknown> | null;

/**
 * Content identifier -- a hash-based reference to a value.
 *
 * Union of `Reference.View` (legacy merkle-reference) and
 * `FabricHash` (canonical hashing). Both branches provide `.bytes`,
 * `.toString()`, `.toJSON()`, and `"/"`.
 *
 * The phantom type parameter `T` is kept for compatibility with generic call
 * sites; `FabricHash` ignores it (no phantom member).
 */
export type HashObject<
  T extends DefinedReferent = DefinedReferent,
> = Reference.View<T> | FabricHash;

// ---------------------------------------------------------------------------
// Canonical hashing mode flag
// ---------------------------------------------------------------------------

/**
 * Module-level flag for canonical hashing mode, set by the `Runtime`
 * constructor via `setCanonicalHashConfig()`. When enabled, the public API
 * functions dispatch to canonical hash implementations instead of
 * merkle-reference.
 */
let canonicalHashingEnabled = false;

/**
 * Activates or deactivates canonical hashing mode. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions.modernHash` into the
 * memory layer.
 */
export function setCanonicalHashConfig(enabled: boolean): void {
  canonicalHashingEnabled = enabled;
}

/**
 * Restores canonical hashing mode to its default (disabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetCanonicalHashConfig(): void {
  canonicalHashingEnabled = false;
}

// ---------------------------------------------------------------------------
// Flag-dispatched public API
// ---------------------------------------------------------------------------

/**
 * Parse a `FabricHash` from its string representation
 * (`<algorithmTag>:<base64urlHash>`).
 */
export function hashObjectFromString(source: string): FabricHash {
  const colonIndex = source.indexOf(":");
  if (colonIndex === -1) {
    throw new ReferenceError(`Invalid content ID string: ${source}`);
  }
  const algorithmTag = source.substring(0, colonIndex);
  const hashBase64url = source.substring(colonIndex + 1);
  return new FabricHash(fromBase64url(hashBase64url), algorithmTag);
}

/**
 * Type guard: returns true if the value is a content identifier
 * (`Reference.View` or `FabricHash`).
 */
export function isHashObject<T extends DefinedReferent>(
  value: unknown | HashObject<T>,
): value is HashObject<T> {
  if (value instanceof FabricHash) return true;
  return Reference.is(value);
}

/** Reconstructs a hash object from its JSON representation. */
export function hashObjectFromJson(source: { "/": string }): HashObject {
  return canonicalHashingEnabled
    ? hashObjectFromString(source["/"])
    : hashObjectFromJsonLegacy(source);
}

/** Reconstruct a hash object from its string representation. */
export function fromString(source: string): HashObject {
  return canonicalHashingEnabled
    ? hashObjectFromString(source)
    : fromStringLegacy(source);
}

/**
 * Compute a content identifier for the given source value.
 *
 * In server environments, uses node:crypto SHA-256 (hardware accelerated).
 * In browsers, uses hash-wasm (WASM, ~3x faster than pure JS).
 * Falls back to @noble/hashes if neither is available.
 */
export function hashOf<T extends DefinedReferent>(
  source: T,
): HashObject<T> {
  return canonicalHashingEnabled
    ? modernHash(source)
    : referLegacyCached(source);
}
