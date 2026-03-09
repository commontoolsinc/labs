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

  evictOldest(keepCount: number): Promise<number> {
    if (this.store.size <= keepCount) return Promise.resolve(0);
    const sorted = [...this.store.entries()]
      .sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    const toRemove = sorted.slice(0, sorted.length - keepCount);
    for (const [key] of toRemove) {
      this.store.delete(key);
    }
    return Promise.resolve(toRemove.length);
  }

  clear(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  count(): Promise<number> {
    return Promise.resolve(this.store.size);
  }
}
