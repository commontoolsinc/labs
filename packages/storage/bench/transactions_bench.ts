// Transaction-focused benchmarks covering a wide range of tx patterns
//
// Run with Deno bench:
//   deno bench -A --no-prompt packages/storage/bench/transactions_bench.ts
//
// Standalone run modes (outside of Deno bench):
//   deno run -A packages/storage/bench/transactions_bench.ts
//   BENCH_TX_RUN=1 BENCH_TX_SCENARIO=all deno run -A packages/storage/bench/transactions_bench.ts
//   BENCH_TX_RUN=1 BENCH_TX_SCENARIO=single_doc_separate deno run -A packages/storage/bench/transactions_bench.ts
//
// Tunables (env):
// - BENCH_TX_SEED            (default: 1234)
// - BENCH_TX_DOCS            (default: 1000)
// - BENCH_TX_CHANGES         (default: 2000)
// - BENCH_TX_BATCH           (default: 50)
// - BENCH_TX_MULTI_DOCS      (default: 25)
// - BENCH_TX_CONCURRENCY     (default: 8)
// - BENCH_TX_VERIFY          (default: 0)
// - BENCH_TX_SCENARIO        (one of: all, genesis_many, single_doc_separate, single_doc_batch, multi_doc_multi_write, concurrent_small)
// - BENCH_TX_RUN             (if set to truthy, runs outside Deno bench)

import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";
import { createGenesisDoc } from "../src/store/genesis.ts";

// Helpers
function mulberry32(a: number) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(Deno.env.get("BENCH_TX_SEED") ?? 1234);
const rnd = mulberry32(SEED);

const DOCS = Number(Deno.env.get("BENCH_TX_DOCS") ?? 1000);
const CHANGES = Number(Deno.env.get("BENCH_TX_CHANGES") ?? 2000);
const BATCH = Number(Deno.env.get("BENCH_TX_BATCH") ?? 50);
const MULTI_DOCS = Number(Deno.env.get("BENCH_TX_MULTI_DOCS") ?? 25);
const CONCURRENCY = Number(Deno.env.get("BENCH_TX_CONCURRENCY") ?? 8);
const VERIFY = (() => {
  const v = (Deno.env.get("BENCH_TX_VERIFY") ?? "0").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();
// Optional: force-enable server merge globally for this run
(() => {
  const v = (Deno.env.get("BENCH_TX_ENABLE_SERVER_MERGE") ?? "").toLowerCase();
  const on = v === "1" || v === "true" || v === "yes" || v === "on";
  if (on) Deno.env.set("ENABLE_SERVER_MERGE", "1");
})();

type Space = Awaited<ReturnType<typeof openSpaceStorage>>;

async function createSpace(tag: string): Promise<Space> {
  const tmpDir = await Deno.makeTempDir();
  const spacesDir = new URL(`file://${tmpDir}/`);
  const spaceDid = `did:key:bench-tx-${tag}`;
  return await openSpaceStorage(spaceDid, { spacesDir });
}

function actorForDoc(docId: string): string {
  return `bench-actor:${docId}`;
}

function randomInt(n: number): number {
  return Math.floor(rnd() * n);
}

function changeCounter(doc: Automerge.Doc<any>): Automerge.ChangeFn<any> {
  return (d: any) => {
    if (typeof d.count !== "number") d.count = 0;
    d.count += 1;
  };
}

function changeArray(doc: Automerge.Doc<any>): Automerge.ChangeFn<any> {
  return (d: any) => {
    if (!Array.isArray(d.items)) d.items = [];
    d.items.push({ t: Date.now(), v: Math.floor(rnd() * 1_000_000) });
  };
}

function changeMap(doc: Automerge.Doc<any>): Automerge.ChangeFn<any> {
  return (d: any) => {
    if (typeof d.map !== "object" || d.map == null) d.map = {};
    const k = `k${Math.floor(rnd() * 1024)}`;
    d.map[k] = (d.map[k] ?? 0) + 1;
  };
}

function pickChangeFn(doc: Automerge.Doc<any>): Automerge.ChangeFn<any> {
  const r = rnd();
  if (r < 0.34) return changeCounter(doc);
  if (r < 0.67) return changeArray(doc);
  return changeMap(doc);
}

async function ensureDoc(space: Space, docId: string): Promise<void> {
  await space.getOrCreateBranch(docId, "main");
}

async function submitSingleChange(
  space: Space,
  docId: string,
  cur: Automerge.Doc<any>,
  changeFn: Automerge.ChangeFn<any>,
): Promise<{ ok: boolean; updated: Automerge.Doc<any> }> {
  const base = Automerge.clone(cur);
  const updated = Automerge.change(base, changeFn);
  const c = Automerge.getLastLocalChange(updated);
  if (!c) return { ok: false, updated: cur };
  const rec = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: "main" },
      baseHeads: Automerge.getHeads(base),
      changes: [{ bytes: c }],
      allowServerMerge: true,
    }],
  });
  const ok = rec.results.length > 0 && rec.results[0].status === "ok";
  if (!ok && VERIFY) {
    try {
      console.error(
        "submitSingleChange failed",
        JSON.stringify(rec.results[0] ?? rec, null, 2),
      );
    } catch {
      // ignore logging failures
    }
  }
  return { ok, updated: ok ? updated : cur };
}

