/**
 * Production wiring of the Reactive Interpreter into `instantiatePattern`
 * (behind the default-OFF `experimentalInterpreter` flag).
 *
 * This is the permanent gate seed: a DIFFERENTIAL ORACLE that runs the SAME
 * pattern through the legacy path (flag off) and the interpreter path (flag on)
 * via the REAL `runtime.run` + start machinery, and asserts:
 *   - IDENTICAL `$result` (deep-eq) across non-collection patterns, AND
 *   - the flag-on run actually went through the interpreter (census
 *     `interpreted_ok` incremented — not a silent fallback that trivially
 *     matches).
 * Plus REACTIVITY (input change → interpreted node re-runs → result updates) and
 * FALLBACK SAFETY (a collection/effect pattern with the flag on falls back,
 * bumps `fallback_by_reason`, and still produces the legacy result).
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { InterpreterCensus } from "../../src/runner.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-prod-wire");

function makeEnv(experimentalInterpreter: boolean) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    experimental: { experimentalInterpreter },
  });
  const { commonfabric } = createTrustedBuilder(runtime);
  // deno-lint-ignore no-explicit-any
  const cf = commonfabric as any;
  return {
    runtime,
    cf,
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

type Env = ReturnType<typeof makeEnv>;

/** Run a pattern factory (built fresh in each env's builder) and pull $result. */
async function runAndPull(
  env: Env,
  buildPattern: (cf: any) => unknown,
  argument: unknown,
  resultSchema: JSONSchema,
  cause: string,
): Promise<unknown> {
  const { runtime, cf, space } = env;
  // deno-lint-ignore no-explicit-any
  const pattern = buildPattern(cf) as any;
  const tx = runtime.edit();
  const res = runtime.getCell(space, cause, resultSchema, tx);
  const r = runtime.run(tx, pattern, argument, res);
  await tx.commit();
  await runtime.idle();
  r.sink(() => {});
  await runtime.idle();
  return await r.pull();
}

const num = { type: "number" } as const satisfies JSONSchema;

interface OracleCase {
  name: string;
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  build: (cf: any) => unknown;
  args: unknown[];
}

