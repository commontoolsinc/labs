import type { JsScript } from "@commontools/js-compiler";

export interface CompilationCacheEntry {
  /** Full JsScript including source maps. */
  jsScript: JsScript;
  fingerprint: string;
  /** Timestamp for diagnostics / count-based eviction. */
  cachedAt: number;
}

export interface CompilationCacheStorage {
  get(programHash: string): Promise<CompilationCacheEntry | undefined>;
  set(programHash: string, entry: CompilationCacheEntry): Promise<void>;
  /** Delete all entries not matching the given fingerprint. */
  evictStale(currentFingerprint: string): Promise<number>;
  /** Delete oldest entries until at most `keepCount` remain. Returns number evicted. */
  evictOldest(keepCount: number): Promise<number>;
  /** Delete all entries. */
  clear(): Promise<void>;
  /** Return the number of entries in the cache. */
  count(): Promise<number>;
}
