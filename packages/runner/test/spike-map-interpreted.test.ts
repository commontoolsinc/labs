/**
 * SPIKE (throwaway): validate the Reactive Interpreter design's central claim on
 * the dominant cost driver — collapse `map` over a leaf op from a per-element
 * child-pattern fan-out (~5 + 3N docs, ~8 + 4N nodes) into ONE coordinator node
 * that computes the leaf inline and holds results in one inline container.
 *
 * Measures, in the same in-process harness, LEGACY `map` (via mapWithPattern)
 * vs `mapInterpreted` (a test-only builtin) for the same pattern + data:
 *   - distinct documents created, scheduler nodes;
 *   - recompute on a 1-element edit (nodes re-run, docs re-written, write paths);
 *   - load proxy.
 *
 * This is NOT production code: the leaf is hardcoded (x*2), scope/CFC/link
 * handling is minimal, and the element op is a single leaf. The point is the
 * footprint + incremental-write numbers, and to confront the real runner/
 * scheduler/storage plumbing so coverage gaps surface.
 *
 * Run:
 *   cd packages/runner
 *   deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     test/spike-map-interpreted.test.ts
 *
 * MEASURED RESULT (this harness):
 *                docs     sched-nodes (computation)   load     edit(nodes/docs)
 *   legacy N=500 1505     2008 (501)                  948ms    4 / 2
 *   interp N=500    5      508 (1)                      87ms    3 / 2
 *   => docs slope 3.0/elem -> 0.0 ; computation nodes N -> 1 ; ~11x load.
 *   => edit stays O(1) at all N (3 nodes / 2 docs) — preserved, as required.
 *   => the interp container edit writes at pathLen 2 (a PATH-SCOPED array patch
 *      at the index), confirming the falsifier does not bite (no whole-container
 *      rewrite). The residual node slope (~1.0/elem) is the N genuine INPUT cells
 *      (the read-index), NOT scaffolding — exactly what the design predicts stays
 *      O(distinct external reads).
 *
 * WHAT THIS VALIDATES: the footprint + load win (decisively, measured), the
 * incremental path-scoped container patch, and basic feasibility against the
 * REAL runner/scheduler/storage (a builtin registration + byRef node — no
 * scheduler surgery needed for the leaf-map case).
 *
 * WHAT THIS DOES NOT VALIDATE (deliberately out of spike scope):
 *  - CFC per-element labels. This naive coordinator reads the whole list in ONE
 *    transaction, so under enforce-explicit it would SMEAR all element labels
 *    onto all outputs (deriveFlowJoin). Legacy map gets pointwise labels
 *    STRUCTURALLY via per-element transactions. Making the interpreter sound
 *    therefore requires the read-isolation mechanism (spec OQ-4) — which is an
 *    implementation effort, not a spike. CFC soundness reduces entirely to OQ-4.
 *  - filter/flatMap, control flow, nested patterns, scoped cells, the op passed
 *    in (here the leaf is hardcoded x*2), and externally-referenced element
 *    results (here results are inline values, so the materialization boundary /
 *    causal-id carry-through is not exercised).
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import type {
  ICommitNotification,
  IExtendedStorageTransaction,
  StorageNotification,
} from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { raw } from "../src/module.ts";
import type { Action } from "../src/scheduler.ts";
import type { AddCancel } from "../src/cancel.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { setResultCell } from "../src/result-utils.ts";
import { outputSpotFromBinding } from "../src/builtins/scope-policy.ts";

setGlobalLogFloor("error");

const signer = await Identity.fromPassphrase("spike map interpreted");
const space = signer.did();

// ---------------------------------------------------------------------------
// The mapInterpreted builtin (test-only): one coordinator node, leaf computed
// inline, results held inline in one container. Modeled on builtins/map.ts but
// WITHOUT the per-element `runtime.runner.run(opPattern, ...)` fan-out.
// ---------------------------------------------------------------------------

const MAP_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: { list: { type: "array", items: { type: "number" } } },
  required: ["list"],
});
const RESULT_SCHEMA = internSchema({
  type: "array",
  items: { type: "number" },
});

/** Build the raw builtin impl, closing over the leaf function. */
function makeMapInterpreted(leaf: (x: number) => number) {
  return function mapInterpreted(
    inputsCell: Cell<{ list: number[] }>,
    sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
    _addCancel: AddCancel,
    _cause: any,
    parentCell: Cell<any>,
    runtime: Runtime,
    outputBinding?: NormalizedFullLink,
  ): Action {
    let result: Cell<number[]> | undefined;
    // Per-element memo for incremental recompute: index -> { input, output }.
    const memo = new Map<number, { input: number; output: number }>();
    let leafApplications = 0; // instrumentation: how many leaf calls total

    return (tx: IExtendedStorageTransaction) => {
      if (!result) {
        const outputSpot = outputSpotFromBinding(outputBinding);
        if (!outputSpot) {
          throw new Error(
            "mapInterpreted: requires a write-redirect output binding",
          );
        }
        result = runtime.getCell<number[]>(
          parentCell.space,
          { mapInterpreted: parentCell.entityId, outputSpot },
          RESULT_SCHEMA,
          tx,
        );
        result.send([]);
        setResultCell(result, parentCell);
        sendResult(tx, result);
      }

      const mapped = inputsCell.asSchema(MAP_INPUT_SCHEMA).withTx(tx);
      const arr = mapped.key("list").get() as number[] | undefined;
      const resultWithTx = result.withTx(tx);
      if (arr === undefined) {
        resultWithTx.set([]);
        return;
      }

      // Interpret the leaf inline, reusing memoized element outputs whose input
      // is unchanged. No child pattern, no per-element documents/nodes.
      const newArray = arr.map((v, i) => {
        const prev = memo.get(i);
        if (prev && prev.input === v) return prev.output;
        leafApplications++;
        const out = leaf(v);
        memo.set(i, { input: v, output: out });
        return out;
      });
      // Trim memo entries past the current length.
      for (const k of [...memo.keys()]) if (k >= arr.length) memo.delete(k);

      // set() diffs against current → only changed indices produce a
      // path-scoped patch (validated falsifier: array edits patch one path).
      resultWithTx.set(newArray);
      (result as any).__leafApplications = leafApplications;
    };
  };
}

