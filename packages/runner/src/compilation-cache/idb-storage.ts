import type {
  CompilationCacheEntry,
  CompilationCacheStorage,
} from "./storage.ts";

const DB_NAME = "ct-compilation-cache";
const DB_VERSION = 1;
const STORE_NAME = "compiled";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME);
        store.createIndex("by-fingerprint", "fingerprint", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txPromise(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
  });
}

function reqPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * **Browser-only.** Requires IndexedDB. On the server, use
 * `FileSystemCompilationCache` instead.
 */
export class IDBCompilationCache implements CompilationCacheStorage {
  private dbPromise: Promise<IDBDatabase> | undefined;

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB();
    }
    return this.dbPromise;
  }

  async get(programHash: string): Promise<CompilationCacheEntry | undefined> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const result = await reqPromise(store.get(programHash));
    return result as CompilationCacheEntry | undefined;
  }

  async set(
    programHash: string,
    entry: CompilationCacheEntry,
  ): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(entry, programHash);
    await txPromise(tx);
  }

  async evictStale(currentFingerprint: string): Promise<number> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("by-fingerprint");

    // Get all keys, then delete those with non-matching fingerprint.
    // We can't use the index to find "not equal", so we iterate all entries.
    const allKeys = await reqPromise(store.getAllKeys());
    const allValues = await reqPromise(store.getAll());

    let evicted = 0;
    for (let i = 0; i < allKeys.length; i++) {
      const entry = allValues[i] as CompilationCacheEntry;
      if (entry.fingerprint !== currentFingerprint) {
        store.delete(allKeys[i]);
        evicted++;
      }
    }
    // Suppress unused variable warning — index is created for potential
    // future use with cursor-based eviction.
    void index;

    await txPromise(tx);
    return evicted;
  }

  async evictOldest(keepCount: number): Promise<number> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const allKeys = await reqPromise(store.getAllKeys());
    const allValues = await reqPromise(store.getAll());

    if (allKeys.length <= keepCount) return 0;

    const entries = allKeys.map((key, i) => ({
      key,
      cachedAt: (allValues[i] as CompilationCacheEntry).cachedAt,
    }));
    entries.sort((a, b) => a.cachedAt - b.cachedAt);
    const toRemove = entries.slice(0, entries.length - keepCount);
    for (const { key } of toRemove) {
      store.delete(key);
    }
    await txPromise(tx);
    return toRemove.length;
  }

  async clear(): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    await txPromise(tx);
  }

  async count(): Promise<number> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    return reqPromise(store.count());
  }
}
