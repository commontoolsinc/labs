// Test-only polyfill: provides a global `indexedDB` for IDBCompilationCache tests.
// Intentionally kept out of the package import map to prevent leaking into runtime.
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

// FileSystemCompilationCache-specific tests
describe("FileSystem: path traversal validation", () => {
  let storage: FileSystemCompilationCache;
  let tempDir: string;

  beforeEach(() => {
    tempDir = Deno.makeTempDirSync({ prefix: "ct-cache-test-" });
    storage = new FileSystemCompilationCache(tempDir);
  });

  afterEach(async () => {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch { /* already cleaned up */ }
  });

  it("rejects programHash with path separator", async () => {
    await expect(storage.get("../etc/passwd")).rejects.toThrow(
      "Invalid programHash",
    );
  });

  it("rejects programHash with backslash", async () => {
    await expect(storage.get("..\\etc\\passwd")).rejects.toThrow(
      "Invalid programHash",
    );
  });

  it("rejects programHash with dot-dot", async () => {
    await expect(storage.get("foo..bar")).rejects.toThrow(
      "Invalid programHash",
    );
  });

  it("rejects on set as well", async () => {
    await expect(
      storage.set("../../escape", {
        jsScript: testJsScript,
        fingerprint: "fp",
        cachedAt: 1000,
      }),
    ).rejects.toThrow("Invalid programHash");
  });
});

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
    // Create a compiler with cap=2 and evictionInterval=1 so every write checks
    const smallCompiler = new CachedCompiler(storage, "fp", 2, 1);

    // Seed 3 entries with hardcoded timestamps via storage directly
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

    // Trigger eviction by writing through the compiler (4th entry, over cap of 2)
    await smallCompiler.set("hash4", testJsScript2);

    // Eviction is fire-and-forget; yield to let it complete
    await new Promise((r) => setTimeout(r, 0));

    // Should have evicted down to 2 — hash1 (oldest) and hash3 removed
    expect(await storage.count()).toBe(2);
    expect(await storage.get("hash2")).toBeDefined();
    expect(await storage.get("hash4")).toBeDefined();

    const stats = smallCompiler.getStats();
    expect(stats.countEvictions).toBeGreaterThan(0);
  });

  it("stale eviction alone can bring count under cap", async () => {
    // cap=2, evictionInterval=1
    const smallCompiler = new CachedCompiler(storage, "current-fp", 2, 1);

    // Seed 2 stale entries via storage directly (wrong fingerprint)
    await storage.set("stale1", {
      jsScript: testJsScript,
      fingerprint: "old-fp",
      cachedAt: 1000,
    });
    await storage.set("stale2", {
      jsScript: testJsScript2,
      fingerprint: "old-fp",
      cachedAt: 2000,
    });

    // Write 1 current entry — now at 3, over cap of 2
    // Eviction should remove the 2 stale entries without needing evictOldest
    await smallCompiler.set("current1", testJsScript);
    await new Promise((r) => setTimeout(r, 0));

    expect(await storage.count()).toBe(1);
    expect(await storage.get("current1")).toBeDefined();
    expect(await storage.get("stale1")).toBeUndefined();
    expect(await storage.get("stale2")).toBeUndefined();
  });

  it("does not evict when below eviction interval", async () => {
    // cap=2, evictionInterval=10 — need 10 writes before eviction triggers
    const smallCompiler = new CachedCompiler(storage, "fp", 2, 10);

    // Seed entries to exceed cap
    await storage.set("old1", {
      jsScript: testJsScript,
      fingerprint: "fp",
      cachedAt: 1000,
    });
    await storage.set("old2", {
      jsScript: testJsScript2,
      fingerprint: "fp",
      cachedAt: 2000,
    });

    // 3 writes through compiler — below interval of 10, no eviction
    await smallCompiler.set("new1", testJsScript);
    await smallCompiler.set("new2", testJsScript2);
    await smallCompiler.set("new3", testJsScript);
    await new Promise((r) => setTimeout(r, 0));

    // All 5 entries should still be present (no eviction triggered)
    expect(await storage.count()).toBe(5);
    expect(smallCompiler.getStats().countEvictions).toBe(0);
  });

  it("clear removes everything", async () => {
    await compiler.set("hash1", testJsScript);
    await compiler.set("hash2", testJsScript2);

    await compiler.clear();

    expect(await compiler.get("hash1")).toBeUndefined();
    expect(await compiler.get("hash2")).toBeUndefined();
  });
});