// ---------------------------------------------------------------------------
// Probes (compact; mirror doc-explosion-measure.test.ts).
// ---------------------------------------------------------------------------

interface DocRecorder {
  createdIds: Set<string>;
  mark(): { createdSince(): string[]; writtenSince(): Array<[string, number]> };
}

function attachDocRecorder(storageManager: {
  subscribe(s: { next(n: StorageNotification): undefined }): void;
}): DocRecorder {
  const createdIds = new Set<string>();
  const seenIds = new Set<string>();
  // event log: (id, created?, pathLen)
  const events: Array<{ id: string; created: boolean; pathLen: number }> = [];
  storageManager.subscribe({
    next(notification: StorageNotification) {
      if (notification.type !== "commit") return undefined;
      const commit = notification as ICommitNotification;
      for (const change of commit.changes) {
        const id = change.address.id as string;
        const path = (change.address as { path?: readonly unknown[] }).path ??
          [];
        const created = change.before === undefined && path.length === 0;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          if (created) createdIds.add(id);
        }
        events.push({ id, created, pathLen: path.length });
      }
      return undefined;
    },
  });
  return {
    createdIds,
    mark() {
      const start = events.length;
      return {
        createdSince() {
          const seen = new Set<string>();
          const out: string[] = [];
          for (let i = start; i < events.length; i++) {
            if (events[i].created && !seen.has(events[i].id)) {
              seen.add(events[i].id);
              out.push(events[i].id);
            }
          }
          return out;
        },
        // distinct (id, minPathLen) written since mark — pathLen shows whether
        // a write was whole-doc (0) or path-scoped (>0).
        writtenSince() {
          const minPath = new Map<string, number>();
          for (let i = start; i < events.length; i++) {
            const e = events[i];
            minPath.set(e.id, Math.min(minPath.get(e.id) ?? 99, e.pathLen));
          }
          return [...minPath.entries()];
        },
      };
    },
  };
}

