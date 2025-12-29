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
import { available as idbAvailable } from "../storage/idb.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("compilation-cache", { enabled: true, level: "warn" });

/**
 * Cache version string. Increment when any of the following change:
 * - TypeScript version (npm:typescript in js-compiler/deno.json)
 * - Transformer pipeline (CommonToolsTransformerPipeline)
 * - Compiler options (js-compiler/typescript/options.ts)
 * - Cache entry structure (CachedCompilation interface)
 */
const CACHE_VERSION = "1";

/**
 * IndexedDB schema version. Bump to clear cache on schema changes.
 * When bumped, existing cache entries are deleted during upgrade.
 */
const DB_VERSION = 2;
const STORE_NAME = "compilations";

/** Schema version stored in entries for runtime validation */
const ENTRY_SCHEMA_VERSION = 1;

/** Cache entry stored in IndexedDB */
interface CachedCompilation {
  /** Content-addressable key from refer(program) */
  key: string;
  /** Compiled JavaScript */
  js: string;
  /** Source map for debugging */
  sourceMap?: string; // JSON stringified
  /** Unix timestamp when entry was created */
  createdAt: number;
  /** Unix timestamp of last access (for LRU) */
  lastAccessedAt: number;
  /** Schema version for migration support */
  schemaVersion: number;
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

/**
 * Compute a content-addressable cache key for a program.
 * Excludes .d.ts files since they only affect type checking, not runtime.
 * Includes CACHE_VERSION to invalidate on compiler/transformer changes.
 */
export function computeCacheKey(program: Program): string {
  const source = [
    CACHE_VERSION,
    program.main,
    ...program.files.filter(({ name }) => !name.endsWith(".d.ts")),
  ];
  return refer(source).toString();
}

/** Validate that a cached entry matches the expected schema */
function isValidCachedEntry(entry: unknown): entry is CachedCompilation {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.key === "string" &&
    typeof e.js === "string" &&
    typeof e.createdAt === "number" &&
    typeof e.lastAccessedAt === "number" &&
    (e.sourceMap === undefined || typeof e.sourceMap === "string") &&
    (e.schemaVersion === undefined || e.schemaVersion === ENTRY_SCHEMA_VERSION)
  );
}

/** Check if an error is a quota exceeded error */
function isQuotaError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return (
      error.name === "QuotaExceededError" ||
      error.code === 22 || // Legacy quota code
      error.name === "NS_ERROR_DOM_QUOTA_REACHED"
    ); // Firefox
  }
  return false;
}

/**
 * IndexedDB-backed compilation cache with LRU eviction and TTL expiration.
 *
 * Uses a two-tier cache: in-memory Map for hot entries, IndexedDB for persistence.
 * Memory cache uses Map's natural insertion order for O(1) LRU eviction.
 */
export class CompilationCache {
  private config: CompilationCacheConfig;
  private memoryCache = new Map<string, CachedCompilation>();
  private dbPromise: Promise<IDBDatabase> | null = null;
  private dbOpenFailed = false;
  /** Tracks quota exhaustion - disables IDB persistence */
  private idbDisabled = false;
  /** Error counts for observability */
  private errorCounts = { quota: 0, transaction: 0, other: 0 };

  constructor(config: Partial<CompilationCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if IndexedDB is available in this environment.
   */
  static isAvailable(): boolean {
    return idbAvailable();
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
        // Move to end of map for LRU ordering (delete + re-insert)
        this.memoryCache.delete(key);
        this.touchEntry(memoryEntry);
        this.memoryCache.set(key, memoryEntry);
        return this.toJsScript(memoryEntry);
      }
    }

    // Skip IDB if disabled due to quota issues
    if (this.idbDisabled) {
      return undefined;
    }