async function submitBatchChanges(
  space: Space,
  docId: string,
  cur: Automerge.Doc<any>,
  count: number,
): Promise<{ ok: boolean; updated: Automerge.Doc<any>; produced: number }> {
  let rolling = Automerge.clone(cur);
  const baseHeads = Automerge.getHeads(rolling);
  const changes: { bytes: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    rolling = Automerge.change(rolling, pickChangeFn(rolling));
    const ch = Automerge.getLastLocalChange(rolling);
    if (ch) changes.push({ bytes: ch });
  }
  if (changes.length === 0) return { ok: false, updated: cur, produced: 0 };
  const rec = await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch: "main" },
      baseHeads,
      changes,
      allowServerMerge: true,
    }],
  });
  const ok = rec.results.length > 0 && rec.results[0].status === "ok";
  if (!ok && VERIFY) {
    try {
      console.error(
        "submitBatchChanges failed",
        JSON.stringify(rec.results[0] ?? rec, null, 2),
      );
    } catch {
      // ignore
    }
  }
  return { ok, updated: ok ? rolling : cur, produced: changes.length };
}

// Scenario 1: Many new documents, one small change each (genesis path)
async function scenarioGenesisManyDocs(): Promise<number> {
  const space = await createSpace("genesis-many");
  const docs = new Map<string, Automerge.Doc<any>>();
  let applied = 0;
  for (let i = 0; i < DOCS; i++) {
    const docId = `txdoc:${i}`;
    await ensureDoc(space, docId);
    const base = createGenesisDoc<any>(docId, actorForDoc(docId));
    let d = base;
    d = Automerge.change(d, (x: any) => {
      x.kind = "bench";
      x.docNo = i;
      x.count = 0;
    });
    const c = Automerge.getLastLocalChange(d);
    if (!c) continue;
    const rec = await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch: "main" },
        baseHeads: Automerge.getHeads(base),
        changes: [{ bytes: c }],
      }],
    });
    const ok = rec.results.length > 0 && rec.results[0].status === "ok";
    if (ok) {
      docs.set(docId, d);
      applied += 1;
    }
  }
  (space as any)?.close?.();
  if (VERIFY && applied !== DOCS) {
    throw new Error(`applied=${applied} != DOCS=${DOCS}`);
  }
  return applied;
}

// Scenario 2: One document, many transactions (1 change per tx)
async function scenarioSingleDocSeparateTx(): Promise<number> {
  const space = await createSpace("single-separate");
  const docId = `single:separate`;
  await ensureDoc(space, docId);
  let cur = createGenesisDoc<any>(docId, actorForDoc(docId));
  let applied = 0;
  for (let i = 0; i < CHANGES; i++) {
    const res = await submitSingleChange(space, docId, cur, pickChangeFn(cur));
    if (res.ok) {
      cur = res.updated;
      applied += 1;
    }
  }
  (space as any)?.close?.();
  if (VERIFY && applied !== CHANGES) {
    throw new Error(`applied=${applied} != CHANGES=${CHANGES}`);
  }
  return applied;
}

// Scenario 3: One document, batched changes in fewer transactions
async function scenarioSingleDocBatchTx(): Promise<number> {
  const space = await createSpace("single-batch");
  const docId = `single:batch`;
  await ensureDoc(space, docId);
  let cur = createGenesisDoc<any>(docId, actorForDoc(docId));
  let applied = 0;
  let remaining = CHANGES;
  while (remaining > 0) {
    const take = Math.min(BATCH, remaining);
    const res = await submitBatchChanges(space, docId, cur, take);
    if (res.ok) {
      cur = res.updated;
      applied += res.produced;
    }
    remaining -= take;
  }
  (space as any)?.close?.();
  if (VERIFY && applied !== CHANGES) {
    throw new Error(`applied=${applied} != CHANGES=${CHANGES}`);
  }
  return applied;
}