function nodeCount(runtime: Runtime): { total: number; byType: string } {
  const snap = runtime.scheduler.getGraphSnapshot();
  const counts: Record<string, number> = {};
  for (const n of snap.nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  return { total: snap.nodes.length, byType: JSON.stringify(counts) };
}

function totalRunCount(runtime: Runtime): number {
  const snap = runtime.scheduler.getGraphSnapshot();
  let t = 0;
  for (const n of snap.nodes) t += n.stats?.runCount ?? 0;
  return t;
}

// ---------------------------------------------------------------------------
// Env.
// ---------------------------------------------------------------------------

function createEnv() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  // Register the test-only interpreter builtin alongside the real ones.
  runtime.moduleRegistry.addModuleByRef(
    "mapInterpreted",
    raw(makeMapInterpreted((x: number) => x * 2)),
  );
  const docs = attachDocRecorder(storageManager);
  const { commonfabric } = createTrustedBuilder(runtime);
  return { runtime, storageManager, docs, commonfabric };
}

const numberSchema = { type: "number" } as const satisfies JSONSchema;
const numberArraySchema = {
  type: "array",
  items: numberSchema,
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
const elementArgumentSchema = {
  type: "object",
  properties: { element: numberSchema },
  required: ["element"],
  additionalProperties: false,
} as const satisfies JSONSchema;

function report(title: string, lines: Array<[string, unknown]>) {
  console.log(`\n===== ${title} =====`);
  for (const [k, v] of lines) console.log(`  ${k.padEnd(36)} ${v}`);
}

// Seed N item docs, return their cells (created before the measurement window).
async function seedItems(
  runtime: Runtime,
  prefix: string,
  N: number,
): Promise<Cell<number>[]> {
  const tx = runtime.edit();
  const cells: Cell<number>[] = [];
  for (let i = 0; i < N; i++) {
    const c = runtime.getCell<number>(
      space,
      `${prefix}:item:${i}`,
      numberSchema,
      tx,
    );
    c.set(i + 1);
    cells.push(c);
  }
  await tx.commit();
  return cells;
}

// ---------------------------------------------------------------------------
// LEGACY map (via mapWithPattern) — the materialized baseline.
// ---------------------------------------------------------------------------

async function measureLegacy(N: number) {
  const env = createEnv();
  const { runtime, commonfabric, docs } = env;
  const prefix = `legacy${N}`;
  const lift = commonfabric.lift;
  const pattern = commonfabric.pattern;

  const double = lift((x: number) => x * 2, numberSchema, numberSchema);
  const elementPattern = pattern<{ element: number }, unknown>(
    // deno-lint-ignore no-explicit-any
    ({ element }) => double(element as any),
    elementArgumentSchema,
    numberSchema,
  );
  const mapPattern = pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      mapped: (values as any).mapWithPattern(elementPattern as any, {}),
    }),
    listInputSchema,
    mappedResultSchema,
  );

  const items = await seedItems(runtime, prefix, N);
  await runtime.idle();

  const mark = docs.mark();
  const t0 = performance.now();
  const tx = runtime.edit();
  const valuesCell = runtime.getCell<number[]>(
    space,
    `${prefix}:values`,
    numberArraySchema,
    tx,
  );
  valuesCell.set(items as unknown as number[]);
  const resultCell = runtime.getCell<{ mapped: number[] }>(
    space,
    `${prefix}:result`,
    mappedResultSchema,
    tx,
  );
  const res = runtime.run(tx, mapPattern, { values: valuesCell }, resultCell);
  await tx.commit();
  await runtime.idle();
  const mapped = res.key("mapped") as Cell<number[]>;
  const cancel = mapped.sink(() => {});
  await runtime.idle();
  await mapped.pull();
  await runtime.idle();
  const loadMs = performance.now() - t0;
  const created = mark.createdSince().length;
  const nodes = nodeCount(runtime);

  // edit one element
  const editMark = docs.mark();
  const before = totalRunCount(runtime);
  const etx = runtime.edit();
  items[0].withTx(etx).set(1000);
  await etx.commit();
  await runtime.idle();
  await mapped.pull();
  await runtime.idle();
  const reruns = totalRunCount(runtime) - before;
  const written = editMark.writtenSince();

  report(`LEGACY map  N=${N}`, [
    ["docs created", created],
    ["scheduler nodes", `${nodes.total}  ${nodes.byType}`],
    [
      "mapped (first 5)",
      JSON.stringify((await mapped.pull() as any)?.slice?.(0, 5)),
    ],
    ["load proxy (ms)", loadMs.toFixed(1)],
    ["edit-1: nodes re-run", reruns],
    ["edit-1: docs written (id->minPathLen)", written.length],
    ["edit-1: write path lens", JSON.stringify(written.map((w) => w[1]))],
  ]);
  cancel();
  await runtime.dispose();
  await env.storageManager.close();
  return { N, created, nodes: nodes.total, reruns, written: written.length };
}

