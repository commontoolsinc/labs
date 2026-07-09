/**
 * Benchmarks Cell.set()/get() for a FLAT LIST of many similar shallow items —
 * the "search index / autocomplete list" shape.
 *
 * Why: a production capture of a Mobile Loom boot (loom repo,
 * docs/development/projects/mobile-loom-production-performance/findings.md,
 * 2026-07-10 HAR forensics) showed a ~3k-item derived jump-search list
 * weighing ~1.33MB per copy (~445B/item) and re-materialized once per
 * consuming pattern instance — 58% of a 25MB boot payload. Before assigning
 * blame between the runtime and that usage, this bench measures the
 * runtime's NATIVE dynamics for the shape in isolation:
 *
 *   1. write cost + stored bytes + docs created for one flat array in ONE
 *      doc vs one doc PER ITEM, as f(N)
 *   2. read cost: first get(), repeated get() (does anything memoize?), and
 *      get() through a JSON schema (the validateAndTransform path), as f(N)
 *   3. update cost: whole-array re-set with one item changed vs a targeted
 *      per-index write — bytes written per transaction (history growth)
 *
 * Interpretation guide: if stored bytes ≈ raw JSON and per-tx update bytes
 * ≈ one item, the runtime is efficient for this shape and the production
 * bloat is usage (item shape redundancy + per-instance copies). Superlinear
 * read times or whole-doc rewrites on single-item updates would instead be
 * runtime terms.
 *
 * Environment controls:
 * - FLAT_INDEX_LIST_SIZES: comma-separated Ns, default "100,1000,3000"
 * - FLAT_INDEX_LIST_UPDATE_TXS: update transactions per bench, default 20
 * - FLAT_INDEX_LIST_REPORT: "1" (default) prints a one-line stored-bytes/doc
 *   accounting per bench+N to stderr (outside the timed window); "0" silences
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import {
  type Cell,
  type Frame,
  type JSONSchema,
} from "../src/builder/types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("bench flat index list");
const space = signer.did();
const { commonfabric: { Writable } } = createBuilder();

const SIZES = (Deno.env.get("FLAT_INDEX_LIST_SIZES") ?? "100,1000,3000")
  .split(",")
  .map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`FLAT_INDEX_LIST_SIZES entries must be integers >= 1`);
    }
    return n;
  });
const UPDATE_TXS = Number(Deno.env.get("FLAT_INDEX_LIST_UPDATE_TXS") ?? "20");
const REPORT = (Deno.env.get("FLAT_INDEX_LIST_REPORT") ?? "1") !== "0";

// Item shape modeled on the production jump-search entries: an EntityRef-ish
// `data` object plus duplicated presentation fields (~445B/item in the wild).
type IndexItem = {
  data: {
    group: string;
    id: string;
    kind: string;
    label: string;
    name: string;
    path: string;
  };
  group: string;
  label: string;
  searchAliases: string[];
  value: string;
};

function makeItem(i: number, mutation = ""): IndexItem {
  const name = `entry-${i}${mutation}`;
  const id = `FC:Folder ${i % 37}/Subfolder ${i % 11}/${name}.md`;
  return {
    data: {
      group: i % 3 === 0 ? "Folders" : i % 3 === 1 ? "Pages" : "Notes",
      id,
      kind: i % 3 === 0 ? "folder" : "page",
      label: name,
      name,
      path: `Folder ${i % 37}/Subfolder ${i % 11}/${name}.md`,
    },
    group: i % 3 === 0 ? "Folders" : i % 3 === 1 ? "Pages" : "Notes",
    label: name,
    searchAliases: [id],
    value: `${i % 3 === 0 ? "folder" : "page"}:${id}`,
  };
}

function makeList(n: number, mutation = ""): IndexItem[] {
  return Array.from({ length: n }, (_, i) => makeItem(i, mutation));
}

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        group: { type: "string" },
        id: { type: "string" },
        kind: { type: "string" },
        label: { type: "string" },
        name: { type: "string" },
        path: { type: "string" },
      },
    },
    group: { type: "string" },
    label: { type: "string" },
    searchAliases: { type: "array", items: { type: "string" } },
    value: { type: "string" },
  },
} as const satisfies JSONSchema;

const LIST_SCHEMA = {
  type: "array",
  items: ITEM_SCHEMA,
} as const satisfies JSONSchema;

function setup() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx?: IExtendedStorageTransaction,
) {
  if (tx && tx.status().status === "ready") tx.abort();
  await runtime.dispose();
  await storageManager.close();
}

// --- write accounting (outside timed windows) -------------------------------
// tx.journal.novelty(space) yields the attestations a commit wrote. Count
// distinct doc ids and JSON bytes so each bench can report stored size vs the
// raw-JSON floor. Printed once per bench name.
const reported = new Set<string>();
function accountNovelty(tx: IExtendedStorageTransaction): {
  docs: number;
  bytes: number;
} {
  const ids = new Set<string>();
  let bytes = 0;
  for (const att of tx.journal.novelty(space)) {
    ids.add(String((att.address as { id?: unknown }).id ?? "?"));
    if (att.value !== undefined) bytes += JSON.stringify(att.value).length;
  }
  return { docs: ids.size, bytes };
}
function reportOnce(name: string, detail: string) {
  if (!REPORT || reported.has(name)) return;
  reported.add(name);
  console.error(`[flat-index-list] ${name}: ${detail}`);
}

// =============================================================================
// 1. WRITE: one flat array in ONE doc, via a single Cell.set()
// =============================================================================
for (const N of SIZES) {
  const rawBytes = JSON.stringify(makeList(N)).length;
  Deno.bench({
    name: `flat list ONE doc - cell.set(${N} items) + commit`,
    group: `write-${N}`,
    baseline: true,
    async fn(b) {
      const { runtime, storageManager, tx } = setup();
      const cell = runtime.getCell<IndexItem[]>(
        space,
        `bench-flat-index-one-doc-${N}`,
        undefined,
        tx,
      );
      const list = makeList(N);
      try {
        b.start();
        cell.set(list);
        await tx.commit();
        b.end();
        const { docs, bytes } = accountNovelty(tx);
        reportOnce(
          `one-doc write N=${N}`,
          `docs=${docs} storedBytes=${bytes} rawJSON=${rawBytes} ` +
            `overhead=${(bytes / rawBytes).toFixed(2)}x ` +
            `perItem=${Math.round(bytes / N)}B`,
        );
      } finally {
        await cleanup(runtime, storageManager, tx);
      }
    },
  });

  // ===========================================================================
  // 2. WRITE: one doc PER ITEM (parent array holds cell links)
  // ===========================================================================
  Deno.bench({
    name: `flat list PER-ITEM docs - ${N} Writable.set + parent set + commit`,
    group: `write-${N}`,
    async fn(b) {
      const { runtime, storageManager, tx } = setup();
      const frame: Frame = pushFrame({
        cause: { type: "bench-flat-index-per-item", n: N },
        runtime,
        tx,
        space,
        inHandler: true,
      });
      const parent = runtime.getCell<Cell<IndexItem>[]>(
        space,
        `bench-flat-index-per-item-${N}`,
        undefined,
        tx,
      );
      try {
        b.start();
        const cells = makeList(N).map((item, i) =>
          Writable.for<IndexItem>(`bench-flat-index-item-${N}-${i}`)
            .set(item) as unknown as Cell<IndexItem>
        );
        parent.set(cells);
        await tx.commit();
        b.end();
        const { docs, bytes } = accountNovelty(tx);
        reportOnce(
          `per-item write N=${N}`,
          `docs=${docs} storedBytes=${bytes} rawJSON=${rawBytes} ` +
            `overhead=${(bytes / rawBytes).toFixed(2)}x ` +
            `perItem=${Math.round(bytes / N)}B`,
        );
      } finally {
        popFrame(frame);
        await cleanup(runtime, storageManager, tx);
      }
    },
  });
}

// =============================================================================
// 3. READ: first get(), repeated get() x100, and schema get() x100
// =============================================================================
for (const N of SIZES) {
  Deno.bench({
    name: `flat list read - FIRST get() after commit (${N} items)`,
    group: `read-${N}`,
    baseline: true,
    async fn(b) {
      const { runtime, storageManager, tx } = setup();
      const cell = runtime.getCell<IndexItem[]>(
        space,
        `bench-flat-index-read-first-${N}`,
        undefined,
        tx,
      );
      cell.set(makeList(N));
      await tx.commit();
      b.start();
      cell.get();
      b.end();
      await cleanup(runtime, storageManager, tx);
    },
  });

  Deno.bench({
    name: `flat list read - repeated get() x100, unchanged doc (${N} items)`,
    group: `read-${N}`,
    async fn(b) {
      const { runtime, storageManager, tx } = setup();
      const cell = runtime.getCell<IndexItem[]>(
        space,
        `bench-flat-index-read-repeat-${N}`,
        undefined,
        tx,
      );
      cell.set(makeList(N));
      await tx.commit();
      cell.get(); // warm
      b.start();
      for (let i = 0; i < 100; i++) cell.get();
      b.end();
      await cleanup(runtime, storageManager, tx);
    },
  });

  Deno.bench({
    name: `flat list read - schema get() x100, unchanged doc (${N} items)`,
    group: `read-${N}`,
    async fn(b) {
      const { runtime, storageManager, tx } = setup();
      const cell = runtime.getCell(
        space,
        `bench-flat-index-read-schema-${N}`,
        LIST_SCHEMA,
        tx,
      );
      cell.set(makeList(N));
      await tx.commit();
      cell.get(); // warm
      b.start();
      for (let i = 0; i < 100; i++) cell.get();
      b.end();
      await cleanup(runtime, storageManager, tx);
    },
  });
}

// =============================================================================
// 4. UPDATE: whole-array re-set with ONE item changed vs targeted per-index
//    write. novelty bytes per tx expose whether the runtime rewrites the
//    whole doc (history growth ∝ N) or just the delta (∝ 1).
// =============================================================================
for (const N of SIZES) {
  Deno.bench({
    name: `flat list update - whole cell.set, 1 item changed (${N} items)`,
    group: `update-${N}`,
    baseline: true,
    async fn(b) {
      const { runtime, storageManager, tx: setupTx } = setup();
      const cell0 = runtime.getCell<IndexItem[]>(
        space,
        `bench-flat-index-update-set-${N}`,
        undefined,
        setupTx,
      );
      cell0.set(makeList(N));
      await setupTx.commit();

      let totalBytes = 0;
      let totalDocs = 0;
      b.start();
      for (let t = 0; t < UPDATE_TXS; t++) {
        const tx = runtime.edit();
        const cell = runtime.getCell<IndexItem[]>(
          space,
          `bench-flat-index-update-set-${N}`,
          undefined,
          tx,
        );
        const list = makeList(N);
        list[t % N] = makeItem(t % N, `-mut${t}`);
        cell.set(list);
        await tx.commit();
        const { docs, bytes } = accountNovelty(tx);
        totalBytes += bytes;
        totalDocs += docs;
      }
      b.end();
      reportOnce(
        `update whole-set N=${N}`,
        `txs=${UPDATE_TXS} avgBytes/tx=${
          Math.round(totalBytes / UPDATE_TXS)
        } ` +
          `avgDocs/tx=${(totalDocs / UPDATE_TXS).toFixed(1)} ` +
          `(one raw item≈${JSON.stringify(makeItem(0)).length}B)`,
      );
      await cleanup(runtime, storageManager);
    },
  });

  Deno.bench({
    name: `flat list update - targeted key(i).set, 1 item changed (${N} items)`,
    group: `update-${N}`,
    async fn(b) {
      const { runtime, storageManager, tx: setupTx } = setup();
      const cell0 = runtime.getCell<IndexItem[]>(
        space,
        `bench-flat-index-update-key-${N}`,
        undefined,
        setupTx,
      );
      cell0.set(makeList(N));
      await setupTx.commit();

      let totalBytes = 0;
      let totalDocs = 0;
      b.start();
      for (let t = 0; t < UPDATE_TXS; t++) {
        const tx = runtime.edit();
        const cell = runtime.getCell<IndexItem[]>(
          space,
          `bench-flat-index-update-key-${N}`,
          undefined,
          tx,
        );
        cell.key(t % N).set(makeItem(t % N, `-mut${t}`));
        await tx.commit();
        const { docs, bytes } = accountNovelty(tx);
        totalBytes += bytes;
        totalDocs += docs;
      }
      b.end();
      reportOnce(
        `update targeted N=${N}`,
        `txs=${UPDATE_TXS} avgBytes/tx=${
          Math.round(totalBytes / UPDATE_TXS)
        } ` +
          `avgDocs/tx=${(totalDocs / UPDATE_TXS).toFixed(1)} ` +
          `(one raw item≈${JSON.stringify(makeItem(0)).length}B)`,
      );
      await cleanup(runtime, storageManager);
    },
  });
}
