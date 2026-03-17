import { assertEquals } from "@std/assert";
import { resolveMemoryV2StoreRootUrl } from "./memory-path.ts";

Deno.test("resolveMemoryV2StoreRootUrl derives a sibling v2-engine directory for DB_PATH mode", () => {
  const file = new URL("file:///tmp/ct-memory/space.sqlite");

  assertEquals(
    resolveMemoryV2StoreRootUrl(file).href,
    new URL("file:///tmp/ct-memory/space.v2-engine/").href,
  );
});

Deno.test("resolveMemoryV2StoreRootUrl derives a nested v2-engine directory for directory mode", () => {
  const root = new URL("file:///tmp/ct-memory/");

  assertEquals(
    resolveMemoryV2StoreRootUrl(root).href,
    new URL("file:///tmp/ct-memory/v2-engine/").href,
  );
});
