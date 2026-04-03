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
        store.createIndex("by-cachedAt", "cachedAt", { unique: false });
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

    // Get keys for all records that don't match current fingerprint
    // IDBKeyRange can't do "not equal", but we can query the two ranges around it
    const [below, above] = await Promise.all([
      reqPromise(
        index.getAllKeys(
          IDBKeyRange.upperBound(currentFingerprint, /*exclude equal*/ true),
        ),
      ),
      reqPromise(
        index.getAllKeys(
          IDBKeyRange.lowerBound(currentFingerprint, /*exclude equal*/ true),
        ),
      ),
    ]);

    const staleKeys = [...below, ...above];
    for (const key of staleKeys) {
      store.delete(key);
    }

    await txPromise(tx);
    return staleKeys.length;
  }

  async evictOldest(keepCount: number): Promise<number> {
    const db = await this.getDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("by-cachedAt");

    const totalCount = await reqPromise(store.count());
    const deleteCount = totalCount - keepCount;
    if (deleteCount <= 0) return 0;

    // Get only the keys we need to delete, sorted oldest-first by cachedAt
    const keysToDelete = await reqPromise(
      index.getAllKeys(null, deleteCount),
    );

    for (const key of keysToDelete) {
      store.delete(key);
    }

    await txPromise(tx);
    return keysToDelete.length;
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
