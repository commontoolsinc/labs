// Query benchmarks for the SQLite-backed storage engine
// Run with:
//   deno bench -A --no-prompt packages/storage/bench/query_bench.ts
//
// This seeds a synthetic space with many docs, nested structures, and link graphs,
// then exercises the IR compiler/evaluator with filters, joins, and traversals.

import * as Automerge from "@automerge/automerge";
import { openSpaceStorage } from "../src/provider.ts";
import { openSqlite } from "../src/sqlite/db.ts";
import type { Database } from "@db/sqlite";
import { compileSchema, IRPool } from "../src/query/ir.ts";
import { Evaluator, Provenance } from "../src/query/eval.ts";
import { SqliteStorage } from "../src/query/sqlite_storage.ts";

// ---------------------------
// Config (defaults kept small for quick iteration; override via env vars)
// ---------------------------
const SEED = 42;
const ROOT_DOCS = Number(Deno.env.get("BENCH_ROOT_DOCS") ?? 200); // default small for quick run
const USERS = Number(Deno.env.get("BENCH_USERS") ?? 100);
const EDGES_PER_DOC = Number(Deno.env.get("BENCH_EDGES_PER_DOC") ?? 2);
const CHURN_BATCHES = Number(Deno.env.get("BENCH_CHURN_BATCHES") ?? 5);
// VDOM-specific knobs
const VDOM_NODES = Number(Deno.env.get("BENCH_VDOM_NODES") ?? 250); // at least 200
const VDOM_MAX_CHILDREN = Number(Deno.env.get("BENCH_VDOM_MAX_CHILDREN") ?? 20);
const VDOM_DEPTH = Number(Deno.env.get("BENCH_VDOM_DEPTH") ?? 3);
const VDOM_BUDGET = Number(Deno.env.get("BENCH_VDOM_BUDGET") ?? 2);

// ---------------------------
// Globals initialized once
// ---------------------------
const tmpDir = await Deno.makeTempDir();
const spacesDir = new URL(`file://${tmpDir}/`);
const spaceDid = "did:key:bench-space";
const space = await openSpaceStorage(spaceDid, { spacesDir });
const sqliteHandle = await openSqlite({
  url: new URL(`./${spaceDid}.sqlite`, spacesDir),
});
const db: Database = sqliteHandle.db;

// rand helper with seed for reproducibility
function mulberry32(a: number) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

// Link shape used throughout: LinkValue {"/":{"link@1":{id, path}}} with path as JSON Pointer
function link(doc: string, pathTokens: string[] = []): any {
  const ptr = pathTokens.length === 0 ? "" : "/" + pathTokens.join("/");
  return { "/": { "link@1": { id: doc, path: ptr } } };
}

// Seed synthetic data set
async function seedOnce() {
  // Users: user:0..USERS-1 each has { profile: { name, org, tags[] } }
  for (let i = 0; i < USERS; i++) {
    const docId = `user:${i}`;
    await seedDoc(docId, (d: any) => {
      d.profile = {
        name: `user-${i}`,
        org: `org-${i % 50}`,
        tags: ["alpha", i % 2 === 0 ? "eng" : "design", `tier-${i % 5}`],
      };
    });
  }

  // Root task docs: task:0..ROOT_DOCS-1
  // Each has nested schema and refs to users via value.assignee = {doc, path}
  // and a graph adjacency list at value.edges = [{doc, path}]
  for (let i = 0; i < ROOT_DOCS; i++) {
    const docId = `task:${i}`;
    const assigneeId = Math.floor(rnd() * USERS);
    // pick some neighbor edges to random tasks (sparse graph)
    const neighbors: { doc: string; path: string[] }[] = [];
    for (let e = 0; e < EDGES_PER_DOC; e++) {
      const tgt = Math.floor(rnd() * ROOT_DOCS);
      if (tgt === i) continue;
      neighbors.push(link(`task:${tgt}`, []));
    }
    await seedDoc(docId, (d: any) => {
      d.value = {
        title: `task-${i}`,
        status: i % 3 === 0 ? "open" : i % 3 === 1 ? "in_progress" : "closed",
        priority: (i % 5) + 1,
        metrics: {
          estHours: (i % 13) + Math.floor(rnd() * 3),
          done: i % 7 === 0,
        },
        assignee: link(`user:${assigneeId}`, ["profile"]),
        edges: neighbors,
        // nested array of items with $ref-like owner links
        items: Array.from({ length: (i % 4) }, (_, k) => ({
          text: `sub-${k}`,
          done: (i + k) % 2 === 0,
          owner: link(`user:${(assigneeId + k) % USERS}`, ["profile"]),
        })),
      };
    });
  }

  // Background churn docs unrelated to task graph
  for (let b = 0; b < CHURN_BATCHES; b++) {
    const docId = `noise:${b}`;
    await seedDoc(docId, (d: any) => {
      d.journal = [{ at: Date.now(), note: `batch-${b}` }];
    });
  }

  // Seed a recursive VDOM of at least 200 nodes (configurable via env)
  await seedVDOM(VDOM_NODES, VDOM_MAX_CHILDREN);
}

