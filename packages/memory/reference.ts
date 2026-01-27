import * as Reference from "merkle-reference";
import { isDeno } from "@commontools/utils/env";
import { LRUCache } from "@commontools/utils/cache";
import { createSHA256, type IHasher } from "hash-wasm";
export * from "merkle-reference";

/**
 * Which SHA-256 implementation is currently in use.
 */
export type HashImplementation = "node:crypto" | "hash-wasm" | "noble";

let activeHashImpl: HashImplementation = "noble";

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
 * Internal refer implementation - set based on environment.
 *
 * Priority:
 * 1. Server (Deno): node:crypto - hardware accelerated via OpenSSL
 * 2. Browser: hash-wasm - WASM SHA-256, ~3x faster than pure JS
 * 3. Fallback: @noble/hashes (via merkle-reference default)
 */
let referImpl: (<T>(source: T) => Reference.View<T>) | null = null;

// Initialize hash implementation based on environment
if (isDeno()) {
  // Server: use node:crypto for hardware acceleration
  try {
    const nodeCrypto = await import("node:crypto");
    const nodeSha256 = (payload: Uint8Array): Uint8Array => {
      return nodeCrypto.createHash("sha256").update(payload).digest();
    };
    const treeBuilder = Reference.Tree.createBuilder(
      nodeSha256,
      wrappedNodeBuilder,
    );
    referImpl = <T>(source: T): Reference.View<T> => {
      return treeBuilder.refer(source) as unknown as Reference.View<T>;
    };
    activeHashImpl = "node:crypto";
  } catch {
    // node:crypto not available, will try next option
  }
}

if (!referImpl) {
  // Not Deno, or Deno's node:crypto failed — try hash-wasm (browser)
  try {
    const hasher: IHasher = await createSHA256();
    // Note: This hash function is synchronous (no awaits between init/update/digest).
    // In JS's single-threaded model, synchronous code runs to completion without
    // interruption, so the shared hasher instance is safe from interleaving.
    const wasmSha256 = (payload: Uint8Array): Uint8Array => {
      hasher.init();
      hasher.update(payload);
      return hasher.digest("binary");
    };
    const treeBuilder = Reference.Tree.createBuilder(
      wasmSha256,
      wrappedNodeBuilder,
    );
    referImpl = <T>(source: T): Reference.View<T> => {
      return treeBuilder.refer(source) as unknown as Reference.View<T>;
    };
    activeHashImpl = "hash-wasm";
  } catch {
    // hash-wasm failed, will use fallback
  }
}

if (!referImpl) {
  // Both optimized paths failed — create fallback with default sha256
  const fallbackBuilder = Reference.Tree.createBuilder(
    Reference.sha256,
    wrappedNodeBuilder,
  );
  referImpl = <T>(source: T): Reference.View<T> => {
    return fallbackBuilder.refer(source) as unknown as Reference.View<T>;
  };
  // activeHashImpl stays "noble" (the initial default)
}

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
export const getHashImplementation = (): HashImplementation => {
  return activeHashImpl;
};
