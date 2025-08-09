import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test("reject non-monotonic actor seq on same branch", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const branch = "main";

  // Build two changes for the same actor in order, then try to re-submit the first change again
  let doc = Automerge.init();
  doc = Automerge.change(doc, (d: any) => { d.value = { n: 1 }; });
  const c1 = Automerge.getLastLocalChange(doc)!; // seq=1

  doc = Automerge.change(doc, (d: any) => { d.value.n = 2; });
  const c2 = Automerge.getLastLocalChange(doc)!; // seq=2

  // Submit c1 then c2
  let r1 = await space.submitTx({ reads: [], writes: [ { ref: { docId, branch }, baseHeads: [], changes: [ { bytes: c1 } ] } ] });
  assertEquals(r1.results[0]?.status, "ok");
  const s1 = await space.getBranchState(docId, branch);

  let r2 = await space.submitTx({ reads: [], writes: [ { ref: { docId, branch }, baseHeads: s1.heads, changes: [ { bytes: c2 } ] } ] });
  assertEquals(r2.results[0]?.status, "ok");
  const s2 = await space.getBranchState(docId, branch);

  // Now attempt to submit c1 again with baseHeads = current heads (would be an old seq for same actor)
  const r3 = await space.submitTx({ reads: [], writes: [ { ref: { docId, branch }, baseHeads: s2.heads, changes: [ { bytes: c1 } ] } ] });
  assertEquals(r3.results[0]?.status, "rejected");
});
