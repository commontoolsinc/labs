// deno-lint-ignore no-external-import
import "npm:fake-indexeddb@6.0.0/auto";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CachedCompiler,
  FileSystemCompilationCache,
  IDBCompilationCache,
  MemoryCompilationCache,
} from "../src/compilation-cache/mod.ts";
import type { CompilationCacheStorage } from "../src/compilation-cache/mod.ts";
import type { JsScript } from "@commontools/js-compiler";

const testJsScript: JsScript = {
  js: "var x = 42;",
  filename: "test.js",
};

const testJsScript2: JsScript = {
  js: "var y = 99;",
  filename: "test2.js",
};

// Run the same storage test suite against each backend
function storageTests(
  name: string,
  createStorage: () => CompilationCacheStorage,
  cleanup?: () => Promise<void>,
) {
  describe(`${name}: CompilationCacheStorage`, () => {
    let storage: CompilationCacheStorage;

    beforeEach(() => {
      storage = createStorage();
    });

    afterEach(async () => {
      await cleanup?.();
    });

    it("returns undefined for missing key", async () => {
      const result = await storage.get("nonexistent");
      expect(result).toBeUndefined();
    });

    it("stores and retrieves an entry", async () => {
      await storage.set("hash1", {
        jsScript: testJsScript,
        fingerprint: "fp1",
        cachedAt: 1000,
      });

      const result = await storage.get("hash1");
      expect(result).toBeDefined();
      expect(result!.jsScript.js).toBe("var x = 42;");
      expect(result!.fingerprint).toBe("fp1");
      expect(result!.cachedAt).toBe(1000);
    });

    it("overwrites existing entry", async () => {
      await storage.set("hash1", {
        jsScript: testJsScript,
        fingerprint: "fp1",
        cachedAt: 1000,
      });
      await storage.set("hash1", {
        jsScript: testJsScript2,
        fingerprint: "fp2",
        cachedAt: 2000,
      });

      const result = await storage.get("hash1");
      expect(result!.jsScript.js).toBe("var y = 99;");
      expect(result!.fingerprint).toBe("fp2");
    });

    it("evictStale removes entries with non-matching fingerprint", async () => {
      await storage.set("hash1", {
        jsScript: testJsScript,
        fingerprint: "old-fp",
        cachedAt: 1000,
      });
      await storage.set("hash2", {
        jsScript: testJsScript2,
        fingerprint: "current-fp",
        cachedAt: 2000,
      });
      await storage.set("hash3", {
        jsScript: testJsScript,
        fingerprint: "old-fp",
        cachedAt: 3000,
      });

      const evicted = await storage.evictStale("current-fp");
      expect(evicted).toBe(2);

      expect(await storage.get("hash1")).toBeUndefined();
      expect(await storage.get("hash2")).toBeDefined();
      expect(await storage.get("hash3")).toBeUndefined();
    });

    it("evictStale returns 0 when all entries match", async () => {
      await storage.set("hash1", {
        jsScript: testJsScript,
        fingerprint: "fp",
        cachedAt: 1000,
      });

      const evicted = await storage.evictStale("fp");
      expect(evicted).toBe(0);
      expect(await storage.count()).toBe(1);
    });

    it("clear removes all entries", async () => {
      await storage.set("hash1", {
        jsScript: testJsScript,
        fingerprint: "fp1",
        cachedAt: 1000,
      });
      await storage.set("hash2", {
        jsScript: testJsScript2,
        fingerprint: "fp2",
        cachedAt: 2000,
      });

      await storage.clear();

      expect(await storage.get("hash1")).toBeUndefined();
      expect(await storage.get("hash2")).toBeUndefined();
      expect(await storage.count()).toBe(0);
    });

    it("evictOldest removes oldest entries by cachedAt", async () => {
      await storage.set("hash1", {
        jsScript: testJsScript,
        fingerprint: "fp",
        cachedAt: 1000,
      });
      await storage.set("hash2", {
        jsScript: testJsScript2,
        fingerprint: "fp",
        cachedAt: 3000,
      });
      await storage.set("hash3", {
        jsScript: testJsScript,
        fingerprint: "fp",
        cachedAt: 2000,
      });

      const evicted = await storage.evictOldest(1);
      expect(evicted).toBe(2);

      // Only the newest (hash2, cachedAt=3000) should remain
      expect(await storage.get("hash1")).toBeUndefined();
      expect(await storage.get("hash2")).toBeDefined();
      expect(await storage.get("hash3")).toBeUndefined();
      expect(await storage.count()).toBe(1);
    });

    it("evictOldest returns 0 when under keepCount", async () => {
      await storage.set("hash1", {
        jsScript: testJsScript,
        fingerprint: "fp",
        cachedAt: 1000,
      });

      const evicted = await storage.evictOldest(5);
      expect(evicted).toBe(0);
      expect(await storage.count()).toBe(1);
    });

    it("count returns the number of entries", async () => {
      expect(await storage.count()).toBe(0);

      await storage.set("hash1", {
        jsScript: testJsScript,
        fingerprint: "fp1",
        cachedAt: 1000,
      });
      expect(await storage.count()).toBe(1);

      await storage.set("hash2", {
        jsScript: testJsScript2,
        fingerprint: "fp1",
        cachedAt: 2000,
      });
      expect(await storage.count()).toBe(2);
    });
  });
}

