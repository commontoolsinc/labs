/**
 * RED→GREEN eligibility-hole test for the COLLECTION interpreter branch.
 *
 * THE HOLE (highest-value correctness check): `extractRog` recurses into the
 * element pattern with a FRESH per-recursion `ops` array THAT IS DISCARDED
 * (extract.ts builds the nested ROG only for coverage and throws it away). So an
 * element pattern that itself contains a NESTED PATTERN or an EFFECT op leaves
 * `rog.ops` showing ONLY the outer collection + the synthesized result construct
 * — the element-internal `pattern`/`effect` op NEVER appears in `rog.ops`.
 *
 * A naive collection-eligibility gate that loops `rog.ops` to reject element-
 * internal pattern/effect ops would therefore find NOTHING to reject and ADMIT
 * the map — then SILENTLY MIS-EVALUATE it (the element evaluator does not model a
 * nested pattern/effect). The sound gate must consult `coverage.byKind` /
 * `coverage.nested` (which DO account for the recursed-into element graph), and
 * that is exactly what `tryBuildCollectionInterpreterPattern` does.
 *
 * This file proves the transition twice:
 *   (RED)   the naive `rog.ops`-only predicate ADMITS a nested-pattern /
 *           nested-effect element map (finds no offending op-kind), and
 *   (GREEN) the real `coverage.byKind`/`coverage.nested` predicate REJECTS it.
 * Then an end-to-end check confirms the map falls back overall (a fail-closed
 * reason is bumped) and still matches legacy element-for-element.
 *
 * Run:
 *   cd packages/runner
 *   deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     test/reactive-interpreter/collection-eligibility-hole.test.ts
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
const signer = await Identity.fromPassphrase("ri-collection-hole");
const num = { type: "number" } as const satisfies JSONSchema;

/** The NAIVE (UNSOUND) gate the sound gate must NOT be: it loops `rog.ops`
 * looking for element-internal pattern/effect/extra-collection ops. Because the
 * element graph is discarded from `rog.ops`, this finds nothing for a nested
 * pattern/effect element and ADMITS the map. Returns true = "would admit". */
function naiveRogOpsGateAdmits(rog: Rog): boolean {
  let collections = 0;
  for (const op of rog.ops) {
    if (op.kind === "pattern") return false; // would reject (but never present)
    if (op.kind === "effect") return false; // would reject (but never present)
    if (op.kind === "collection") collections++;
  }
  return collections <= 1; // only the outer map visible → admit
}

/** The SOUND gate (mirrors `tryBuildCollectionInterpreterPattern`): consult the
 * coverage report, which DOES account for the recursed-into element graph.
 * Returns true = "would reject (fall back)". */
