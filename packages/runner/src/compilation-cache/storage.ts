import type { JsScript } from "@commontools/js-compiler";

export interface CompilationCacheEntry {
  /** Full JsScript including source maps. */
  jsScript: JsScript;
  fingerprint: string;
  /** Timestamp for diagnostics / count-based eviction. */
  cachedAt: number;
}

/**
 * Persistent key-value store for compiled JS (`JsScript`).
 *
 * Keyed by a content hash of the input program. Each entry carries a
 * fingerprint so stale results from a previous compiler version can be
 * detected and evicted. Implementations exist for IndexedDB (browser),
 * filesystem (server/Deno), and in-memory (tests).
 *
 * See docs/specs/compilation-cache.md for design rationale.
 */
export interface CompilationCacheStorage {
  get(programHash: string): Promise<CompilationCacheEntry | undefined>;
  set(programHash: string, entry: CompilationCacheEntry): Promise<void>;
  /** Delete all entries not matching the given fingerprint. Returns number evicted. */
  evictStale(currentFingerprint: string): Promise<number>;
  /** Delete oldest entries until at most `keepCount` remain. Returns number evicted. */
  evictOldest(keepCount: number): Promise<number>;
  /** Delete all entries. */
  clear(): Promise<void>;
  /** Return the number of entries in the cache. */
  count(): Promise<number>;
}
