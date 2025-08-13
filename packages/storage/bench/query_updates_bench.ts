// Query engine update benchmarks simulating structural churn on a large VDOM-like graph
// Run with:
//   deno bench -A --no-prompt packages/storage/bench/query_updates_bench.ts

import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";
import { openSqlite } from "../src/store/db.ts";
import type { Database } from "@db/sqlite";
import { SqliteStorageReader } from "../src/query/sqlite_storage.ts";
import { compileSchema, IRPool } from "../src/query/ir.ts";
import { Evaluator, Provenance } from "../src/query/eval.ts";
import { SubscriptionIndex } from "../src/query/subs.ts";
import { ChangeProcessor } from "../src/query/change_processor.ts";
import { keyPath as keyPathLocal } from "../src/query/path.ts";
import type { Delta } from "../src/query/types.ts";
import { createGenesisDoc } from "../src/store/genesis.ts";

// Tunables (overridable via env)
const SEED = Number(Deno.env.get("BENCH_UPD_SEED") ?? 1234);
const NODES = Number(Deno.env.get("BENCH_UPD_NODES") ?? 500);
const MAX_CHILDREN = Number(Deno.env.get("BENCH_UPD_MAX_CHILDREN") ?? 12);
const CHANGES = Number(Deno.env.get("BENCH_UPD_CHANGES") ?? 200);

function mulberry32(a: number) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

// Link shape: LinkValue {"/":{"link@1":{id, path}}}
function link(doc: string, pathTokens: string[] = []): any {
  return { "/": { "link@1": { id: doc, path: pathTokens } } };
}

// Seed a space with VDOM docs: vdom:0..N-1
// Children heuristic: only link to higher indices (> i) to avoid cycles,
// making node 0 the head/root that can reach the whole VDOM.
async function seedVDOM(
  space: Awaited<ReturnType<typeof openSpaceStorage>>,
  nodes: number,
  maxChildren: number,
): Promise<
  {
    docs: Map<string, Automerge.Doc<any>>;
    graph: Map<number, number[]>;
    reachableFromZero: number[];
  }
> {
  const docs = new Map<string, Automerge.Doc<any>>();
  const graph = new Map<number, number[]>();
  for (let i = 0; i < nodes; i++) {
    const docId = `vdom:${i}`;
    await space.getOrCreateBranch(docId, "main");
    // Use deterministic client actor per doc to ensure monotonic seq numbers
    const base = createGenesisDoc<any>(docId, `bench-actor:${i}`);
    const d = Automerge.change(base, (x: any) => {
      x.tag = "div";
      x.props = { id: `n-${i}`, idx: i, visible: (i % 5) !== 0 };
      const fanout = Math.floor(rnd() * (maxChildren + 1));
      const children = new Set<number>();
      for (let k = 0; k < fanout; k++) {
        const remaining = Math.max(0, nodes - i - 1);
        if (remaining <= 0) break;
        const j = i + 1 + Math.floor(rnd() * remaining);
        if (j > i && j < nodes) children.add(j);
      }
      x.children = Array.from(children).map((j) => link(`vdom:${j}`, []));
    });
    const c = Automerge.getLastLocalChange(d)!;
    const seedRes = await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch: "main" },
        baseHeads: Automerge.getHeads(base),
        changes: [{ bytes: c }],
      }],
    });
    const ok = seedRes.results.length > 0 && seedRes.results[0].status === "ok";
    if (!ok) throw new Error(`seed failed for ${docId}`);
    docs.set(docId, d);
    graph.set(
      i,
      Array.from(
        new Set(
          (Automerge.toJS(d) as any).children?.map((c: any) => {
            const id = c?.["/"]?.["link@1"]?.id as string | undefined;
            return id ? Number(id.split(":")[1]) : -1;
          })?.filter((n: number) => n >= 0) ?? [],
        ),
      ),
    );
  }
  // Compute nodes reachable from 0 via adjacency in graph
  const seen = new Set<number>();
  const q: number[] = [0];
  while (q.length) {
    const n = q.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    const kids = graph.get(n) ?? [];
    for (const k of kids) if (!seen.has(k)) q.push(k);
  }
  const reachableFromZero = Array.from(seen.values());
  return { docs, graph, reachableFromZero };
}

