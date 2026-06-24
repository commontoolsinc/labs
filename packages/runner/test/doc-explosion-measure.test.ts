/**
 * App-agnostic measurement harness for the "document explosion / scheduler
 * overhead" baseline. NOT a regression guard — it prints a report so an
 * architect can read real numbers before a redesign.
 *
 * Measures, in-process (emulated storage, no browser), for a pattern
 * instantiated with realistic data:
 *
 *   1. Distinct top-level documents created in the space, broken down by kind
 *      (scaffold result/argument cells, derived-internal cells, and map
 *      per-element child docs).
 *   2. Scheduler node/action count (getGraphSnapshot()).
 *   3. Recompute volume on a representative edit (how many docs get re-written
 *      and how many nodes re-run when one input changes).
 *   4. Rehydrate/load cost proxy (timing of the initial run().commit()).
 *
 * PROBES
 * ------
 * - Distinct documents: subscribe() to the StorageManager. Every local commit
 *   broadcasts an ICommitNotification whose `changes` iterate IMemoryChange
 *   ({ address: { id }, before, after }). A change with before === undefined at
 *   the root path is a brand-new document. We collect the set of distinct ids.
 * - Per-tx written docs: tx.getReactivityLog().writes distinct id.
 * - Scheduler graph: runtime.scheduler.getGraphSnapshot() -> nodes/edges.
 *
 * Run with:
 *   deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     --no-check test/doc-explosion-measure.test.ts
 *
 * (no asserts that fail by default; set MEASURE_STRICT=1 to assert the law)
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import type {
  ICommitNotification,
  StorageNotification,
} from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";

setGlobalLogFloor("error");

const signer = await Identity.fromPassphrase("doc explosion measurement");
const space = signer.did();

// ---------------------------------------------------------------------------
// Doc-counting probe: a StorageManager subscriber that records every distinct
// document id touched, and whether it was newly created (before === undefined
// at the root path) vs updated.
// ---------------------------------------------------------------------------

interface DocRecorder {
  /** Every distinct document id that has ever been touched. */
  allIds: Set<string>;
  /** Ids first observed with before===undefined (root creation). */
  createdIds: Set<string>;
  /** First-seen root `after` value per created id, for shape classification. */
  firstValueOf: Map<string, unknown>;
  /** Reset markers used to measure a delta window. */
  mark(): DocMark;
}

/**
 * Classify a created document by the shape of its first stored root value.
 * These buckets are heuristic but stable for the map/pattern machinery:
 *  - "result"   : the pattern/map result cell (holds the computed value)
 *  - "argument" : an argument/run-input cell (object of inputs, often links)
 *  - "process"  : a run-meta / process doc (has spell/argument/internal keys)
 *  - "scalar"   : a leaf value cell (number/string/bool)
 *  - "link"     : a cell whose value is a single link/alias
 *  - "object"   : some other structured doc
 */
function classifyDoc(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (typeof value !== "object") return "scalar";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  // Sigil link object: { "/": ... } or { $alias / cell }.
  if (keys.length === 1 && (keys[0] === "/" || keys[0].startsWith("$"))) {
    return "link";
  }
  if (
    "argument" in obj || "spell" in obj || "internal" in obj ||
    "resultRef" in obj
  ) {
    return "process";
  }
  return "object";
}

interface DocMark {
  /** Ids created since this mark. */
  createdSince(): string[];
  /** Ids written (created or updated) since this mark. */
  writtenSince(): string[];
}

