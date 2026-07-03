import { assertEquals, assertThrows } from "@std/assert";
import type { MemorySpace } from "../interface.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

const memorySpace = (value: string): MemorySpace => value as MemorySpace;

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

Deno.test("resolveSpaceStoreUrl rejects traversal-like subjects", () => {
  const root = new URL("file:///tmp/cf-memory/");

  assertThrows(
    () => resolveSpaceStoreUrl(root, memorySpace("../../evil")),
    Error,
    "Invalid memory space identifier for store path",
  );
  assertThrows(
    () => resolveSpaceStoreUrl(root, memorySpace("nested/space")),
    Error,
    "Invalid memory space identifier for store path",
  );
  assertThrows(
    () => resolveSpaceStoreUrl(root, memorySpace("..")),
    Error,
    "Invalid memory space identifier for store path",
  );
});

Deno.test("resolveSpaceStoreUrl rejects malformed unicode subjects with validation error", () => {
  const root = new URL("file:///tmp/cf-memory/");

  assertThrows(
    () => resolveSpaceStoreUrl(root, memorySpace("\uD800")),
    Error,
    "Invalid memory space identifier for store path",
  );
});