async function seedDoc(docId: string, mutate: (d: any) => void) {
  const branch = "main";
  await space.getOrCreateBranch(docId, branch);
  const init = Automerge.init<any>();
  const updated = Automerge.change(init, mutate);
  const c = Automerge.getLastLocalChange(updated)!;
  await space.submitTx({
    reads: [],
    writes: [{
      ref: { docId, branch },
      baseHeads: [],
      changes: [{ bytes: c }],
    }],
  });
}

// --- VDOM seeding ---
const TAGS = [
  "div",
  "span",
  "ul",
  "li",
  "p",
  "section",
  "header",
  "footer",
  "main",
  "article",
] as const;

type VNode = {
  tag: typeof TAGS[number];
  props?: { [k: string]: string | number | boolean };
  children: any[]; // links to other VNode docs
};

async function seedVDOM(nodes: number, maxChildren: number) {
  const N = Math.max(200, nodes);
  // Pre-generate children adjacency to avoid cycles: only point to higher index
  const children: number[][] = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) {
    const fanout = Math.floor(rnd() * (maxChildren + 1)); // 0..maxChildren
    for (let k = 0; k < fanout; k++) {
      const j = i + 1 + Math.floor(rnd() * Math.max(1, N - i - 1));
      if (j >= N) break;
      children[i].push(j);
    }
  }
  // Create docs: vdom:0..N-1, each doc is a VNode at root with children as links to other docs' roots
  for (let i = 0; i < N; i++) {
    const docId = `vdom:${i}`;
    const tag = TAGS[Math.floor(rnd() * TAGS.length)];
    const kidLinks = children[i].map((j) => link(`vdom:${j}`, []));
    await seedDoc(docId, (d: any) => {
      // Put VNode at document root so links can target "" path
      d.tag = tag;
      d.props = { id: `n-${i}`, idx: i, visible: i % 5 !== 0 };
      d.children = kidLinks;
    });
  }
}

// Build evaluator over SQLite storage
const storage = new SqliteStorage(db);
const pool = new IRPool();
const prov = new Provenance();
const evaluator = new Evaluator(pool, storage, prov);

// Seed dataset once before benchmarks
await seedOnce();

// ---------------------------
// Benchmarks
// ---------------------------

// --- VDOM benchmarks ---
Deno.bench({
  name: "vdom: validate VNode schema ($defs recursive)",
  group: "queries",
  n: 1,
}, () => {
  // Recursive VNode schema using $defs; evaluator must cap traversal via budget
  const VNodeRecursive = {
    $defs: {
      VNode: {
        type: "object",
        properties: {
          tag: { enum: Array.from(TAGS) },
          props: { type: "object", additionalProperties: true },
          children: { type: "array", items: { $ref: "#/$defs/VNode" } },
        },
      },
    },
    $ref: "#/$defs/VNode",
  } as const;
  const ir = compileSchema(pool, VNodeRecursive as any);
  const deadline = performance.now() + 2000; // 2s soft timeout
  let ok = 0;
  for (let i = 0; i < Math.min(20, VDOM_NODES); i++) {
    if (performance.now() > deadline) {
      throw new Error("bench timeout (vdom validate)");
    }
    const res = evaluator.evaluate({
      ir,
      doc: `vdom:${i}`,
      path: [],
      budget: VDOM_BUDGET,
    });
    if (res.verdict !== "No") ok++;
    if (ok >= 5) break; // early exit once we validated a few
  }
  if (ok <= 0) throw new Error("no VDOM nodes validated");
});

Deno.bench({
  name: "vdom: find nodes tag=div with \u003e=10 children",
  group: "queries",
  n: 1,
}, () => {
  const schema = {
    type: "object",
    properties: {
      tag: { const: "div" },
      children: { type: "array", minItems: 10 },
    },
  };
  const ir = compileSchema(pool, schema);
  const deadline = performance.now() + 2000; // 2s soft timeout
  let count = 0;
  for (let i = 0; i < Math.min(100, VDOM_NODES); i++) {
    if (performance.now() > deadline) {
      throw new Error("bench timeout (vdom find nodes)");
    }
    const res = evaluator.evaluate({
      ir,
      doc: `vdom:${i}`,
      path: [],
      budget: 0,
    });
    if (res.verdict === "Yes") count++;
  }
  // OK if zero depending on random seed; just exercise path
  if (count < 0) throw new Error("unreachable");
});

