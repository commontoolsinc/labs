import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";
import { decodeChangeHeader } from "../src/sqlite/change.ts";

Deno.test("fork: two concurrent changes produce two heads", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const branch = "main";

  const s0 = await space.getOrCreateBranch(docId, branch);
  assertEquals(s0.heads, []);

  // First change from base []
  let a0 = Automerge.init();
  let a1 = Automerge.change(a0, (doc: any) => {
    doc.value = { v: 1 };
  });
  const c1 = Automerge.getLastLocalChange(a1)!;
  const h1 = decodeChangeHeader(c1).changeHash;

  const r1 = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });
  assertEquals(r1.results[0]?.status, "ok");

  const s1 = await space.getBranchState(docId, branch);
  assertEquals(s1.heads, [h1]);

  // Second independent change also derived from empty base [] (concurrent)
  let b0 = Automerge.init();
  let b1 = Automerge.change(b0, (doc: any) => {
    doc.value = { v: 2 };
  });
  const c2 = Automerge.getLastLocalChange(b1)!;
  const h2 = decodeChangeHeader(c2).changeHash;

  // Submit with baseHeads equal to current heads [h1]
  const r2 = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c2 }],
    }],
  });
  assertEquals(r2.results[0]?.status, "ok");

  const s2 = await space.getBranchState(docId, branch);
  assertEquals(s2.seqNo, 2);
  // Heads should be the two hashes sorted
  assertEquals(s2.heads, [h1, h2].sort());
});
