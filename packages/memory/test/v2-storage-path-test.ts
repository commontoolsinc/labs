import { assertEquals, assertThrows } from "@std/assert";
import {
  resolveSchemaStoreUrl,
  resolveSpaceStoreUrl,
} from "../v2/storage-path.ts";

Deno.test("resolveSpaceStoreUrl uses a dedicated engine subdirectory in directory mode", () => {
  const root = new URL("file:///tmp/cf-memory/");
  const subject = "did:key:z6Mkk-test" as const;

  assertEquals(
    resolveSpaceStoreUrl(root, subject).href,
    new URL(`./engine-v3/${encodeURIComponent(subject)}.sqlite`, root).href,
  );
});

Deno.test("resolveSpaceStoreUrl uses a sibling engine directory in single-file mode", () => {
  const file = new URL("file:///tmp/cf-memory/space.sqlite");
  const subject = "did:key:z6Mkk-test" as const;

  assertEquals(
    resolveSpaceStoreUrl(file, subject).href,
    new URL(
      `file:///tmp/cf-memory/space.engine-v3/${
        encodeURIComponent(encodeURIComponent(subject))
      }.sqlite`,
    ).href,
  );
});

Deno.test("resolveSchemaStoreUrl keeps the durable store outside per-space databases", () => {
  assertEquals(
    resolveSchemaStoreUrl(new URL("file:///tmp/cf-memory/")).href,
    "file:///tmp/cf-memory/schema-store-v1.sqlite",
  );
  assertEquals(
    resolveSchemaStoreUrl(new URL("file:///tmp/cf-memory/space.sqlite")).href,
    "file:///tmp/cf-memory/space.schema-store-v1.sqlite",
  );
  assertEquals(
    resolveSchemaStoreUrl(new URL("memory:")).href,
    "memory:",
  );
});

Deno.test("resolveSpaceStoreUrl rejects traversal-like subjects", () => {
  const root = new URL("file:///tmp/cf-memory/");

  assertThrows(
    () => resolveSpaceStoreUrl(root, "../../evil" as any),
    Error,
    "Invalid memory space identifier for store path",
  );
  assertThrows(
    () => resolveSpaceStoreUrl(root, "nested/space" as any),
    Error,
    "Invalid memory space identifier for store path",
  );
  assertThrows(
    () => resolveSpaceStoreUrl(root, ".." as any),
    Error,
    "Invalid memory space identifier for store path",
  );
});

Deno.test("resolveSpaceStoreUrl rejects malformed unicode subjects with validation error", () => {
  const root = new URL("file:///tmp/cf-memory/");

  assertThrows(
    () => resolveSpaceStoreUrl(root, "\uD800" as any),
    Error,
    "Invalid memory space identifier for store path",
  );
});