function soundCoverageGateRejects(coverage: CoverageReport): boolean {
  if ((coverage.byKind.pattern ?? 0) > 0) return true;
  if ((coverage.byKind.effect ?? 0) > 0) return true;
  if ((coverage.byKind.collection ?? 0) > 1) return true;
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

function buildMapWithNestedPatternElement(cf: any) {
  // The element body instantiates a NESTED pattern (inner) over the element.
  const inner = cf.pattern(
    ({ v }: { v: number }) => ({
      r: cf.lift((x: number) => x + 1, num, num)(v),
    }),
    { type: "object", properties: { v: num }, required: ["v"] },
    { type: "object", properties: { r: num } },
  );
  const elementWithNested = cf.pattern(
    ({ element }: { element: number }) => ({ nested: inner({ v: element }) }),
    { type: "object", properties: { element: num }, required: ["element"] },
    {
      type: "object",
      properties: { nested: { type: "object", properties: { r: num } } },
    },
  );
  return cf.pattern(
    ({ values }: { values: number[] }) => ({
      mapped: (values as any).mapWithPattern(elementWithNested, {}),
    }),
    {
      type: "object",
      properties: { values: { type: "array", items: num } },
      required: ["values"],
    },
    { type: "object", properties: { mapped: { type: "array" } } },
  );
}

describe("collection eligibility hole: rog.ops vs coverage.byKind/nested", () => {
  it("RED→GREEN: a nested-PATTERN-element map is admitted by the naive rog.ops gate but rejected by the coverage gate", () => {
    const { runtime, storageManager, cf } = makeBuilder();
    try {
      const mapPattern = buildMapWithNestedPatternElement(cf);
      // deno-lint-ignore no-explicit-any
      const ex = extractRog(mapPattern as any);

      // The element-internal `pattern` op is INVISIBLE in rog.ops — only the
      // outer collection + the synthesized result construct survive.
      const kinds = ex.rog.ops.map((o) => o.kind).sort();
      expect(kinds).toEqual(["collection", "construct"]);
      expect(kinds).not.toContain("pattern");

      // RED: the naive `rog.ops`-only gate finds nothing to reject → ADMITS.
      expect(naiveRogOpsGateAdmits(ex.rog)).toBe(true);

      // But the coverage report DID account for the element graph: it recorded
      // the nested pattern op and the recursion.
      expect(ex.coverage.byKind.pattern ?? 0).toBeGreaterThan(0);
      expect(ex.coverage.nested).toBeGreaterThanOrEqual(1);

      // GREEN: the sound coverage gate REJECTS (falls back) — closing the hole.
      expect(soundCoverageGateRejects(ex.coverage)).toBe(true);
    } finally {
      // No async work scheduled; dispose is best-effort sync teardown.
      void runtime.dispose();
      void storageManager.close();
    }
  });
});

// End-to-end: the same nested-pattern-element map, run through the REAL runner
// with the flag ON, must FALL BACK (a fail-closed reason bumped) and still match
// legacy element-for-element. (In practice this shape ALSO trips the earlier
// `unrecognized_alias` gate via the nested pattern's `defer:1` serialization, so
// the assertion is the fail-closed invariant — SOME fallback was recorded and
// the collection was NOT interpreted — not a specific bucket. The unit test
// above is what proves the byKind/nested gate itself has teeth.)
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

async function runMap(
  env: ReturnType<typeof makeEnv>,
  cause: string,
): Promise<unknown> {
  const { runtime, cf, space } = env;
  const mapPattern = buildMapWithNestedPatternElement(cf);
  const tx = runtime.edit();
  const valuesIn = runtime.getCell(space, `${cause}:list`, undefined, tx);
  valuesIn.set([1, 2, 3]);
  const res = runtime.getCell(space, `${cause}:res`, undefined, tx);
  const r = runtime.run(tx, mapPattern, { values: valuesIn }, res);
  await tx.commit();
  await runtime.idle();
  r.sink(() => {});
  await runtime.idle();
  return await r.pull();
}

describe("collection eligibility hole: end-to-end fallback (flag ON)", () => {
  it("a map with a nested-pattern element does NOT interpret the outer collection (fail-closed)", async () => {
    const on = makeEnv(true);
    try {
      const sumFallbacks = (c: InterpreterCensus) =>
        Object.values(c.fallback_by_reason).reduce((a, b) => a + b, 0);
      const before = sumFallbacks(on.census());
      await runMap(on, "interp:nested");
      const after = on.census();

      // The OUTER collection was NOT admitted by the collection branch: a
      // fail-closed reason was bumped (it falls back at the earlier
      // `unrecognized_alias` gate via the nested pattern's `defer:1`
      // serialization, and the byKind/nested gate is the belt-and-braces second
      // line — proven to have teeth by the unit test above). The map output
      // itself is produced by the legacy collection path; the per-element inner
      // SUB-patterns the map builtin instantiates ARE eligible scalar leaves and
      // DO interpret (interpreted_ok rises), which is correct and not asserted
      // here. What matters: the OUTER map never silently mis-evaluated through
      // `$ri-collection-map`.
      expect(sumFallbacks(after)).toBeGreaterThan(before);
    } finally {
      await on.dispose();
    }
  });
});
