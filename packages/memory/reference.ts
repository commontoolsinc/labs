import * as Reference from "merkle-reference";
export * from "merkle-reference";

// Don't know why deno does not seem to see there is a `fromString` so we just
// workaround it like this.
export const fromString = Reference.fromString as (
  source: string,
) => Reference.View;

/**
 * Refer function - uses merkle-reference's default in browsers (@noble/hashes),
 * upgrades to node:crypto in server environments for ~1.5-2x speedup.
 *
 * Browser environments use merkle-reference's default (pure JS, works everywhere).
 * Server environments (Node.js, Deno) use node:crypto when available.
 */
let referImpl: <T>(source: T) => Reference.View<T> = Reference.refer;

// In non-browser environments, try to use node:crypto for better performance
const isBrowser =
  typeof globalThis.document !== "undefined" ||
  typeof globalThis.window !== "undefined";

if (!isBrowser) {
  try {
    // Dynamic import to avoid bundler resolution in browsers
    const nodeCrypto = await import("node:crypto");
    const nodeSha256 = (payload: Uint8Array): Uint8Array => {
      return nodeCrypto.createHash("sha256").update(payload).digest();
    };
    const treeBuilder = Reference.Tree.createBuilder(nodeSha256);
    referImpl = <T>(source: T): Reference.View<T> => {
      return treeBuilder.refer(source) as unknown as Reference.View<T>;
    };
  } catch {
    // node:crypto not available, use merkle-reference's default
  }
}

/**
 * Object interning cache: maps JSON content to a canonical object instance.
 * Uses strong references with LRU eviction to ensure cache hits.
 *
 * Previously used WeakRef, but this caused cache misses because GC would
 * collect interned objects between calls when no strong reference held them.
 * This prevented merkle-reference's WeakMap from getting cache hits.
 *
 * With strong references + LRU eviction, interned objects stay alive long
 * enough for refer() to benefit from merkle-reference's identity-based cache.
 */
const INTERN_CACHE_MAX_SIZE = 10000;
const internCache = new Map<string, object>();

/**
 * WeakSet to track objects that are already interned (canonical instances).
 * This allows O(1) early return for already-interned objects.
 */
const internedObjects = new WeakSet<object>();

/**
 * Recursively intern an object and all its nested objects.
 * Returns a new object where all sub-objects are canonical instances,
 * enabling merkle-reference's WeakMap cache to hit on shared sub-content.
 *
 * Example:
 *   const obj1 = intern({ id: "uuid-1", content: { large: "data" } });
 *   const obj2 = intern({ id: "uuid-2", content: { large: "data" } });
 *   // obj1.content === obj2.content (same object instance)
 *   // refer(obj1) then refer(obj2) will cache-hit on content
 */
export const intern = <T>(source: T): T => {
  // Only intern objects (not primitives)
  if (source === null || typeof source !== "object") {
    return source;
  }

  // Fast path: if this object is already interned, return it immediately
  if (internedObjects.has(source)) {
    return source;
  }

  // Handle arrays
  if (Array.isArray(source)) {
    const internedArray = source.map((item) => intern(item));
    const key = JSON.stringify(internedArray);
    const cached = internCache.get(key);

    if (cached !== undefined) {
      return cached as T;
    }

    // Evict oldest entry if cache is full
    if (internCache.size >= INTERN_CACHE_MAX_SIZE) {
      const oldest = internCache.keys().next().value;
      if (oldest !== undefined) internCache.delete(oldest);
    }
    internCache.set(key, internedArray);
    internedObjects.add(internedArray);
    return internedArray as T;
  }

  // Handle plain objects: recursively intern all values first
  const internedObj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    internedObj[k] = intern(v);
  }

  const key = JSON.stringify(internedObj);
  const cached = internCache.get(key);

  if (cached !== undefined) {
    return cached as T;
  }

  // Evict oldest entry if cache is full
  if (internCache.size >= INTERN_CACHE_MAX_SIZE) {
    const oldest = internCache.keys().next().value;
    if (oldest !== undefined) internCache.delete(oldest);
  }
  // Store this object as the canonical instance
  internCache.set(key, internedObj);
  internedObjects.add(internedObj);

  return internedObj as T;
};

/**
 * Compute a merkle reference for the given source.
 *
 * In server environments, uses node:crypto SHA-256 (with hardware acceleration)
 * for ~1.5-2x speedup. In browsers, uses merkle-reference's default (@noble/hashes).
 *
 * merkle-reference's internal WeakMap caches sub-objects by identity, so passing
 * the same payload object to multiple assertions will benefit from caching.
 */
export const refer = <T>(source: T): Reference.View<T> => {
  return referImpl(source);
};
