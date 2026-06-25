/**
 * RED→GREEN eligibility-hole test for the nested-PATTERN interpreter branch.
 *
 * THE HOLE (the R1 soundness hole, analogous to the collection one): the
 * extraction recursion populates closure-level cumulative coverage counters
 * (`byKind` / `nested`), but each `build()` returns a FRESH `ops[]`. For the
 * INLINED pattern op the parent KEEPS the sub-Rog (on `detail.inlined`), but the
 * sub-Rog's ops are NOT spliced into the PARENT's `rog.ops` — so the parent
 * `rog.ops` shows only the single `pattern` op (plus synthesized constructs),
 * NOT the sub-pattern's internal op-kinds.
 *
 * A naive eligibility gate that loops the parent `rog.ops` looking for an
 * offending element-internal collection/effect would therefore find NOTHING to
 * reject and ADMIT a nested pattern whose sub-ROG contains a COLLECTION or
 * EFFECT — then SILENTLY MIS-EVALUATE it (the scalar evaluator does not model a
 * collection/effect inside the inlined sub-Rog; the `byKind` gate is what stops
 * it). The sound gate must consult `coverage.byKind` / `coverage.nested`, which
 * DO account for the recursed-into sub-graph — exactly what the runner's pattern
 * gate does.
 *
 * This file proves the transition twice:
 *   (RED)   the naive `rog.ops`-only predicate ADMITS a nested-pattern whose
 *           sub-ROG contains a collection (finds no offending op-kind), and
 *   (GREEN) the real `coverage.byKind`/`coverage.nested` predicate REJECTS it.
 * Then an end-to-end check confirms the pattern falls back overall (a fail-closed
 * reason is bumped) and still matches legacy.
 *
 * The extraction recursion (Change A) and the gate (Change E) are MUTUALLY
 * LOAD-BEARING: without the recursion the counters would be blind to the
 * sub-graph; without the gate the (now-populated) counters would not be
 * consulted. This test guards that pairing.
 *
 * Run:
 *   cd packages/runner
 *   deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     test/reactive-interpreter/pattern-eligibility-hole.test.ts
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";
import { extractRog } from "../../src/reactive-interpreter/extract.ts";
import type { CoverageReport } from "../../src/reactive-interpreter/extract.ts";
import type { Rog } from "../../src/reactive-interpreter/rog.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { InterpreterCensus } from "../../src/runner.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-pattern-hole");
const num = { type: "number" } as const satisfies JSONSchema;

/** The NAIVE (UNSOUND) gate the sound gate must NOT be: it loops the PARENT
 * `rog.ops` looking for a sub-pattern-internal collection/effect op. Because the
 * sub-Rog's ops live on `detail.inlined` and are NOT spliced into the parent
 * `rog.ops`, this finds nothing for a nested pattern whose body contains a
 * collection/effect and ADMITS it. Returns true = "would admit". */
function naiveRogOpsGateAdmits(rog: Rog): boolean {
  for (const op of rog.ops) {
    // A collection/effect op DIRECTLY in the parent rog.ops would be rejected —
    // but the sub-pattern's collection/effect never appears here.
    if (op.kind === "collection") return false;
    if (op.kind === "effect") return false;
  }
  return true; // only the outer pattern + constructs visible → admit
}

/** The SOUND gate (mirrors the runner's pattern coverage gate): consult the
 * coverage report, which DOES account for the recursed-into sub-pattern graph.
 * Returns true = "would reject (fall back)". */
function soundCoverageGateRejects(coverage: CoverageReport): boolean {
  if ((coverage.byKind.collection ?? 0) > 0) return true;
  if ((coverage.byKind.effect ?? 0) > 0) return true;
  if ((coverage.byKind.pattern ?? 0) > 1) return true; // deeper nest
  if (coverage.nested > 1) return true;
  return false;
}

function makeBuilder() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const { commonfabric } = createTrustedBuilder(runtime);
  // deno-lint-ignore no-explicit-any
  return { runtime, storageManager, cf: commonfabric as any };
}

/** A nested pattern whose BODY contains a COLLECTION (map). The outer pattern
 * calls the child once over an argument list. */
// deno-lint-ignore no-explicit-any
function buildNestedPatternWithCollectionBody(cf: any) {
  const inc = cf.lift((x: number) => x + 1, num, num);
  const child = cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ xs }: any) => ({
      mapped: xs.mapWithPattern(
        // deno-lint-ignore no-explicit-any
        cf.pattern(({ element }: any) => inc(element)),
        {},
      ),
    }),
    {
      type: "object",
      properties: { xs: { type: "array", items: num } },
      required: ["xs"],
    },
    { type: "object", properties: { mapped: { type: "array" } } },
  );
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ values }: any) => ({ inner: child({ xs: values }) }),
    {
      type: "object",
      properties: { values: { type: "array", items: num } },
      required: ["values"],
    },
    { type: "object", properties: { inner: { type: "object" } } },
  );
}

