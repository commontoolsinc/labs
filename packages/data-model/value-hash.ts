/**
 * Content identifier dispatch layer.
 *
 * Provides the public API for content identification (hashing): `hashOf`,
 * `isContentId`, `contentIdFromJSON`, `fromString`. Dispatches between
 * canonical hashing (value-hash-modern.ts) and legacy merkle-reference
 * (value-hash-legacy.ts) based on a runtime flag.
 *
 * Follows the same dispatch + modern/legacy split pattern used by
 * `fabric-value.ts` / `fabric-value-modern.ts` / `fabric-value-legacy.ts`.
 */
import { modernHash } from "./value-hash-modern.ts";
import { FabricHash } from "./fabric-hash.ts";
import { fromBase64url } from "./bigint-encoding.ts";
import {
  contentIdFromJSONLegacy,
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
 * Used by `ContentId<T>` and related generic types.
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
export type ContentId<
  T extends DefinedReferent = DefinedReferent,
> = Reference.View<T> | FabricHash;

// ---------------------------------------------------------------------------
// Flag-dispatched public API
//
// These four symbols are reassigned by `configureDispatch()` whenever
// canonical hashing mode changes.  The two implementation worlds (canonical
// vs. legacy/merkle-reference) are kept in fully separate blocks so that
// NO code changes when the experiment flag is off -- the legacy path is
// identical to the pre-flag code.
// ---------------------------------------------------------------------------

/**
 * Type guard: returns true if the value is a content identifier
 * (`Reference.View` or `FabricHash`).
 */
export let isContentId: <T extends DefinedReferent>(
  value: unknown | ContentId<T>,
) => value is ContentId<T>;

/** Reconstructs a content identifier from its JSON representation. */
export let contentIdFromJSON: (
  source: { "/": string },
) => ContentId;

/** Reconstruct a content identifier from its string representation. */
export let fromString: (source: string) => ContentId;

/**
 * Compute a content identifier for the given source value.
 *
 * In server environments, uses node:crypto SHA-256 (hardware accelerated).
 * In browsers, uses hash-wasm (WASM, ~3x faster than pure JS).
 * Falls back to @noble/hashes if neither is available.
 */
export let hashOf: <T extends DefinedReferent>(
  source: T,
) => ContentId<T>;

// ---------------------------------------------------------------------------
// Canonical hashing mode flag and dispatch configuration
// ---------------------------------------------------------------------------

/**
 * Module-level flag for canonical hashing mode, set by the `Runtime`
 * constructor via `setCanonicalHashConfig()`. When enabled, the public API
 * symbols dispatch to canonical hash implementations instead of
 * merkle-reference.
 */
let canonicalHashingEnabled = false;

/**
 * Parse a `FabricHash` from its string representation
 * (`<algorithmTag>:<base64urlHash>`).
 */
function contentIdFromString(source: string): FabricHash {
  const colonIndex = source.indexOf(":");
  if (colonIndex === -1) {
    throw new ReferenceError(`Invalid content ID string: ${source}`);
  }
  const algorithmTag = source.substring(0, colonIndex);
  const hashBase64url = source.substring(colonIndex + 1);
  return new FabricHash(fromBase64url(hashBase64url), algorithmTag);
}

/** Shared `isContentId` implementation (same for both modes). */
const isContentIdImpl = (<T extends DefinedReferent>(
  value: unknown | ContentId<T>,
): value is ContentId<T> => {
  if (value instanceof FabricHash) return true;
  return Reference.is(value);
}) as typeof isContentId;

/**
 * Reassign the public API symbols based on the current value of
 * `canonicalHashingEnabled`. Called at module load and whenever the flag
 * changes.
 */
function configureDispatch(): void {
  isContentId = isContentIdImpl;

  if (canonicalHashingEnabled) {
    // ----- Canonical hashing implementations -----

    contentIdFromJSON = (source) => {
      return contentIdFromString(source["/"]);
    };

    fromString = (source) => {
      return contentIdFromString(source);
    };

    hashOf = (source) => {
      return modernHash(source);
    };
  } else {
    // ----- Legacy merkle-reference implementations -----

    contentIdFromJSON = contentIdFromJSONLegacy;
    fromString = fromStringLegacy;
    hashOf = referLegacyCached;
  }
}

/**
 * Activates or deactivates canonical hashing mode. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions.modernHash` into the
 * memory layer.
 */
export function setCanonicalHashConfig(enabled: boolean): void {
  canonicalHashingEnabled = enabled;
  configureDispatch();
}

/**
 * Restores canonical hashing mode to its default (disabled). Called by
 * `Runtime.dispose()` to avoid leaking flags between runtime instances or
 * test runs.
 */
export function resetCanonicalHashConfig(): void {
  canonicalHashingEnabled = false;
  configureDispatch();
}

// ---------------------------------------------------------------------------
// Initialize dispatch to legacy mode at module load.
// ---------------------------------------------------------------------------

configureDispatch();