// ---------------------------------------------------------------------------
// mapInterpreted — the spike.
// ---------------------------------------------------------------------------

async function measureInterpreted(N: number) {
  const env = createEnv();
  const { runtime, commonfabric, docs } = env;
  const prefix = `interp${N}`;
  const pattern = commonfabric.pattern;
  const mapInterpreted = commonfabric.byRef("mapInterpreted");

  const mapPattern = pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      mapped: (mapInterpreted as any)({ list: values }),
    }),
    listInputSchema,
    mappedResultSchema,
  );

  const items = await seedItems(runtime, prefix, N);
  await runtime.idle();

  const mark = docs.mark();
  const t0 = performance.now();
  const tx = runtime.edit();
  const valuesCell = runtime.getCell<number[]>(
    space,
    `${prefix}:values`,
    numberArraySchema,
    tx,
  );
  valuesCell.set(items as unknown as number[]);
  const resultCell = runtime.getCell<{ mapped: number[] }>(
    space,
    `${prefix}:result`,
    mappedResultSchema,
    tx,
  );
  const res = runtime.run(tx, mapPattern, { values: valuesCell }, resultCell);
  await tx.commit();
  await runtime.idle();
  const mapped = res.key("mapped") as Cell<number[]>;
  const cancel = mapped.sink(() => {});
  await runtime.idle();
  await mapped.pull();
  await runtime.idle();
  const loadMs = performance.now() - t0;
  const created = mark.createdSince().length;
  const nodes = nodeCount(runtime);

  // edit one element
  const editMark = docs.mark();
  const before = totalRunCount(runtime);
  const etx = runtime.edit();
  items[0].withTx(etx).set(1000);
  await etx.commit();
  await runtime.idle();
  await mapped.pull();
  await runtime.idle();
  const reruns = totalRunCount(runtime) - before;
  const written = editMark.writtenSince();

  report(`mapInterpreted  N=${N}`, [
    ["docs created", created],
    ["scheduler nodes", `${nodes.total}  ${nodes.byType}`],
    [
      "mapped (first 5)",
      JSON.stringify((await mapped.pull() as any)?.slice?.(0, 5)),
    ],
    ["load proxy (ms)", loadMs.toFixed(1)],
    ["edit-1: nodes re-run", reruns],
    ["edit-1: docs written (id->minPathLen)", written.length],
    [
      "edit-1: write path lens (>0 = path-scoped patch)",
      JSON.stringify(written.map((w) => w[1])),
    ],
  ]);
  cancel();
  await runtime.dispose();
  await env.storageManager.close();
  return { N, created, nodes: nodes.total, reruns, written: written.length };
}

Deno.test("SPIKE: mapInterpreted vs legacy map — footprint + incremental", async () => {
  const results: any[] = [];
  for (const N of [5, 50, 500]) {
    const legacy = await measureLegacy(N);
    const interp = await measureInterpreted(N);
    results.push({ N, legacy, interp });
  }

  console.log(
    "\n\n========== SUMMARY (docs / nodes / edit-nodes / edit-docs) ==========",
  );
  for (const r of results) {
    console.log(
      `  N=${
        String(r.N).padEnd(4)
      }  legacy: ${r.legacy.created}d ${r.legacy.nodes}n  edit ${r.legacy.reruns}n/${r.legacy.written}d` +
        `   |   interp: ${r.interp.created}d ${r.interp.nodes}n  edit ${r.interp.reruns}n/${r.interp.written}d`,
    );
  }
  // Fit slopes over N=5..500.
  const fit = (sel: (x: any) => number) => {
    const a = results.find((r) => r.N === 5)!;
    const b = results.find((r) => r.N === 500)!;
    return ((sel(b) - sel(a)) / (500 - 5)).toFixed(3);
  };
  console.log(
    "\n  per-element slope (docs):  legacy=" + fit((r) => r.legacy.created) +
      "  interp=" + fit((r) => r.interp.created),
  );
  console.log(
    "  per-element slope (nodes): legacy=" + fit((r) => r.legacy.nodes) +
      "  interp=" + fit((r) => r.interp.nodes),
  );
});