const cases: OracleCase[] = [
  {
    name: "leaf",
    argumentSchema: {
      type: "object",
      properties: { x: num },
      required: ["x"],
    },
    resultSchema: { type: "object", properties: { doubled: num } },
    build: (cf) => {
      const double = cf.lift((x: number) => x * 2, num, num);
      return cf.pattern(
        ({ x }: { x: number }) => ({ doubled: double(x) }),
        { type: "object", properties: { x: num }, required: ["x"] },
        { type: "object", properties: { doubled: num } },
      );
    },
    args: [{ x: 21 }, { x: -4 }],
  },
  {
    name: "control (ifElse)",
    argumentSchema: {
      type: "object",
      properties: { x: num, show: { type: "boolean" } },
      required: ["x", "show"],
    },
    resultSchema: { type: "object", properties: { shown: num } },
    build: (cf) =>
      cf.pattern(
        ({ x, show }: { x: number; show: boolean }) => ({
          shown: cf.ifElse(show, x, 0),
        }),
        {
          type: "object",
          properties: { x: num, show: { type: "boolean" } },
          required: ["x", "show"],
        },
        { type: "object", properties: { shown: num } },
      ),
    args: [{ x: 5, show: true }, { x: 5, show: false }],
  },
  {
    // CORRECTNESS (control vocabulary): when(condition, value) =
    //   condition ? value : condition. The ELSE branch returns the CONDITION,
    //   NOT undefined. Before the extract/interpret fix, `value` (the THEN
    //   branch) was never extracted (only ifTrue/then read) and the off-branch
    //   returned undefined — both branches silently WRONG vs legacy.
    name: "control (when) — both branches",
    argumentSchema: {
      type: "object",
      properties: { x: num, show: { type: "boolean" } },
      required: ["x", "show"],
    },
    resultSchema: { type: "object", properties: { maybe: num } },
    build: (cf) =>
      cf.pattern(
        ({ x, show }: { x: number; show: boolean }) => ({
          maybe: cf.when(show, x),
        }),
        {
          type: "object",
          properties: { x: num, show: { type: "boolean" } },
          required: ["x", "show"],
        },
        { type: "object", properties: { maybe: num } },
      ),
    // when(true, 5) = 5 ; when(false, 5) = false (the condition)
    args: [{ x: 5, show: true }, { x: 5, show: false }],
  },
  {
    // CORRECTNESS (control vocabulary): unless(condition, fallback) =
    //   condition ? condition : fallback. The THEN branch returns the
    //   CONDITION, NOT undefined; the ELSE branch is `fallback`. Before the fix
    //   `fallback` (the ELSE branch) was never extracted (only ifFalse/else
    //   read) and the on-branch returned undefined — both branches silently
    //   WRONG vs legacy.
    name: "control (unless) — both branches",
    argumentSchema: {
      type: "object",
      properties: { x: num, hide: { type: "boolean" } },
      required: ["x", "hide"],
    },
    resultSchema: { type: "object", properties: { maybe: num } },
    build: (cf) =>
      cf.pattern(
        ({ x, hide }: { x: number; hide: boolean }) => ({
          maybe: cf.unless(hide, x),
        }),
        {
          type: "object",
          properties: { x: num, hide: { type: "boolean" } },
          required: ["x", "hide"],
        },
        { type: "object", properties: { maybe: num } },
      ),
    // unless(true, 5) = true (the condition) ; unless(false, 5) = 5
    args: [{ x: 5, hide: true }, { x: 5, hide: false }],
  },
  {
    // REGRESSION (structured-input blocker): a multi-input leaf whose `inputs`
    // is an object-of-aliases `{a, b}`. Legacy passes the leaf ONE structured
    // value `{a:<v>, b:<v>}`; extraction must reconstruct that losslessly (NOT a
    // positional alias array, which would make `i.a + i.b` NaN → silent `{}`).
    name: "multi-input leaf (object-of-aliases: add({a,b}))",
    argumentSchema: {
      type: "object",
      properties: { a: num, b: num },
      required: ["a", "b"],
    },
    resultSchema: { type: "object", properties: { sum: num } },
    build: (cf) => {
      const add = cf.lift(
        (i: { a: number; b: number }) => i.a + i.b,
        {
          type: "object",
          properties: { a: num, b: num },
          required: ["a", "b"],
        },
        num,
      );
      return cf.pattern(
        ({ a, b }: { a: number; b: number }) => ({ sum: add({ a, b }) }),
        {
          type: "object",
          properties: { a: num, b: num },
          required: ["a", "b"],
        },
        { type: "object", properties: { sum: num } },
      );
    },
    args: [{ a: 3, b: 4 }, { a: 10, b: -2 }],
  },
  {
    // A leaf over a CONSTRUCTED ARRAY input `sum([a, b])`. The leaf receives the
    // exact array legacy passes (positional values), assembled by a synthesized
    // array construct — not flattened or re-keyed.
    name: "multi-input leaf (constructed array: sum([a,b]))",
    argumentSchema: {
      type: "object",
      properties: { a: num, b: num },
      required: ["a", "b"],
    },
    resultSchema: { type: "object", properties: { total: num } },
    build: (cf) => {
      const sumArr = cf.lift(
        (xs: number[]) => xs.reduce((s, n) => s + n, 0),
        { type: "array", items: num },
        num,
      );
      return cf.pattern(
        ({ a, b }: { a: number; b: number }) => ({ total: sumArr([a, b]) }),
        {
          type: "object",
          properties: { a: num, b: num },
          required: ["a", "b"],
        },
        { type: "object", properties: { total: num } },
      );
    },
    args: [{ a: 5, b: 6 }, { a: 1, b: 1 }],
  },
  {
    // A leaf over a NESTED structured input `{pair:{a,b}, k}` — keys preserved
    // at every level, scalar literal carried through.
    name: "multi-input leaf (nested object + literal)",
    argumentSchema: {
      type: "object",
      properties: { a: num, b: num },
      required: ["a", "b"],
    },
    resultSchema: { type: "object", properties: { out: num } },
    build: (cf) => {
      const f = cf.lift(
        (i: { pair: { a: number; b: number }; k: number }) =>
          (i.pair.a + i.pair.b) * i.k,
        {
          type: "object",
          properties: {
            pair: {
              type: "object",
              properties: { a: num, b: num },
              required: ["a", "b"],
            },
            k: num,
          },
          required: ["pair", "k"],
        },
        num,
      );
      return cf.pattern(
        ({ a, b }: { a: number; b: number }) => ({
          out: f({ pair: { a, b }, k: 3 }),
        }),
        {
          type: "object",
          properties: { a: num, b: num },
          required: ["a", "b"],
        },
        { type: "object", properties: { out: num } },
      );
    },
    args: [{ a: 2, b: 5 }],
  },
  {
    // ERROR-ISOLATION (per-op containment, legacy parity). A pattern with a
    // `poisoned` leaf that THROWS for some inputs alongside an INDEPENDENT
    // `safe` leaf. Legacy materializes each node separately, so the throw is
    // contained: `poisoned` resolves to `undefined` and `safe` still computes.
    // The interpreter runs the whole ROG in one action, so before per-op
    // isolation a single throwing leaf threw the entire node and the whole
    // result diverged/was lost. With isolation, evalRog catches the leaf throw,
    // sets that op's value to `undefined` (the probed legacy equivalent), and
    // continues — so the interpreter result deep-eqs legacy: poisoned isolated,
    // safe computed. The second arg (x:0) is the non-throwing steady state; the
    // first (x:2) is the throwing case. Both must match legacy.
    name: "error-isolation (throwing leaf + independent safe leaf)",
    argumentSchema: {
      type: "object",
      properties: { x: num },
      required: ["x"],
    },
    resultSchema: {
      type: "object",
      properties: { poisoned: num, safe: num },
    },
    build: (cf) => {
      const boom = cf.lift(
        (x: number) => {
          if (x > 1) throw new Error("Poisoned!");
          return x + 100;
        },
        num,
        num,
      );
      const double = cf.lift((x: number) => x * 2, num, num);
      return cf.pattern(
        ({ x }: { x: number }) => ({ poisoned: boom(x), safe: double(x) }),
        { type: "object", properties: { x: num }, required: ["x"] },
        { type: "object", properties: { poisoned: num, safe: num } },
      );
    },
    // x=2: boom throws → poisoned isolated to undefined, safe = 4.
    // x=0: boom returns 100, safe = 0 (non-throwing steady state).
    args: [{ x: 2 }, { x: 0 }],
  },
  {
    name: "multi-op (leaf + control + construct)",
    argumentSchema: {
      type: "object",
      properties: { x: num, show: { type: "boolean" } },
      required: ["x", "show"],
    },
    resultSchema: {
      type: "object",
      properties: { doubled: num, shown: num },
    },
    build: (cf) => {
      const double = cf.lift((x: number) => x * 2, num, num);
      return cf.pattern(
        ({ x, show }: { x: number; show: boolean }) => ({
          doubled: double(x),
          shown: cf.ifElse(show, x, 0),
        }),
        {
          type: "object",
          properties: { x: num, show: { type: "boolean" } },
          required: ["x", "show"],
        },
        { type: "object", properties: { doubled: num, shown: num } },
      );
    },
    args: [{ x: 21, show: true }, { x: 7, show: false }],
  },
  {
    // STR → NATIVE INTERPOLATE (08-expression-interpretation §2). A
    // `str\`...${x}...\`` site lowers to a native `interpolate` op the evaluator
    // computes directly — NO str SES leaf is resolved/invoked. The differential
    // oracle pins byte-equivalence: flag-off (str leaf) == flag-on (native op),
    // AND interpreted_ok bumps (genuine native interpretation, not a fallback).
    // Multiple sites + a no-ref template + a numeric coercion exercise the fold.
    name: "str interpolation → native interpolate op",
    argumentSchema: {
      type: "object",
      properties: { name: { type: "string" }, count: num },
      required: ["name", "count"],
    },
    resultSchema: {
      type: "object",
      properties: {
        greeting: { type: "string" },
        tally: { type: "string" },
        plain: { type: "string" },
      },
    },
    build: (cf) =>
      cf.pattern(
        ({ name, count }: { name: string; count: number }) => ({
          greeting: cf.str`Hello ${name}!`,
          tally: cf.str`${name} has ${count} items`,
          plain: cf.str`no refs here`,
        }),
        {
          type: "object",
          properties: { name: { type: "string" }, count: num },
          required: ["name", "count"],
        },
        {
          type: "object",
          properties: {
            greeting: { type: "string" },
            tally: { type: "string" },
            plain: { type: "string" },
          },
        },
      ),
    args: [{ name: "Ada", count: 3 }, { name: "Bo", count: 0 }],
  },
];

