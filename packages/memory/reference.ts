import * as Reference from "merkle-reference";
import { LRUCache } from "@commontools/utils/cache";
import { canonicalHash } from "./canonical-hash.ts";
import {
  getHashImplementation,
  type HashImplementation,
  sha256,
} from "./hash-impl.ts";
export * from "merkle-reference";
export type { HashImplementation };

/**
 * Module-level flag for canonical hashing mode, set by the `Runtime`
 * constructor via `setCanonicalHashConfig()`. When enabled, `refer()`
 * dispatches to the canonical hash stub instead of merkle-reference.
 */
let canonicalHashingEnabled = false;

/**
 * Activates or deactivates canonical hashing mode. Called by the `Runtime`
 * constructor to propagate `ExperimentalOptions.canonicalHashing` into the
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

// Don't know why deno does not seem to see there is a `fromString` so we just
// workaround it like this.
export const fromString = Reference.fromString as (
  source: string,
) => Reference.View;

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

const referImpl = <T>(source: T): Reference.View<T> => {
  return treeBuilder.refer(source) as unknown as Reference.View<T>;
};

/**
 * Cache for {the, of} references (unclaimed facts).
 * These patterns repeat constantly in claims, so caching avoids redundant hashing.
 * Bounded with LRU eviction to prevent unbounded memory growth.
 */
const unclaimedCache = new LRUCache<string, Reference.View<unknown>>({
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

/**
 * Compute a merkle reference for the given source.
 *
 * For {the, of} objects (unclaimed facts), results are cached since these
 * patterns repeat constantly in claims.
 *
 * In server environments, uses node:crypto SHA-256 (hardware accelerated).
 * In browsers, uses hash-wasm (WASM, ~3x faster than pure JS).
 * Falls back to @noble/hashes if neither is available.
 */
export const refer = <T>(source: T): Reference.View<T> => {
  if (canonicalHashingEnabled) {
    const digest = canonicalHash(source);
    return Reference.fromDigest(digest) as Reference.View<T>;
  }

  // Cache {the, of} patterns (unclaimed facts)
  if (isUnclaimed(source)) {
    // Use null character as delimiter to avoid collisions if the/of contain '|'
    const key = `${source.the}\0${source.of}`;
    const cached = unclaimedCache.get(key);
    if (cached) {
      return cached as Reference.View<T>;
    }
    const result = referImpl(source);
    unclaimedCache.put(key, result);
    return result;
  }

  return referImpl(source);
};

/**
 * Get the currently active SHA-256 implementation.
 */
export { getHashImplementation };
