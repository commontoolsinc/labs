// Automerge microbenchmarks for key operations used by storage/query
// Run with:
//   deno bench -A --no-prompt packages/storage/bench/automerge_bench.ts

import * as Automerge from "@automerge/automerge";

// Tunables
const AM_CHANGES = Number(Deno.env.get("BENCH_AM_CHANGES") ?? 600);
const AM_PAYLOAD = Number(Deno.env.get("BENCH_AM_PAYLOAD") ?? 16); // bytes-ish per change
const AM_BRANCH_MERGE_SPLIT = Number(
  Deno.env.get("BENCH_AM_BRANCH_SPLIT") ?? 0.5,
);

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);

// Seed a linear history and collect change bytes
function buildLinearHistory(n: number, payloadSize: number) {
  let doc = Automerge.init<any>();
  const changes: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    doc = Automerge.change(doc, (d: any) => {
      if (d.meta === undefined) d.meta = { createdAt: Date.now() };
      if (d.events === undefined) d.events = [];
      const noteChars = Array.from(
        { length: payloadSize },
        () => String.fromCharCode(97 + Math.floor(rnd() * 26)),
      ).join("");
      d.events.push({ i, note: noteChars, r: Math.floor(rnd() * 1e6) });
      if (d.counters === undefined) d.counters = {} as any;
      const k = `k${i % 32}`;
      d.counters[k] = (d.counters[k] ?? 0) + 1;
    });
    const c = Automerge.getLastLocalChange(doc)!;
    changes.push(c);
  }
  const bytes = Automerge.save(doc);
  const js = Automerge.toJS(doc);
  const json = JSON.stringify(js);
  return { doc, bytes, changes, js, json };
}

const seeded = buildLinearHistory(AM_CHANGES, AM_PAYLOAD);
const half = Math.max(1, Math.floor(AM_CHANGES * 0.5));
const twoThirds = Math.max(1, Math.floor(AM_CHANGES * 0.67));

Deno.bench({ name: "am: load snapshot bytes", group: "automerge" }, () => {
  const d = Automerge.load(seeded.bytes);
  if (!d) throw new Error("load failed");
});

Deno.bench({ name: "am: toJS on loaded doc", group: "automerge" }, () => {
  const d = Automerge.load(seeded.bytes);
  const js = Automerge.toJS(d);
  if (!js) throw new Error("toJS failed");
});

Deno.bench({ name: "am: save doc to bytes", group: "automerge" }, () => {
  const d = Automerge.load(seeded.bytes);
  const out = Automerge.save(d);
  if (out.length === 0) throw new Error("save failed");
});

Deno.bench({ name: "json: stringify to string", group: "automerge" }, () => {
  const d = Automerge.load(seeded.bytes);
  const js = Automerge.toJS(d);
  const s = JSON.stringify(js);
  if (!s || s.length === 0) throw new Error("stringify failed");
});

Deno.bench({ name: "json: parse from string", group: "automerge" }, () => {
  const obj = JSON.parse(seeded.json);
  if (!obj) throw new Error("parse failed");
});

Deno.bench({ name: "am: applyChanges (all)", group: "automerge" }, () => {
  const base = Automerge.init();
  const applied = Automerge.applyChanges(base, seeded.changes);
  const doc = Array.isArray(applied) ? applied[0] : applied;
  if (!doc) throw new Error("applyChanges failed");
});

Deno.bench({ name: "am: applyChanges (half)", group: "automerge" }, () => {
  const base = Automerge.init();
  const slice = seeded.changes.slice(0, half);
  const applied = Automerge.applyChanges(base, slice);
  const doc = Array.isArray(applied) ? applied[0] : applied;
  if (!doc) throw new Error("applyChanges(half) failed");
});

Deno.bench({ name: "am: applyChanges (2/3)", group: "automerge" }, () => {
  const base = Automerge.init();
  const slice = seeded.changes.slice(0, twoThirds);
  const applied = Automerge.applyChanges(base, slice);
  const doc = Array.isArray(applied) ? applied[0] : applied;
  if (!doc) throw new Error("applyChanges(twoThirds) failed");
});

// Note: merge microbench omitted due to Automerge proxy constraints in this setup

// ------------------------------------------------------------
// Small-doc (VDOM-like) microbenches: 0 changes, 5 changes
// ------------------------------------------------------------

function buildSmallVNodeHistory(numChanges: number) {
  let doc = Automerge.init<any>();
  const changes: Uint8Array[] = [];
  // base: set a small VNode-like shape
  doc = Automerge.change(doc, (d: any) => {
    d.tag = "div";
    d.props = { id: "n-1", idx: 1, visible: true };
    d.children = [];
  });
  changes.push(Automerge.getLastLocalChange(doc)!);
  for (let i = 0; i < numChanges; i++) {
    doc = Automerge.change(doc, (d: any) => {
      if (i % 2 === 0) {
        // toggle visible
        d.props.visible = !d.props.visible;
      } else {
        // push a small child record
        d.children.push({ tag: "span", props: { id: `c-${i}` }, children: [] });
      }
    });
    changes.push(Automerge.getLastLocalChange(doc)!);
  }
  const bytes = Automerge.save(doc);
  const js = Automerge.toJS(doc);
  const json = JSON.stringify(js);
  return { bytes, changes, js, json };
}

const small0 = buildSmallVNodeHistory(0);
const small5 = buildSmallVNodeHistory(5);

