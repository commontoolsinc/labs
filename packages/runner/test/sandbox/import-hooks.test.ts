import { assertEquals, assertThrows } from "@std/assert";
import {
  createImportHook,
  createResolveHook,
  ESMCache,
  isExternalSpecifier,
  resetImportCounter,
} from "../../src/sandbox/mod.ts";

Deno.test("ESMCache", async (t) => {
  await t.step("stores and retrieves modules", () => {
    const cache = new ESMCache();
    cache.set("https://esm.sh/zod", {
      source: "export const z = {};",
      url: "https://esm.sh/zod",
      cachedAt: Date.now(),
    });

    const cached = cache.get("https://esm.sh/zod");
    assertEquals(cached?.source, "export const z = {};");
  });

  await t.step("evicts oldest when at capacity", () => {
    const cache = new ESMCache(2);
    cache.set("a", { source: "a", url: "a", cachedAt: 1 });
    cache.set("b", { source: "b", url: "b", cachedAt: 2 });
    cache.set("c", { source: "c", url: "c", cachedAt: 3 });

    assertEquals(cache.has("a"), false);
    assertEquals(cache.has("b"), true);
    assertEquals(cache.has("c"), true);
    assertEquals(cache.size, 2);
  });

  await t.step("clears all entries", () => {
    const cache = new ESMCache();
    cache.set("a", { source: "a", url: "a", cachedAt: 1 });
    cache.clear();
    assertEquals(cache.size, 0);
  });
});

Deno.test("createResolveHook", async (t) => {
  await t.step("resolves allowed esm.sh URLs", () => {
    resetImportCounter();
    const resolve = createResolveHook();
    const result = resolve("https://esm.sh/zod@3.0.0", "");
    assertEquals(result.startsWith("https://esm.sh/zod@3.0.0"), true);
    assertEquals(result.includes("__ct_instance="), true);
  });

  await t.step("blocks node: imports", () => {
    const resolve = createResolveHook({ patternId: "test" });
    assertThrows(
      () => resolve("node:fs", ""),
      Error,
      "not allowed",
    );
  });

  await t.step("blocks deno: imports", () => {
    const resolve = createResolveHook({ patternId: "test" });
    assertThrows(
      () => resolve("deno:test", ""),
      Error,
      "not allowed",
    );
  });

  await t.step("blocks file: imports", () => {
    const resolve = createResolveHook({ patternId: "test" });
    assertThrows(
      () => resolve("file:///etc/passwd", ""),
      Error,
      "not allowed",
    );
  });

  await t.step("blocks relative imports", () => {
    const resolve = createResolveHook({ patternId: "test" });
    assertThrows(
      () => resolve("./local-module", ""),
      Error,
      "not allowed",
    );
  });

  await t.step("converts bare specifiers to esm.sh", () => {
    resetImportCounter();
    const resolve = createResolveHook();
    const result = resolve("lodash", "");
    assertEquals(result.startsWith("https://esm.sh/lodash"), true);
  });

  await t.step("blocks non-allowed HTTPS URLs", () => {
    const resolve = createResolveHook({
      allowedPrefixes: ["https://esm.sh/"],
    });
    assertThrows(
      () => resolve("https://evil.com/malware.js", ""),
      Error,
      "not allowed",
    );
  });

  await t.step("generates unique suffixes", () => {
    resetImportCounter();
    const resolve = createResolveHook();
    const r1 = resolve("https://esm.sh/zod", "");
    const r2 = resolve("https://esm.sh/zod", "");
    assertEquals(r1 !== r2, true);
  });
});

Deno.test("createImportHook", async (t) => {
  await t.step("fetches from cache when available", async () => {
    const cache = new ESMCache();
    cache.set("https://esm.sh/zod", {
      source: "export const z = {};",
      url: "https://esm.sh/zod",
      cachedAt: Date.now(),
    });

    const importHook = createImportHook({ cacheEnabled: true }, cache);
    const result = await importHook("https://esm.sh/zod");
    assertEquals(result.source, "export const z = {};");
  });
});

Deno.test("isExternalSpecifier", async (t) => {
  await t.step("identifies HTTPS URLs", () => {
    assertEquals(isExternalSpecifier("https://esm.sh/zod"), true);
  });

  await t.step("identifies HTTP URLs", () => {
    assertEquals(isExternalSpecifier("http://example.com/mod.js"), true);
  });

  await t.step("identifies npm: specifiers", () => {
    assertEquals(isExternalSpecifier("npm:zod@3.0.0"), true);
  });

  await t.step("rejects relative paths", () => {
    assertEquals(isExternalSpecifier("./local"), false);
  });

  await t.step("rejects bare specifiers", () => {
    assertEquals(isExternalSpecifier("lodash"), false);
  });
});
