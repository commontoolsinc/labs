import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";

Deno.test("getDocBytes json reconstructs from index", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const docId = "doc:test";
  const branch = "main";

  // two linear changes
  let d = Automerge.init();
  d = Automerge.change(d, (doc: any) => { doc.value = { n: 1 }; });
  const c1 = Automerge.getLastLocalChange(d)!;
  await space.submitTx({ reads: [], writes: [ { ref: { docId, branch }, baseHeads: [], changes: [ { bytes: c1 } ] } ] });

  d = Automerge.change(d, (doc: any) => { doc.value.n = 2; });
  const c2 = Automerge.getLastLocalChange(d)!;
  const s1 = await space.getBranchState(docId, branch);
  await space.submitTx({ reads: [], writes: [ { ref: { docId, branch }, baseHeads: s1.heads, changes: [ { bytes: c2 } ] } ] });

  const bytes = await space.getDocBytes(docId, branch, { accept: "json" });
  const json = JSON.parse(new TextDecoder().decode(bytes));
  assertEquals(json.value.n, 2);
});
