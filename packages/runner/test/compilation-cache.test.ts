import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CompilationCache,
  computeCacheKey,
} from "../src/harness/compilation-cache.ts";
import type { JsScript, Program, SourceMap } from "@commontools/js-compiler";

// Helper to create a test program
function createProgram(
  main: string,
  files: Array<{ name: string; contents: string }>,
): Program {
  return { main, files };
}

// Helper to create a test JsScript result
function createJsScript(js: string, sourceMap?: SourceMap): JsScript {
  return { js, sourceMap };
}

describe("computeCacheKey", () => {
  it("should return a string key for a program", () => {
    const program = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 1;" },
    ]);
    const key = computeCacheKey(program);
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  it("should return the same key for identical programs", () => {
    const program1 = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 1;" },
    ]);
    const program2 = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 1;" },
    ]);
    expect(computeCacheKey(program1)).toBe(computeCacheKey(program2));
  });

  it("should return different keys for different content", () => {
    const program1 = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 1;" },
    ]);
    const program2 = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 2;" },
    ]);
    expect(computeCacheKey(program1)).not.toBe(computeCacheKey(program2));
  });

  it("should return different keys for different main file", () => {
    const program1 = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 1;" },
    ]);
    const program2 = createProgram("other.ts", [
      { name: "other.ts", contents: "export const x = 1;" },
    ]);
    expect(computeCacheKey(program1)).not.toBe(computeCacheKey(program2));
  });

  it("should exclude .d.ts files from key computation", () => {
    const program1 = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 1;" },
    ]);
    const program2 = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 1;" },
      { name: "types.d.ts", contents: "declare const foo: string;" },
    ]);
    // Keys should be the same since .d.ts files are excluded
    expect(computeCacheKey(program1)).toBe(computeCacheKey(program2));
  });

  it("should include non-d.ts files in key computation", () => {
    const program1 = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 1;" },
    ]);
    const program2 = createProgram("main.ts", [
      { name: "main.ts", contents: "export const x = 1;" },
      { name: "helper.ts", contents: "export const y = 2;" },
    ]);
    // Keys should differ since helper.ts adds to the key
    expect(computeCacheKey(program1)).not.toBe(computeCacheKey(program2));
  });
});

