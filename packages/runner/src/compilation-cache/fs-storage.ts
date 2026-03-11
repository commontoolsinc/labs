import { getLogger } from "@commontools/utils/logger";
import type {
  CompilationCacheEntry,
  CompilationCacheStorage,
} from "./storage.ts";

const logger = getLogger("compilation-cache");

function isCacheEntry(dirEntry: Deno.DirEntry): boolean {
  return dirEntry.isFile && dirEntry.name.endsWith(".json");
}

/**
 * **Server-only.** Requires Deno filesystem APIs (`Deno.readTextFile`,
 * `Deno.writeTextFile`, `Deno.mkdir`, `Deno.rename`, `Deno.remove`,
 * `Deno.readDir`). In the browser, use `IDBCompilationCache` instead.
 */
export class FileSystemCompilationCache implements CompilationCacheStorage {
  constructor(private cacheDir: string) {}

  private path(programHash: string): string {
    if (/[\/\\]|\.\./.test(programHash)) {
      throw new Error(`Invalid programHash: ${programHash}`);
    }
    return `${this.cacheDir}/${programHash}.json`;
  }

  async get(programHash: string): Promise<CompilationCacheEntry | undefined> {
    const filePath = this.path(programHash);
    try {
      const text = await Deno.readTextFile(filePath);
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
        if (!isCacheEntry(dirEntry)) continue;
        const filePath = `${this.cacheDir}/${dirEntry.name}`;
        try {
          const text = await Deno.readTextFile(filePath);
          const entry = JSON.parse(text) as CompilationCacheEntry;
          if (entry.fingerprint !== currentFingerprint) {
            await Deno.remove(filePath);
            evicted++;
          }
        } catch (err) {
          logger.warn("fs-cache", `Corrupt cache entry ${filePath}`, err);
          try {
            await Deno.remove(filePath);
            evicted++;
          } catch { /* already gone */ }
        }
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        logger.warn("fs-cache", `Failed to read cache directory`, err);
      }
    }
    return evicted;
  }

  async evictOldest(keepCount: number): Promise<number> {
    const entries: { name: string; cachedAt: number }[] = [];
    try {
      for await (const dirEntry of Deno.readDir(this.cacheDir)) {
        if (!isCacheEntry(dirEntry)) continue;
        const filePath = `${this.cacheDir}/${dirEntry.name}`;
        try {
          const text = await Deno.readTextFile(filePath);
          const entry = JSON.parse(text) as CompilationCacheEntry;
          entries.push({ name: dirEntry.name, cachedAt: entry.cachedAt });
        } catch (err) {
          logger.warn("fs-cache", `Corrupt cache entry ${filePath}`, err);
          entries.push({ name: dirEntry.name, cachedAt: 0 });
        }
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        logger.warn("fs-cache", `Failed to read cache directory`, err);
      }
      return 0;
    }

    if (entries.length <= keepCount) return 0;

    entries.sort((a, b) => a.cachedAt - b.cachedAt);
    const toRemove = entries.slice(0, entries.length - keepCount);
    let evicted = 0;
    for (const { name } of toRemove) {
      try {
        await Deno.remove(`${this.cacheDir}/${name}`);
        evicted++;
      } catch { /* already gone */ }
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
        if (isCacheEntry(dirEntry)) n++;
      }
    } catch {
      // Directory doesn't exist
    }
    return n;
  }
}
