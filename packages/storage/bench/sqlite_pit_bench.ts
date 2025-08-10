// SQLite/PIT/Automerge heavy-path benchmarks
// Run with:
//   deno bench -A --no-prompt packages/storage/bench/sqlite_pit_bench.ts

import * as Automerge from "@automerge/automerge";
import type { Database } from "@db/sqlite";
import { openSpaceStorage } from "../src/provider.ts";
import { openSqlite } from "../src/store/db.ts";
import { getAutomergeBytesAtSeq, uptoSeqNo } from "../src/store/pit.ts";
import { getBranchState } from "../src/store/heads.ts";
import { SqliteStorageReader } from "../src/query/sqlite_storage.ts";

// Config (override via env)
const SEED = 123;
const PIT_DOC_ID = Deno.env.get("BENCH_PIT_DOC") ?? "pit:heavy";
const PIT_CHANGES = Number(Deno.env.get("BENCH_PIT_CHANGES") ?? 600);
const HOT_READS = Number(Deno.env.get("BENCH_PIT_HOT_READS") ?? 50);

// Setup
const tmpDir = await Deno.makeTempDir();
const spacesDir = new URL(`file://${tmpDir}/`);
const spaceDid = "did:key:bench-space-pit";
const space = await openSpaceStorage(spaceDid, { spacesDir });
const sqliteHandle = await openSqlite({
  url: new URL(`./${spaceDid}.sqlite`, spacesDir),
});
const db: Database = sqliteHandle.db;
const storage = new SqliteStorageReader(db);

function mulberry32(a: number) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

// Seed a heavy doc with many sequential changes
async function seedHeavyDoc() {
  const branch = "main";
  await space.getOrCreateBranch(PIT_DOC_ID, branch);
  let doc = Automerge.init<any>();
  for (let i = 0; i < PIT_CHANGES; i++) {
    doc = Automerge.change(doc, (d: any) => {
      // Grow both map and array shapes to produce non-trivial bytes
      if (d.meta === undefined) d.meta = { createdAt: Date.now() };
      if (d.journal === undefined) d.journal = [];
      d.journal.push({
        at: Date.now(),
        v: i,
        note: `n${i}`,
        r: Math.floor(rnd() * 1e6),
      });
      if (d.counters === undefined) d.counters = {} as any;
      const k = `k${i % 32}`;
      d.counters[k] = (d.counters[k] ?? 0) + 1;
    });
    const c = Automerge.getLastLocalChange(doc)!;
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId: PIT_DOC_ID, branch },
        baseHeads: [],
        changes: [{ bytes: c }],
      }],
    });
  }
}

await seedHeavyDoc();

// Resolve latest version and branchId
const latest = storage.currentVersion(PIT_DOC_ID);
const { branchId } = getBranchState(db, PIT_DOC_ID, latest.branch ?? "main");
const latestSeq = uptoSeqNo(db, PIT_DOC_ID as any, branchId, latest.epoch);
const latestBytes = getAutomergeBytesAtSeq(
  db,
  null,
  PIT_DOC_ID as any,
  branchId,
  latestSeq,
);

// Benchmarks
Deno.bench({
  name: "sqlite PIT: reconstruct bytes at latest",
  group: "sqlite-pit",
  n: 1,
}, () => {
  const bytes = getAutomergeBytesAtSeq(
    db,
    null,
    PIT_DOC_ID as any,
    branchId,
    latestSeq,
  );
  if (bytes.length === 0) throw new Error("empty PIT bytes");
});

Deno.bench({
  name: "automerge: load bytes at latest → doc",
  group: "sqlite-pit",
  n: 1,
}, () => {
  const doc = Automerge.load(latestBytes);
  // simple check to ensure decode happened
  if (!doc) throw new Error("failed to load");
});

Deno.bench({
  name: "sqlite storage: readDocAtVersion (cold)",
  group: "sqlite-pit",
  n: 1,
}, () => {
  const cold = new SqliteStorageReader(db);
  const r = cold.readDocAtVersion(PIT_DOC_ID as any, latest);
  if (!r.doc) throw new Error("no doc");
});

Deno.bench({
  name: "sqlite storage: readDocAtVersion (hot, repeated)",
  group: "sqlite-pit",
  n: 1,
}, () => {
  for (let i = 0; i < HOT_READS; i++) {
    const r = storage.readDocAtVersion(PIT_DOC_ID as any, latest);
    if (!r.doc) throw new Error("no doc");
  }
});

Deno.bench({
  name: "sqlite PIT: reconstruct bytes at random mid-range",
  group: "sqlite-pit",
  n: 1,
}, () => {
  const mid = Math.max(1, Math.floor(latestSeq * 0.6));
  const bytes = getAutomergeBytesAtSeq(
    db,
    null,
    PIT_DOC_ID as any,
    branchId,
    mid,
  );
  if (bytes.length === 0) throw new Error("empty PIT bytes (mid)");
});
