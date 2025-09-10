import { assert, assertEquals } from "@std/assert";
import {
  compareETags,
  createCacheHeaders,
  generateETag,
} from "@commontools/static/etag";
import { StaticCache } from "@commontools/static";
import { decode } from "@commontools/utils/encoding";

Deno.test("ETag Generation - generates same ETag for same content", async () => {
  const content = new TextEncoder().encode("Hello, World!");
  const etag1 = await generateETag(content);
  const etag2 = await generateETag(content);
  assertEquals(etag1, etag2);
});

Deno.test("ETag Generation - generates different ETags for different content", async () => {
  const content1 = new TextEncoder().encode("Hello, World!");
  const content2 = new TextEncoder().encode("Goodbye, World!");
  const etag1 = await generateETag(content1);
  const etag2 = await generateETag(content2);
  assert(etag1 !== etag2);
});

Deno.test("ETag Generation - generates valid ETag format (quoted base64)", async () => {
  const content = new TextEncoder().encode("Test content");
  const etag = await generateETag(content);

  // Should be wrapped in quotes
  assert(etag.startsWith('"') && etag.endsWith('"'));

  // Should be valid base64-like format (URL-safe)
  const base64Part = etag.slice(1, -1);
  assert(/^[A-Za-z0-9_-]+$/.test(base64Part));
});

Deno.test("ETag Comparison - matches single matching ETag", () => {
  const etag = '"abc123"';
  const ifNoneMatch = '"abc123"';
  assertEquals(compareETags(etag, ifNoneMatch), true);
});

Deno.test("ETag Comparison - does not match non-matching ETag", () => {
  const etag = '"abc123"';
  const ifNoneMatch = '"xyz789"';
  assertEquals(compareETags(etag, ifNoneMatch), false);
});

Deno.test("ETag Comparison - matches ETag in comma-separated list", () => {
  const etag = '"abc123"';
  const ifNoneMatch = '"xyz789", "abc123", "def456"';
  assertEquals(compareETags(etag, ifNoneMatch), true);
});

Deno.test("ETag Comparison - handles comma-separated list with spaces", () => {
  const etag = '"abc123"';
  const ifNoneMatch = '"xyz789" , "abc123" , "def456"';
  assertEquals(compareETags(etag, ifNoneMatch), true);
});

Deno.test("ETag Comparison - matches wildcard *", () => {
  const etag = '"abc123"';
  const ifNoneMatch = "*";
  assertEquals(compareETags(etag, ifNoneMatch), true);
});

Deno.test("ETag Comparison - handles undefined If-None-Match", () => {
  const etag = '"abc123"';
  assertEquals(compareETags(etag, undefined), false);
});

Deno.test("ETag Comparison - handles null If-None-Match", () => {
  const etag = '"abc123"';
  assertEquals(compareETags(etag, null), false);
});

Deno.test("ETag Comparison - handles empty string If-None-Match", () => {
  const etag = '"abc123"';
  assertEquals(compareETags(etag, ""), false);
});

Deno.test("ETag Comparison - handles weak ETags (W/ prefix)", () => {
  const etag = '"abc123"';
  const ifNoneMatch = 'W/"abc123"';
  assertEquals(compareETags(etag, ifNoneMatch), true);
});

Deno.test("ETag Comparison - handles weak ETags in server response", () => {
  const etag = 'W/"abc123"';
  const ifNoneMatch = '"abc123"';
  assertEquals(compareETags(etag, ifNoneMatch), true);
});

Deno.test("ETag Comparison - handles both weak ETags", () => {
  const etag = 'W/"abc123"';
  const ifNoneMatch = 'W/"abc123"';
  assertEquals(compareETags(etag, ifNoneMatch), true);
});

Deno.test("Cache Headers - generates 'public, no-cache' by default", () => {
  const etag = '"abc123"';
  const headers = createCacheHeaders(etag);
  assertEquals(headers["Cache-Control"], "public, no-cache");
});

Deno.test("Cache Headers - includes ETag header", () => {
  const etag = '"abc123"';
  const headers = createCacheHeaders(etag);
  assertEquals(headers["ETag"], etag);
});

Deno.test("Cache Headers - respects noCache: false option", () => {
  const etag = '"abc123"';
  const headers = createCacheHeaders(etag, { noCache: false });
  assertEquals("Cache-Control" in headers, false);
  assertEquals(headers["ETag"], etag);
});

Deno.test("Cache Headers - respects public: false option", () => {
  const etag = '"abc123"';
  const headers = createCacheHeaders(etag, { public: false });
  assertEquals(headers["Cache-Control"], "no-cache");
});

Deno.test("Cache Headers - respects both options together", () => {
  const etag = '"abc123"';
  const headers = createCacheHeaders(etag, {
    noCache: false,
    public: false,
  });
  assertEquals("Cache-Control" in headers, false);
  assertEquals(headers["ETag"], etag);
});

Deno.test("StaticCache ETag - getWithETag returns both buffer and ETag", async () => {
  const cache = new StaticCache();
  const result = await cache.getWithETag("prompts/system.md");

  assert(result.buffer instanceof Uint8Array);
  assertEquals(typeof result.etag, "string");
  assert(result.etag.startsWith('"') && result.etag.endsWith('"'));
});

Deno.test("StaticCache ETag - returns same ETag for same asset (caching works)", async () => {
  const cache = new StaticCache();
  const result1 = await cache.getWithETag("prompts/system.md");
  const result2 = await cache.getWithETag("prompts/system.md");

  assertEquals(result1.etag, result2.etag);
  // Should be the exact same promise/object from cache
  assert(result1 === result2 || result1.etag === result2.etag);
});

Deno.test("StaticCache ETag - get() method still works (backward compatibility)", async () => {
  const cache = new StaticCache();
  const buffer = await cache.get("prompts/system.md");

  assert(buffer instanceof Uint8Array);
  const text = decode(buffer);
  assert(/# React Component Builder/.test(text));
});

Deno.test("StaticCache ETag - ETag is consistent for same content", async () => {
  const cache = new StaticCache();
  const result = await cache.getWithETag("prompts/system.md");

  // Generate ETag directly from the buffer
  const expectedETag = await generateETag(result.buffer);
  assertEquals(result.etag, expectedETag);
});

Deno.test("StaticCache ETag - different assets have different ETags", async () => {
  const cache = new StaticCache();
  const result1 = await cache.getWithETag("prompts/system.md");
  const result2 = await cache.getWithETag("types/es2023.d.ts");

  assert(result1.etag !== result2.etag);
});
