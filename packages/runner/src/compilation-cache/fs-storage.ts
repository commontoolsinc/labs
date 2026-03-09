import type {
  CompilationCacheEntry,
  CompilationCacheStorage,
} from "./storage.ts";

export class FileSystemCompilationCache implements CompilationCacheStorage {
  constructor(private cacheDir: string) {}

  private path(programHash: string): string {
    return `${this.cacheDir}/${programHash}.json`;
  }

  async get(programHash: string): Promise<CompilationCacheEntry | undefined> {
    try {
      const text = await Deno.readTextFile(this.path(programHash));
      return JSON.parse(text) as CompilationCacheEntry;
    } catch {
      return undefined;
    }
  }

  async set(
    programHash: string,
    entry: CompilationCacheEntry,
  ): Promise<void> {
    await Deno.mkdir(this.cacheDir, { recursive: true });
    const data = JSON.stringify(entry);
    // Atomic write: write to temp file, then rename into place.
    const tmp = `${this.path(programHash)}.tmp.${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmp, data);
    await Deno.rename(tmp, this.path(programHash));
  }

  async evictStale(currentFingerprint: string): Promise<number> {
    let evicted = 0;
    try {
      for await (const dirEntry of Deno.readDir(this.cacheDir)) {
        if (!dirEntry.isFile || !dirEntry.name.endsWith(".json")) continue;
        const filePath = `${this.cacheDir}/${dirEntry.name}`;
        try {
          const text = await Deno.readTextFile(filePath);
          const entry = JSON.parse(text) as CompilationCacheEntry;
          if (entry.fingerprint !== currentFingerprint) {
            await Deno.remove(filePath);
            evicted++;
          }
        } catch {
          // Corrupt or unreadable entry — remove it
          try {
            await Deno.remove(filePath);
            evicted++;
          } catch { /* already gone */ }
        }
      }
    } catch {
      // Cache directory doesn't exist yet — nothing to evict
    }
    return evicted;
  }

  async clear(): Promise<void> {
    try {
      await Deno.remove(this.cacheDir, { recursive: true });
    } catch {
      // Directory doesn't exist
    }
  }

  async count(): Promise<number> {
    let n = 0;
    try {
      for await (const dirEntry of Deno.readDir(this.cacheDir)) {
        if (dirEntry.isFile && dirEntry.name.endsWith(".json")) n++;
      }
    } catch {
      // Directory doesn't exist
    }
    return n;
  }
}