describe("prod-wire: reactive-interpreter dispatch (flag OFF default)", () => {
  it("flag OFF leaves the census pristine (no dispatch entered)", async () => {
    const env = makeEnv(false);
    try {
      await runAndPull(
        env,
        cases[0].build,
        cases[0].args[0],
        cases[0].resultSchema,
        "off:leaf",
      );
      const c = env.census();
      expect(c.interpreted_ok).toBe(0);
      expect(c.fallback_by_reason.ineligible_opkind).toBe(0);
      expect(c.fallback_by_reason.unrecognized_alias).toBe(0);
      expect(c.fallback_by_reason.unresolved_leaf).toBe(0);
      expect(c.fallback_by_reason.eval_threw).toBe(0);
    } finally {
      await env.dispose();
    }
  });
});

describe("prod-wire: differential oracle (flag OFF == flag ON)", () => {
  for (const c of cases) {
    it(`${c.name}: interpreter result == legacy result + census`, async () => {
      const off = makeEnv(false);
      const on = makeEnv(true);
      try {
        for (let i = 0; i < c.args.length; i++) {
          const arg = c.args[i];
          const before = on.census().interpreted_ok;
          const legacy = await runAndPull(
            off,
            c.build,
            arg,
            c.resultSchema,
            `legacy:${c.name}:${i}`,
          );
          const interp = await runAndPull(
            on,
            c.build,
            arg,
            c.resultSchema,
            `interp:${c.name}:${i}`,
          );
          // Differential oracle: identical materialized result.
          expect(interp).toEqual(legacy);
          // And the flag-on run actually went through the interpreter (not a
          // silent fallback that would trivially match).
          expect(on.census().interpreted_ok).toBe(before + 1);
          expect(on.census().fallback_by_reason.ineligible_opkind).toBe(0);
          expect(on.census().fallback_by_reason.unresolved_leaf).toBe(0);
          expect(on.census().fallback_by_reason.eval_threw).toBe(0);
        }
      } finally {
        await off.dispose();
        await on.dispose();
      }
    });
  }
});

