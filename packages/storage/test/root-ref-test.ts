import { assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";
import { Database } from "@db/sqlite";
import {
  refer as referJson,
  toDigest as refToDigest,
} from "merkle-reference/json";

Deno.test("am_heads.root_hash matches referJSON over sorted heads", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const space = await openSpaceStorage("did:key:testspace", { spacesDir });

  const dbUrl = new URL(`./did:key:testspace.sqlite`, spacesDir);
  const db = new Database(dbUrl);

  const docId = "doc:test";
  const branch = "main";

  let d = Automerge.init();
  d = Automerge.change(d, (doc: any) => {
    doc.value = { n: 1 };
  });
  const c1 = Automerge.getLastLocalChange(d)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });

  d = Automerge.change(d, (doc: any) => {
    doc.value.n = 2;
  });
  const c2 = Automerge.getLastLocalChange(d)!;
  const s1 = await space.getBranchState(docId, branch);
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c2 }],
    }],
  });

  const state = await space.getBranchState(docId, branch);
  const expected = referJson({ heads: [...state.heads].sort() });
  const row = db.prepare(
    `SELECT root_hash FROM am_heads h JOIN branches b ON (h.branch_id=b.branch_id) WHERE b.doc_id = :doc_id AND b.name = :name`,
  ).get({ doc_id: docId, name: branch }) as { root_hash: Uint8Array };
  const gotHex = [...row.root_hash].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expDigest = new Uint8Array(refToDigest(expected));
  const expHex = [...expDigest].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(gotHex, expHex);

  db.close();
});