    // Check IndexedDB (L2)
    const idbEntry = await this.getFromIDB(key);
    if (idbEntry) {
      if (this.isExpired(idbEntry)) {
        // Lazy eviction - delete expired entry
        this.deleteFromIDB(key).catch((e) =>
          this.handleError("lazy-delete", e, key)
        );
        return undefined;
      }
      // Promote to memory cache
      this.touchEntry(idbEntry);
      this.memoryCache.set(key, idbEntry);

      // Evict oldest from memory if at capacity
      if (this.memoryCache.size > this.config.maxEntries) {
        this.evictOldestFromMemory();
      }

      // Fire-and-forget: update lastAccessedAt in IDB
      this.putToIDB(idbEntry).catch((e) =>
        this.handleError("touch-update", e, key)
      );
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
      createdAt: now,
      lastAccessedAt: now,
      schemaVersion: ENTRY_SCHEMA_VERSION,
    };

    // Always update memory cache
    this.memoryCache.set(key, entry);

    // Evict oldest from memory if at capacity
    if (this.memoryCache.size > this.config.maxEntries) {
      this.evictOldestFromMemory();
    }

    // Skip IDB if disabled due to quota issues
    if (this.idbDisabled) {
      return;
    }

    // Try to persist to IndexedDB with quota handling
    try {
      await this.putToIDB(entry);
    } catch (error) {
      if (isQuotaError(error)) {
        logger.warn("quota-exceeded", () => [
          "Quota exceeded, attempting aggressive eviction",
        ]);
        const recovered = await this.handleQuotaExceeded();
        if (recovered) {
          // Retry the put after eviction
          try {
            await this.putToIDB(entry);
          } catch (retryError) {
            if (isQuotaError(retryError)) {
              this.disableIDB("Quota still exceeded after eviction");
            } else {
              this.handleError("persist-retry", retryError, key);
            }
          }
        }
      } else {
        this.handleError("persist", error, key);
      }
    }
  }

  /**
   * Clear all cached entries.
   */
  async clear(): Promise<void> {
    this.memoryCache.clear();
    if (this.idbDisabled) return;

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
      this.handleError("clear", error);
    }
  }

  /**
   * Get cache statistics for debugging.
   */
  stats(): {
    memorySize: number;
    idbDisabled: boolean;
    errors: { quota: number; transaction: number; other: number };
  } {
    return {
      memorySize: this.memoryCache.size,
      idbDisabled: this.idbDisabled,
      errors: { ...this.errorCounts },
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
      // Note: filename intentionally omitted - caller should apply desired filename
      // since the same compiled output can be used with different filenames
    };
  }

  private evictOldestFromMemory(): void {
    // Map maintains insertion order - first entry is the least recently used
    const oldestKey = this.memoryCache.keys().next().value;
    if (oldestKey !== undefined) {
      this.memoryCache.delete(oldestKey);
    }
  }

  /** Log and track errors appropriately */
  private handleError(operation: string, error: unknown, key?: string): void {
    if (isQuotaError(error)) {
      this.errorCounts.quota++;
      logger.warn(`${operation}-quota-error`, () => [
        `Quota exceeded during ${operation}`,
        key ? `key=${key.substring(0, 20)}...` : "",
      ]);
    } else if (
      error instanceof DOMException &&
      error.name === "TransactionInactiveError"
    ) {
      this.errorCounts.transaction++;
      // Transaction errors are often benign races, log at debug level
      logger.debug(`${operation}-transaction-inactive`, () => [
        `Transaction inactive during ${operation} (likely benign race)`,
      ]);
    } else {
      this.errorCounts.other++;
      logger.warn(`${operation}-error`, () => [
        `Error during ${operation}:`,
        error,
        key ? `key=${key.substring(0, 20)}...` : "",
      ]);
    }
  }

  /** Handle quota exceeded by aggressive eviction */
  private async handleQuotaExceeded(): Promise<boolean> {
    try {
      const db = await this.openDB();
      if (!db) {
        this.disableIDB("Database unavailable during quota recovery");
        return false;
      }

      return await new Promise<boolean>((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, "readwrite");
          const store = tx.objectStore(STORE_NAME);

          // Get count and evict 50% of entries
          const countRequest = store.count();
          countRequest.onsuccess = () => {
            const count = countRequest.result;
            const toEvict = Math.ceil(count * 0.5);

            if (toEvict === 0) {
              resolve(false);
              return;
            }

            logger.info("quota-eviction", () => [
              `Evicting ${toEvict} of ${count} entries for quota recovery`,
            ]);
            this.evictOldestFromIDB(store, toEvict);

            tx.oncomplete = () => resolve(true);
            tx.onerror = () => {
              this.handleError("quota-eviction-tx", tx.error);
              resolve(false);
            };
          };
          countRequest.onerror = () => resolve(false);
        } catch (error) {
          this.handleError("quota-recovery", error);
          resolve(false);
        }
      });
    } catch (error) {
      this.handleError("quota-recovery-outer", error);
      return false;
    }
  }

  /** Disable IDB operations for this session */
  private disableIDB(reason: string): void {
    if (!this.idbDisabled) {
      logger.warn("idb-disabled", () => [
        `Disabling IndexedDB persistence - ${reason}`,
      ]);
      this.idbDisabled = true;
    }
  }

  private async openDB(): Promise<IDBDatabase | null> {
    // Don't retry if we already know IDB isn't available
    if (this.dbOpenFailed || this.idbDisabled) return null;

    if (!CompilationCache.isAvailable()) {
      this.dbOpenFailed = true;
      return null;
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.config.dbName, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const oldVersion = event.oldVersion;

          // If upgrading from an older version, delete and recreate the store
          // This is safe for a cache - we just lose cached compilations
          if (oldVersion > 0 && db.objectStoreNames.contains(STORE_NAME)) {
            db.deleteObjectStore(STORE_NAME);
            logger.info("schema-upgrade", () => [
              `Cleared cache due to schema upgrade from v${oldVersion} to v${DB_VERSION}`,
            ]);
          }

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

  private async getFromIDB(
    key: string,
  ): Promise<CachedCompilation | undefined> {
    const db = await this.openDB();
    if (!db) return undefined;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);

        request.onsuccess = () => {
          const result = request.result;
          // Validate entry schema before returning
          if (result && !isValidCachedEntry(result)) {
            logger.warn("invalid-entry", () => [
              "Invalid cache entry, ignoring",
              key.substring(0, 20),
            ]);
            // Lazy cleanup of invalid entry
            this.deleteFromIDB(key).catch((e) =>
              this.handleError("invalid-entry-delete", e, key)
            );
            resolve(undefined);
            return;
          }
          resolve(result as CachedCompilation | undefined);
        };
        request.onerror = () => {
          this.handleError("idb-get", request.error, key);
          resolve(undefined);
        };
      } catch (error) {
        this.handleError("idb-transaction", error, key);
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
        // Use soft limit (10% buffer) to reduce eviction frequency
        const softLimit = Math.ceil(this.config.maxEntries * 1.1);
        const countRequest = store.count();
        countRequest.onsuccess = () => {
          if (countRequest.result >= softLimit) {
            // Evict 20% to make room and reduce future evictions
            this.evictOldestFromIDB(
              store,
              Math.ceil(this.config.maxEntries * 0.2),
            );
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

  /**
   * Evict oldest entries from IndexedDB by lastAccessedAt.
   *
   * NOTE: Eviction is best-effort and may not be perfectly atomic with
   * concurrent writes. The cache may temporarily exceed maxEntries by up to
   * 10% during high write concurrency. This is acceptable for a compilation
   * cache where exact counts are not critical.
   */
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

      request.onerror = () => {
        this.handleError("lru-eviction-cursor", request.error);
      };
    } catch (error) {
      this.handleError("lru-eviction", error);
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
