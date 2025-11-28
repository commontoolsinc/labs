import * as Reference from "merkle-reference";
export * from "merkle-reference";

// Don't know why deno does not seem to see there is a `fromString` so we just
// workaround it like this.
export const fromString = Reference.fromString as (
  source: string,
) => Reference.Reference;

/**
 * Bounded LRU cache for memoizing refer() results.
 * refer() is a pure function (same input → same output), so caching is safe.
 * We use JSON.stringify as the cache key since it's ~25x faster than refer().
 */
const CACHE_MAX_SIZE = 1000;
const referCache = new Map<string, Reference.Reference>();

/**
 * Object intern cache: merkle hash → canonical object reference.
 *
 * This cache enables the merkle-reference package's internal WeakMap caching
 * to work across transactions. The internal WeakMap caches by object identity
 * (object → hash), providing ~1200x speedup for same-reference calls.
 *
 * Without interning, each transaction creates new object instances, so the
 * WeakMap never hits. By interning objects by their merkle hash, we ensure
 * that semantically identical content always uses the same object reference,
 * enabling cross-transaction WeakMap cache hits.
 *
 * Flow:
 * 1. First time we see content C: compute hash H, intern C as canonical for H
 * 2. Read from SQLite with hash H: return interned C (same reference!)
 * 3. Future refer(C) calls: WeakMap hit (~138ns instead of ~170µs)
 */
const internCache = new Map<string, WeakRef<object>>();

/**
 * Intern an object by its merkle hash, making it the canonical reference.
 * Returns the canonical object (which may be a previously interned object
 * with the same hash).
 */
export const intern = <T extends object>(hash: string, obj: T): T => {
  const existing = internCache.get(hash)?.deref();
  if (existing !== undefined) {
    return existing as T;
  }

  // Evict oldest entry if at capacity (LRU)
  if (internCache.size >= CACHE_MAX_SIZE) {
    // Find and remove entries with dead WeakRefs first
    for (const [key, ref] of internCache) {
      if (ref.deref() === undefined) {
        internCache.delete(key);
      }
    }
    // If still at capacity, remove oldest
    if (internCache.size >= CACHE_MAX_SIZE) {
      const oldest = internCache.keys().next().value;
      if (oldest !== undefined) {
        internCache.delete(oldest);
      }
    }
  }

  internCache.set(hash, new WeakRef(obj));
  return obj;
};

/**
 * Get the canonical interned object for a merkle hash, if one exists.
 */
export const getInterned = <T extends object>(hash: string): T | undefined => {
  const ref = internCache.get(hash);
  if (ref === undefined) return undefined;

  const obj = ref.deref();
  if (obj === undefined) {
    // WeakRef was collected, clean up
    internCache.delete(hash);
    return undefined;
  }

  return obj as T;
};

/**
 * Memoized version of refer() that caches results and interns objects.
 *
 * This function provides two levels of caching:
 * 1. LRU cache: Maps JSON.stringify(source) → Reference (for content-based lookup)
 * 2. Intern cache: Maps hash → object (for identity-based WeakMap hits)
 *
 * The LRU cache avoids recomputing hashes for identical content.
 * The intern cache enables merkle-reference's internal WeakMap to hit across
 * transactions by ensuring the same content uses the same object reference.
 */
export const refer = <T>(source: T): Reference.Reference<T> => {
  const key = JSON.stringify(source);

  let ref = referCache.get(key);
  if (ref !== undefined) {
    // Move to end (most recently used) by re-inserting
    referCache.delete(key);
    referCache.set(key, ref);
    return ref as Reference.Reference<T>;
  }

  // Compute new reference
  ref = Reference.refer(source);

  // Intern the object by its hash for future identity-based cache hits
  if (source !== null && typeof source === "object") {
    intern(ref.toString(), source as object);
  }

  // Evict oldest entry if at capacity
  if (referCache.size >= CACHE_MAX_SIZE) {
    const oldest = referCache.keys().next().value;
    if (oldest !== undefined) {
      referCache.delete(oldest);
    }
  }

  referCache.set(key, ref);
  return ref as Reference.Reference<T>;
};
