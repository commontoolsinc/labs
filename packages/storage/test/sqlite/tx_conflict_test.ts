import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";
import { decodeChangeHeader } from "../../src/store/change.ts";
import { createGenesisDoc } from "../../src/index.ts";

Deno.test("sqlite tx pipeline: concurrent write conflict on same branch", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:space-conflict", { spacesDir });

  const docId = "doc:X";
  const branch = "main";
  const s0 = await space.getOrCreateBranch(docId, branch);
  assertEquals(s0.heads, []);

  // Build two independent changes atop genesis
  const aBase = createGenesisDoc<any>(docId);
  const a0 = Automerge.change(aBase, (d: any) => {
    d.v = 1;
  });
  const bBase = Automerge.init();
  const b0 = Automerge.change(bBase, (d: any) => {
    d.v = 2;
  });
  const ca = Automerge.getLastLocalChange(a0)!;
  const cb = Automerge.getLastLocalChange(b0)!;
  const ha = decodeChangeHeader(ca).changeHash;
  const hb = decodeChangeHeader(cb).changeHash;

  // First tx applies change A
  const r1 = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: Automerge.getHeads(aBase),
      changes: [{ bytes: ca }],
    }],
  });
  assertEquals(r1.conflicts.length, 0);

  // Second tx attempts to apply change B but still claims base incorrect genesis -> should conflict
  const r2 = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: Automerge.getHeads(aBase),
      changes: [{ bytes: cb }],
    }],
  });
  assertEquals(r2.results[0]?.status, "conflict");

  const s1 = await space.getBranchState(docId, branch);
  assertEquals(s1.heads, [ha]);

  // Now submit with correct base = current heads -> should fork to [ha, hb]
  const r3 = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: cb }],
    }],
  });
  assertEquals(r3.conflicts.length, 0);
  const s2 = await space.getBranchState(docId, branch);
  assertEquals(s2.heads, [ha, hb].sort());
});
