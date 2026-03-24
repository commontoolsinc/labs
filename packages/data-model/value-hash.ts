/**
 * Content hash dispatch layer.
 *
 * Provides the public API for content hashing: `hashOf`,
 * `isHashObject`, `hashObjectFromJson`, `fromString`. Dispatches between
 * canonical hashing (value-hash-modern.ts) and legacy merkle-reference
 * (value-hash-legacy.ts) based on a runtime flag.
 *
 * Follows the same inline-flag-test dispatch pattern used by
 * `fabric-value.ts`.
 */
import { hashOfModern } from "./value-hash-modern.ts";
import { FabricHash } from "./fabric-hash.ts";
import {
  hashObjectFromJsonLegacy,
  hashObjectFromStringLegacy,
  hashOfLegacyCached,
  isLegacyHashObject,
  type LegacyHashObject,
} from "./value-hash-legacy.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Type constraint for content hash referents — i.e., any value
 * including `null` but _not_ `undefined`.
 * Used by `HashObject<T>` and related generic types.
 */
export type DefinedReferent = NonNullable<unknown> | null;

/**
 * Content hash -- a hash-based reference to a value.
 *
 * Union of `LegacyHashObject` (legacy merkle-reference) and
 * `FabricHash` (canonical hashing). Both branches provide `.bytes`,
 * `.toString()`, `.toJSON()`, and `"/"`.
 *
 * The phantom type parameter `T` is kept for compatibility with generic call
 * sites; `FabricHash` ignores it (no phantom member).
 */
export type HashObject<
  T extends DefinedReferent = DefinedReferent,
> = LegacyHashObject<T> | FabricHash;

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
 * Parse a hash object from its string representation.
 * Modern path delegates to `FabricHash.fromString()`.
 */
export function hashObjectFromString(source: string): HashObject {
  return canonicalHashingEnabled
    ? FabricHash.fromString(source)
    : hashObjectFromStringLegacy(source);
}

/**
 * Type guard: returns true if the value is a content hash
 * (`LegacyHashObject` or `FabricHash`).
 */
export function isHashObject<T extends DefinedReferent>(
  value: unknown | HashObject<T>,
): value is HashObject<T> {
  return value instanceof FabricHash || isLegacyHashObject(value);
}

/** Reconstructs a hash object from its JSON representation. */
export function hashObjectFromJson(source: { "/": string }): HashObject {
  return canonicalHashingEnabled
    ? FabricHash.fromString(source["/"])
    : hashObjectFromJsonLegacy(source);
}

/** Reconstruct a hash object from its string representation. */
export function fromString(source: string): HashObject {
  return canonicalHashingEnabled
    ? FabricHash.fromString(source)
    : hashObjectFromStringLegacy(source);
}

/** Compute a content hash for the given source value. */
export function hashOf<T extends DefinedReferent>(
  source: T,
): HashObject<T> {
  return canonicalHashingEnabled
    ? hashOfModern(source)
    : hashOfLegacyCached(source);
}
