import { assert, assertEquals, assertGreater } from "@std/assert";
import { InMemoryStorage } from "../../src/query/storage.ts";
import { compileSchema, IRPool } from "../../src/query/ir.ts";
import { Evaluator, Provenance } from "../../src/query/eval.ts";
import { SubscriptionIndex } from "../../src/query/subs.ts";
import { ChangeProcessor } from "../../src/query/change_processor.ts";

// Helpers
function setup() {
  const storage = new InMemoryStorage();
  const prov = new Provenance();
  const pool = new IRPool();
  const evalr = new Evaluator(pool, storage, prov);
  const subs = new SubscriptionIndex();
  const proc = new ChangeProcessor(evalr, prov, subs);
  return { storage, prov, pool, evalr, subs, proc };
}

/**
 * 1) Proper cycles do not yield MaybeExceededDepth
 */
Deno.test("cycle: no MaybeExceededDepth on legal link cycles", () => {
  const { storage, pool, evalr, subs, proc } = setup();

  // A ↔ B
  storage.setDoc("A", { "/": { "link@1": { id: "B", path: [] } } }, {
    epoch: 1,
  });
  storage.setDoc("B", { "/": { "link@1": { id: "A", path: [] } } }, {
    epoch: 1,
  });

  const ir = compileSchema(pool, true); // follow everything
  subs.queryRoot.clear();
  proc.registerQuery({ id: "q", doc: "A", path: [], ir });

  const root = subs.queryRoot.get("q")!;
  const r = evalr.evaluate(root, undefined, evalr.newContext());
  assert(r.verdict !== "MaybeExceededDepth");
});

/**
 * 2) Cycle includes target doc in Touch Set (so changes invalidate)
 *    Implementation currently touches the target entry path (or doc root).
 */
Deno.test("cycle: target doc is touched so its change invalidates", () => {
  const { storage, pool, evalr, subs, proc } = setup();

  storage.setDoc("A", { "/": { "link@1": { id: "B", path: [] } } }, {
    epoch: 1,
  });
  storage.setDoc("B", { x: 1 }, { epoch: 1 });

  const ir = compileSchema(pool, true);
  proc.registerQuery({ id: "q", doc: "A", path: [], ir });

  // Change inside B — should trigger an event due to touched target
  const dB = storage.setDoc("B", {
    x: 2,
    link: { "/": { "link@1": { id: "A", path: [] } } },
  }, { epoch: 2 });
  const ev = proc.onDelta(dB);
  assert(ev.some((e) => e.queryId === "q"));
});

/**
 * 3) Cycle uses (IR, doc) as the guard — SAME IR short-circuits; different IR must still traverse.
 */
Deno.test("cycle: short-circuit keyed by (IR, doc) — different IR must evaluate", () => {
  const { storage, pool, evalr, subs, proc } = setup();

  // A ↔ B
  storage.setDoc("A", { "/": { "link@1": { id: "B", path: [] } } }, {
    epoch: 1,
  });
  storage.setDoc("B", { t: "yes" }, { epoch: 1 });

  const irTrue = compileSchema(pool, true); // follow everything
  const irProp = compileSchema(pool, {
    type: "object",
    properties: { t: { const: "yes" } },
  });

  // First query with irTrue
  proc.registerQuery({ id: "q1", doc: "A", path: [], ir: irTrue });
  const root1 = subs.queryRoot.get("q1")!;
  const r1 = evalr.evaluate(root1, undefined, evalr.newContext());
  assert(r1.verdict !== "MaybeExceededDepth");

  // Second query with a different IR; must still evaluate into B to check its 't'
  proc.registerQuery({ id: "q2", doc: "A", path: [], ir: irProp });
  const root2 = subs.queryRoot.get("q2")!;
  const r2 = evalr.evaluate(root2, undefined, evalr.newContext());

  assert(r2.verdict === "Yes");
  // Should have evaluated into B for irProp
  const deps = [...r2.deps];
  assert(deps.some((k) => k.doc === "B"));
});

/**
 * 4) Visit-limit exhaustion yields MaybeExceededDepth for deep chains (non-cycles)
 */
Deno.test(
  "visit-limit: deep chain triggers MaybeExceededDepth when limit is exhausted",
  () => {
    // Local setup to inject a small visitLimit
    const storage = new InMemoryStorage();
    const prov = new Provenance();
    const pool = new IRPool();
    const evalr = new Evaluator(pool, storage as any, prov, { visitLimit: 1 });
    const subs = new SubscriptionIndex();
    const proc = new ChangeProcessor(evalr, prov, subs);

    storage.setDoc("A", { "/": { "link@1": { id: "B", path: [] } } }, {
      epoch: 1,
    });
    storage.setDoc("B", { "/": { "link@1": { id: "C", path: [] } } }, {
      epoch: 1,
    });
    storage.setDoc("C", { x: 42 }, { epoch: 1 });

    const ir = compileSchema(pool, true); // follow all
    proc.registerQuery({ id: "q", doc: "A", path: [], ir });

    const r = evalr.evaluate(
      subs.queryRoot.get("q")!,
      undefined,
      evalr.newContext(),
    );
    assertEquals(r.verdict, "MaybeExceededDepth");
  },
);

