import { assertEquals, assert } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";
import { decodeChangeHeader } from "../../src/sqlite/change.ts";

Deno.test("sqlite tx pipeline: valid multi-doc tx applies atomically", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:space-tx", { spacesDir });

  const docA = "doc:A";
  const docB = "doc:B";
  const branch = "main";

  const sA0 = await space.getOrCreateBranch(docA, branch);
  const sB0 = await space.getOrCreateBranch(docB, branch);
  assertEquals(sA0.heads, []);
  assertEquals(sB0.heads, []);

  // Build one change for A and one for B
  const a0 = Automerge.change(Automerge.init(), (d: any) => {
    d.title = "A1";
  });
  const a1 = Automerge.getLastLocalChange(a0)!;
  const aH = decodeChangeHeader(a1).changeHash;

  const b0 = Automerge.change(Automerge.init(), (d: any) => {
    d.title = "B1";
  });
  const b1 = Automerge.getLastLocalChange(b0)!;
  const bH = decodeChangeHeader(b1).changeHash;

  const receipt = await space.submitTx({
    reads: [
      { ref: { docId: docA, branch }, heads: [] },
      { ref: { docId: docB, branch }, heads: [] },
    ],
    writes: [
      { ref: { docId: docA, branch }, baseHeads: [], changes: [{ bytes: a1 }] },
      { ref: { docId: docB, branch }, baseHeads: [], changes: [{ bytes: b1 }] },
    ],
  });

  assertEquals(receipt.results.length, 2);
  assertEquals(receipt.conflicts.length, 0);

  const sA1 = await space.getBranchState(docA, branch);
  const sB1 = await space.getBranchState(docB, branch);
  assertEquals(sA1.heads, [aH]);
  assertEquals(sB1.heads, [bH]);
  assert(sA1.seqNo === 1 && sB1.seqNo === 1);
});

