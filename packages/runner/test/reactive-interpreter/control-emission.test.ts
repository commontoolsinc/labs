/**
 * Native control emission (W8 / D-CONTROL-EMISSION) — the conditional-
 * subscription oracle.
 *
 * Legacy ifElse/when/unless exist to provide DEMAND-DRIVEN reads: the node
 * subscribes to the predicate only and forwards a LINK to the taken branch,
 * so writes to the untaken branch's inputs wake nothing. Fusing a control op
 * into a segment must preserve exactly that:
 *
 *   R-CONTROL-READS: the fused node's read-set never exceeds
 *   predicate-inputs ∪ active-branch-inputs.
 *
 * A value differential is BLIND to subscription shape
 * (L-DEMAND-DRIVEN-IS-THE-POINT), so the oracle here is a TRIGGER-COUNT
 * differential: after the initial run, a write to an UNTAKEN branch input
 * must re-run nothing flag-on (scheduler runCount delta 0), while
 * taken-branch writes and predicate flips propagate normally — with values
 * byte-equal to legacy at every step.
 *
 * Branch inputs are CELLS PASSED AS ARGUMENT FIELDS (piece wiring): the
 * argument doc holds links, and the read of each target lands only when the
 * evaluation actually dereferences it — so an untaken branch's target is
 * never read, never subscribed.
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  getDispatchCensus,
  resetDispatchCensus,
} from "../../src/reactive-interpreter/dispatch.ts";
import {
  attachDocRecorder,
  nodeStats,
} from "../support/interpreter-measure.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/** Census fields the emission adds; optional so this file compiles (and runs
 * RED) before the implementation lands. */
function controlCensus(): { controlsFused: number; controlOpsGated: number } {
  const c = getDispatchCensus() as unknown as {
    controlsFused?: number;
    controlOpsGated?: number;
  };
  return {
    controlsFused: c.controlsFused ?? 0,
    controlOpsGated: c.controlOpsGated ?? 0,
  };
}

interface Harness {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
  docs: ReturnType<typeof attachDocRecorder>;
  // deno-lint-ignore no-explicit-any
  cf: any;
  dispose(): Promise<void>;
}

