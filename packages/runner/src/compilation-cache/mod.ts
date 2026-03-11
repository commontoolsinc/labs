import { getLogger } from "@commontools/utils/logger";
import type { CompilationCacheStorage } from "./storage.ts";
import type { CompileResult } from "../harness/types.ts";

export type {
  CompilationCacheEntry,
  CompilationCacheStorage,
} from "./storage.ts";
export { MemoryCompilationCache } from "./memory-storage.ts";
export { FileSystemCompilationCache } from "./fs-storage.ts";
export { IDBCompilationCache } from "./idb-storage.ts";
export { computeGitFingerprint } from "./git-fingerprint.ts";

const logger = getLogger("compilation-cache");

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_EVICTION_INTERVAL = 50;

export interface CachedCompilerStats {
  hits: number;
  misses: number;
  missReasons: { notFound: number; fingerprintMismatch: number };
  writes: number;
  writeErrors: number;
  countEvictions: number;
}

/**
 * Not thread-safe — assumes single-threaded access (Deno main thread).
 * All methods mutate shared state (stats, storage) without synchronization.
 */
export class CachedCompiler {
  private stats: CachedCompilerStats = {
    hits: 0,
    misses: 0,
    missReasons: { notFound: 0, fingerprintMismatch: 0 },
    writes: 0,
    writeErrors: 0,
    countEvictions: 0,
  };

  private maxEntries: number;
  private evictionInterval: number;
  private writesSinceEviction = 0;
  private evicting = false;

  constructor(
    private cache: CompilationCacheStorage,
    private fingerprint: string,
    maxEntries?: number,
    evictionInterval?: number,
  ) {
    this.maxEntries = maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.evictionInterval = evictionInterval ?? DEFAULT_EVICTION_INTERVAL;
  }

  /**
   * Returns cached CompileResult for the given program, or undefined on miss.
   * Caller is responsible for compilation on miss and calling set().
   */
  async get(programHash: string): Promise<CompileResult | undefined> {
    const entry = await this.cache.get(programHash);
    if (!entry) {
      this.stats.misses++;
      this.stats.missReasons.notFound++;
      return undefined;
    }
    if (entry.fingerprint !== this.fingerprint) {
      this.stats.misses++;
      this.stats.missReasons.fingerprintMismatch++;
      return undefined;
    }
    this.stats.hits++;
    return { id: entry.id, jsScript: entry.jsScript };
  }

  async set(programHash: string, result: CompileResult): Promise<void> {
    try {
      await this.cache.set(programHash, {
        jsScript: result.jsScript,
        id: result.id,
        fingerprint: this.fingerprint,
        cachedAt: Date.now(),
      });
      this.stats.writes++;
      this.maybeEvictByCount();
    } catch (err) {
      this.stats.writeErrors++;
      logger.warn("compilation-cache", "Failed to write cache entry", err);
    }
  }

  /** Evict entries from previous compiler versions. Call on startup. */
  async evictStale(): Promise<void> {
    const evicted = await this.cache.evictStale(this.fingerprint);
    const remaining = await this.cache.count();
    logger.info(
      "compilation-cache",
      `fingerprint=${
        this.fingerprint.substring(0, 8)
      } entries=${remaining} evicted=${evicted}`,
    );
  }

  /** Clear the entire cache. */
  async clear(): Promise<void> {
    await this.cache.clear();
  }

  /** Get current stats snapshot. */
  getStats(): Readonly<CachedCompilerStats> {
    return {
      ...this.stats,
      missReasons: { ...this.stats.missReasons },
    };
  }

  /** Get the fingerprint in use. */
  getFingerprint(): string {
    return this.fingerprint;
  }

  /** Fire-and-forget eviction check. Runs every N writes, skips if already running. */
  private maybeEvictByCount(): void {
    this.writesSinceEviction++;
    if (this.writesSinceEviction < this.evictionInterval) return;
    if (this.evicting) return;
    this.evicting = true;
    this.doEvictionByCount().finally(() => {
      this.evicting = false;
      this.writesSinceEviction = 0;
    });
  }

  private async doEvictionByCount(): Promise<void> {
    try {
      const count = await this.cache.count();
      if (count <= this.maxEntries) return;

      // First try stale eviction (cheap — removes wrong-fingerprint entries)
      let evicted = await this.cache.evictStale(this.fingerprint);

      // If still over cap, evict oldest entries by cachedAt
      const remaining = await this.cache.count();
      if (remaining > this.maxEntries) {
        evicted += await this.cache.evictOldest(this.maxEntries);
      }

      if (evicted > 0) {
        this.stats.countEvictions += evicted;
        logger.warn(
          "compilation-cache",
          `Count-based eviction: removed ${evicted} entries (cap=${this.maxEntries})`,
        );
      }
    } catch (err) {
      logger.warn("compilation-cache", "Eviction failed", err);
    }
  }
}
