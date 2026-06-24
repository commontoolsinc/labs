/**
 * Production wiring of INLINED nested patterns (the `pattern` op) into the
 * Reactive Interpreter, behind the default-OFF `experimentalInterpreter` flag.
 *
 * A TOP-LEVEL, PURE-COMPUTATION, IN-MEMORY nested pattern is now INLINED: the
 * extractor recurses into the sub-pattern and keeps its sub-Rog on the parent's
 * `pattern` op detail; the evaluator runs the sub-Rog in the SAME action against
 * the resolved bound argument. The child mints NO docs — its value flows through
 * the parent's single `$result` egress (the doc-explosion legacy cost removed).
 *
 * Differential oracle (4 axes):
 *   (1) OUTPUT parity — `({x}) => ({inner: child({v:x})})`, child doubles `v`,
 *       x=6 ⇒ {inner:{doubled:12}} deep-eq legacy + interpreted_ok bumped.
 *   (2) FOOTPRINT — independent variable = nested-pattern instance count; the
 *       interpreter pays 0 child docs vs legacy's child result cell + bound-arg
 *       doc + child internals per instance ⇒ interp.docs < legacy.docs.
 *   (3) REACTIVITY — change an input the sub-ROG reads ⇒ result updates.
 *   (4) NEGATIVE — nested-with-collection / nested-with-effect / depth>1 /
 *       scoped / serialized-$patternRef all FALL BACK (right fallback reason)
 *       and match legacy.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";
import { attachDocRecorder } from "../support/interpreter-measure.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { InterpreterCensus } from "../../src/runner.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-nested-prod-wire");
const num = { type: "number" } as const satisfies JSONSchema;

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
    storageManager,
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
type Env = ReturnType<typeof makeEnv>;

const innerResultSchema = {
  type: "object",
  properties: { doubled: num },
} as const satisfies JSONSchema;

// child = ({v}) => ({ doubled: double(v) }); a PURE leaf-only sub-pattern.
// deno-lint-ignore no-explicit-any
function buildOuter(cf: any) {
  const double = cf.lift((v: number) => v * 2, num, num);
  const child = cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ v }: any) => ({ doubled: double(v) }),
    { type: "object", properties: { v: num }, required: ["v"] },
    innerResultSchema,
  );
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ x }: any) => ({ inner: child({ v: x }) }),
    { type: "object", properties: { x: num }, required: ["x"] },
    {
      type: "object",
      properties: { inner: innerResultSchema },
    },
  );
}
const outerResultSchema = {
  type: "object",
  properties: { inner: innerResultSchema },
} as const satisfies JSONSchema;

async function runOuter(
  env: Env,
  // deno-lint-ignore no-explicit-any
  build: (cf: any) => unknown,
  argument: unknown,
  resultSchema: JSONSchema,
  cause: string,
): Promise<unknown> {
  const { runtime, cf, space } = env;
  // deno-lint-ignore no-explicit-any
  const pattern = build(cf) as any;
  const tx = runtime.edit();
  const res = runtime.getCell(space, cause, resultSchema, tx);
  const r = runtime.run(tx, pattern, argument, res);
  await tx.commit();
  await runtime.idle();
  r.sink(() => {});
  await runtime.idle();
  return await r.pull();
}

// ---------------------------------------------------------------------------
// (0) flag OFF leaves the census pristine.
// ---------------------------------------------------------------------------
describe("nested prod-wire: flag OFF (no dispatch)", () => {
  it("flag OFF never enters interpreter dispatch for a nested pattern", async () => {
    const env = makeEnv(false);
    try {
      await runOuter(env, buildOuter, { x: 6 }, outerResultSchema, "off:nest");
      const c = env.census();
      expect(c.interpreted_ok).toBe(0);
      expect(Object.values(c.fallback_by_reason).reduce((a, b) => a + b, 0))
        .toBe(0);
    } finally {
      await env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// (1) OUTPUT parity.
// ---------------------------------------------------------------------------
describe("nested prod-wire: (1) output parity (flag OFF == flag ON)", () => {
  it("a pure inlined nested pattern interprets and deep-eqs legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const legacy = await runOuter(
        off,
        buildOuter,
        { x: 6 },
        outerResultSchema,
        "legacy:nest",
      );
      const before = on.census().interpreted_ok;
      const interp = await runOuter(
        on,
        buildOuter,
        { x: 6 },
        outerResultSchema,
        "interp:nest",
      );
      const after = on.census();
      expect(legacy).toEqual({ inner: { doubled: 12 } });
      expect(interp).toEqual(legacy);
      // Went THROUGH the interpreter (the inlined pattern op), no fallback.
      expect(after.interpreted_ok).toBe(before + 1);
      expect(after.fallback_by_reason.ineligible_opkind).toBe(0);
      expect(after.fallback_by_reason.unrecognized_alias).toBe(0);
      expect(after.fallback_by_reason.unresolved_leaf).toBe(0);
      expect(after.fallback_by_reason.eval_threw).toBe(0);
      expect(after.fallback_by_reason.scoped).toBe(0);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) FOOTPRINT — interpreter pays 0 child docs vs legacy's child result cell +
//     bound-arg doc + child internals PER nested-pattern instance.
//
// Independent variable = nested-pattern INSTANCE COUNT: we instantiate the SAME
// single-child outer pattern N times (N separate `runtime.run` calls), each of
// which inlines its one child under the interpreter (each outer stays eligible —
// `byKind.pattern === 1`). Under legacy each instance instantiates the child as
// a separate pattern (minting its result cell + bound-arg doc + internals);
// under the interpreter the child is inlined and mints NONE of those. So the
// interpreter's total doc footprint over N instances is strictly less than
// legacy's, and grows more slowly in N.
// ---------------------------------------------------------------------------

async function measureNestedDocs(
  flag: boolean,
  n: number,
  prefix: string,
): Promise<{ docs: number; census: InterpreterCensus; outs: unknown[] }> {
  const env = makeEnv(flag);
  const docs = attachDocRecorder(env.storageManager);
  try {
    const { runtime, cf, space } = env;
    // Build the single-child outer ONCE; instantiate it N times.
    const pattern = buildOuter(cf);
    const mark = docs.mark();
    const outs: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const tx = runtime.edit();
      const res = runtime.getCell(
        space,
        `${prefix}:inst:${i}`,
        outerResultSchema,
        tx,
      );
      const r = runtime.run(tx, pattern, { x: i + 1 }, res);
      await tx.commit();
      await runtime.idle();
      r.sink(() => {});
      await runtime.idle();
      outs.push(await r.pull());
    }
    return { docs: mark.createdSince().length, census: env.census(), outs };
  } finally {
    await env.dispose();
  }
}

describe("nested prod-wire: (2) footprint (inlined pays 0 child docs)", () => {
  it("interpreter doc count over N instances is strictly less than legacy and grows more slowly", async () => {
    const legacy4 = await measureNestedDocs(false, 4, "leg4:nest");
    const legacy8 = await measureNestedDocs(false, 8, "leg8:nest");
    const interp4 = await measureNestedDocs(true, 4, "int4:nest");
    const interp8 = await measureNestedDocs(true, 8, "int8:nest");

    // Output parity at every instance.
    const expected = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => ({ inner: { doubled: 2 * (i + 1) } }),
      );
    expect(interp4.outs).toEqual(expected(4));
    expect(interp8.outs).toEqual(expected(8));
    expect(legacy4.outs).toEqual(expected(4));

    // Each outer instance went through the interpreter and inlined its child
    // (no per-instance fallback; one interpreted_ok per instance).
    expect(interp4.census.interpreted_ok).toBe(4);
    expect(interp8.census.interpreted_ok).toBe(8);
    expect(interp8.census.fallback_by_reason.ineligible_opkind).toBe(0);

    // FOOTPRINT: the interpreter pays strictly FEWER docs than legacy at each N
    // (no child result cell / bound-arg doc / child internals minted per
    // instance — the doc-explosion the inlining removes).
    expect(interp4.docs).toBeLessThan(legacy4.docs);
    expect(interp8.docs).toBeLessThan(legacy8.docs);

    // And the legacy per-instance doc slope is strictly steeper than the
    // interpreter's (legacy pays the child-doc tax per instance; the interpreter
    // does not).
    const legacySlope = (legacy8.docs - legacy4.docs) / 4;
    const interpSlope = (interp8.docs - interp4.docs) / 4;
    expect(legacySlope).toBeGreaterThan(interpSlope);
  });
});

// ---------------------------------------------------------------------------
// (3) REACTIVITY.
// ---------------------------------------------------------------------------
describe("nested prod-wire: (3) reactivity (flag ON)", () => {
  it("changing an input the sub-ROG reads updates the inlined result", async () => {
    const env = makeEnv(true);
    try {
      const { runtime, cf, space } = env;
      // Build the pattern ONCE (a builder factory call needs a runtime context);
      // reuse the SAME pattern across both runs.
      const pattern = buildOuter(cf);
      const tx = runtime.edit();
      const res = runtime.getCell(space, "react:nest", outerResultSchema, tx);
      const r = runtime.run(tx, pattern, { x: 10 }, res);
      await tx.commit();
      await runtime.idle();
      r.sink(() => {});
      await runtime.idle();
      expect(await r.pull()).toEqual({ inner: { doubled: 20 } });
      expect(env.census().interpreted_ok).toBeGreaterThan(0);

      // Re-run with a fresh argument on the SAME result cell → the interpreter
      // node reads the argument through the tx, so the sub-ROG re-evaluates.
      const atx = runtime.edit();
      runtime.run(atx, pattern, { x: 50 }, res.withTx(atx));
      await atx.commit();
      await runtime.idle();
      expect(await r.pull()).toEqual({ inner: { doubled: 100 } });
    } finally {
      await env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) NEGATIVE axes — each must FALL BACK and match legacy.
// ---------------------------------------------------------------------------

const sumFallbacks = (c: InterpreterCensus) =>
  Object.values(c.fallback_by_reason).reduce((a, b) => a + b, 0);

// (4a) nested-with-collection: sub-ROG contains a map → ineligible_opkind.
// deno-lint-ignore no-explicit-any
function buildNestedWithCollection(cf: any) {
  const inc = cf.lift((x: number) => x + 1, num, num);
  const child = cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ xs }: any) => ({
      // deno-lint-ignore no-explicit-any
      mapped: xs.mapWithPattern(
        cf.pattern(({ element }: any) => inc(element)),
        {},
      ),
    }),
    {
      type: "object",
      properties: { xs: { type: "array", items: num } },
      required: ["xs"],
    },
    { type: "object", properties: { mapped: { type: "array", items: num } } },
  );
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ values }: any) => ({ inner: child({ xs: values }) }),
    {
      type: "object",
      properties: { values: { type: "array", items: num } },
      required: ["values"],
    },
    {
      type: "object",
      properties: {
        inner: {
          type: "object",
          properties: { mapped: { type: "array", items: num } },
        },
      },
    },
  );
}

// (4b) nested-with-effect: sub-ROG contains a navigateTo effect.
// deno-lint-ignore no-explicit-any
function buildNestedWithEffect(cf: any) {
  const child = cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ v }: any) => ({ go: cf.navigateTo(v) }),
    { type: "object", properties: { v: num }, required: ["v"] },
    { type: "object", properties: { go: {} } },
  );
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ x }: any) => ({ inner: child({ v: x }) }),
    { type: "object", properties: { x: num }, required: ["x"] },
    { type: "object", properties: { inner: { type: "object" } } },
  );
}

// (4b') nested-with-HANDLER: the sub-ROG carries a `cf.handler` node
// (`type:"javascript"`, `wrapper:"handler"`). This is the W5-nested instance of
// the same admit-and-mis-evaluate hole: pre-fix the handler classified as a pure
// `leaf`, so `byKind.effect` stayed 0, the sub-ROG looked pure, the coverage
// gate ADMITTED the nested pattern, and the interpreter dropped the child's
// event stream. The classifier fix makes it `effect`, so `byKind.effect>0` trips
// the nested-pattern gate → legacy fallback (stream preserved).
const str = { type: "string" } as const satisfies JSONSchema;
// deno-lint-ignore no-explicit-any
function buildNestedWithHandler(cf: any) {
  const child = cf.pattern(
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
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ x }: any) => ({ inner: child({ count: x }) }),
    { type: "object", properties: { x: num }, required: ["x"] },
    { type: "object", properties: { inner: { type: "object" } } },
  );
}

// (4b'') nested-with-[UI]-render: the sub-ROG renders an INTERACTIVE vnode whose
// onClick binds a `cf.handler` — so the child carries a handler node. Same gate,
// same fail-closed outcome.
// deno-lint-ignore no-explicit-any
function buildNestedWithUI(cf: any) {
  const child = cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ label }: any) => {
      const onClick = cf.handler(
        { type: "object" },
        { type: "object", properties: { label: str } },
        // deno-lint-ignore no-explicit-any
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
    { type: "object", properties: { label: str } },
  );
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ s }: any) => ({ inner: child({ label: s }) }),
    { type: "object", properties: { s: str }, required: ["s"] },
    { type: "object", properties: { inner: { type: "object" } } },
  );
}

// (4c) depth>1: a nested pattern inside the nested pattern.
// deno-lint-ignore no-explicit-any
function buildDepth2(cf: any) {
  const double = cf.lift((v: number) => v * 2, num, num);
  const inner = cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ v }: any) => ({ doubled: double(v) }),
    { type: "object", properties: { v: num }, required: ["v"] },
    innerResultSchema,
  );
  const mid = cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ w }: any) => ({ m: inner({ v: w }) }),
    { type: "object", properties: { w: num }, required: ["w"] },
    { type: "object", properties: { m: innerResultSchema } },
  );
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ x }: any) => ({ inner: mid({ w: x }) }),
    { type: "object", properties: { x: num }, required: ["x"] },
    {
      type: "object",
      properties: {
        inner: { type: "object", properties: { m: innerResultSchema } },
      },
    },
  );
}

// (4d) scoped: a user-scoped argument the sub-pattern reads through its bound
// argument. The `scope: "user"` narrowing rides on the alias schema, which
// `hasNonDefaultScope` rejects (distinct `scoped` reason).
const userNum = { type: "number", scope: "user" } as JSONSchema;
// deno-lint-ignore no-explicit-any
function buildScoped(cf: any) {
  const double = cf.lift((v: number) => v * 2, num, num);
  const child = cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ v }: any) => ({ doubled: double(v) }),
    { type: "object", properties: { v: num }, required: ["v"] },
    innerResultSchema,
  );
  return cf.pattern(
    // deno-lint-ignore no-explicit-any
    ({ x }: any) => ({ inner: child({ v: x }) }),
    { type: "object", properties: { x: userNum }, required: ["x"] },
    { type: "object", properties: { inner: innerResultSchema } },
  );
}

describe("nested prod-wire: (4) negative axes fall back (flag ON) + match legacy", () => {
  it("nested-with-COLLECTION body falls back (ineligible_opkind) and matches legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const rs = {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: { mapped: { type: "array", items: num } },
          },
        },
      } as const satisfies JSONSchema;
      const arg = { values: [1, 2, 3] };
      const legacy = await runOuter(
        off,
        buildNestedWithCollection,
        arg,
        rs,
        "leg:nc",
      );
      const beforeIneligible = on.census().fallback_by_reason.ineligible_opkind;
      const interp = await runOuter(
        on,
        buildNestedWithCollection,
        arg,
        rs,
        "int:nc",
      );
      // The byKind/nested gate rejects the collection-bearing sub-ROG.
      expect(on.census().fallback_by_reason.ineligible_opkind)
        .toBeGreaterThan(beforeIneligible);
      expect(interp).toEqual(legacy);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });

  it("nested-with-EFFECT body falls back (ineligible_opkind) and matches legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const rs = {
        type: "object",
        properties: { inner: { type: "object" } },
      } as const satisfies JSONSchema;
      const arg = { x: 1 };
      const legacy = await runOuter(
        off,
        buildNestedWithEffect,
        arg,
        rs,
        "leg:ne",
      );
      const before = sumFallbacks(on.census());
      const interp = await runOuter(
        on,
        buildNestedWithEffect,
        arg,
        rs,
        "int:ne",
      );
      // Some fail-closed reason was bumped (the effect in the sub-ROG is caught
      // by the byKind gate — or, if its alias shape trips an earlier gate, that
      // one). The invariant: it did NOT silently interpret an effect-bearing
      // sub-pattern.
      expect(sumFallbacks(on.census())).toBeGreaterThan(before);
      expect(interp).toEqual(legacy);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });

  it("nested-with-HANDLER body falls back (ineligible_opkind) and matches legacy (stream preserved)", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const rs = {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: { count: num, increment: { asStream: true } },
          },
        },
      } as JSONSchema;
      const arg = { x: 0 };
      const legacy = await runOuter(
        off,
        buildNestedWithHandler,
        arg,
        rs,
        "leg:nh",
      );
      const before = on.census().fallback_by_reason.ineligible_opkind;
      const interp = await runOuter(
        on,
        buildNestedWithHandler,
        arg,
        rs,
        "int:nh",
      );
      // The child's handler now classifies as `effect`, so `byKind.effect>0`
      // trips the nested-pattern coverage gate (ineligible_opkind) — the W5
      // instance of the admit-and-mis-evaluate hole, closed.
      expect(on.census().fallback_by_reason.ineligible_opkind)
        .toBeGreaterThan(before);
      // STREAM PRESERVED: legacy resolves the child's `increment` to its event
      // stream; the interpreter (pre-fix) dropped it. The stream cell's internal
      // identity differs across the two runtimes, so assert PRESENCE + value
      // parity (not a cross-runtime deep identity). Pre-fix the key was ABSENT.
      const l = legacy as { inner?: { count?: unknown; increment?: unknown } };
      const i = interp as { inner?: { count?: unknown; increment?: unknown } };
      expect(l.inner?.increment).toBeDefined();
      expect(i.inner?.increment).toBeDefined();
      expect(i.inner?.count).toEqual(l.inner?.count);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });

  it("nested-with-[UI]-render body falls back (ineligible_opkind) and matches legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const rs = {
        type: "object",
        properties: {
          inner: { type: "object", properties: { label: str } },
        },
      } as const satisfies JSONSchema;
      const arg = { s: "hi" };
      const legacy = await runOuter(off, buildNestedWithUI, arg, rs, "leg:nui");
      const before = on.census().fallback_by_reason.ineligible_opkind;
      const interp = await runOuter(on, buildNestedWithUI, arg, rs, "int:nui");
      // The interactive render's handler node classifies as `effect` → the
      // nested-pattern gate rejects the child → legacy fallback.
      expect(on.census().fallback_by_reason.ineligible_opkind)
        .toBeGreaterThan(before);
      expect(interp).toEqual(legacy);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });

  it("DEPTH>1 nested pattern falls back (ineligible_opkind) and matches legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const rs = {
        type: "object",
        properties: {
          inner: { type: "object", properties: { m: innerResultSchema } },
        },
      } as const satisfies JSONSchema;
      const arg = { x: 6 };
      const legacy = await runOuter(off, buildDepth2, arg, rs, "leg:d2");
      const before = on.census().fallback_by_reason.ineligible_opkind;
      const interp = await runOuter(on, buildDepth2, arg, rs, "int:d2");
      // byKind.pattern > 1 (or nested > 1) → ineligible_opkind.
      expect(on.census().fallback_by_reason.ineligible_opkind)
        .toBeGreaterThan(before);
      expect(interp).toEqual({ inner: { m: { doubled: 12 } } });
      expect(interp).toEqual(legacy);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });

  it("SCOPED (user-scoped argument) falls back (scoped) and matches legacy", async () => {
    const off = makeEnv(false);
    const on = makeEnv(true);
    try {
      const arg = { x: 6 };
      const before = on.census().fallback_by_reason.scoped;
      const interp = await runOuter(
        on,
        buildScoped,
        arg,
        outerResultSchema,
        "int:sc",
      );
      const legacy = await runOuter(
        off,
        buildScoped,
        arg,
        outerResultSchema,
        "leg:sc",
      );
      // The scope narrowing is rejected for the distinct `scoped` reason.
      expect(on.census().fallback_by_reason.scoped).toBeGreaterThan(before);
      expect(interp).toEqual(legacy);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });
});
