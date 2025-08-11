import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../../src/provider.ts";
import {
  clearInvariants,
  registerInvariant,
} from "../../src/store/invariants.ts";

Deno.test("invariants: fail-closed aborts tx and leaves state unchanged", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:inv", { spacesDir });

  const docId = "doc:INV";
  const branch = "main";
  await space.getOrCreateBranch(docId, branch);

  // Simple invariant that blocks value.a === 1 at tip
  clearInvariants();
  registerInvariant(({ json }) => {
    if ((json as any)?.value?.a === 1) throw new Error("a=1 not allowed");
  });

  let d = Automerge.init<any>();
  d = Automerge.change(d, (x: any) => (x.value = { a: 1 }));
  const c1 = Automerge.getLastLocalChange(d)!;

  const r = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });
  assertEquals(r.txId, 0);
  const st = await space.getBranchState(docId, branch);
  assertEquals(st.seqNo, 0);
  assertEquals(st.heads, []);
});