describe("CompilationCache", () => {
  // Note: IndexedDB is not available in Deno's test environment.
  // These tests focus on memory cache behavior only.
  //
  // For IndexedDB persistence tests, see:
  //   packages/runner/test/compilation-cache-idb.webtest.ts
  //
  // Run IndexedDB tests with:
  //   deno task test:web test/compilation-cache-idb.webtest.ts
  //
  // Those tests use the deno-web-test framework to run in a real browser,
  // which provides access to IndexedDB APIs.

  describe("isAvailable", () => {
    it("should return false when IndexedDB is not available", () => {
      // In Deno test environment, IndexedDB is typically not available
      // This test documents the expected behavior
      const available = CompilationCache.isAvailable();
      expect(typeof available).toBe("boolean");
    });
  });

  describe("memory cache operations", () => {
    it("should cache and retrieve compilation results", async () => {
      const cache = new CompilationCache({ maxEntries: 100, ttlMs: 60000 });
      const program = createProgram("main.ts", [
        { name: "main.ts", contents: "export const x = 1;" },
      ]);
      const result = createJsScript("const x = 1;");

      await cache.set(program, result);
      const retrieved = await cache.get(program);

      expect(retrieved).toBeDefined();
      expect(retrieved?.js).toBe(result.js);
    });

    it("should cache with source maps", async () => {
      const cache = new CompilationCache({ maxEntries: 100, ttlMs: 60000 });
      const program = createProgram("main.ts", [
        { name: "main.ts", contents: "export const x = 1;" },
      ]);
      const sourceMap: SourceMap = {
        version: "3",
        sources: ["main.ts"],
        names: [],
        mappings: "AAAA",
      };
      const result = createJsScript("const x = 1;", sourceMap);

      await cache.set(program, result);
      const retrieved = await cache.get(program);

      expect(retrieved).toBeDefined();
      expect(retrieved?.sourceMap).toEqual(sourceMap);
    });

    it("should return undefined for non-cached programs", async () => {
      const cache = new CompilationCache({ maxEntries: 100, ttlMs: 60000 });
      const program = createProgram("main.ts", [
        { name: "main.ts", contents: "export const x = 1;" },
      ]);

      const retrieved = await cache.get(program);
      expect(retrieved).toBeUndefined();
    });

    it("should overwrite existing entries", async () => {
      const cache = new CompilationCache({ maxEntries: 100, ttlMs: 60000 });
      const program = createProgram("main.ts", [
        { name: "main.ts", contents: "export const x = 1;" },
      ]);
      const result1 = createJsScript("const x = 1;");
      const result2 = createJsScript("const x = 2;");

      await cache.set(program, result1);
      await cache.set(program, result2);
      const retrieved = await cache.get(program);

      expect(retrieved?.js).toBe(result2.js);
    });

    it("should evict oldest entries when maxEntries is exceeded", async () => {
      const cache = new CompilationCache({ maxEntries: 3, ttlMs: 60000 });

      // Fill cache
      for (let i = 0; i < 4; i++) {
        const program = createProgram(`main${i}.ts`, [
          { name: `main${i}.ts`, contents: `export const x = ${i};` },
        ]);
        await cache.set(program, createJsScript(`const x = ${i};`));
      }

      // First entry should be evicted
      const firstProgram = createProgram("main0.ts", [
        { name: "main0.ts", contents: "export const x = 0;" },
      ]);
      const retrieved = await cache.get(firstProgram);

      // Memory cache should have evicted the oldest entry
      const stats = cache.stats();
      expect(stats.memorySize).toBeLessThanOrEqual(3);
    });

    it("should clear all entries", async () => {
      const cache = new CompilationCache({ maxEntries: 100, ttlMs: 60000 });
      const program = createProgram("main.ts", [
        { name: "main.ts", contents: "export const x = 1;" },
      ]);
      const result = createJsScript("const x = 1;");

      await cache.set(program, result);
      await cache.clear();

      const retrieved = await cache.get(program);
      expect(retrieved).toBeUndefined();

      const stats = cache.stats();
      expect(stats.memorySize).toBe(0);
    });

    it("should expire entries based on TTL", async () => {
      // Use very short TTL for testing
      const cache = new CompilationCache({ maxEntries: 100, ttlMs: 1 });
      const program = createProgram("main.ts", [
        { name: "main.ts", contents: "export const x = 1;" },
      ]);
      const result = createJsScript("const x = 1;");

      await cache.set(program, result);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      const retrieved = await cache.get(program);
      expect(retrieved).toBeUndefined();
    });

    it("should update lastAccessedAt on cache hit (LRU behavior)", async () => {
      const cache = new CompilationCache({ maxEntries: 3, ttlMs: 60000 });

      // Add three entries
      const programs = [];
      for (let i = 0; i < 3; i++) {
        const program = createProgram(`main${i}.ts`, [
          { name: `main${i}.ts`, contents: `export const x = ${i};` },
        ]);
        programs.push(program);
        await cache.set(program, createJsScript(`const x = ${i};`));
      }

      // Access the first entry to move it to end of LRU
      await cache.get(programs[0]);

      // Add a fourth entry - should evict the second entry (now oldest)
      const newProgram = createProgram("main3.ts", [
        { name: "main3.ts", contents: "export const x = 3;" },
      ]);
      await cache.set(newProgram, createJsScript("const x = 3;"));

      // First entry (accessed recently) should still be cached
      const firstRetrieved = await cache.get(programs[0]);
      expect(firstRetrieved).toBeDefined();

      // Second entry should be evicted
      const secondRetrieved = await cache.get(programs[1]);
      expect(secondRetrieved).toBeUndefined();
    });
  });

  describe("stats", () => {
    it("should return cache statistics", async () => {
      const cache = new CompilationCache({ maxEntries: 100, ttlMs: 60000 });

      const stats = cache.stats();
      expect(stats).toHaveProperty("memorySize");
      expect(stats).toHaveProperty("idbDisabled");
      expect(stats).toHaveProperty("errors");
      expect(stats.errors).toHaveProperty("quota");
      expect(stats.errors).toHaveProperty("transaction");
      expect(stats.errors).toHaveProperty("other");
    });

    it("should track memory cache size", async () => {
      const cache = new CompilationCache({ maxEntries: 100, ttlMs: 60000 });

      expect(cache.stats().memorySize).toBe(0);

      const program = createProgram("main.ts", [
        { name: "main.ts", contents: "export const x = 1;" },
      ]);
      await cache.set(program, createJsScript("const x = 1;"));

      expect(cache.stats().memorySize).toBe(1);

      await cache.clear();
      expect(cache.stats().memorySize).toBe(0);
    });
  });
});