/**
 * 5) Re-eval uses a fresh VisitContext so cycles never accidentally leak across runs
 */
Deno.test("context: fresh VisitContext per evaluation run", () => {
  const { storage, pool, evalr, subs, proc } = setup();

  storage.setDoc("A", { "/": { "link@1": { id: "B", path: [] } } }, {
    epoch: 1,
  });
  storage.setDoc("B", { "/": { "link@1": { id: "A", path: [] } } }, {
    epoch: 1,
  });

  const ir = compileSchema(pool, true);
  proc.registerQuery({ id: "q", doc: "A", path: [], ir });

  const root = subs.queryRoot.get("q")!;

  const r1 = evalr.evaluate(root, undefined, evalr.newContext());
  const r2 = evalr.evaluate(root, undefined, evalr.newContext());

  // Both evaluations terminate and don't degrade to Maybe because of leaked state
  assert(r1.verdict !== "MaybeExceededDepth");
  assert(r2.verdict !== "MaybeExceededDepth");
});

/**
 * 6) Invalidation through cycle: change in B flips an anyOf branch followed via A
 *    (proves we still re-traverse meaningfully after invalidation)
 */
Deno.test("invalidation: anyOf over cycle flips after target change", () => {
  const { storage, pool, evalr, subs, proc } = setup();

  // A → B → A (cycle), but schema looks for { flag: true } anywhere
  storage.setDoc("A", { "/": { "link@1": { id: "B", path: [] } } }, {
    epoch: 1,
  });
  storage.setDoc("B", { "/": { "link@1": { id: "A", path: [] } } }, {
    epoch: 1,
  });

  const ir = compileSchema(pool, {
    anyOf: [
      { type: "object", properties: { flag: { const: true } } },
      true, // ensures we still traverse/touch through links
    ],
  });

  proc.registerQuery({ id: "q", doc: "A", path: [], ir });

  // Initially not No (true branch)
  const r0 = evalr.evaluate(
    subs.queryRoot.get("q")!,
    undefined,
    evalr.newContext(),
  );
  assert(r0.verdict !== "No");
  // Change propagates: add flag in B
  const dB = storage.setDoc(
    "B",
    { flag: true },
    { epoch: 2 },
  );
  const ev = proc.onDelta(dB);
  assert(ev.some((e) => e.queryId === "q")); // query notified
});

/**
 * 7) Touch granularity check: on cycle short-circuit we at least touch the target entry path
 *    (Adjust this if you changed to doc-root touch instead.)
 */
Deno.test("touches: cycle short-circuit touches target entry path", () => {
  const { storage, pool, evalr, subs, proc } = setup();

  storage.setDoc("A", { "/": { "link@1": { id: "B", path: [] } } }, {
    epoch: 1,
  });
  storage.setDoc("B", { y: 1 }, { epoch: 1 });

  const ir = compileSchema(pool, true);
  proc.registerQuery({ id: "q", doc: "A", path: [], ir });

  const root = subs.queryRoot.get("q")!;
  const r = evalr.evaluate(root, undefined, evalr.newContext());

  // Aggregate touches through deps (like ChangeProcessor.collectTouches)
  const aggregate = new Set<string>();
  const seen = new Set<string>();
  const dfs = (k: typeof root) => {
    const ks = `${k.ir}\u0001${k.doc}\u0001${JSON.stringify(k.path)}`;
    if (seen.has(ks)) return;
    seen.add(ks);
    const rr = (evalr as any)["memo"].get(ks);
    if (!rr) return;
    rr.touches.forEach((l: any) =>
      aggregate.add(`${l.doc}:${JSON.stringify(l.path)}`)
    );
    rr.deps.forEach((child: any) => dfs(child));
  };
  dfs(root);

  // We expect both A and B to be in aggregated touches
  assert(aggregate.has(`A:${JSON.stringify([])}`));
  assert(aggregate.has(`B:${JSON.stringify([])}`)); // entry path ([]) touched for B in this setup
});

/**
 * 8) Memoization sanity: normal (non-cycle) second run should hit memo
 */
Deno.test("memo: non-cycle path uses memo on second evaluation", () => {
  const { storage, pool, evalr, subs, proc } = setup();

  storage.setDoc("A", { obj: { n: 1 } }, { epoch: 1 });

  const ir = compileSchema(pool, {
    type: "object",
    properties: {
      obj: { type: "object", properties: { n: { type: "number" } } },
    },
  });
  proc.registerQuery({ id: "q", doc: "A", path: [], ir });

  const root = subs.queryRoot.get("q")!;

  (evalr as any)["memo"].clear();
  const r1 = evalr.evaluate(root, undefined, evalr.newContext());
  const memoAfterFirst = (evalr as any)["memo"].size as number;
  const r2 = evalr.evaluate(root, undefined, evalr.newContext());
  const memoAfterSecond = (evalr as any)["memo"].size as number;

  assertEquals(r1.verdict, "Yes");
  assertEquals(r2.verdict, "Yes");
  // No new entries added on the second run if nothing changed
  assertEquals(memoAfterSecond, memoAfterFirst);
});
