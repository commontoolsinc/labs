import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";
import { createGenesisDoc } from "../../src/index.ts";

Deno.test("sqlite tx pipeline: idempotent replay returns same heads and no-ops", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:space-idem", { spacesDir });

  const docId = "doc:IDEM";
  const branch = "main";

  // Build a change at base genesis
  const base = createGenesisDoc<any>(docId);
  const d1 = Automerge.change(base, (doc: any) => {
    doc.n = 1;
  });
  const c1 = Automerge.getLastLocalChange(d1)!;

  // First submit
  const r1 = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: Automerge.getHeads(base),
      changes: [{ bytes: c1 }],
    }],
  });
  await space.getOrCreateBranch(docId, branch);
  const s1 = await space.getBranchState(docId, branch);
  assertEquals(s1.seqNo, 1);

  // Replay same txId and exact same change
  const r2 = await space.submitTx({
    clientTxId: "same-id",
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c1 }],
    }],
  });
  const s2 = await space.getBranchState(docId, branch);

  // Idempotent: heads unchanged and seqNo not incremented
  assertEquals(s2.heads, s1.heads);
  assertEquals(s2.seqNo, s1.seqNo);

  // Replay again with same txId should still be a no-op
  const r3 = await space.submitTx({
    clientTxId: "same-id",
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c1 }],
    }],
  });
  const s3 = await space.getBranchState(docId, branch);
  assertEquals(s3.heads, s1.heads);
  assertEquals(s3.seqNo, s1.seqNo);
});