function attachDocRecorder(storageManager: {
  subscribe(s: { next(n: StorageNotification): undefined }): void;
}): DocRecorder {
  const allIds = new Set<string>();
  const createdIds = new Set<string>();
  const firstValueOf = new Map<string, unknown>();
  // Ordered log of (id, created?) events for delta windows.
  const events: Array<{ id: string; created: boolean }> = [];

  const isRootCreation = (before: unknown, path: readonly unknown[]) =>
    before === undefined && path.length === 0;

  storageManager.subscribe({
    next(notification: StorageNotification) {
      if (notification.type !== "commit") return undefined;
      const commit = notification as ICommitNotification;
      for (const change of commit.changes) {
        const id = change.address.id as string;
        const path = (change.address as { path?: readonly unknown[] }).path ??
          [];
        const created = isRootCreation(change.before, path);
        if (!allIds.has(id)) {
          allIds.add(id);
          if (created) {
            createdIds.add(id);
            firstValueOf.set(id, change.after);
          }
        }
        events.push({ id, created });
      }
      return undefined;
    },
  });

  return {
    allIds,
    createdIds,
    firstValueOf,
    mark(): DocMark {
      const startLen = events.length;
      return {
        createdSince() {
          const seen = new Set<string>();
          const out: string[] = [];
          for (let i = startLen; i < events.length; i++) {
            const e = events[i];
            if (e.created && !seen.has(e.id)) {
              seen.add(e.id);
              out.push(e.id);
            }
          }
          return out;
        },
        writtenSince() {
          const seen = new Set<string>();
          const out: string[] = [];
          for (let i = startLen; i < events.length; i++) {
            const e = events[i];
            if (!seen.has(e.id)) {
              seen.add(e.id);
              out.push(e.id);
            }
          }
          return out;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduler graph probe.
// ---------------------------------------------------------------------------

interface NodeBreakdown {
  total: number;
  effects: number;
  computations: number;
  inputs: number;
  inactive: number;
  edges: number;
}

/** Sum of runCount across all scheduler nodes (total node executions so far). */
function totalRunCount(runtime: Runtime): number {
  const snap = runtime.scheduler.getGraphSnapshot();
  let total = 0;
  for (const n of snap.nodes) total += n.stats?.runCount ?? 0;
  return total;
}

function nodeBreakdown(runtime: Runtime): NodeBreakdown {
  const snap = runtime.scheduler.getGraphSnapshot();
  const by = (t: string) => snap.nodes.filter((n) => n.type === t).length;
  return {
    total: snap.nodes.length,
    effects: by("effect"),
    computations: by("computation"),
    inputs: by("input"),
    inactive: by("inactive"),
    edges: snap.edges.length,
  };
}

// ---------------------------------------------------------------------------
// Env scaffolding (mirrors push-pull-patterns.bench.ts).
// ---------------------------------------------------------------------------

interface MeasureEnv {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
  docs: DocRecorder;
  lift: ReturnType<typeof createTrustedBuilder>["commonfabric"]["lift"];
  pattern: ReturnType<typeof createTrustedBuilder>["commonfabric"]["pattern"];
}

function createEnv(): MeasureEnv {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const docs = attachDocRecorder(storageManager);
  const { commonfabric } = createTrustedBuilder(runtime);
  return {
    runtime,
    storageManager,
    docs,
    lift: commonfabric.lift,
    pattern: commonfabric.pattern,
  };
}

async function disposeEnv(env: MeasureEnv) {
  await env.runtime.dispose();
  await env.storageManager.close();
}

// ---------------------------------------------------------------------------
// Schemas.
// ---------------------------------------------------------------------------

const numberSchema = { type: "number" } as const satisfies JSONSchema;
const numberArraySchema = {
  type: "array",
  items: numberSchema,
} as const satisfies JSONSchema;

const elementArgumentSchema = {
  type: "object",
  properties: { element: numberSchema },
  required: ["element"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const listInputSchema = {
  type: "object",
  properties: { values: numberArraySchema },
  required: ["values"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const mappedResultSchema = {
  type: "object",
  properties: { mapped: numberArraySchema },
  required: ["mapped"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const scalarInputSchema = {
  type: "object",
  properties: { value: numberSchema },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const doubledResultSchema = {
  type: "object",
  properties: { doubled: numberSchema },
  required: ["doubled"],
  additionalProperties: false,
} as const satisfies JSONSchema;

// ---------------------------------------------------------------------------
// Report formatting.
// ---------------------------------------------------------------------------

function kindBreakdown(
  docs: DocRecorder,
  ids: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const kind = classifyDoc(docs.firstValueOf.get(id));
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

function report(title: string, lines: Array<[string, unknown]>) {
  console.log(`\n===== ${title} =====`);
  for (const [k, v] of lines) {
    console.log(`  ${k.padEnd(34)} ${v}`);
  }
}

// ===========================================================================
// (a) TRIVIAL pattern: single computed over one scalar input, no list.
// ===========================================================================

Deno.test("measure: trivial pattern (single computed, no list)", async () => {
  const env = createEnv();
  const { runtime } = env;
  const double = env.lift((x: number) => x * 2, numberSchema, numberSchema);

  const p = env.pattern<{ value: number }, unknown>(
    ({ value }) => ({ doubled: double(value) }),
    scalarInputSchema,
    doubledResultSchema,
  );

  // ---- initial instantiation (load cost proxy) ----
  const loadMark = env.docs.mark();
  const t0 = performance.now();
  const tx = runtime.edit();
  const inputCell = runtime.getCell<number>(
    space,
    "trivial:input",
    numberSchema,
    tx,
  );
  inputCell.set(21);
  const resultCell = runtime.getCell<{ doubled: number }>(
    space,
    "trivial:result",
    doubledResultSchema,
    tx,
  );
  const result = runtime.run(tx, p, { value: inputCell }, resultCell);
  await tx.commit();
  await runtime.idle();
  // Live subscription, like a UI rendering the result.
  const cancel = result.sink(() => {});
  await runtime.idle();
  const loadMs = performance.now() - t0;

  const createdAtLoad = loadMark.createdSince();
  const nodes = nodeBreakdown(runtime);

  report("TRIVIAL — instantiation", [
    ["distinct docs created", createdAtLoad.length],
    ["  by kind", JSON.stringify(kindBreakdown(env.docs, createdAtLoad))],
    ["scheduler nodes total", nodes.total],
    ["  effects", nodes.effects],
    ["  computations", nodes.computations],
    ["  inputs", nodes.inputs],
    ["scheduler edges", nodes.edges],
    ["load proxy (ms)", loadMs.toFixed(2)],
    ["result.doubled", result.key("doubled").get()],
  ]);

  // ---- recompute on edit: change the one input ----
  const editMark = env.docs.mark();
  const runsBefore = totalRunCount(runtime);
  const editTx = runtime.edit();
  inputCell.withTx(editTx).set(100);
  await editTx.commit();
  await runtime.idle();
  const nodeReruns = totalRunCount(runtime) - runsBefore;

  report("TRIVIAL — edit one input", [
    ["nodes re-run", nodeReruns],
    ["docs re-written", editMark.writtenSince().length],
    ["  ids", editMark.writtenSince().join("\n" + " ".repeat(38))],
    ["result.doubled (after)", result.key("doubled").get()],
  ]);

  cancel();
  await disposeEnv(env);
});

// ===========================================================================
// (b) MAP-HEAVY pattern: map(doublePattern) over an N-element list, N=5,50.
// ===========================================================================

async function measureMap(N: number) {
  const env = createEnv();
  const { runtime } = env;
  const prefix = `map${N}`;

  const double = env.lift((x: number) => x * 2, numberSchema, numberSchema);
  const elementPattern = env.pattern<{ element: number }, unknown>(
    // deno-lint-ignore no-explicit-any
    ({ element }) => double(element as any),
    elementArgumentSchema,
    numberSchema,
  );
  const mapPattern = env.pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      mapped: (values as any).mapWithPattern(elementPattern as any, {}),
    }),
    listInputSchema,
    mappedResultSchema,
  );

  // Seed the list as N separate linked item docs (a realistic "list of item
  // documents", and the shape that resolves cleanly in-process — see
  // push-pull-patterns.bench.ts). These N input docs are created BEFORE the
  // measurement window so they are counted as inputs, not scaffold.
  const seedTx = runtime.edit();
  const itemCells: Cell<number>[] = [];
  for (let i = 0; i < N; i++) {
    const c = runtime.getCell<number>(
      space,
      `${prefix}:item:${i}`,
      numberSchema,
      seedTx,
    );
    c.set(i + 1);
    itemCells.push(c);
  }
  await seedTx.commit();
  await runtime.idle();

  // ---- initial instantiation (measurement window opens here) ----
  const loadMark = env.docs.mark();
  const t0 = performance.now();
  const tx = runtime.edit();
  const valuesCell = runtime.getCell<number[]>(
    space,
    `${prefix}:values`,
    numberArraySchema,
    tx,
  );
  // The list document holds links to the N item docs.
  valuesCell.set(itemCells as unknown as number[]);
  const resultCell = runtime.getCell<{ mapped: number[] }>(
    space,
    `${prefix}:result`,
    mappedResultSchema,
    tx,
  );
  const result = runtime.run(
    tx,
    mapPattern,
    { values: valuesCell },
    resultCell,
  );
  await tx.commit();
  await runtime.idle();
  const mappedCell = result.key("mapped") as Cell<number[]>;
  const cancel = mappedCell.sink(() => {});
  await runtime.idle();
  const loadMs = performance.now() - t0;
  // pull() demands + resolves the mapped array, like the push-pull bench.
  const mappedValue = await mappedCell.pull() as unknown as number[];
  await runtime.idle();

  const createdAtLoad = loadMark.createdSince();
  const nodes = nodeBreakdown(runtime);
  const kinds = kindBreakdown(env.docs, createdAtLoad);

  report(`MAP N=${N} — instantiation`, [
    ["distinct docs created", createdAtLoad.length],
    ["  by kind", JSON.stringify(kinds)],
    ["scheduler nodes total", nodes.total],
    ["  effects", nodes.effects],
    ["  computations", nodes.computations],
    ["  inputs", nodes.inputs],
    ["scheduler edges", nodes.edges],
    ["load proxy (ms)", loadMs.toFixed(2)],
    ["seeded input docs (pre-window)", N],
    ["mapped result (first 5)", JSON.stringify(mappedValue?.slice?.(0, 5))],
  ]);

  if (N <= 5) {
    console.log(`  --- per-doc dump (N=${N}) ---`);
    for (const id of createdAtLoad) {
      const v = env.docs.firstValueOf.get(id);
      let preview = JSON.stringify(v);
      if (preview && preview.length > 90) preview = preview.slice(0, 90) + "…";
      console.log(
        `    [${classifyDoc(v).padEnd(8)}] ${id.slice(0, 30)}  ${preview}`,
      );
    }
  }

  // ---- recompute on edit: change ONE list element (mutate item[0] doc) ----
  const editMark = env.docs.mark();
  const editRunsBefore = totalRunCount(runtime);
  const editTx = runtime.edit();
  itemCells[0].withTx(editTx).set(1000);
  await editTx.commit();
  await runtime.idle();
  await mappedCell.pull();
  await runtime.idle();
  const editWritten = editMark.writtenSince();
  const editReruns = totalRunCount(runtime) - editRunsBefore;

  // ---- recompute on edit: APPEND one element (new item doc + push link) ----
  const appendMark = env.docs.mark();
  const appendRunsBefore = totalRunCount(runtime);
  const appendTx = runtime.edit();
  const newItem = runtime.getCell<number>(
    space,
    `${prefix}:item:appended`,
    numberSchema,
    appendTx,
  );
  newItem.set(9999);
  valuesCell.withTx(appendTx).push(newItem as unknown as number);
  await appendTx.commit();
  await runtime.idle();
  await mappedCell.pull();
  await runtime.idle();
  const appendCreated = appendMark.createdSince();
  const appendWritten = appendMark.writtenSince();
  const appendReruns = totalRunCount(runtime) - appendRunsBefore;

  report(`MAP N=${N} — edits`, [
    ["edit one element: nodes re-run", editReruns],
    ["edit one element: docs re-written", editWritten.length],
    ["append one element: nodes re-run", appendReruns],
    ["append one element: docs created", appendCreated.length],
    ["append one element: docs re-written", appendWritten.length],
  ]);

  cancel();
  await disposeEnv(env);

  return {
    N,
    docsCreated: createdAtLoad.length,
    nodesTotal: nodes.total,
    nodesEffects: nodes.effects,
    nodesComputations: nodes.computations,
    editRewritten: editWritten.length,
    appendCreated: appendCreated.length,
    appendRewritten: appendWritten.length,
    loadMs,
  };
}

Deno.test("measure: map-heavy pattern, scaling N=5 and N=50", async () => {
  const r5 = await measureMap(5);
  const r50 = await measureMap(50);

  const perElementDocs = (r50.docsCreated - r5.docsCreated) / (50 - 5);
  const perElementNodes = (r50.nodesTotal - r5.nodesTotal) / (50 - 5);
  const baseDocs = r5.docsCreated - perElementDocs * 5;
  const baseNodes = r5.nodesTotal - perElementNodes * 5;

  report("MAP scaling law (least-effort linear fit over N=5,50)", [
    ["docs created  N=5", r5.docsCreated],
    ["docs created  N=50", r50.docsCreated],
    ["  => per-element docs", perElementDocs.toFixed(3)],
    ["  => base (scaffold) docs", baseDocs.toFixed(3)],
    ["nodes total   N=5", r5.nodesTotal],
    ["nodes total   N=50", r50.nodesTotal],
    ["  => per-element nodes", perElementNodes.toFixed(3)],
    ["  => base (scaffold) nodes", baseNodes.toFixed(3)],
    [
      "edit-1-element rewrites N=5/50",
      `${r5.editRewritten} / ${r50.editRewritten}`,
    ],
    [
      "append docs created N=5/50",
      `${r5.appendCreated} / ${r50.appendCreated}`,
    ],
  ]);

  if (Deno.env.get("MEASURE_STRICT") === "1") {
    if (perElementDocs <= 0) throw new Error("expected docs to grow with N");
    if (perElementNodes <= 0) throw new Error("expected nodes to grow with N");
  }
});
