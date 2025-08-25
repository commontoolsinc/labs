import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";

Deno.test("sqlite tx pipeline: rollback on partial failure (all-or-nothing)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:space-rollback", { spacesDir });

  const docA = "doc:A";
  const docB = "doc:B";
  const branch = "main";

  // Ensure branches exist with empty heads
  const sA0 = await space.getOrCreateBranch(docA, branch);
  const sB0 = await space.getOrCreateBranch(docB, branch);
  assertEquals(sA0.heads, []);
  assertEquals(sB0.heads, []);

  // Build a valid change for A
  const a0 = Automerge.change(Automerge.init(), (d: any) => {
    d.title = "A1";
  });
  const a1 = Automerge.getLastLocalChange(a0)!;

  // Submit a single tx: A valid, B conflicting baseHeads
  const receipt = await space.submitTx({
    reads: [
      { ref: { docId: docA, branch }, heads: [] },
      { ref: { docId: docB, branch }, heads: [] },
    ],
    writes: [
      { ref: { docId: docA, branch }, baseHeads: [], changes: [{ bytes: a1 }] },
      // Base heads mismatch for B to force a conflict
      { ref: { docId: docB, branch }, baseHeads: ["deadbeef"], changes: [] },
    ],
  });

  // Entire tx should be aborted and return txId=0 with conflicts
  assertEquals(receipt.txId, 0);
  assertEquals(receipt.conflicts.length, 1);

  // Neither A nor B should be updated (rollback)
  const sA1 = await space.getBranchState(docA, branch);
  const sB1 = await space.getBranchState(docB, branch);
  assertEquals(sA1.seqNo, 0);
  assertEquals(sB1.seqNo, 0);
  assertEquals(sA1.heads, []);
  assertEquals(sB1.heads, []);
});
