import { assertEquals, assertThrows } from "@std/assert";
import { resolveSpaceStoreUrl } from "../memory.ts";

Deno.test("resolveSpaceStoreUrl keeps v1 directory mode unchanged", () => {
  const root = new URL("file:///tmp/cf-memory/");
  const subject = "did:key:z6Mkk-test";

  assertEquals(
    resolveSpaceStoreUrl(root, subject, "v1").href,
    new URL(`./${subject}.sqlite`, root).href,
  );
});

Deno.test("resolveSpaceStoreUrl uses a dedicated engine subdirectory in directory mode", () => {
  const root = new URL("file:///tmp/cf-memory/");
  const subject = "did:key:z6Mkk-test";

  assertEquals(
    resolveSpaceStoreUrl(root, subject, "v2").href,
    new URL(`./engine-v3/${subject}.sqlite`, root).href,
  );
});

Deno.test("resolveSpaceStoreUrl uses a sibling engine directory in single-file mode", () => {
  const file = new URL("file:///tmp/cf-memory/space.sqlite");
  const subject = "did:key:z6Mkk-test";

  assertEquals(
    resolveSpaceStoreUrl(file, subject, "v2").href,
    new URL(`file:///tmp/cf-memory/space.engine-v3/${subject}.sqlite`).href,
  );
});

Deno.test("resolveSpaceStoreUrl rejects traversal-like subjects", () => {
  const root = new URL("file:///tmp/cf-memory/");

  assertThrows(
    () => resolveSpaceStoreUrl(root, "../../evil" as any, "v2"),
    Error,
    "Invalid memory space identifier for store path",
  );
  assertThrows(
    () => resolveSpaceStoreUrl(root, "nested/space" as any, "v2"),
    Error,
    "Invalid memory space identifier for store path",
  );
  assertThrows(
    () => resolveSpaceStoreUrl(root, ".." as any, "v2"),
    Error,
    "Invalid memory space identifier for store path",
  );
});