function makeHarness(interpreter: boolean): Harness {
  const storageManager = StorageManager.emulate({ as: signer });
  const docs = attachDocRecorder(storageManager);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { experimentalInterpreter: interpreter },
  });
  const cf = createTrustedBuilder(runtime).commonfabric;
  return {
    runtime,
    storageManager,
    docs,
    cf,
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

async function write<T>(
  runtime: Runtime,
  cell: Cell<T>,
  value: T,
): Promise<void> {
  const tx = runtime.edit();
  cell.withTx(tx).set(value);
  await tx.commit();
  await runtime.idle();
  await runtime.storageManager.synced();
}

/**
 * The workhorse pattern: `((a + b) > 0 ? (c + d) : (e + f)) * 2`, with
 * a..f cells wired through the argument. Fused, this is ONE node whose reads
 * are {a,b,c,d} or {a,b,e,f} — never both — and (the control being
 * value-consumed by the `* 2` lift) ZERO conditional documents.
 */
async function runConditionalExpr(interpreter: boolean) {
  const h = makeHarness(interpreter);
  const { runtime, cf, docs } = h;
  const tx = runtime.edit();
  const mk = (name: string, v: number): Cell<number> => {
    const c = runtime.getCell<number>(
      space,
      `ctl-expr-${name}-${interpreter}`,
      undefined,
      tx,
    );
    c.set(v);
    return c;
  };
  // a+b starts truthy (then-branch taken).
  const cells = {
    a: mk("a", 1),
    b: mk("b", 1),
    c: mk("c", 10),
    d: mk("d", 20),
    e: mk("e", 100),
    f: mk("f", 200),
  };

  const { pattern, lift, ifElse } = cf;
  const sum = lift(
    (v: { x: number; y: number }) => v.x + v.y,
    {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
    { type: "number" },
  );
  const gt0 = lift(
    (v: { x: number; y: number }) => v.x + v.y > 0,
    {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
    { type: "boolean" },
  );
  const mul2 = lift(
    (v: number) => v * 2,
    { type: "number" },
    { type: "number" },
  );

  // deno-lint-ignore no-explicit-any
  const Root = pattern((input: any) => ({
    out: mul2(
      ifElse(
        gt0({ x: input.a, y: input.b }),
        sum({ x: input.c, y: input.d }),
        sum({ x: input.e, y: input.f }),
      ),
    ),
  }));

  const resultCell = runtime.getCell(
    space,
    `ctl-expr-result-${interpreter}`,
    undefined,
    tx,
  );
  const mark = docs.mark();
  const result = runtime.run(tx, Root, { ...cells }, resultCell);
  await tx.commit();
  await runtime.idle();
  await runtime.storageManager.synced();
  await result.pull();
  // STANDING DEMAND: production patterns are sunk by a render effect; the
  // pull-based scheduler maintains subscriptions only under demand.
  const cancelSink = result.key("out").sink(() => {});
  await runtime.idle();

  const read = () => result.key("out").get() as unknown;
  const runCount = () => nodeStats(runtime).runCount;

  const steps: Array<{ label: string; value: unknown; runDelta: number }> = [];
  const record = (label: string, before: number) => {
    steps.push({ label, value: read(), runDelta: runCount() - before });
  };
  record("initial", runCount());

  // 1. UNTAKEN branch input write: e 100→101. Result must not change and
  //    NOTHING may run — pull scheduling already keeps legacy quiet here
  //    (no demand flows into the unselected branch), so the fused node must
  //    match: a union-read segment would REGRESS this exact property.
  let before = runCount();
  await write(runtime, cells.e, 101);
  record("untaken-write", before);

  // 2. TAKEN branch input write: c 10→11 → out (11+20)*2 = 62.
  before = runCount();
  await write(runtime, cells.c, 11);
  record("taken-write", before);

  // 3. Predicate flip: a → -5 (a+b = -4, falsy) → else branch with the
  //    CURRENT e (101): out (101+200)*2 = 602. The previously-unread branch
  //    must be read FRESH.
  before = runCount();
  await write(runtime, cells.a, -5);
  record("pred-flip", before);

  // 4. Now-untaken branch (then) input write: c 11→12. No change, no re-run.
  before = runCount();
  await write(runtime, cells.c, 12);
  record("untaken-after-flip", before);

  // 5. Taken (else) branch input write: f 200→201 → out (101+201)*2 = 604.
  before = runCount();
  await write(runtime, cells.f, 201);
  record("taken-after-flip", before);

  const census = controlCensus();
  const docsCreated = mark.createdSince().length;
  cancelSink();
  await h.dispose();
  return { steps, census, docsCreated };
}

/** Reference-passthrough: `ifElse(cond, itemA, itemB)` over object cells
 * wired through the argument, the control output RETAINED in the result
 * tree. The result must be a live reference to the taken cell (legacy writes
 * a LINK): writing through the result reaches the source cell. */
async function runReferencePassthrough(interpreter: boolean) {
  const h = makeHarness(interpreter);
  const { runtime, cf } = h;
  const tx = runtime.edit();
  const mkItem = (name: string, title: string): Cell<{ title: string }> => {
    const cell = runtime.getCell<{ title: string }>(
      space,
      `ctl-ref-${name}-${interpreter}`,
      undefined,
      tx,
    );
    cell.set({ title });
    return cell;
  };
  const itemA = mkItem("a", "alpha");
  const itemB = mkItem("b", "beta");
  const cond = runtime.getCell<boolean>(
    space,
    `ctl-ref-cond-${interpreter}`,
    undefined,
    tx,
  );
  cond.set(true);

  const { pattern, ifElse, lift } = cf;
  // A second collapsible op so the pattern passes the cost gate flag-on.
  const echo = lift(
    (v: boolean) => !v,
    { type: "boolean" },
    { type: "boolean" },
  );
  // deno-lint-ignore no-explicit-any
  const Root = pattern((input: any) => ({
    choice: ifElse(input.cond, input.itemA, input.itemB),
    inverted: echo(input.cond),
  }));

  const resultCell = runtime.getCell(
    space,
    `ctl-ref-result-${interpreter}`,
    undefined,
    tx,
  );
  const result = runtime.run(tx, Root, { cond, itemA, itemB }, resultCell);
  await tx.commit();
  await runtime.idle();
  await runtime.storageManager.synced();
  await result.pull();
  const cancelSink = result.key("choice").sink(() => {});
  await runtime.idle();

  const titleOf = () =>
    (result.key("choice").get() as { title?: string } | undefined)?.title;
  const initial = titleOf();

  // Write THROUGH the result: must land in itemA (the taken source).
  const tx2 = runtime.edit();
  result.key("choice").key("title").withTx(tx2).set("edited");
  await tx2.commit();
  await runtime.idle();
  await runtime.storageManager.synced();
  const afterWrite = {
    throughResult: titleOf(),
    sourceA: itemA.get()?.title,
    sourceB: itemB.get()?.title,
  };

  // Flip the condition: the result now tracks itemB.
  const tx3 = runtime.edit();
  cond.withTx(tx3).set(false);
  await tx3.commit();
  await runtime.idle();
  await runtime.storageManager.synced();
  const afterFlip = titleOf();

  cancelSink();
  await h.dispose();
  return { initial, afterWrite, afterFlip };
}

/** when/unless value corpus (their "pred" side returns the predicate value
 * itself — the link target legacy forwards is the CONDITION cell). */
async function runWhenUnless(interpreter: boolean) {
  const h = makeHarness(interpreter);
  const { runtime, cf } = h;
  const tx = runtime.edit();
  const cond = runtime.getCell<number>(
    space,
    `ctl-when-cond-${interpreter}`,
    undefined,
    tx,
  );
  cond.set(0); // falsy
  const { pattern, lift, when, unless } = cf;
  const inc = lift(
    (v: number) => v + 1,
    { type: "number" },
    { type: "number" },
  );
  // deno-lint-ignore no-explicit-any
  const Root = pattern((input: any) => ({
    whenOut: when(input.cond, inc(input.cond)),
    unlessOut: unless(input.cond, inc(input.cond)),
  }));
  const resultCell = runtime.getCell(
    space,
    `ctl-when-result-${interpreter}`,
    undefined,
    tx,
  );
  const result = runtime.run(tx, Root, { cond }, resultCell);
  await tx.commit();
  await runtime.idle();
  await runtime.storageManager.synced();
  await result.pull();
  const cancelWhen = result.key("whenOut").sink(() => {});
  const cancelUnless = result.key("unlessOut").sink(() => {});
  await runtime.idle();
  const snap = () => ({
    whenOut: result.key("whenOut").get() as unknown,
    unlessOut: result.key("unlessOut").get() as unknown,
  });
  const falsy = snap();
  const tx2 = runtime.edit();
  cond.withTx(tx2).set(7);
  await tx2.commit();
  await runtime.idle();
  await runtime.storageManager.synced();
  const truthy = snap();
  cancelWhen();
  cancelUnless();
  await h.dispose();
  return { falsy, truthy };
}

/** Nested conditionals: `a ? (b ? x : y) : z` — inner control feeds the
 * outer's then-branch only (a gated chain when fused). */
async function runNested(interpreter: boolean) {
  const h = makeHarness(interpreter);
  const { runtime, cf } = h;
  const tx = runtime.edit();
  const mk = (name: string, v: number): Cell<number> => {
    const c = runtime.getCell<number>(
      space,
      `ctl-nested-${name}-${interpreter}`,
      undefined,
      tx,
    );
    c.set(v);
    return c;
  };
  const cells = {
    a: mk("a", 1),
    b: mk("b", 0),
    x: mk("x", 10),
    y: mk("y", 20),
    z: mk("z", 30),
  };
  const { pattern, lift, ifElse } = cf;
  const inc = lift(
    (v: number) => v + 1,
    { type: "number" },
    { type: "number" },
  );
  // deno-lint-ignore no-explicit-any
  const Root = pattern((input: any) => ({
    out: inc(ifElse(input.a, ifElse(input.b, input.x, input.y), input.z)),
  }));
  const resultCell = runtime.getCell(
    space,
    `ctl-nested-result-${interpreter}`,
    undefined,
    tx,
  );
  const result = runtime.run(tx, Root, { ...cells }, resultCell);
  await tx.commit();
  await runtime.idle();
  await runtime.storageManager.synced();
  await result.pull();
  const cancelSink = result.key("out").sink(() => {});
  await runtime.idle();
  const first = result.key("out").get() as unknown; // a=1,b=0 → y=20 → 21
  await write(runtime, cells.b, 1);
  const second = result.key("out").get() as unknown; // b=1 → x=10 → 11
  await write(runtime, cells.a, 0);
  const third = result.key("out").get() as unknown; // a=0 → z=30 → 31
  cancelSink();
  await h.dispose();
  return { first, second, third };
}

describe("native control emission (W8)", () => {
  it("conditional expr: values match legacy at every step; fused node never re-runs on untaken-branch writes; conditional docs collapse", async () => {
    const off = await runConditionalExpr(false);
    resetDispatchCensus();
    const on = await runConditionalExpr(true);

    console.log(
      `[ctl-emission] OFF steps=${
        JSON.stringify(off.steps)
      } docs=${off.docsCreated}`,
    );
    console.log(
      `[ctl-emission] ON  steps=${
        JSON.stringify(on.steps)
      } docs=${on.docsCreated} census=${JSON.stringify(on.census)}`,
    );

    // Values byte-equal to legacy at every step (the value differential).
    assertEquals(
      on.steps.map((s) => ({ label: s.label, value: s.value })),
      off.steps.map((s) => ({ label: s.label, value: s.value })),
      "flag-on values must match legacy at every step",
    );
    // Pin the actual values (the oracle, not mutual equality alone).
    assertEquals(off.steps.map((s) => s.value), [
      60, // (10+20)*2
      60, // untaken e write: unchanged
      62, // (11+20)*2
      602, // flip: (101+200)*2 — reads the CURRENT e
      602, // untaken c write: unchanged
      604, // (101+201)*2
    ]);

    // ENGAGEMENT: the control op actually fused (RED until built).
    assert(
      on.census.controlsFused >= 1,
      `expected controlsFused>=1, got ${JSON.stringify(on.census)}`,
    );

    // R-CONTROL-READS: untaken-branch writes re-run NOTHING flag-on.
    const deltas = Object.fromEntries(
      on.steps.map((s) => [s.label, s.runDelta]),
    );
    assertEquals(
      deltas["untaken-write"],
      0,
      `untaken-branch write must not re-run the fused node: ${
        JSON.stringify(on.steps)
      }`,
    );
    assertEquals(
      deltas["untaken-after-flip"],
      0,
      "after a flip, the now-untaken branch must be unsubscribed",
    );
    assert(
      (deltas["taken-write"] ?? 0) >= 1,
      "taken-branch writes must re-run",
    );
    assert((deltas["pred-flip"] ?? 0) >= 1, "predicate flips must re-run");

    // The conditional's documents collapse (control value-consumed by the
    // `* 2` lift: no ifElse node doc, no branch-lift docs).
    assert(
      on.docsCreated < off.docsCreated,
      `doc win expected: ON ${on.docsCreated} < OFF ${off.docsCreated}`,
    );
  });

  it("reference passthrough: retained control output stays a live link (write-through reaches the taken source; flips retarget)", async () => {
    const off = await runReferencePassthrough(false);
    resetDispatchCensus();
    const on = await runReferencePassthrough(true);
    const census = controlCensus();

    console.log(
      `[ctl-ref] OFF=${JSON.stringify(off)} ON=${JSON.stringify(on)} census=${
        JSON.stringify(census)
      }`,
    );

    // Pin legacy: the write lands in itemA; itemB untouched; flips retarget.
    assertEquals(off.initial, "alpha");
    assertEquals(off.afterWrite, {
      throughResult: "edited",
      sourceA: "edited",
      sourceB: "beta",
    });
    assertEquals(off.afterFlip, "beta");

    // Flag-on must reproduce it exactly — a VALUE COPY would break the
    // write-through (sourceA would stay "alpha").
    assertEquals(on, off);

    // And the control must have fused (not fallen back to a boundary).
    assert(
      census.controlsFused >= 1,
      `expected controlsFused>=1, got ${JSON.stringify(census)}`,
    );
  });

  it("when/unless: pred-side semantics match legacy through flips", async () => {
    const off = await runWhenUnless(false);
    const on = await runWhenUnless(true);
    // when(0, inc) → 0 (falsy: the condition value); unless(0, inc) → 1.
    assertEquals(off.falsy, { whenOut: 0, unlessOut: 1 });
    assertEquals(off.truthy, { whenOut: 8, unlessOut: 7 });
    assertEquals(on, off);
  });

  it("nested conditionals: inner control in the outer's branch chain", async () => {
    const off = await runNested(false);
    const on = await runNested(true);
    assertEquals(off, { first: 21, second: 11, third: 31 });
    assertEquals(on, off);
  });
});