Deno.bench({
  name: "vdom: deep traversal to leaf with limited budget",
  group: "queries",
  n: 1,
}, () => {
  const schema = {
    type: "object",
    properties: { children: { type: "array" } },
  };
  const ir = compileSchema(pool, schema);
  const deadline = performance.now() + 2000; // 2s soft timeout
  let maybes = 0;
  for (let i = 0; i < Math.min(50, VDOM_NODES); i++) {
    if (performance.now() > deadline) {
      throw new Error("bench timeout (vdom deep traversal)");
    }
    const res = evaluator.evaluate({
      ir,
      doc: `vdom:${i}`,
      path: [],
      budget: VDOM_BUDGET,
    });
    if (res.verdict === "MaybeExceededDepth") maybes++;
  }
  if (maybes < 0) throw new Error("unreachable");
});

Deno.bench({
  name: "schema: match open tasks (const filter)",
  group: "queries",
}, () => {
  // Schema that selects only open tasks
  const taskOpen = {
    type: "object",
    properties: {
      value: { type: "object", properties: { status: { const: "open" } } },
    },
  };
  const ir = compileSchema(pool, taskOpen);
  let count = 0;
  for (let i = 0; i < ROOT_DOCS; i++) {
    const res = evaluator.evaluate({
      ir,
      doc: `task:${i}`,
      path: [],
      budget: 0,
    });
    if (res.verdict === "Yes") count += 1;
  }
  // sanity: some open tasks exist
  if (count <= 0) throw new Error("no open tasks matched");
});

Deno.bench({
  name: "schema: tasks requiring assignee.profile schema via link",
  group: "queries",
}, () => {
  const schema = {
    definitions: {
      UserProfile: {
        type: "object",
        properties: {
          name: { type: "string" },
          org: { type: "string" },
          tags: { type: "array" },
        },
      },
    },
    type: "object",
    properties: {
      value: {
        type: "object",
        properties: {
          status: { enum: ["open", "in_progress", "closed"] },
          assignee: { $ref: "#/definitions/UserProfile" },
        },
      },
    },
  };
  const ir = compileSchema(pool, schema);
  let matched = 0;
  for (let i = 0; i < ROOT_DOCS; i++) {
    const res = evaluator.evaluate({
      ir,
      doc: `task:${i}`,
      path: [],
      budget: 2,
    });
    if (res.verdict !== "No") matched++;
  }
  if (matched <= 0) throw new Error("no tasks matched join-like schema");
});

Deno.bench({
  name: "schema: traversal budget across edges (depth 2)",
  group: "queries",
}, () => {
  const schema = {
    type: "object",
    properties: {
      value: { type: "object", properties: { edges: { type: "array" } } },
    },
  };
  const ir = compileSchema(pool, schema);
  const roots = Math.min(100, ROOT_DOCS);
  let maybes = 0;
  for (let i = 0; i < roots; i++) {
    const res = evaluator.evaluate({
      ir,
      doc: `task:${i}`,
      path: [],
      budget: 2,
    });
    if (res.verdict === "MaybeExceededDepth") maybes++;
  }
  // Not asserting count, just exercising traversal path with budget
});

// Simulate heavy unrelated write churn then query only target subset
Deno.bench({
  name: "schema: selective over churn (open tasks)",
  group: "queries",
}, async () => {
  // Apply unrelated changes to noise:* docs to stress PIT/chunk retrieval
  for (let b = 0; b < CHURN_BATCHES; b++) {
    const docId = `noise:${b}`;
    const init = Automerge.init<any>();
    const d1 = Automerge.change(init, (d: any) => {
      d.tick = (d.tick ?? 0) + 1;
    });
    const c = Automerge.getLastLocalChange(d1)!;
    await space.submitTx({
      reads: [],
      writes: [{
        ref: { docId, branch: "main" },
        baseHeads: [],
        changes: [{ bytes: c }],
      }],
    });
  }

  // Now query a narrow subset of task docs
  const targetCount = Math.min(100, ROOT_DOCS);
  const targets = Array.from({ length: targetCount }, (_, i) => `task:${i}`);
  const taskOpen = {
    type: "object",
    properties: {
      value: { type: "object", properties: { status: { const: "open" } } },
    },
  };
  const ir = compileSchema(pool, taskOpen);
  let matched = 0;
  for (const docId of targets) {
    const res = evaluator.evaluate({ ir, doc: docId, path: [], budget: 0 });
    if (res.verdict === "Yes") matched++;
  }
  if (matched < 0) throw new Error("unreachable");
});
