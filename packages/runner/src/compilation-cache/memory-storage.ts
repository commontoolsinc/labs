import type {
  CompilationCacheEntry,
  CompilationCacheStorage,
} from "./storage.ts";

export class MemoryCompilationCache implements CompilationCacheStorage {
  private store = new Map<string, CompilationCacheEntry>();

  get(programHash: string): Promise<CompilationCacheEntry | undefined> {
    return Promise.resolve(this.store.get(programHash));
  }

  set(
    programHash: string,
    entry: CompilationCacheEntry,
  ): Promise<void> {
    this.store.set(programHash, entry);
    return Promise.resolve();
  }

  evictStale(currentFingerprint: string): Promise<number> {
    let evicted = 0;
    for (const [key, entry] of this.store) {
      if (entry.fingerprint !== currentFingerprint) {
        this.store.delete(key);
        evicted++;
      }
    }
    return Promise.resolve(evicted);
  }

  clear(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  count(): Promise<number> {
    return Promise.resolve(this.store.size);
  }
}
