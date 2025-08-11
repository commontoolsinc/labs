import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSqlite } from "../../src/store/db.ts";
import { openSpaceStorage } from "../../src/provider.ts";
import { SqliteStorageReader } from "../../src/query/sqlite_storage.ts";

Deno.test("json cache: tip uses cache; historical bypasses", async () => {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const did = "did:key:json-cache";
  const space = await openSpaceStorage(did, { spacesDir });

  const docId = "doc:J";
  const branch = "main";
  await space.getOrCreateBranch(docId, branch);

  // Apply two changes so seq=2
  let d = Automerge.init<any>();
  d = Automerge.change(d, (x: any) => (x.value = { a: 1 }));
  const c1 = Automerge.getLastLocalChange(d)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c1 }],
    }],
  });
  d = Automerge.change(d, (x: any) => (x.value.a = 2));
  const c2 = Automerge.getLastLocalChange(d)!;
  const s1 = await space.getBranchState(docId, branch);
  const r2 = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: s1.heads,
      changes: [{ bytes: c2 }],
    }],
  });
  const epoch2 = r2.txId;

  // Ensure a json_cache row exists
  const dbUrl = new URL(`./${did}.sqlite`, spacesDir);
  const { db, close } = await openSqlite({ url: dbUrl });
  try {
    const row = db.prepare(
      `SELECT json, seq_no FROM json_cache WHERE doc_id = :doc_id AND branch_id = (SELECT branch_id FROM branches WHERE doc_id = :doc_id AND name = :branch)`,
    ).get({ doc_id: docId, branch }) as
      | { json: string; seq_no: number }
      | undefined;
    assert(row && row.seq_no === 2);

    // Tamper: overwrite cached JSON to a bogus value but keep seq_no=2
    db.run(
      `UPDATE json_cache SET json = :json WHERE doc_id = :doc_id AND branch_id = (SELECT branch_id FROM branches WHERE doc_id = :doc_id AND name = :branch)`,
      { json: JSON.stringify({ value: { a: 999 } }), doc_id: docId, branch },
    );

    const reader = new SqliteStorageReader(db as any);

    // Tip read uses cache → returns bogus value
    const tip = reader.read(docId, ["value", "a"]);
    assertEquals(tip, 999);

    // Historical read (epoch before latest) bypasses cache → returns real value 1
    const hist = reader.read(docId, ["value", "a"], {
      epoch: epoch2 - 1,
      branch,
    });
    assertEquals(hist, 1);
  } finally {
    await close();
  }
});