// Scenario 4: Multi-doc, multi-write in a single transaction
async function scenarioMultiDocMultiWriteTx(): Promise<number> {
  const space = await createSpace("multi-doc-multi-write");
  const docs: { id: string; cur: Automerge.Doc<any> }[] = [];
  for (let i = 0; i < MULTI_DOCS; i++) {
    const docId = `multi:${i}`;
    await ensureDoc(space, docId);
    const cur = createGenesisDoc<any>(docId, actorForDoc(docId));
    docs.push({ id: docId, cur });
  }
  const writes = docs.map(({ id, cur }) => {
    let rolling = cur;
    const baseHeads = Automerge.getHeads(rolling);
    const changes: { bytes: Uint8Array }[] = [];
    const local = 1 + randomInt(Math.max(1, BATCH));
    for (let k = 0; k < local; k++) {
      rolling = Automerge.change(rolling, pickChangeFn(rolling));
      const ch = Automerge.getLastLocalChange(rolling);
      if (ch) changes.push({ bytes: ch });
    }
    return {
      ref: { docId: id, branch: "main" },
      baseHeads,
      changes,
      allowServerMerge: true,
    } as const;
  });
  const rec = await space.submitTx({ reads: [], writes: writes as any });
  const ok = rec.results.every((r) => r.status === "ok");
  (space as any)?.close?.();
  if (VERIFY && !ok) throw new Error("multi-doc multi-write tx failed");
  // Count changes applied
  const applied = writes.reduce((n, w) => n + w.changes.length, 0);
  return applied;
}

// Scenario 5: Many small transactions across different docs concurrently
async function scenarioConcurrentSmallTxs(): Promise<number> {
  const space = await createSpace("concurrent-small");
  const total = CHANGES;
  let applied = 0;
  const docs: string[] = [];
  for (let i = 0; i < Math.max(CONCURRENCY, 1) * 2; i++) {
    const docId = `concurrent:${i}`;
    await ensureDoc(space, docId);
    docs.push(docId);
  }
  // Keep a map of current states per doc
  const curByDoc = new Map<string, Automerge.Doc<any>>(
    docs.map((id) => [id, createGenesisDoc<any>(id, actorForDoc(id))]),
  );
  let remaining = total;
  while (remaining > 0) {
    const inFlight = Math.min(CONCURRENCY, remaining);
    // Select unique docs for this batch to avoid parallel writes to same doc
    const chosen = new Set<string>();
    while (chosen.size < inFlight) {
      chosen.add(docs[randomInt(docs.length)]);
    }
    const promises: Promise<void>[] = [];
    for (const docId of chosen) {
      const cur = curByDoc.get(docId)!;
      promises.push((async () => {
        const res = await submitSingleChange(
          space,
          docId,
          cur,
          pickChangeFn(cur),
        );
        if (res.ok) {
          curByDoc.set(docId, res.updated);
          applied += 1;
        } else if (VERIFY) {
          // surface failure early in verify mode
          throw new Error(`concurrent batch tx failed for ${docId}`);
        }
      })());
    }
    await Promise.all(promises);
    remaining -= inFlight;
  }
  (space as any)?.close?.();
  if (VERIFY && applied !== total) {
    throw new Error(`applied=${applied} != total=${total}`);
  }
  return applied;
}

// Scenario 6: Random docs, sequential small txs (no concurrency)
async function scenarioRandomDocsSeparateTx(
  changeCount: number,
): Promise<number> {
  const space = await createSpace("random-docs-separate");
  const docPool = DOCS;
  const docIds: string[] = [];
  for (let i = 0; i < docPool; i++) {
    const docId = `rand:${i}`;
    await ensureDoc(space, docId);
    docIds.push(docId);
  }
  const curByDoc = new Map<string, Automerge.Doc<any>>(
    docIds.map((id) => [
      id,
      createGenesisDoc<any>(id, actorForDoc(id)),
    ]),
  );
  let applied = 0;
  for (let t = 0; t < changeCount; t++) {
    const docId = docIds[randomInt(docIds.length)];
    const cur = curByDoc.get(docId)!;
    const res = await submitSingleChange(space, docId, cur, pickChangeFn(cur));
    if (res.ok) {
      curByDoc.set(docId, res.updated);
      applied += 1;
    } else if (VERIFY) {
      throw new Error(`tx failed for ${docId} at t=${t}`);
    }
  }
  (space as any)?.close?.();
  if (VERIFY && applied !== changeCount) {
    throw new Error(`applied=${applied} != changes=${changeCount}`);
  }
  return applied;
}