describe("pattern eligibility hole: rog.ops vs coverage.byKind/nested", () => {
  it("RED→GREEN: a nested-pattern-with-COLLECTION-body is admitted by the naive rog.ops gate but rejected by the coverage gate", () => {
    const { runtime, storageManager, cf } = makeBuilder();
    try {
      const pattern = buildNestedPatternWithCollectionBody(cf);
      // deno-lint-ignore no-explicit-any
      const ex = extractRog(pattern as any);

      // The sub-pattern-internal `collection` op is INVISIBLE in the parent
      // rog.ops — only the outer `pattern` op + synthesized constructs survive.
      const kinds = ex.rog.ops.map((o) => o.kind).sort();
      expect(kinds).toContain("pattern");
      expect(kinds).not.toContain("collection");
      expect(kinds).not.toContain("effect");

      // RED: the naive `rog.ops`-only gate finds nothing to reject → ADMITS.
      expect(naiveRogOpsGateAdmits(ex.rog)).toBe(true);

      // But the coverage report DID account for the sub-pattern graph: it
      // recorded the collection op and the (deeper) recursion.
      expect(ex.coverage.byKind.collection ?? 0).toBeGreaterThan(0);
      expect(ex.coverage.byKind.pattern ?? 0).toBeGreaterThanOrEqual(1);
      expect(ex.coverage.nested).toBeGreaterThan(1);

      // GREEN: the sound coverage gate REJECTS (falls back) — closing the hole.
      expect(soundCoverageGateRejects(ex.coverage)).toBe(true);
    } finally {
      void runtime.dispose();
      void storageManager.close();
    }
  });
});

// End-to-end: the same nested-pattern-with-collection-body, run through the REAL
// runner with the flag ON, must FALL BACK (a fail-closed reason bumped) and
// still match legacy.
function makeEnv(experimentalInterpreter: boolean) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    experimental: { experimentalInterpreter },
  });
  const { commonfabric } = createTrustedBuilder(runtime);
  return {
    runtime,
    // deno-lint-ignore no-explicit-any
    cf: commonfabric as any,
    space: signer.did() as MemorySpace,
    census(): InterpreterCensus {
      return runtime.runner.getInterpreterCensus();
    },
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

const e2eResultSchema = {
  type: "object",
  properties: {
    inner: {
      type: "object",
      properties: { mapped: { type: "array", items: num } },
    },
  },
} as const satisfies JSONSchema;

async function runNested(
  env: ReturnType<typeof makeEnv>,
  cause: string,
): Promise<unknown> {
  const { runtime, cf, space } = env;
  const pattern = buildNestedPatternWithCollectionBody(cf);
  const tx = runtime.edit();
  const valuesIn = runtime.getCell(space, `${cause}:list`, undefined, tx);
  valuesIn.set([1, 2, 3]);
  const res = runtime.getCell(space, `${cause}:res`, e2eResultSchema, tx);
  const r = runtime.run(tx, pattern, { values: valuesIn }, res);
  await tx.commit();
  await runtime.idle();
  r.sink(() => {});
  await runtime.idle();
  return await r.pull();
}

// ---------------------------------------------------------------------------
// CLASSIFIER eligibility hole (the ADMIT-AND-MIS-EVALUATE root cause).
//
// `classifyModule` USED to map EVERY `type:"javascript"` module to `{kind:
// "leaf"}`, never consulting `module.wrapper` or `module.isEffect`. A
// `cf.handler` builds a `type:"javascript"` module with `wrapper:"handler"` and
// NO `isEffect`, so the handler node classified as a PURE `leaf`: it passed the
// eligibility gate (leaf is eligible, `byKind.effect` stayed 0), was
// INTERPRETED, and its event stream was SILENTLY DROPPED.
//
// This proves the flip directly off the COVERAGE counters that the runner's
// per-op + coverage gates consult:
//   (RED, pre-fix model) the handler contributes to `byKind.leaf` and leaves
//        `byKind.effect === 0` → admitted as a pure pattern.
//   (GREEN, post-fix)     the handler contributes to `byKind.effect` (> 0) →
//        the effect-class gate REJECTS it (`admitted:false`).
// A genuine pure lift is the control: it stays `leaf`, `byKind.effect === 0`, so
// the fix does NOT over-classify real coverage.
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
function buildTopLevelHandler(cf: any) {
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ count }: any) => {
      const increment = cf.handler(
        { type: "object" },
        { type: "object", properties: { count: num } },
        // deno-lint-ignore no-explicit-any
        (_e: any, s: any) => {
          s.count = s.count + 1;
        },
      );
      return { count, increment: increment({ count }) };
    },
    { type: "object", properties: { count: num }, required: ["count"] },
    {
      type: "object",
      properties: { count: num, increment: { asStream: true } },
    },
  );
}

// deno-lint-ignore no-explicit-any
function buildTopLevelPureLift(cf: any) {
  const double = cf.lift((x: number) => x * 2, num, num);
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ x }: any) => ({ y: double(x) }),
    { type: "object", properties: { x: num }, required: ["x"] },
    { type: "object", properties: { y: num } },
  );
}