describe("prod-wire: reactivity (flag ON)", () => {
  it("changing the argument re-runs the interpreter node and updates result", async () => {
    const env = makeEnv(true);
    try {
      const { runtime, cf, space } = env;
      const double = cf.lift((x: number) => x * 2, num, num);
      const argumentSchema = {
        type: "object",
        properties: { x: num },
        required: ["x"],
      } as const satisfies JSONSchema;
      const resultSchema = {
        type: "object",
        properties: { doubled: num },
      } as const satisfies JSONSchema;
      const pattern = cf.pattern(
        ({ x }: { x: number }) => ({ doubled: double(x) }),
        argumentSchema,
        resultSchema,
      );

      const tx = runtime.edit();
      const res = runtime.getCell(space, "react:1", resultSchema, tx);
      const r = runtime.run(tx, pattern, { x: 10 }, res);
      await tx.commit();
      await runtime.idle();
      r.sink(() => {});
      await runtime.idle();
      expect(await r.pull()).toEqual({ doubled: 20 });
      expect(env.census().interpreted_ok).toBe(1);

      // Change the input by re-running with a fresh argument on the SAME result
      // cell (updates the argument cell in place). The interpreter node reads
      // the argument through the tx, so the tracked read makes it re-run and the
      // result updates — parity with legacy reactivity.
      const atx = runtime.edit();
      runtime.run(atx, pattern, { x: 50 }, res.withTx(atx));
      await atx.commit();
      await runtime.idle();
      expect(await r.pull()).toEqual({ doubled: 100 });
    } finally {
      await env.dispose();
    }
  });
});

