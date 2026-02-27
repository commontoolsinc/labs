import * as Reference from "merkle-reference";
import { LRUCache } from "@commontools/utils/cache";
import { canonicalHash } from "./canonical-hash.ts";
import { sha256 } from "./hash-impl.ts";
import { StorableContentId } from "./storable-content-id.ts";
import { fromBase64 } from "./bigint-encoding.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Type constraint for content identifier referents. Equivalent to
 * `NonNullable<unknown> | null` — accepts any value except `undefined`.
 * Used by `ContentId<T>` and related generic types.
 */
export type DefinedReferent = NonNullable<unknown> | null;

/**
 * Content identifier -- a hash-based reference to a value.
 *
 * Union of `Reference.View` (legacy merkle-reference) and
 * `StorableContentId` (canonical hashing). Both branches provide `.bytes`,
 * `.toString()`, `.toJSON()`, and `"/"`.
 *
 * The phantom type parameter `T` is kept for compatibility with generic call
 * sites; `StorableContentId` ignores it (no phantom member).
 */
export type ContentId<
  T extends DefinedReferent = DefinedReferent,
> = Reference.View<T> | StorableContentId;

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
 * (`Reference.View` or `StorableContentId`).
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
export let refer: <T extends DefinedReferent>(
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
 * Parse a `StorableContentId` from its string representation
 * (`<algorithmTag>:<base64hash>`).
 */
function contentIdFromString(source: string): StorableContentId {
  const colonIndex = source.indexOf(":");
  if (colonIndex === -1) {
    throw new ReferenceError(`Invalid content ID string: ${source}`);
  }
  const algorithmTag = source.substring(0, colonIndex);
  const hashBase64 = source.substring(colonIndex + 1);
  return new StorableContentId(fromBase64(hashBase64), algorithmTag);
}

/**
 * Reassign the public API symbols based on the current value of
 * `canonicalHashingEnabled`. Called at module load and whenever the flag
 * changes.
 */
function configureDispatch(): void {
  if (canonicalHashingEnabled) {
    // ----- Canonical hashing implementations -----

    isContentId = (<T extends DefinedReferent>(
      value: unknown | ContentId<T>,
    ): value is ContentId<T> => {
      if (value instanceof StorableContentId) return true;
      return Reference.is(value);
    }) as typeof isContentId;

    contentIdFromJSON = (source) => {
      return contentIdFromString(source["/"]);
    };

    fromString = (source) => {
      return contentIdFromString(source);
    };

    refer = (source) => {
      return canonicalHash(source);
    };
  } else {
    // ----- Legacy merkle-reference implementations -----

    isContentId = (<T extends DefinedReferent>(
      value: unknown | ContentId<T>,
    ): value is ContentId<T> => {
      if (value instanceof StorableContentId) return true;
      return Reference.is(value);
    }) as typeof isContentId;

    contentIdFromJSON = Reference.fromJSON;

    fromString = Reference.fromString as (
      source: string,
    ) => ContentId;

    refer = <T extends DefinedReferent>(
      source: T,
    ): ContentId<T> => {
      // Cache {the, of} patterns (unclaimed facts)
      if (isUnclaimed(source)) {
        const key = `${source.the}\0${source.of}`;
        const cached = unclaimedCache.get(key);
        if (cached) return cached as ContentId<T>;
        const result = referImpl(source);
        unclaimedCache.put(key, result);
        return result;
      }
      return referImpl(source);
    };
  }
}

/**
 * Activates or deactivates canonical hashing mode. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions.canonicalHashing` into the
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
// Merkle-reference tree builder (used by legacy `refer` path)
// ---------------------------------------------------------------------------

/**
 * Get the default nodeBuilder from merkle-reference, then wrap it to intercept
 * all toTree calls for caching of primitives.
 */
const defaultNodeBuilder = Reference.Tree.createBuilder(Reference.sha256)
  .nodeBuilder;

type TreeBuilder = ReturnType<typeof Reference.Tree.createBuilder>;
type Node = ReturnType<typeof defaultNodeBuilder.toTree>;

/**
 * LRU cache for primitive toTree results. Primitives can't be cached by
 * merkle-reference's internal WeakMap, but they repeat constantly in facts.
 * Ad-hoc testing shows 97%+ hit rate for primitives.
 */
const primitiveCache = new LRUCache<unknown, Node>({ capacity: 50_000 });

const isPrimitive = (value: unknown): boolean =>
  value === null || typeof value !== "object";

const wrappedNodeBuilder = {
  toTree(source: unknown, builder: TreeBuilder) {
    if (isPrimitive(source)) {
      const cached = primitiveCache.get(source);
      if (cached) return cached;
      const node = defaultNodeBuilder.toTree(source, builder);
      primitiveCache.put(source, node);
      return node;
    }

    return defaultNodeBuilder.toTree(source, builder);
  },
};

/**
 * Build the merkle-reference tree builder using the best available SHA-256.
 */
const treeBuilder = Reference.Tree.createBuilder(
  sha256,
  wrappedNodeBuilder,
);

const referImpl = <T extends DefinedReferent>(
  source: T,
): ContentId<T> => {
  return treeBuilder.refer(source) as unknown as ContentId<T>;
};

/**
 * Cache for {the, of} references (unclaimed facts).
 * These patterns repeat constantly in claims, so caching avoids redundant hashing.
 * Bounded with LRU eviction to prevent unbounded memory growth.
 */
const unclaimedCache = new LRUCache<string, ContentId<NonNullable<unknown>>>({
  // ~50KB overhead (small string keys + refs)
  capacity: 50_000,
});

/**
 * Check if source is exactly {the, of} with string values and no other keys.
 */
const isUnclaimed = (
  source: unknown,
): source is { the: string; of: string } => {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return false;
  }
  const keys = Object.keys(source);
  if (keys.length !== 2) return false;
  const obj = source as Record<string, unknown>;
  return typeof obj.the === "string" && typeof obj.of === "string";
};

// ---------------------------------------------------------------------------
// Initialize dispatch to legacy mode at module load.
// ---------------------------------------------------------------------------

configureDispatch();