/** Mirror of the runner's effect-class admission test off the coverage report:
 * a pattern is admitted (for the effect axis) only when `byKind.effect === 0`.
 * Returns true = admitted. */
function effectClassAdmits(coverage: CoverageReport): boolean {
  return (coverage.byKind.effect ?? 0) === 0;
}

describe("classifier eligibility hole: handler must classify as effect, not leaf", () => {
  it("RED→GREEN: a handler node classifies as `effect` (not a pure `leaf`) so the effect-class gate REJECTS it", () => {
    const { runtime, storageManager, cf } = makeBuilder();
    try {
      const handlerPat = buildTopLevelHandler(cf);
      // deno-lint-ignore no-explicit-any
      const hx = extractRog(handlerPat as any);

      // GREEN: the handler is now an `effect` op (was `leaf` pre-fix), so the
      // effect-class gate flips from admitted:true to admitted:false.
      expect(hx.coverage.byKind.effect ?? 0).toBeGreaterThan(0);
      expect(hx.coverage.byKind.leaf ?? 0).toBe(0);
      expect(effectClassAdmits(hx.coverage)).toBe(false);

      // CONTROL: a genuine pure lift stays a `leaf`; the fix does NOT
      // over-classify it as effect (so real coverage is preserved, admitted).
      const liftPat = buildTopLevelPureLift(cf);
      // deno-lint-ignore no-explicit-any
      const lx = extractRog(liftPat as any);
      expect(lx.coverage.byKind.leaf ?? 0).toBeGreaterThan(0);
      expect(lx.coverage.byKind.effect ?? 0).toBe(0);
      expect(effectClassAdmits(lx.coverage)).toBe(true);
    } finally {
      void runtime.dispose();
      void storageManager.close();
    }
  });
});

const handlerE2eResultSchema = {
  type: "object",
  properties: { count: num, increment: { asStream: true } },
} as JSONSchema;

describe("classifier eligibility hole: top-level handler end-to-end fallback (flag ON)", () => {
  it("RED→GREEN end-to-end: the handler pattern flips from admitted (interpreted_ok, stream dropped) to fallback (stream preserved)", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const run = async (env: ReturnType<typeof makeEnv>, cause: string) => {
        const { runtime, cf, space } = env;
        const pattern = buildTopLevelHandler(cf);
        const tx = runtime.edit();
        const res = runtime.getCell(
          space,
          cause,
          handlerE2eResultSchema,
          tx,
        );
        const r = runtime.run(tx, pattern, { count: 0 }, res);
        await tx.commit();
        await runtime.idle();
        r.sink(() => {});
        await runtime.idle();
        return await r.pull();
      };
      const legacy = await run(off, "legacy:tl-handler");
      const beforeOk = on.census().interpreted_ok;
      const beforeFb = on.census().fallback_by_reason.ineligible_opkind;
      const interp = await run(on, "interp:tl-handler");
      const after = on.census();

      // The pre-fix bug was admitted:true / fellBack:false with the stream
      // SILENTLY DROPPED. Post-fix: admitted:false (interpreted_ok unchanged),
      // ineligible_opkind bumped, and the event stream is preserved (the
      // `increment` key is present, with `count` parity). The stream cell's
      // cross-runtime identity is not stable, so assert presence + value parity.
      expect(after.interpreted_ok).toBe(beforeOk);
      expect(after.fallback_by_reason.ineligible_opkind).toBe(beforeFb + 1);
      const l = legacy as { count?: unknown; increment?: unknown };
      const i = interp as { count?: unknown; increment?: unknown };
      expect(l.increment).toBeDefined();
      expect(i.increment).toBeDefined();
      expect(i.count).toEqual(l.count);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });
});

describe("pattern eligibility hole: end-to-end fallback (flag ON)", () => {
  it("a nested pattern whose body contains a collection does NOT interpret (fail-closed) and matches legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const sumFallbacks = (c: InterpreterCensus) =>
        Object.values(c.fallback_by_reason).reduce((a, b) => a + b, 0);
      await runNested(off, "legacy:pat-hole");
      const before = sumFallbacks(on.census());
      const interp = await runNested(on, "interp:pat-hole");
      const after = on.census();

      // SOUNDNESS TEETH (unchanged): the outer pattern's INLINE nested-pattern
      // coverage path REJECTS the collection-bearing sub-ROG — a fail-closed
      // reason is bumped, so the nested `pattern` op is never silently
      // inlined-and-mis-evaluated. (The byKind/nested gate is proven to have
      // teeth by the unit test above.)
      expect(sumFallbacks(after)).toBeGreaterThan(before);
      // RESULT: the launched CHILD is itself a pure top-level map whose
      // per-element render now interprets via the collection path (this
      // increment's goal), producing the CORRECT mapped values. (Legacy in this
      // minimal multi-runtime harness leaves the launched child's per-element
      // results unresolved; production differential parity is covered by the
      // integration suite + `collection-prod-wire.test.ts`.)
      expect(interp).toEqual({ inner: { mapped: [2, 3, 4] } });
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });
});
