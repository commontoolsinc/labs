// Automerge microbenchmarks for key operations used by storage/query
// Run with:
//   deno bench -A --no-prompt packages/storage/bench/automerge_bench.ts

import * as Automerge from "@automerge/automerge";

// Tunables
const AM_CHANGES = Number(Deno.env.get("BENCH_AM_CHANGES") ?? 600);
const AM_PAYLOAD = Number(Deno.env.get("BENCH_AM_PAYLOAD") ?? 16); // bytes-ish per change
const AM_BRANCH_MERGE_SPLIT = Number(Deno.env.get("BENCH_AM_BRANCH_SPLIT") ?? 0.5);

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
      const noteChars = Array.from({ length: payloadSize }, () =>
        String.fromCharCode(97 + Math.floor(rnd() * 26))
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
  return { doc, bytes, changes };
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