// Register Deno.bench variants
function registerBenches() {
  Deno.bench(
    { name: `tx: genesis many docs (${DOCS})`, group: "tx", n: 1 },
    async () => {
      await scenarioGenesisManyDocs();
    },
  );
  Deno.bench({
    name: `tx: single doc, many small txs (${CHANGES})`,
    group: "tx",
    n: 1,
  }, async () => {
    await scenarioSingleDocSeparateTx();
  });
  Deno.bench({
    name: `tx: single doc, batched changes (total ${CHANGES}, batch ${BATCH})`,
    group: "tx",
    n: 1,
  }, async () => {
    await scenarioSingleDocBatchTx();
  });
  Deno.bench({
    name: `tx: multi-doc multi-write (docs ${MULTI_DOCS}, ~batch <= ${BATCH})`,
    group: "tx",
    n: 1,
  }, async () => {
    await scenarioMultiDocMultiWriteTx();
  });
  Deno.bench({
    name: `tx: concurrent small txs (changes ${CHANGES}, conc ${CONCURRENCY})`,
    group: "tx",
    n: 1,
  }, async () => {
    await scenarioConcurrentSmallTxs();
  });
  Deno.bench({
    name: `tx: random docs separate (docs ${DOCS}, changes ${CHANGES})`,
    group: "tx",
    n: 1,
  }, async () => {
    await scenarioRandomDocsSeparateTx(CHANGES);
  });
}

// Standalone run mode
async function runStandalone() {
  const scenario = (Deno.env.get("BENCH_TX_SCENARIO") ?? Deno.args[0] ?? "all")
    .toLowerCase();
  const cases: Record<string, () => Promise<number>> = {
    genesis_many: scenarioGenesisManyDocs,
    single_doc_separate: scenarioSingleDocSeparateTx,
    single_doc_batch: scenarioSingleDocBatchTx,
    multi_doc_multi_write: scenarioMultiDocMultiWriteTx,
    concurrent_small: scenarioConcurrentSmallTxs,
    random_docs_separate: () => scenarioRandomDocsSeparateTx(CHANGES),
  };

  async function runOne(name: string, fn: () => Promise<number>) {
    const t0 = performance.now();
    const count = await fn();
    const t1 = performance.now();
    const ms = t1 - t0;
    const opsPerSec = (count / (ms / 1000)).toFixed(2);
    console.log(
      `${name}: count=${count} timeMs=${ms.toFixed(1)} ops/s=${opsPerSec}`,
    );
  }

  if (scenario === "all") {
    await runOne("genesis_many", scenarioGenesisManyDocs);
    await runOne("single_doc_separate", scenarioSingleDocSeparateTx);
    await runOne("single_doc_batch", scenarioSingleDocBatchTx);
    await runOne("multi_doc_multi_write", scenarioMultiDocMultiWriteTx);
    await runOne("concurrent_small", scenarioConcurrentSmallTxs);
    await runOne(
      "random_docs_separate",
      () => scenarioRandomDocsSeparateTx(CHANGES),
    );
  } else if (scenario in cases) {
    // Sweep support: BENCH_TX_SWEEP as comma-separated change counts
    const sweep = Deno.env.get("BENCH_TX_SWEEP");
    if (sweep && scenario === "random_docs_separate") {
      const values = sweep.split(",").map((s) => Number(s.trim())).filter((n) =>
        Number.isFinite(n) && n > 0
      );
      for (const v of values) {
        await runOne(
          `${scenario}[changes=${v}]`,
          () => scenarioRandomDocsSeparateTx(v),
        );
      }
    } else {
      await runOne(scenario, cases[scenario]);
    }
  } else {
    console.error(
      `Unknown BENCH_TX_SCENARIO='${scenario}'. Expected one of: all, ${
        Object.keys(cases).join(", ")
      }`,
    );
    Deno.exit(2);
  }
}

// Determine mode
const runStandaloneMode = (() => {
  const v = (Deno.env.get("BENCH_TX_RUN") ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();

if (runStandaloneMode) {
  await runStandalone();
} else {
  registerBenches();
}
