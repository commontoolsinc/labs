import * as Reference from "merkle-reference";
export * from "merkle-reference";

// Don't know why deno does not seem to see there is a `fromString` so we just
// workaround it like this.
export const fromString = Reference.fromString as (
  source: string,
) => Reference.View;

/**
 * Bounded LRU cache for memoizing refer() results.
 * refer() is a pure function (same input → same output), so caching is safe.
 * We use JSON.stringify as the cache key since it's ~25x faster than refer().
 */
const CACHE_MAX_SIZE = 1000;
const referCache = new Map<string, Reference.View>();

/**
 * Memoized version of refer() that caches results.
 * Provides significant speedup for repeated references to the same objects,
 * which is common in transaction processing where the same payload is
 * referenced multiple times (datum, assertion, commit log).
 */
export const refer = <T>(source: T): Reference.View<T> => {
  const key = JSON.stringify(source);

  let ref = referCache.get(key);
  if (ref !== undefined) {
    // Move to end (most recently used) by re-inserting
    referCache.delete(key);
    referCache.set(key, ref);
    return ref as Reference.View<T>;
  }

  // Compute new reference
  ref = Reference.refer(source);

  // Evict oldest entry if at capacity
  if (referCache.size >= CACHE_MAX_SIZE) {
    const oldest = referCache.keys().next().value;
    if (oldest !== undefined) {
      referCache.delete(oldest);
    }
  }

  referCache.set(key, ref);
  return ref as Reference.View<T>;
};