// Run tests for MemoryCompilationCache
storageTests("Memory", () => new MemoryCompilationCache());

// Run tests for FileSystemCompilationCache
let fsTempDir: string | undefined;
storageTests(
  "FileSystem",
  () => {
    fsTempDir = Deno.makeTempDirSync({ prefix: "ct-cache-test-" });
    return new FileSystemCompilationCache(fsTempDir);
  },
  async () => {
    if (fsTempDir) {
      try {
        await Deno.remove(fsTempDir, { recursive: true });
      } catch { /* already cleaned up */ }
      fsTempDir = undefined;
    }
  },
);

// Run tests for IDBCompilationCache (using fake-indexeddb polyfill)
let idbStorage: IDBCompilationCache | undefined;
storageTests(
  "IDB",
  () => {
    idbStorage = new IDBCompilationCache();
    return idbStorage;
  },
  async () => {
    if (idbStorage) {
      await idbStorage.clear();
      idbStorage = undefined;
    }
  },
);

// CachedCompiler tests
describe("CachedCompiler", () => {
  let storage: MemoryCompilationCache;
  let compiler: CachedCompiler;

  beforeEach(() => {
    storage = new MemoryCompilationCache();
    compiler = new CachedCompiler(storage, "fingerprint-v1");
  });

  it("returns undefined on cache miss", async () => {
    const result = await compiler.get("unknown-hash");
    expect(result).toBeUndefined();
  });

  it("stores and retrieves JsScript", async () => {
    await compiler.set("hash1", testJsScript);
    const result = await compiler.get("hash1");

    expect(result).toBeDefined();
    expect(result!.js).toBe("var x = 42;");
  });

  it("returns undefined when fingerprint doesn't match", async () => {
    // Store with v1 fingerprint
    await compiler.set("hash1", testJsScript);

    // Create a new compiler with a different fingerprint
    const compiler2 = new CachedCompiler(storage, "fingerprint-v2");
    const result = await compiler2.get("hash1");

    expect(result).toBeUndefined();
  });

  it("tracks hit/miss stats", async () => {
    await compiler.set("hash1", testJsScript);

    await compiler.get("hash1"); // hit
    await compiler.get("hash1"); // hit
    await compiler.get("missing"); // miss (not found)

    const stats = compiler.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.missReasons.notFound).toBe(1);
    expect(stats.writes).toBe(1);
  });

  it("tracks fingerprint mismatch as miss reason", async () => {
    await compiler.set("hash1", testJsScript);

    const compiler2 = new CachedCompiler(storage, "fingerprint-v2");
    await compiler2.get("hash1"); // miss (fingerprint mismatch)

    const stats = compiler2.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.missReasons.fingerprintMismatch).toBe(1);
    expect(stats.missReasons.notFound).toBe(0);
  });

  it("evictStale removes entries from old fingerprints", async () => {
    // Store entries with old fingerprint
    const oldCompiler = new CachedCompiler(storage, "old-fp");
    await oldCompiler.set("hash1", testJsScript);
    await oldCompiler.set("hash2", testJsScript2);

    // Store entry with current fingerprint
    await compiler.set("hash3", testJsScript);

    // Evict stale
    await compiler.evictStale();

    expect(await compiler.get("hash1")).toBeUndefined();
    expect(await compiler.get("hash2")).toBeUndefined();
    expect(await compiler.get("hash3")).toBeDefined();
  });

  it("exposes the fingerprint", () => {
    expect(compiler.getFingerprint()).toBe("fingerprint-v1");
  });

  it("evicts oldest entries when exceeding maxEntries", async () => {
    // Create a compiler with a cap of 2
    const smallCompiler = new CachedCompiler(storage, "fp", 2);

    // Add 3 entries — the third should trigger eviction of the oldest
    await smallCompiler.set("hash1", testJsScript);
    // Ensure distinct cachedAt by using the internal storage directly
    // to control timestamps
    await storage.set("hash2", {
      jsScript: testJsScript2,
      fingerprint: "fp",
      cachedAt: Date.now() + 1000,
    });
    await storage.set("hash3", {
      jsScript: testJsScript,
      fingerprint: "fp",
      cachedAt: Date.now() + 2000,
    });

    // Trigger eviction by setting a 4th entry
    await smallCompiler.set("hash4", testJsScript2);

    // Should have evicted down to 2
    expect(await storage.count()).toBe(2);

    const stats = smallCompiler.getStats();
    expect(stats.countEvictions).toBeGreaterThan(0);
  });

  it("clear removes everything", async () => {
    await compiler.set("hash1", testJsScript);
    await compiler.set("hash2", testJsScript2);

    await compiler.clear();

    expect(await compiler.get("hash1")).toBeUndefined();
    expect(await compiler.get("hash2")).toBeUndefined();
  });
});
