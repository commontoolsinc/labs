import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";
import { Database } from "@db/sqlite";

Deno.test("accepted changes are indexed with seq_no", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const dbUrl = new URL(`./did:key:testspace.sqlite`, spacesDir);
  const db = new Database(dbUrl);

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

  // assert am_change_index has two rows with seq_no 1 and 2
  const rows = db.prepare(`SELECT seq_no FROM am_change_index WHERE doc_id = :doc_id ORDER BY seq_no`).all({ doc_id: docId }) as Array<{ seq_no: number }>;
  assertEquals(rows.map((r) => r.seq_no), [1, 2]);

  db.close();
});
