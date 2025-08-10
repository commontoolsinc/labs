import { assert, assertEquals } from "@std/assert";
import * as Automerge from "@automerge/automerge";
import { openSqlite } from "../../src/sqlite/db.ts";
import { createCas } from "../../src/sqlite/cas.ts";

Deno.test("sqlite cas: put/get/has for am_change, am_snapshot, blob; and index helpers", async () => {
  const tmpDir = await Deno.makeTempDir();
  const url = new URL(`file://${tmpDir}/space.sqlite`);
  const { db, close } = await openSqlite({ url });
  try {
    const cas = createCas(db);

    // am_change roundtrip
    const d0 = Automerge.change(Automerge.init(), (d: any) => {
      d.a = 1;
    });
    const ch0 = Automerge.getLastLocalChange(d0)!;
    const hdr0 = Automerge.decodeChange(ch0);
    const h0 = await cas.put("am_change", ch0);
    assertEquals(h0, hdr0.hash);
    assert(cas.has(h0));
    const got0 = cas.get(h0)!;
    assertEquals(got0.kind, "am_change");
    assertEquals(Automerge.decodeChange(got0.bytes).hash, hdr0.hash);

    // am_snapshot roundtrip
    const saved = Automerge.save(d0);
    const sDig = await cas.put("am_snapshot", saved, {
      docId: "doc:X",
      branchId: "main",
      seqNo: 1,
      txId: 1,
    });
    assert(cas.has(sDig));
    const gotS = cas.get(sDig)!;
    assertEquals(gotS.kind, "am_snapshot");
    assertEquals(gotS.meta?.docId, "doc:X");

    // blob roundtrip
    const blob = new TextEncoder().encode("hello world");
    const bDig = await cas.put("blob", blob, { note: "greeting" });
    assert(cas.has(bDig));
    const gotB = cas.get(bDig)!;
    assertEquals(gotB.kind, "blob");
    assertEquals(new TextDecoder().decode(gotB.bytes), "hello world");

    // index helpers: need am_change_index rows → create minimal doc/branch and index manually
    db.exec("BEGIN IMMEDIATE;");
    db.run(`INSERT OR IGNORE INTO docs(doc_id) VALUES('doc:Z')`);
    const branchId = crypto.randomUUID();
    db.run(
      `INSERT OR IGNORE INTO branches(branch_id, doc_id, name) VALUES(:bid, 'doc:Z', 'main')`,
      { bid: branchId },
    );
    db.run(
      `INSERT OR IGNORE INTO am_heads(branch_id, heads_json, seq_no, tx_id, root_hash, committed_at) VALUES(:bid, '[]', 0, 0, x'', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      { bid: branchId },
    );
    const d1 = Automerge.change(Automerge.init(), (d: any) => {
      d.a = 2;
    });
    const ch1 = Automerge.getLastLocalChange(d1)!;
    const h1 = Automerge.decodeChange(ch1).hash!;
    // store blob through CAS so it's present
    await cas.put("am_change", ch1);
    const bytes_hash = hexToBytes(h1);
    const txId = createStubTx(db);
    db.run(
      `INSERT OR REPLACE INTO am_change_index(doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
             VALUES('doc:Z', :branch_id, 1, :hash, :bytes_hash, '[]', 1, 'actor', :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      { branch_id: branchId, hash: h1, bytes_hash, tx_id: txId },
    );
    db.exec("COMMIT;");

    const bySeq = cas.findChangeBySeq("doc:Z", branchId, 1)!;
    assertEquals(bySeq.digest, h1);
    assertEquals(Automerge.decodeChange(bySeq.bytes).hash, h1);

    const byTx = cas.findByTxId("doc:Z", branchId, txId);
    assertEquals(byTx.length, 1);
    assertEquals(byTx[0]!.digest, h1);
  } finally {
    await close();
  }
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

function createStubTx(db: any): number {
  db.run(
    `INSERT INTO tx(prev_tx_hash, tx_body_hash, tx_hash, server_sig, server_pubkey, client_sig, client_pubkey, ucan_jwt)
     VALUES(:prev_tx_hash, :tx_body_hash, :tx_hash, :server_sig, :server_pubkey, :client_sig, :client_pubkey, :ucan_jwt)`,
    {
      prev_tx_hash: new Uint8Array(),
      tx_body_hash: randomBytes(32),
      tx_hash: randomBytes(32),
      server_sig: randomBytes(64),
      server_pubkey: randomBytes(32),
      client_sig: randomBytes(64),
      client_pubkey: randomBytes(32),
      ucan_jwt: "stub",
    },
  );
  const row = db.prepare(`SELECT tx_id FROM tx ORDER BY tx_id DESC LIMIT 1`)
    .get() as { tx_id: number };
  return row.tx_id;
}