// Build evaluator + change processor and register WATCH_DOCS root queries
function buildEngine(db: Database) {
  const storage = new SqliteStorageReader(db);
  const pool = new IRPool();
  const prov = new Provenance();
  const evaluator = new Evaluator(pool, storage, prov);
  const subs = new SubscriptionIndex();
  const cp = new ChangeProcessor(evaluator, prov, subs);

  const VNodeRecursive = {
    $defs: {
      VNode: {
        type: "object",
        properties: {
          tag: { type: "string" },
          props: { type: "object" },
          children: { type: "array", items: { $ref: "#/$defs/VNode" } },
        },
      },
    },
    $ref: "#/$defs/VNode",
  } as const;
  const ir = compileSchema(pool, VNodeRecursive as any);

  // Register a single root query on vdom:0 to cover the entire VDOM via links
  cp.registerQuery({ id: `q:vdom:0`, doc: `vdom:0`, path: [], ir });

  return { storage, evaluator, cp };
}

// Globals initialized once for the benchmark
const tmpDir = await Deno.makeTempDir();
const spacesDir = new URL(`file://${tmpDir}/`);
const spaceDid = "did:key:bench-updates";
const space = await openSpaceStorage(spaceDid, { spacesDir });
const sqliteHandle = await openSqlite({
  url: new URL(`./${spaceDid}.sqlite`, spacesDir),
});
const db: Database = sqliteHandle.db;
const seeded = await seedVDOM(space, NODES, MAX_CHILDREN);
const docs = seeded.docs;
const reachable = seeded.reachableFromZero;
const { storage, cp } = buildEngine(db);

// Helper to pick random int in [0, n)
function randInt(n: number): number {
  return Math.floor(rnd() * n);
}

// Produce CHANGES structural edits (add/remove children) and feed deltas to engine
Deno.bench({
  name:
    `updates: vdom structural churn (${CHANGES} changes over ${NODES} nodes)`,
  group: "updates",
  n: 1,
}, async () => {
  let events = 0;
  for (let t = 0; t < CHANGES; t++) {
    // Pick a doc reachable from vdom:0 (bias towards impacting the root query)
    const i = reachable[Math.floor(rnd() * reachable.length)] ?? 0;
    const docId = `vdom:${i}`;
    const cur = docs.get(docId) ?? Automerge.init<any>();
    const removeMode = rnd() < 0.5;
    let updated = cur;
    updated = Automerge.change(updated, (d: any) => {
      if (!Array.isArray(d.children)) d.children = [];
      // Extract current child doc ids for convenience
      const current: string[] = d.children.map((c: any) =>
        c?.["/"]?.["link@1"]?.id
      ).filter((x: any) => typeof x === "string");
      if (removeMode && current.length > 0) {
        // remove a random child
        const idx = randInt(current.length);
        d.children.splice(idx, 1);
      } else {
        // add a new child j > i and not already present (respect DAG direction)
        const remaining = Math.max(0, NODES - i - 1);
        if (remaining > 0) {
          const candidate = i + 1 + randInt(remaining);
          const childId = `vdom:${candidate}`;
          if (!current.includes(childId)) {
            d.children.push(link(childId, []));
          } else if (current.length > 0) {
            // fallback: remove one to ensure a structural change
            const idx = randInt(current.length);
            d.children.splice(idx, 1);
          }
        } else if (current.length > 0) {
          // no valid higher children; remove something
          const idx = randInt(current.length);
          d.children.splice(idx, 1);
        }
      }
    });
    const change = Automerge.getLastLocalChange(updated);
    if (!change) continue;
    const baseHeads = Automerge.getHeads(cur);
    const rec = await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch: "main" },
        baseHeads,
        changes: [{ bytes: change }],
      }],
    });
    // Update local doc snapshot only if server accepted
    const ok = rec.results.length > 0 && rec.results[0].status === "ok";
    if (ok) docs.set(docId, updated);

    // Notify query engine of the delta at this version
    const v = storage.currentVersion(docId);
    const delta: Delta = {
      doc: docId,
      changed: new Set([keyPathLocal(["children"])]) as unknown as Set<string>,
      removed: new Set(),
      newDoc: undefined,
      atVersion: v,
    } as unknown as Delta;
    const ev = cp.onDelta(delta);
    events += ev.length;
  }
  if (events <= 0) throw new Error("no update events generated");
});
