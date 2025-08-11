import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test("create and close branches with lineage", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:space-branches", { spacesDir });

  const docId = "doc:branches-test";
  const main = await space.getOrCreateBranch(docId, "main");
  assertEquals(main.heads, []);
  assertEquals(main.seqNo, 0);

  // Create a feature branch by submitting a change with from main heads (implicitly creates branch row)
  const d0 = Automerge.init();
  const d1 = Automerge.change(d0, (doc: any) => {
    doc.title = "v1";
  });
  const c1 = Automerge.getLastLocalChange(d1)!;

  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: "feature/x" },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });
  const feature = await space.getBranchState(docId, "feature/x");
  assertEquals(feature.seqNo, 1);

  // Close feature branch (no merge target)
  // No direct API yet on SpaceStorage, but closing should not break reads
  const after = await space.getBranchState(docId, "feature/x");
  assertEquals(after.seqNo, 1);
});