describe("prod-wire: structured-input regression (add({a,b}))", () => {
  // The exact blocker repro: a multi-input object-of-aliases leaf. Before the
  // fix this passed every gate and returned a SILENTLY WRONG `{}` with
  // interpreted_ok bumped (the leaf got a positional alias array, so `i.a + i.b`
  // was NaN). After the fix the interpreter result deep-eqs the legacy `{sum:7}`
  // with interpreted_ok bumped — no silent mismatch, no fallback.
  function buildAdd(cf: any) {
    const add = cf.lift(
      (i: { a: number; b: number }) => i.a + i.b,
      { type: "object", properties: { a: num, b: num }, required: ["a", "b"] },
      num,
    );
    return cf.pattern(
      ({ a, b }: { a: number; b: number }) => ({ sum: add({ a, b }) }),
      {
        type: "object",
        properties: { a: num, b: num },
        required: ["a", "b"],
      },
      { type: "object", properties: { sum: num } },
    );
  }
  const addResultSchema = {
    type: "object",
    properties: { sum: num },
  } as const satisfies JSONSchema;

  it("interpreter result deep-eqs legacy {sum:7} with interpreted_ok bumped", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const before = on.census().interpreted_ok;
      const legacy = await runAndPull(
        off,
        buildAdd,
        { a: 3, b: 4 },
        addResultSchema,
        "legacy:addreg",
      );
      const interp = await runAndPull(
        on,
        buildAdd,
        { a: 3, b: 4 },
        addResultSchema,
        "interp:addreg",
      );
      // The exact regression assertion: no silent `{}`; faithful {sum:7}.
      expect(legacy).toEqual({ sum: 7 });
      expect(interp).toEqual(legacy);
      expect(interp).toEqual({ sum: 7 });
      // Went through the interpreter (not a silent fallback that trivially
      // matches) and did NOT mis-evaluate.
      expect(on.census().interpreted_ok).toBe(before + 1);
      expect(on.census().fallback_by_reason.unrecognized_alias).toBe(0);
      expect(on.census().fallback_by_reason.eval_threw).toBe(0);
      expect(on.census().fallback_by_reason.ineligible_opkind).toBe(0);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// TOP-LEVEL EFFECT-CLASS NEGATIVES (the pre-existing admit-and-mis-evaluate
// hole). A `cf.handler` builds a `type:"javascript"` module with
// `wrapper:"handler"` and NO `isEffect`. The classifier USED to map every
// `type:"javascript"` module to `leaf`, so the handler node passed the
// eligibility gate (leaf is eligible, `byKind.effect` stayed 0), was
// INTERPRETED, and the interpreter evaluated the handler body as a pure leaf —
// SILENTLY DROPPING the event stream (legacy emits `{increment:<stream link>}`,
// the leaf-interpretation emits `{}`). The fix classifies `wrapper:"handler"`
// (and `isEffect:true`) as `effect`, so the per-op `ELIGIBLE_KINDS` gate rejects
// it → legacy fallback, which preserves the stream. A `[UI]`/render pattern is
// guarded the same way: an interactive render carries a handler node (the
// onClick sink), which now trips the same gate.
// ---------------------------------------------------------------------------

const handlerResultSchema = {
  type: "object",
  properties: { count: num, increment: { asStream: true } },
} as JSONSchema;

// ({count}) => ({count, increment: <handler stream>}). The result references the
// handler's stream link — exactly the value a leaf-interpretation would drop.
// deno-lint-ignore no-explicit-any
function buildHandler(cf: any) {
  return cf.pattern(
    ({ count }: any) => {
      const increment = cf.handler(
        { type: "object" },
        { type: "object", properties: { count: num } },
        (_e: any, s: any) => {
          s.count = s.count + 1;
        },
      );
      return { count, increment: increment({ count }) };
    },
    { type: "object", properties: { count: num } },
    handlerResultSchema,
  );
}

// ({label}) => ({label, [UI]: <button onClick={handler}>}). An INTERACTIVE
// render: the vnode binds an event handler, so the pattern carries a handler
// node (wrapper:"handler") alongside the render. The render value itself is a
// plain vnode object, but the handler node is what must keep this pattern OUT of
// the interpreter (and its stream-bearing vnode out of a leaf mis-eval).
const str = { type: "string" } as const satisfies JSONSchema;
const uiResultSchema = {
  type: "object",
  properties: { label: str },
} as const satisfies JSONSchema;
// deno-lint-ignore no-explicit-any
function buildInteractiveUI(cf: any) {
  return cf.pattern(
    ({ label }: any) => {
      const onClick = cf.handler(
        { type: "object" },
        { type: "object", properties: { label: str } },
        (_e: any, s: any) => {
          s.label = s.label + "!";
        },
      );
      return {
        label,
        [cf.UI]: cf.h("button", { onClick: onClick({ label }) }, label),
      };
    },
    { type: "object", properties: { label: str }, required: ["label"] },
    uiResultSchema,
  );
}

describe("prod-wire: TOP-LEVEL handler falls back (flag ON) + matches legacy", () => {
  it("a handler-bearing pattern does NOT interpret (effect class) and preserves the event stream", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const legacy = await runAndPull(
        off,
        buildHandler,
        { count: 0 },
        handlerResultSchema,
        "legacy:handler",
      );
      const beforeOk = on.census().interpreted_ok;
      const beforeFb = on.census().fallback_by_reason.ineligible_opkind;
      const interp = await runAndPull(
        on,
        buildHandler,
        { count: 0 },
        handlerResultSchema,
        "interp:handler",
      );
      const after = on.census();

      // The handler classified as `effect` → ELIGIBLE_KINDS gate rejected it →
      // fallback bumped, NOT interpreted (no silent admit-and-mis-evaluate).
      expect(after.interpreted_ok).toBe(beforeOk);
      expect(after.fallback_by_reason.ineligible_opkind)
        .toBe(beforeFb + 1);

      // STREAM PRESERVED: legacy resolves `increment` to the handler's event
      // stream; the interpreter (pre-fix) dropped it, yielding a bare `{count}`.
      // Both legacy (fallback path) and the flag-on run (same fallback path) now
      // carry the stream. The stream cell's internal identity differs across the
      // two separate runtimes, so we assert PRESENCE (not a cross-runtime deep
      // identity) plus value-field parity. The pre-fix bug made `increment`
      // ABSENT under the flag — exactly what this guards.
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

describe("prod-wire: TOP-LEVEL [UI] render falls back (flag ON) + matches legacy", () => {
  it("an interactive [UI] render does NOT interpret (carries a handler node) and preserves the vnode", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const legacy = await runAndPull(
        off,
        buildInteractiveUI,
        { label: "hi" },
        uiResultSchema,
        "legacy:ui",
      );
      const beforeOk = on.census().interpreted_ok;
      const beforeFb = on.census().fallback_by_reason.ineligible_opkind;
      const interp = await runAndPull(
        on,
        buildInteractiveUI,
        { label: "hi" },
        uiResultSchema,
        "interp:ui",
      );
      const after = on.census();

      // The render result (incl. the bound vnode) deep-eqs legacy — the
      // interpreter never mis-evaluated the handler-bearing render.
      expect(interp).toEqual(legacy);
      // Fell back via the effect-class gate, did NOT interpret.
      expect(after.interpreted_ok).toBe(beforeOk);
      expect(after.fallback_by_reason.ineligible_opkind)
        .toBe(beforeFb + 1);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// TOP-LEVEL EFFECT-REF NEGATIVE (the by-NAME fail-closed axis). An effect /
// stream / async ref builtin (llm, generateText, fetchData, sqliteQuery, …) used
// as a value computation lowers to a `type:"ref"` module whose `implementation`
// is the builtin name. The classifier now recognizes those names via
// `EFFECT_REFS` → classifies the node as `effect` → the `byKind.effect>0`
// eligibility gate rejects it with reason `ineligible_opkind` (fail closed BY
// NAME). Before EFFECT_REFS listed these names the node classified as `leaf`,
// passed the kind gate, and only fell back incidentally at the `unresolved_leaf`
// gate (a ref builtin has no resolvable leaf body). Either way the pattern falls
// back to legacy and the result deep-eqs legacy (nothing silently dropped); this
// pins the census reason to the precise, named `ineligible_opkind`.
//
// `fetchData` is used because it constructs from a plain `{url}` value and there
// is no fetch server in this env, so BOTH the legacy (flag-off) and flag-on runs
// take the SAME fallback path and the result is identical (the in-flight fetch
// shape — `pending` with no `result` yet — is the same on both sides).
const fetchResultSchema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        pending: { type: "boolean" },
        result: {},
        error: {},
      },
    },
  },
} as JSONSchema;

// ({url}) => ({data: fetchData({url, mode:"json"})}). The result references the
// fetchData ref builtin's output as a value computation — exactly the top-level
// effect-ref-as-value shape EFFECT_REFS must fail closed on.
// deno-lint-ignore no-explicit-any
function buildFetchValue(cf: any) {
  return cf.pattern(
    ({ url }: any) => ({ data: cf.fetchData({ url, mode: "json" }) }),
    { type: "object", properties: { url: str }, required: ["url"] },
    fetchResultSchema,
  );
}

describe("prod-wire: TOP-LEVEL effect-ref falls back (flag ON) + matches legacy", () => {
  it("a fetchData value computation does NOT interpret (effect class, named in EFFECT_REFS) and matches legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const legacy = await runAndPull(
        off,
        buildFetchValue,
        { url: "http://mock-test-server.local/api/test" },
        fetchResultSchema,
        "legacy:fetch",
      );
      const beforeOk = on.census().interpreted_ok;
      const beforeIneligible = on.census().fallback_by_reason.ineligible_opkind;
      const beforeUnresolved = on.census().fallback_by_reason.unresolved_leaf;
      const interp = await runAndPull(
        on,
        buildFetchValue,
        { url: "http://mock-test-server.local/api/test" },
        fetchResultSchema,
        "interp:fetch",
      );
      const after = on.census();

      // Fell back, did NOT interpret (no silent admit-and-mis-evaluate of an
      // effect/stream/async ref builtin as a pure leaf).
      expect(after.interpreted_ok).toBe(beforeOk);
      // The PRECISE, NAMED reason: `effect` class (via EFFECT_REFS) → the
      // `byKind.effect>0` kind gate. NOT the incidental `unresolved_leaf` gate
      // it used to hit when these refs mis-classified as `leaf`.
      expect(after.fallback_by_reason.ineligible_opkind)
        .toBe(beforeIneligible + 1);
      expect(after.fallback_by_reason.unresolved_leaf)
        .toBe(beforeUnresolved);

      // PARITY: both runs took the same legacy fallback path, so the result deep-
      // eqs — nothing about the fetchData op's value computation was dropped.
      expect(interp).toEqual(legacy);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });
});

describe("prod-wire: collection map dispatch (flag ON, single map)", () => {
  // A single top-level `map` over a bare scalar element op is now the ELIGIBLE
  // collection shape — it dispatches through the registered `$ri-collection-map`
  // builtin (the collection branch) rather than falling back. Output parity with
  // legacy is preserved and `interpreted_ok` rises by exactly one (the outer map
  // interpreted once; per-element work is NOT done as sub-patterns). The richer
  // collection oracle (footprint slope, pointwise labels, reactivity, and the
  // filter/flatMap/scoped/nested-pattern NEGATIVE axes) lives in
  // `collection-prod-wire.test.ts`.
  async function runMap(env: Env, cause: string): Promise<unknown> {
    const { runtime, cf, space } = env;
    const inc = cf.lift((x: number) => x + 1, num, num);
    const collectionPattern = cf.pattern(({ values }: any) => ({
      out: values.mapWithPattern(
        cf.pattern(({ element }: any) => inc(element)),
        {},
      ),
    }));

    const tx = runtime.edit();
    const valuesIn = runtime.getCell(space, `${cause}:list`, undefined, tx);
    valuesIn.set([1, 2, 3]);
    const res = runtime.getCell(space, `${cause}:res`, undefined, tx);
    const r = runtime.run(tx, collectionPattern, { values: valuesIn }, res);
    await tx.commit();
    await runtime.idle();
    r.sink(() => {});
    await runtime.idle();
    return await r.pull();
  }

  it("a single map dispatches through the collection interpreter and matches legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const legacy = await runMap(off, "legacy:map");
      const before = on.census().interpreted_ok;
      const interp = await runMap(on, "interp:map");
      const after = on.census();

      // Same materialized result — element-for-element parity with legacy.
      expect(interp).toEqual(legacy);
      expect(interp).toEqual({ out: [2, 3, 4] });
      // The outer map went THROUGH the collection interpreter (interpreted_ok
      // rose by exactly one — the single map node), with NO fallback recorded.
      expect(after.interpreted_ok).toBe(before + 1);
      expect(after.fallback_by_reason.ineligible_opkind).toBe(0);
      expect(after.fallback_by_reason.unrecognized_alias).toBe(0);
      expect(after.fallback_by_reason.unresolved_leaf).toBe(0);
      expect(after.fallback_by_reason.scoped).toBe(0);
      expect(after.fallback_by_reason.eval_threw).toBe(0);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 2(b) PRODUCER-FED READ-ONLY CONTEXT LEAF.
// A pure lift whose `asCell` INPUT is fed by an INTERNAL/opOut PRODUCER (another
// lift's output), not a pattern argument. Pre-2(b) the interpreter held the
// producer's PLAIN value, so the leaf's `.get()` would throw → the leaf stayed a
// legacy `unresolved-leaf` boundary. 2(b) builds a READ-ONLY Cell VIEW of the
// producer value and overlays it onto the leaf input so the leaf interprets. A
// handler boundary keeps the pattern on the PARTITION path (where the cell-view
// overlay is wired). The differential oracle proves the leaf output matches legacy
// AND the leaf is genuinely INTERPRETED (no `unresolved_leaf` fallback).
// ---------------------------------------------------------------------------
const producerFedResultSchema = {
  type: "object",
  properties: { doubled: num, summary: num, bump: { asStream: true } },
} as JSONSchema;

// ({ x }) => {
//   const doubled = double(x);              // producer lift → internal cell
//   const summary = summarize(doubled);     // asCell-input leaf reads doubled.get()
//   const bump = handler(...);              // boundary → partition path
//   return { doubled, summary, bump: bump({ x }) };
// }
// deno-lint-ignore no-explicit-any
function buildProducerFedContextLeaf(cf: any) {
  const double = cf.lift((x: number) => x * 2, num, num);
  // The context leaf: its INPUT schema is `asCell` (it receives a live Cell handle
  // and reads it with `.get()`). Fed by `double(x)` — an internal PRODUCER, the
  // 2(b) shape (not a pattern argument).
  const summarize = cf.lift(
    (c: any) => c.get() + 1,
    { type: "number", asCell: ["readonly"] },
    num,
  );
  return cf.pattern(
    ({ x }: any) => {
      const doubled = double(x);
      const summary = summarize(doubled);
      const bump = cf.handler(
        { type: "object" },
        { type: "object", properties: { x: num } },
        (_e: any, s: any) => {
          s.x = s.x + 1;
        },
      );
      return { doubled, summary, bump: bump({ x }) };
    },
    { type: "object", properties: { x: num } },
    producerFedResultSchema,
  );
}

describe("prod-wire: 2(b) producer-fed read-only context leaf (flag ON)", () => {
  it("interprets an asCell leaf fed by an internal producer + matches legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const legacy = await runAndPull(
        off,
        buildProducerFedContextLeaf,
        { x: 5 },
        producerFedResultSchema,
        "legacy:2b",
      );
      const before = on.census();
      const interp = await runAndPull(
        on,
        buildProducerFedContextLeaf,
        { x: 5 },
        producerFedResultSchema,
        "interp:2b",
      );
      const after = on.census();

      // VALUE PARITY: double(5)=10, summarize(10.get())=10+1=11. The producer-fed
      // context leaf produced the SAME value the legacy binding-layer path does.
      const l = legacy as { doubled?: unknown; summary?: unknown };
      const i = interp as {
        doubled?: unknown;
        summary?: unknown;
        bump?: unknown;
      };
      expect(i.doubled).toEqual(l.doubled);
      expect(i.summary).toEqual(l.summary);
      expect(i.doubled).toEqual(10);
      expect(i.summary).toEqual(11);
      // The handler stream is preserved (the boundary is kept verbatim).
      expect(i.bump).toBeDefined();

      // REAL ENGAGEMENT (not green-via-fallback): the partition interpreted the
      // pure region INCLUDING the producer-fed context leaf — so `interpreted_ok`
      // rose AND `unresolved_leaf` did NOT (the leaf is no longer a boundary).
      expect(after.interpreted_ok).toBe(before.interpreted_ok + 1);
      expect(after.fallback_by_reason.unresolved_leaf).toBe(
        before.fallback_by_reason.unresolved_leaf,
      );
      expect(after.fallback_by_reason.eval_threw).toBe(
        before.fallback_by_reason.eval_threw,
      );
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });

  it("re-runs the 2(b) leaf when its producer changes (reactivity parity)", async () => {
    const on = makeEnv(true);
    try {
      const { runtime, cf, space } = on;
      const double = cf.lift((x: number) => x * 2, num, num);
      const summarize = cf.lift(
        (c: any) => c.get() + 1,
        { type: "number", asCell: ["readonly"] },
        num,
      );
      const pattern = cf.pattern(
        ({ x }: any) => {
          const doubled = double(x);
          const summary = summarize(doubled);
          const bump = cf.handler(
            { type: "object" },
            { type: "object", properties: { x: num } },
            (_e: any, s: any) => {
              s.x = s.x + 1;
            },
          );
          return { doubled, summary, bump: bump({ x }) };
        },
        { type: "object", properties: { x: num } },
        producerFedResultSchema,
      );

      const tx = runtime.edit();
      const argCell = runtime.getCell(space, "2b:react:arg", undefined, tx);
      argCell.set({ x: 5 });
      const res = runtime.getCell(
        space,
        "2b:react:res",
        producerFedResultSchema,
        tx,
      );
      const r = runtime.run(tx, pattern, argCell, res);
      await tx.commit();
      await runtime.idle();
      r.sink(() => {});
      await runtime.idle();
      const first = await r.pull() as { summary?: unknown };
      expect(first.summary).toEqual(11); // double(5)=10, +1=11

      // Change the argument → producer re-derives (double=14) → the 2(b) leaf's
      // read-only view re-reads the fresh producer value → summary=15.
      const atx = runtime.edit();
      argCell.withTx(atx).set({ x: 7 });
      await atx.commit();
      await runtime.idle();
      const second = await r.pull() as { summary?: unknown };
      expect(second.summary).toEqual(15); // double(7)=14, +1=15
    } finally {
      await on.dispose();
    }
  });
});
