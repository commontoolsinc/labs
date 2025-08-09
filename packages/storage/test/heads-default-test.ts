import { assertEquals } from "@std/assert";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test("getOrCreateBranch initializes empty heads and zeros", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const state = await space.getOrCreateBranch(docId, "main");

  assertEquals(state.branchId.length > 0, true);
  assertEquals(state.heads, []);
  assertEquals(state.seqNo, 0);
  assertEquals(state.epoch, 0);
});
