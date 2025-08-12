import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";
import { decodeChangeHeader } from "../src/store/change.ts";
import { computeGenesisHead, createGenesisDoc } from "../src/index.ts";

Deno.test("client merge collapses two heads into one", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const branch = "main";

  // Two independent changes from empty base
  const gen = computeGenesisHead(docId);
  const d0 = createGenesisDoc<any>(docId);
  const d1 = Automerge.change(d0, (doc: any) => {
    doc.value = { n: 1 };
  });
  const c1 = Automerge.getLastLocalChange(d1)!;
  const h1 = decodeChangeHeader(c1).changeHash;

  const e0 = createGenesisDoc<any>(docId);
  const e1 = Automerge.change(e0, (doc: any) => {
    doc.value = { n: 2 };
  });
  const c2 = Automerge.getLastLocalChange(e1)!;
  const h2 = decodeChangeHeader(c2).changeHash;

  // Submit first change
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [gen],
      changes: [{ bytes: c1 }],
    }],
  });
  const s1 = await space.getBranchState(docId, branch);
  assertEquals(s1.heads, [h1]);

  // Submit second change on top (creates fork: heads become [h1, h2])
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c2 }],
    }],
  });
  const s2 = await space.getBranchState(docId, branch);
  assertEquals(s2.heads, [h1, h2].sort());

  // Build a merge change with deps = [h1, h2]
  const applied = Automerge.applyChanges(Automerge.init(), [c1, c2]);
  const baseDoc = Array.isArray(applied) ? applied[0] : applied;
  const mergedDoc = Automerge.change(baseDoc, (doc: any) => {
    doc.value.merged = true;
  });
  const cm = Automerge.getLastLocalChange(mergedDoc)!;
  const hm = decodeChangeHeader(cm).changeHash;

  // Submit merge change with baseHeads equal to current heads
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s2.heads,
      changes: [{ bytes: cm }],
    }],
  });
  const s3 = await space.getBranchState(docId, branch);
  assertEquals(s3.seqNo, 3);
  assertEquals(s3.heads, [hm]);
});
