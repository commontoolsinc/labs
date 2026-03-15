import { assertEquals } from "@std/assert";
import { resolveSpaceStoreUrl } from "../memory.ts";

Deno.test("resolveSpaceStoreUrl keeps v1 directory mode unchanged", () => {
  const root = new URL("file:///tmp/ct-memory/");
  const subject = "did:key:z6Mkk-test";

  assertEquals(
    resolveSpaceStoreUrl(root, subject, "v1").href,
    new URL(`./${subject}.sqlite`, root).href,
  );
});

Deno.test("resolveSpaceStoreUrl uses a dedicated v2 subdirectory in directory mode", () => {
  const root = new URL("file:///tmp/ct-memory/");
  const subject = "did:key:z6Mkk-test";

  assertEquals(
    resolveSpaceStoreUrl(root, subject, "v2").href,
    new URL(`./v2/${subject}.sqlite`, root).href,
  );
});

Deno.test("resolveSpaceStoreUrl uses a sibling v2 sqlite file in single-file mode", () => {
  const file = new URL("file:///tmp/ct-memory/space.sqlite");
  const subject = "did:key:z6Mkk-test";

  assertEquals(
    resolveSpaceStoreUrl(file, subject, "v2").href,
    new URL("file:///tmp/ct-memory/space.v2.sqlite").href,
  );
});
