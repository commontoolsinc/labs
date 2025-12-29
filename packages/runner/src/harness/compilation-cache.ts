/**
 * IndexedDB-backed compilation cache for TypeScript→JavaScript results.
 *
 * Persists compiled JavaScript across page reloads to avoid re-compilation
 * of unchanged patterns. Uses content-addressable keys so cache automatically
 * invalidates when source files change.
 *
 * @module
 */

import { refer } from "@commontools/memory/reference";
import type { JsScript, Program } from "@commontools/js-compiler";

/** Cache entry stored in IndexedDB */
interface CachedCompilation {
  /** Content-addressable key from refer(program) */
  key: string;
  /** Compiled JavaScript */
  js: string;
  /** Source map for debugging */
  sourceMap?: string; // JSON stringified
  /** Output filename */
  filename?: string;
  /** Unix timestamp when entry was created */
  createdAt: number;
  /** Unix timestamp of last access (for LRU) */
  lastAccessedAt: number;
}

/** Configuration for the compilation cache */
export interface CompilationCacheConfig {
  /** Maximum number of cached entries (default: 500) */
  maxEntries: number;
  /** TTL in milliseconds (default: 7 days) */
  ttlMs: number;
  /** IndexedDB database name (default: "compilation-cache") */
  dbName: string;
}

const DEFAULT_CONFIG: CompilationCacheConfig = {
  maxEntries: 500,
  ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  dbName: "compilation-cache",
};

const DB_VERSION = 1;
const STORE_NAME = "compilations";

/**
 * Compute a content-addressable cache key for a program.
 * Excludes .d.ts files since they only affect type checking, not runtime.
 */
export function computeCacheKey(program: Program): string {
  const source = [
    program.main,
    ...program.files.filter(({ name }) => !name.endsWith(".d.ts")),
  ];
  return refer(source).toString();
}

/**
 * IndexedDB-backed compilation cache with LRU eviction and TTL expiration.
 *
 * Uses a two-tier cache: in-memory Map for hot entries, IndexedDB for persistence.
 */
export class CompilationCache {
  private config: CompilationCacheConfig;
  private memoryCache = new Map<string, CachedCompilation>();
  private dbPromise: Promise<IDBDatabase> | null = null;
  private dbOpenFailed = false;

  constructor(config: Partial<CompilationCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if IndexedDB is available in this environment.
   */
  static isAvailable(): boolean {
    return typeof globalThis?.indexedDB?.open === "function";
  }

  /**
   * Get a cached compilation result for the given program.
   * Returns undefined if not cached or expired.
   */
  async get(program: Program): Promise<JsScript | undefined> {
    const key = computeCacheKey(program);

    // Check memory cache first (L1)
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      if (this.isExpired(memoryEntry)) {
        this.memoryCache.delete(key);
      } else {
        this.touchEntry(memoryEntry);
        return this.toJsScript(memoryEntry);
      }
    }

    // Check IndexedDB (L2)
    const idbEntry = await this.getFromIDB(key);
    if (idbEntry) {
      if (this.isExpired(idbEntry)) {
        // Lazy eviction - delete expired entry
        this.deleteFromIDB(key).catch(() => {});
        return undefined;
      }
      // Promote to memory cache
      this.touchEntry(idbEntry);
      this.memoryCache.set(key, idbEntry);
      // Fire-and-forget: update lastAccessedAt in IDB
      this.putToIDB(idbEntry).catch(() => {});
      return this.toJsScript(idbEntry);
    }

    return undefined;
  }

