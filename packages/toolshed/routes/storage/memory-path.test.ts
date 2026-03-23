import { assertEquals } from "@std/assert";
import { resolveMemoryEngineStoreRootUrl } from "./memory-path.ts";

Deno.test("resolveMemoryEngineStoreRootUrl derives a sibling engine directory for DB_PATH mode", () => {
  const file = new URL("file:///tmp/ct-memory/space.sqlite");

  assertEquals(
    resolveMemoryEngineStoreRootUrl(file, { singleFileMode: true }).href,
    new URL("file:///tmp/ct-memory/space.engine-v3/").href,
  );
});

Deno.test("resolveMemoryEngineStoreRootUrl derives a nested engine directory for directory mode", () => {
  const root = new URL("file:///tmp/ct-memory/");

  assertEquals(
    resolveMemoryEngineStoreRootUrl(root, { singleFileMode: false }).href,
    new URL("file:///tmp/ct-memory/engine-v3/").href,
  );
});

Deno.test("resolveMemoryEngineStoreRootUrl treats extensionless DB_PATH values as single-file mode when requested", () => {
  const file = new URL("file:///tmp/ct-memory/space");

  assertEquals(
    resolveMemoryEngineStoreRootUrl(file, { singleFileMode: true }).href,
    new URL("file:///tmp/ct-memory/space.engine-v3/").href,
  );
});
