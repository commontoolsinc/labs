/**
 * Legacy merkle-reference tree builder, used by `value-hash.ts` when
 * canonical hashing mode is disabled. Extracted from `value-hash.ts`
 * following the same dispatch + modern/legacy split pattern used by
 * `fabric-value.ts`.
 */
import * as Reference from "merkle-reference";
import { LRUCache } from "@commonfabric/utils/cache";
import { sha256 } from "@commonfabric/content-hash";
import type { HashObject } from "./value-hash.ts";
import type { FabricValue } from "./interface.ts";

// ---------------------------------------------------------------------------
// Merkle-reference tree builder
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

    // merkle-reference can't hash sparse array holes (undefined type).
    // Densify by converting holes to null before hashing.
    if (Array.isArray(source)) {
      let hasSparseHole = false;
      for (let i = 0; i < source.length; i++) {
        if (!(i in source)) {
          hasSparseHole = true;
          break;
        }
      }
      if (hasSparseHole) {
        const dense = new Array(source.length);
        source.forEach((v, i) => {
          dense[i] = v;
        });
        for (let i = 0; i < dense.length; i++) {
          if (!(i in dense)) dense[i] = null;
        }
        return defaultNodeBuilder.toTree(dense, builder);
      }
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

export const hashOfLegacy = <T extends FabricValue>(
  source: T,
): HashObject<T> => {
  return treeBuilder.refer(source) as unknown as HashObject<T>;
};

/**
 * Cache for {the, of} references (unclaimed facts).
 * These patterns repeat constantly in claims, so caching avoids redundant hashing.
 * Bounded with LRU eviction to prevent unbounded memory growth.
 */
const unclaimedCache = new LRUCache<string, HashObject<NonNullable<unknown>>>({
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
 * Legacy `hashOf` implementation using merkle-reference, with caching for
 * unclaimed {the, of} patterns.
 */
export const hashOfLegacyCached = <T extends FabricValue>(
  source: T,
): HashObject<T> => {
  // Cache {the, of} patterns (unclaimed facts)
  if (isUnclaimed(source)) {
    const key = `${source.the}\0${source.of}`;
    const cached = unclaimedCache.get(key);
    if (cached) return cached as HashObject<T>;
    const result = hashOfLegacy(source);
    unclaimedCache.put(key, result);
    return result;
  }
  return hashOfLegacy(source);
};

/** Legacy `hashObjectFromJson` using merkle-reference. */
export const hashObjectFromJsonLegacy = Reference.fromJSON;

/** Legacy `hashObjectFromString` using merkle-reference. */
export const hashObjectFromStringLegacy = Reference.fromString as (
  source: string,
) => HashObject;

/** Legacy hash object type — the merkle-reference `Reference.View`. */
export type LegacyHashObject<
  T extends FabricValue = FabricValue,
> = Reference.View<T>;

/** Type guard for legacy hash objects (merkle-reference instances). */
export function isLegacyHashObject(value: unknown): value is LegacyHashObject {
  return Reference.is(value);
}