  /**
   * Store a compilation result in the cache.
   */
  async set(program: Program, result: JsScript): Promise<void> {
    const key = computeCacheKey(program);
    const now = Date.now();

    const entry: CachedCompilation = {
      key,
      js: result.js,
      sourceMap: result.sourceMap ? JSON.stringify(result.sourceMap) : undefined,
      filename: result.filename,
      createdAt: now,
      lastAccessedAt: now,
    };

    // Always update memory cache
    this.memoryCache.set(key, entry);

    // Evict oldest from memory if at capacity
    if (this.memoryCache.size > this.config.maxEntries) {
      this.evictOldestFromMemory();
    }

    // Try to persist to IndexedDB
    try {
      await this.putToIDB(entry);
    } catch (error) {
      // Log but don't fail - memory cache still works
      console.warn("CompilationCache: Failed to persist to IndexedDB", error);
    }
  }

  /**
   * Clear all cached entries.
   */
  async clear(): Promise<void> {
    this.memoryCache.clear();
    try {
      const db = await this.openDB();
      if (!db) return;

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn("CompilationCache: Failed to clear IndexedDB", error);
    }
  }

  /**
   * Get cache statistics for debugging.
   */
  stats(): { memorySize: number } {
    return {
      memorySize: this.memoryCache.size,
    };
  }

  // --- Private methods ---

  private isExpired(entry: CachedCompilation): boolean {
    return Date.now() - entry.createdAt > this.config.ttlMs;
  }

  private touchEntry(entry: CachedCompilation): void {
    entry.lastAccessedAt = Date.now();
  }

  private toJsScript(entry: CachedCompilation): JsScript {
    return {
      js: entry.js,
      sourceMap: entry.sourceMap ? JSON.parse(entry.sourceMap) : undefined,
      filename: entry.filename,
    };
  }

  private evictOldestFromMemory(): void {
    // Find and remove the oldest entry by lastAccessedAt
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.memoryCache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.memoryCache.delete(oldestKey);
    }
  }

  private async openDB(): Promise<IDBDatabase | null> {
    // Don't retry if we already know IDB isn't available
    if (this.dbOpenFailed) return null;

    if (!CompilationCache.isAvailable()) {
      this.dbOpenFailed = true;
      return null;
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.config.dbName, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
            // Index for LRU eviction queries
            store.createIndex("lastAccessedAt", "lastAccessedAt", {
              unique: false,
            });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          this.dbOpenFailed = true;
          reject(request.error);
        };
      });
    }

    try {
      return await this.dbPromise;
    } catch {
      return null;
    }
  }

  private async getFromIDB(key: string): Promise<CachedCompilation | undefined> {
    const db = await this.openDB();
    if (!db) return undefined;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);

        request.onsuccess = () => {
          resolve(request.result as CachedCompilation | undefined);
        };
        request.onerror = () => {
          console.warn("CompilationCache: IDB get failed", request.error);
          resolve(undefined);
        };
      } catch (error) {
        console.warn("CompilationCache: IDB transaction failed", error);
        resolve(undefined);
      }
    });
  }

  private async putToIDB(entry: CachedCompilation): Promise<void> {
    const db = await this.openDB();
    if (!db) return;

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);

        // Check entry count and evict if necessary
        const countRequest = store.count();
        countRequest.onsuccess = () => {
          if (countRequest.result >= this.config.maxEntries) {
            // Evict oldest entries (by lastAccessedAt index)
            this.evictOldestFromIDB(store, Math.ceil(this.config.maxEntries * 0.1));
          }

          const putRequest = store.put(entry);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        };
        countRequest.onerror = () => {
          // Proceed anyway without eviction check
          const putRequest = store.put(entry);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private evictOldestFromIDB(store: IDBObjectStore, count: number): void {
    try {
      const index = store.index("lastAccessedAt");
      const request = index.openCursor();
      let deleted = 0;

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && deleted < count) {
          store.delete(cursor.primaryKey);
          deleted++;
          cursor.continue();
        }
      };
    } catch (error) {
      console.warn("CompilationCache: LRU eviction failed", error);
    }
  }

  private async deleteFromIDB(key: string): Promise<void> {
    const db = await this.openDB();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve(); // Ignore delete errors
      } catch {
        resolve();
      }
    });
  }
}