Deno.bench(
  { name: "am small vnode (0): load", group: "automerge-small" },
  () => {
    const d = Automerge.load(small0.bytes);
    if (!d) throw new Error("load failed");
  },
);

Deno.bench(
  { name: "am small vnode (0): toJS", group: "automerge-small" },
  () => {
    const d = Automerge.load(small0.bytes);
    const js = Automerge.toJS(d);
    if (!js) throw new Error("toJS failed");
  },
);

Deno.bench(
  { name: "am small vnode (0): save", group: "automerge-small" },
  () => {
    const d = Automerge.load(small0.bytes);
    const out = Automerge.save(d);
    if (out.length === 0) throw new Error("save failed");
  },
);

Deno.bench(
  { name: "json small vnode (0): stringify", group: "automerge-small" },
  () => {
    const d = Automerge.load(small0.bytes);
    const js = Automerge.toJS(d);
    const s = JSON.stringify(js);
    if (!s) throw new Error("stringify failed");
  },
);

Deno.bench(
  { name: "json small vnode (0): parse", group: "automerge-small" },
  () => {
    const obj = JSON.parse(small0.json);
    if (!obj) throw new Error("parse failed");
  },
);

Deno.bench({
  name: "am small vnode (0): applyChanges",
  group: "automerge-small",
}, () => {
  const base = Automerge.init();
  const r = Automerge.applyChanges(base, small0.changes);
  const doc = Array.isArray(r) ? r[0] : r;
  if (!doc) throw new Error("applyChanges failed");
});

Deno.bench(
  { name: "am small vnode (5): load", group: "automerge-small" },
  () => {
    const d = Automerge.load(small5.bytes);
    if (!d) throw new Error("load failed");
  },
);

Deno.bench(
  { name: "am small vnode (5): toJS", group: "automerge-small" },
  () => {
    const d = Automerge.load(small5.bytes);
    const js = Automerge.toJS(d);
    if (!js) throw new Error("toJS failed");
  },
);

Deno.bench(
  { name: "am small vnode (5): save", group: "automerge-small" },
  () => {
    const d = Automerge.load(small5.bytes);
    const out = Automerge.save(d);
    if (out.length === 0) throw new Error("save failed");
  },
);

Deno.bench(
  { name: "json small vnode (5): stringify", group: "automerge-small" },
  () => {
    const d = Automerge.load(small5.bytes);
    const js = Automerge.toJS(d);
    const s = JSON.stringify(js);
    if (!s) throw new Error("stringify failed");
  },
);

Deno.bench(
  { name: "json small vnode (5): parse", group: "automerge-small" },
  () => {
    const obj = JSON.parse(small5.json);
    if (!obj) throw new Error("parse failed");
  },
);

Deno.bench({
  name: "am small vnode (5): applyChanges",
  group: "automerge-small",
}, () => {
  const base = Automerge.init();
  const r = Automerge.applyChanges(base, small5.changes);
  const doc = Array.isArray(r) ? r[0] : r;
  if (!doc) throw new Error("applyChanges failed");
});

// ------------------------------------------------------------
// Variety matrix: compare load vs applyChanges for different (n,payload)
// ------------------------------------------------------------

type CaseCfg = { label: string; n: number; payload: number };
const CASES: CaseCfg[] = [
  { label: "n0,p8", n: 0, payload: 8 },
  { label: "n5,p8", n: 5, payload: 8 },
  { label: "n20,p16", n: 20, payload: 16 },
  { label: "n100,p16", n: 100, payload: 16 },
  { label: "n500,p16", n: 500, payload: 16 },
  // Larger payload sweeps to observe load vs applyChanges crossover
  { label: "n5,p128", n: 5, payload: 128 },
  { label: "n5,p512", n: 5, payload: 512 },
  { label: "n5,p1024", n: 5, payload: 1024 },
  { label: "n20,p128", n: 20, payload: 128 },
  { label: "n20,p512", n: 20, payload: 512 },
  { label: "n100,p128", n: 100, payload: 128 },
];

const VARIANTS = CASES.map((c) => ({
  cfg: c,
  data: buildLinearHistory(c.n, c.payload),
}));

for (const { cfg, data } of VARIANTS) {
  const nameLoad = `am var (${cfg.label}): load`;
  const nameApply = `am var (${cfg.label}): applyChanges`;
  const nameJsonStr = `json var (${cfg.label}): stringify`;
  const nameJsonParse = `json var (${cfg.label}): parse`;
  Deno.bench({ name: nameLoad, group: "automerge-var" }, () => {
    const d = Automerge.load(data.bytes);
    if (!d) throw new Error("load failed");
  });
  Deno.bench({ name: nameApply, group: "automerge-var" }, () => {
    const base = Automerge.init();
    const r = Automerge.applyChanges(base, data.changes);
    const doc = Array.isArray(r) ? r[0] : r;
    if (!doc) throw new Error("applyChanges failed");
  });
  Deno.bench({ name: nameJsonStr, group: "automerge-var" }, () => {
    const d = Automerge.load(data.bytes);
    const js = Automerge.toJS(d);
    const s = JSON.stringify(js);
    if (!s) throw new Error("stringify failed");
  });
  Deno.bench({ name: nameJsonParse, group: "automerge-var" }, () => {
    const obj = JSON.parse(data.json);
    if (!obj) throw new Error("parse failed");
  });
}
