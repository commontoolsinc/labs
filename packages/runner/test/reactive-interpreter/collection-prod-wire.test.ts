/**
 * PROD-PATH differential oracle for the COLLECTION interpreter branch.
 *
 * Unlike `collection-interpret.test.ts` (which registers `mapInterpreted` via a
 * test-only `addModuleByRef`), every case here runs through the REAL
 * `runtime.run` / `instantiatePattern` machinery with the `experimentalInterpreter`
 * flag ON, so the map dispatches through the runner's collection-eligibility
 * branch → the flag-gated `$ri-collection-map` registration. This is the gate
 * seed that guards the production wiring.
 *
 * Five axes:
 *   (1) OUTPUT parity element-for-element + `interpreted_ok` bumped (the outer
 *       map went through the collection interpreter, not a silent fallback).
 *   (2) FOOTPRINT via `attachDocRecorder`: interpreter slope ≤1.5 doc/element vs
 *       legacy ≥2.5 at N=5/20 — the only axis distinguishing a real interpret
 *       from a fallback (a fallback would match legacy's slope).
 *   (3) POINTWISE labels (cfc "observe" + flow "persist"): 2 labeled + 2 clean
 *       indices, `interp.confs[i]` deep-eq `legacy.confs[i]`, PLUS two teeth so
 *       the oracle is not vacuous:
 *         - live-probe non-vacuity (a labeled index returns a NON-EMPTY derived
 *           set, so the empty clean-index sets are a real signal, not a dead
 *           probe) — guards against a coordinator batch-smear; and
 *         - production-dispatch read-isolation teeth: a deliberately-BROKEN
 *           collection-`map` interpreter (a faithful mirror of the production
 *           builtin with the per-element read-set widened to slotLink(i) AND
 *           slotLink(i+1)) IS caught — the sibling's atom rides mapped[i] —
 *           while the REAL single-slot builtin (collection-interpreter.ts
 *           `reads:[linkAddr]`) does NOT pick the sibling up. This is exactly the
 *           pointwise property the map-wiring change protects. (The prototype-
 *           level proof of the same read-isolation teeth lives in
 *           test/spike-cfc-oracle.test.ts's "sibling-bug" mode.)
 *   (4) REACTIVITY: an element-value change re-runs ONLY mapped[i]; a list-length
 *       change reconciles (grow/shrink updates the result).
 *   (5) NEGATIVE: filter, flatMap, scoped collection, and map-with-nested-pattern
 *       element all FALL BACK (a fail-closed reason bumped) with output still
 *       matching legacy.
 *
 * Run:
 *   cd packages/runner
 *   deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     test/reactive-interpreter/collection-prod-wire.test.ts
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";
import { attachDocRecorder } from "../support/interpreter-measure.ts";
import { brokenSiblingCollectionInterpreter } from "../support/broken-collection-interpreter.ts";
import { raw } from "../../src/module.ts";
import type { Cell, JSONSchema } from "../../src/builder/types.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { InterpreterCensus } from "../../src/runner.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-collection-prod-wire");
const space = signer.did() as MemorySpace;
const num = { type: "number" } as const satisfies JSONSchema;
const elementResultSchema = {
  type: "object",
  properties: { doubled: num },
} as const satisfies JSONSchema;

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

// Element op: a leaf (x*2) feeding an object construct {doubled} — a multi-op
// element ROG (leaf → construct), not just a bare leaf.
function buildMapPattern(cf: any) {
  const double = cf.lift((x: number) => x * 2, num, num);
  const elementPattern = cf.pattern(
    ({ element }: { element: number }) => ({ doubled: double(element) }),
    { type: "object", properties: { element: num }, required: ["element"] },
    elementResultSchema,
  );
  return cf.pattern(
    ({ values }: { values: number[] }) => ({
      mapped: (values as any).mapWithPattern(elementPattern, {}),
    }),
    {
      type: "object",
      properties: { values: { type: "array", items: num } },
      required: ["values"],
    },
    {
      type: "object",
      properties: { mapped: { type: "array", items: elementResultSchema } },
    },
  );
}

// ---------------------------------------------------------------------------
// (1)+(2) Output parity + footprint.
// ---------------------------------------------------------------------------

interface Measurement {
  mapped: Array<{ doubled: number }>;
  docs: number;
  census: InterpreterCensus;
}

async function measure(
  flag: boolean,
  prefix: string,
  N: number,
): Promise<Measurement> {
  const env = makeEnv(flag);
  const docs = attachDocRecorder(env.storageManager);
  try {
    const { runtime, cf } = env;
    // Seed N item docs BEFORE the measurement window (inputs, not scaffold).
    const seedTx = runtime.edit();
    const items: Cell<number>[] = [];
    for (let i = 0; i < N; i++) {
      const c = runtime.getCell<number>(
        space,
        `${prefix}:item:${i}`,
        num,
        seedTx,
      );
      c.set(i + 1);
      items.push(c);
    }
    await seedTx.commit();
    await runtime.idle();

    const mark = docs.mark();
    const tx = runtime.edit();
    const valuesCell = runtime.getCell<number[]>(
      space,
      `${prefix}:values`,
      { type: "array", items: num },
      tx,
    );
    valuesCell.set(items as unknown as number[]);
    const resultCell = runtime.getCell(
      space,
      `${prefix}:result`,
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      buildMapPattern(cf),
      { values: valuesCell },
      resultCell,
    );
    await tx.commit();
    await runtime.idle();
    const mappedCell = result.key("mapped") as Cell<Array<{ doubled: number }>>;
    const cancel = mappedCell.sink(() => {});
    await runtime.idle();
    await mappedCell.pull();
    await runtime.idle();

    const created = mark.createdSince().length;
    const mapped = mappedCell.get() as Array<{ doubled: number }>;
    cancel();
    return { mapped, docs: created, census: env.census() };
  } finally {
    await env.dispose();
  }
}

describe("collection prod-wire: (1) output parity + (2) footprint slope", () => {
  it("interpreter map output == legacy element-for-element; footprint ~1/el vs legacy ~3/el", async () => {
    const legacy5 = await measure(false, "leg5", 5);
    const legacy20 = await measure(false, "leg20", 20);
    const interp5 = await measure(true, "int5", 5);
    const interp20 = await measure(true, "int20", 20);

    // (1) OUTPUT PARITY at both N, and the outer map WENT THROUGH the collection
    // interpreter (interpreted_ok rose; not a silent fallback).
    expect(interp5.mapped).toEqual(legacy5.mapped);
    expect(interp20.mapped).toEqual(legacy20.mapped);
    expect(interp5.mapped).toEqual(
      Array.from({ length: 5 }, (_, i) => ({ doubled: (i + 1) * 2 })),
    );
    expect(interp5.census.interpreted_ok).toBeGreaterThan(0);
    expect(interp20.census.interpreted_ok).toBeGreaterThan(0);
    expect(legacy5.census.interpreted_ok).toBe(0); // flag off → never dispatched

    const legSlope = (legacy20.docs - legacy5.docs) / (20 - 5);
    const intSlope = (interp20.docs - interp5.docs) / (20 - 5);
    console.log(
      `\n[coll prod-wire footprint] legacy:  N=5 ${legacy5.docs}d  N=20 ${legacy20.docs}d  slope=${legSlope}/el`,
    );
    console.log(
      `[coll prod-wire footprint] interp:  N=5 ${interp5.docs}d  N=20 ${interp20.docs}d  slope=${intSlope}/el`,
    );
    console.log(
      `[coll prod-wire footprint] doc reduction: ${
        (legacy20.docs / interp20.docs).toFixed(2)
      }x fewer @N=20; slope ${(legSlope / intSlope).toFixed(2)}x lower\n`,
    );

    // (2) FOOTPRINT: interpreter slope ≤1.5 doc/element, legacy ≥2.5 — the only
    // axis distinguishing a real interpret from a fallback (a fallback would
    // share legacy's slope).
    expect(interp5.docs).toBeLessThan(legacy5.docs);
    expect(interp20.docs).toBeLessThan(legacy20.docs);
    expect(intSlope).toBeLessThanOrEqual(1.5);
    expect(legSlope).toBeGreaterThanOrEqual(2.5);
    expect(legSlope / intSlope).toBeGreaterThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// (3) Pointwise labels.
// ---------------------------------------------------------------------------

/** Run a scalar map (`element*2`) under cfc "observe" + flow "persist" over N
 * element docs, some seeded with a per-element confidentiality atom, and probe
 * the DERIVED confidentiality that lands on each `mapped[i]`. Pointwise isolation
 * means atom i rides ONLY mapped[i] (the per-element effect reads only element i
 * in its own tx). */
async function runPointwise(
  flag: boolean,
  atoms: (string | undefined)[],
): Promise<{ mapped: number[]; confs: string[][] }> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    experimental: { experimentalInterpreter: flag },
    cfcEnforcementMode: "observe",
    cfcFlowLabels: "persist",
  });
  // deno-lint-ignore no-explicit-any
  const { commonfabric } = createTrustedBuilder(runtime) as any;
  const cf = commonfabric;
  try {
    const prefix = `${flag ? "interp" : "legacy"}-pw`;
    // Seed N labeled element docs.
    const items: Cell<number>[] = [];
    for (let i = 0; i < atoms.length; i++) {
      const seed = runtime.edit();
      const cell = runtime.getCell<number>(
        space,
        `${prefix}-el-${i}`,
        undefined,
        seed,
      );
      const id = cell.getAsNormalizedFullLink().id;
      seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
        value: i + 1,
        ...(atoms[i]
          ? {
            cfc: {
              version: 1,
              schemaHash: "seed-schema",
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: [atoms[i]] },
                }],
              },
            },
          }
          : {}),
      });
      expect((await seed.commit()).ok).toBeDefined();
      items.push(cell);
    }

    const elementPattern = cf.pattern(
      ({ element }: { element: number }) =>
        cf.lift((x: number) => x * 2, num, num)(element),
      { type: "object", properties: { element: num }, required: ["element"] },
      num,
    );

    const collectionPattern = cf.pattern(
      ({ values }: { values: number[] }) => ({
        mapped: (values as any).mapWithPattern(elementPattern, {}),
      }),
      {
        type: "object",
        properties: { values: { type: "array", items: num } },
        required: ["values"],
      },
      { type: "object", properties: { mapped: { type: "array", items: num } } },
    );

    const tx = runtime.edit();
    const listCell = runtime.getCell<number[]>(
      space,
      `${prefix}-list`,
      { type: "array", items: { asCell: ["cell"] } },
      tx,
    );
    listCell.set(items as unknown as number[]);
    const resultCell = runtime.getCell(
      space,
      `${prefix}-result`,
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: listCell },
      resultCell,
    );
    await tx.commit();
    await result.pull();
    await runtime.idle();
    // deno-lint-ignore no-explicit-any
    const mappedCell = result.key("mapped") as any;
    mappedCell.sink(() => {});
    await runtime.idle();
    await mappedCell.pull();
    await runtime.idle();

    const derivedConfidentiality = (id: string): string[] => {
      const replica = storageManager.open(space).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<
                {
                  path: string[];
                  label: { confidentiality?: string[] };
                  origin?: string;
                }
              >;
            };
          };
        } | undefined;
      };
      return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
        .filter((e) => e.origin === "derived")
        .flatMap((e) => e.label.confidentiality ?? [])
        .sort();
    };

    const probe = async (index: number): Promise<string[]> => {
      const ptx = runtime.edit();
      const value = mappedCell.key(index).withTx(ptx).get();
      const out = runtime.getCell(
        space,
        `${prefix}-probe-${index}`,
        undefined,
        ptx,
      );
      out.set({ copied: value });
      ptx.prepareCfc();
      expect((await ptx.commit()).ok).toBeDefined();
      return derivedConfidentiality(out.getAsNormalizedFullLink().id);
    };

    const mapped = mappedCell.get() as number[];
    const confs: string[][] = [];
    for (let i = 0; i < atoms.length; i++) confs.push(await probe(i));
    return { mapped, confs };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

/**
 * TEETH for the pointwise oracle, at the production-dispatch level. Identical to
 * `runPointwise` (same labeled seeding, same scalar element pattern, same
 * derived-confidentiality probe), EXCEPT the collection map is dispatched
 * through a deliberately-BROKEN collection-`map` interpreter whose per-element
 * effect reads `slotLink(i)` AND `slotLink(i+1)` — the precise read-isolation
 * violation the production single-slot read-set (`reads:[linkAddr]`) protects
 * against. The broken variant is a faithful mirror of the production builtin
 * (real `evalRog`, real harness, identity-only coordinator read, per-element
 * docs); only the read-set is widened. It is registered under its OWN test ref
 * and invoked via `byRef` (the `{list, op}` contract) so it NEVER masquerades as
 * the real `$ri-collection-map`. If the production builtin ever regressed to a
 * wider read-set, `mapped[i]` would pick up the sibling's atom exactly as the
 * broken variant does here — so the clean-path pointwise assertions in axis (3)
 * are non-vacuous.
 */
async function runPointwiseBroken(
  atoms: (string | undefined)[],
): Promise<{ mapped: number[]; confs: string[][] }> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // Flag OFF: the real `$ri-collection-map` is never registered; the map is
    // dispatched ONLY through the broken ref below, so this measures the broken
    // variant in isolation (no chance of the clean builtin shadowing it).
    experimental: { experimentalInterpreter: false },
    cfcEnforcementMode: "observe",
    cfcFlowLabels: "persist",
  });
  runtime.moduleRegistry.addModuleByRef(
    "$ri-collection-map-BROKEN-sibling",
    // deno-lint-ignore no-explicit-any
    raw(brokenSiblingCollectionInterpreter()) as any,
  );
  // deno-lint-ignore no-explicit-any
  const { commonfabric } = createTrustedBuilder(runtime) as any;
  const cf = commonfabric;
  try {
    const prefix = "broken-pw";
    const items: Cell<number>[] = [];
    for (let i = 0; i < atoms.length; i++) {
      const seed = runtime.edit();
      const cell = runtime.getCell<number>(
        space,
        `${prefix}-el-${i}`,
        undefined,
        seed,
      );
      const id = cell.getAsNormalizedFullLink().id;
      seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
        value: i + 1,
        ...(atoms[i]
          ? {
            cfc: {
              version: 1,
              schemaHash: "seed-schema",
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: [atoms[i]] },
                }],
              },
            },
          }
          : {}),
      });
      expect((await seed.commit()).ok).toBeDefined();
      items.push(cell);
    }

    // Same scalar element pattern as `runPointwise`, passed as `op` (the broken
    // coordinator reads it raw and evaluates it via `evalRog`, like production).
    const elementPattern = cf.pattern(
      ({ element }: { element: number }) =>
        cf.lift((x: number) => x * 2, num, num)(element),
      { type: "object", properties: { element: num }, required: ["element"] },
      num,
    );

    const collectionPattern = cf.pattern(
      ({ values }: { values: number[] }) => ({
        mapped: (cf.byRef("$ri-collection-map-BROKEN-sibling") as any)({
          list: values,
          op: elementPattern,
        }),
      }),
      {
        type: "object",
        properties: { values: { type: "array", items: num } },
        required: ["values"],
      },
      { type: "object", properties: { mapped: { type: "array", items: num } } },
    );

    const tx = runtime.edit();
    const listCell = runtime.getCell<number[]>(
      space,
      `${prefix}-list`,
      { type: "array", items: { asCell: ["cell"] } },
      tx,
    );
    listCell.set(items as unknown as number[]);
    const resultCell = runtime.getCell(
      space,
      `${prefix}-result`,
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      collectionPattern,
      { values: listCell },
      resultCell,
    );
    await tx.commit();
    await result.pull();
    await runtime.idle();
    // deno-lint-ignore no-explicit-any
    const mappedCell = result.key("mapped") as any;
    mappedCell.sink(() => {});
    await runtime.idle();
    await mappedCell.pull();
    await runtime.idle();

    const derivedConfidentiality = (id: string): string[] => {
      const replica = storageManager.open(space).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<
                {
                  path: string[];
                  label: { confidentiality?: string[] };
                  origin?: string;
                }
              >;
            };
          };
        } | undefined;
      };
      return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
        .filter((e) => e.origin === "derived")
        .flatMap((e) => e.label.confidentiality ?? [])
        .sort();
    };

    const probe = async (index: number): Promise<string[]> => {
      const ptx = runtime.edit();
      const value = mappedCell.key(index).withTx(ptx).get();
      const out = runtime.getCell(
        space,
        `${prefix}-probe-${index}`,
        undefined,
        ptx,
      );
      out.set({ copied: value });
      ptx.prepareCfc();
      expect((await ptx.commit()).ok).toBeDefined();
      return derivedConfidentiality(out.getAsNormalizedFullLink().id);
    };

    const mapped = mappedCell.get() as number[];
    const confs: string[][] = [];
    for (let i = 0; i < atoms.length; i++) confs.push(await probe(i));
    return { mapped, confs };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("collection prod-wire: (3) pointwise labels", () => {
  it("per-element secrets stay on their own index, parity with legacy", async () => {
    const atoms = ["alice-secret", "bob-secret", undefined, undefined];
    const legacy = await runPointwise(false, atoms);
    const interp = await runPointwise(true, atoms);

    console.log(
      "\n[coll prod-wire pointwise] legacy mapped =",
      JSON.stringify(legacy.mapped),
    );
    console.log(
      "[coll prod-wire pointwise] interp mapped =",
      JSON.stringify(interp.mapped),
    );
    interp.confs.forEach((c, i) =>
      console.log(
        `[coll prod-wire pointwise] interp mapped[${i}] conf = ${
          JSON.stringify(c)
        }`,
      )
    );
    console.log();

    expect(interp.mapped).toEqual(legacy.mapped);
    // index 0 carries ONLY alice, 1 ONLY bob, 2/3 clean — no cross-element smear.
    expect(interp.confs[0]).toContainEqual("alice-secret");
    expect(interp.confs[0]).not.toContainEqual("bob-secret");
    expect(interp.confs[1]).toContainEqual("bob-secret");
    expect(interp.confs[1]).not.toContainEqual("alice-secret");
    expect(interp.confs[2]).not.toContainEqual("alice-secret");
    expect(interp.confs[2]).not.toContainEqual("bob-secret");
    expect(interp.confs[3]).not.toContainEqual("alice-secret");
    expect(interp.confs[3]).not.toContainEqual("bob-secret");
    // Differential parity: identical taint set at each index as legacy.
    for (let i = 0; i < atoms.length; i++) {
      expect(interp.confs[i]).toEqual(legacy.confs[i]);
    }

    // TEETH / non-vacuity: the probe is LIVE — a labeled index returns a
    // NON-EMPTY derived-confidentiality set. So the EMPTY sets at the clean
    // indices (2/3) are a real isolation signal, not a dead probe that always
    // returns []. A batched (non-pointwise) coordinator would smear alice+bob
    // onto EVERY index — exactly the assertions above (confs[2]/confs[3] not
    // containing alice/bob) that this teeth guard proves are non-trivial.
    expect(interp.confs[0].length).toBeGreaterThan(0);
    expect(interp.confs[1].length).toBeGreaterThan(0);
    expect(interp.confs[2].length).toBe(0);
    expect(interp.confs[3].length).toBe(0);
  });

  // TEETH at the production-dispatch level: prove the per-element read-isolation
  // (the single-slot `reads:[linkAddr]` in collection-interpreter.ts) is what
  // makes the pointwise assertions above non-vacuous. A deliberately-broken
  // collection-`map` interpreter — a faithful mirror of the production builtin
  // (real evalRog / harness / identity-only coordinator read / per-element docs)
  // with EXACTLY ONE change: each per-element effect reads slotLink(i) AND
  // slotLink(i+1) — IS CAUGHT: the sibling's confidentiality atom rides
  // mapped[i]. The REAL builtin (single-slot reads) does NOT pick the sibling
  // up, so the read-isolation it enforces is precisely the load-bearing
  // property. The broken variant lives behind its own test ref (registered via
  // addModuleByRef, invoked by byRef) — production collection-interpreter.ts
  // stays clean and is never shadowed.
  it("sibling-reading element op IS caught (oracle has teeth); real path is clean", async () => {
    const atoms = ["alice-secret", "bob-secret", undefined, undefined];
    // Broken variant: per-element effect reads slotLink(i)+slotLink(i+1).
    const broken = await runPointwiseBroken(atoms);
    // Real production dispatch: single-slot per-element reads (flag ON).
    const real = await runPointwise(true, atoms);

    broken.confs.forEach((c, i) =>
      console.log(
        `[coll prod-wire teeth] BROKEN mapped[${i}] conf = ${
          JSON.stringify(c)
        }`,
      )
    );
    real.confs.forEach((c, i) =>
      console.log(
        `[coll prod-wire teeth] REAL   mapped[${i}] conf = ${
          JSON.stringify(c)
        }`,
      )
    );
    console.log();

    // Sanity: identical mapped values — the violation is the READ, not the math.
    expect(broken.mapped).toEqual(real.mapped);

    // CAUGHT: element 0's effect illegally read element 1, so element 1's secret
    // smears onto mapped[0]; likewise bob (idx1) reads idx2-clean so picks up
    // nothing extra, but alice (idx0) → bob and idx1 → idx2(clean). The
    // diagnostic teeth: a clean index that the REAL path keeps clean is NOT
    // clean under the broken read-set.
    expect(broken.confs[0]).toContainEqual("bob-secret"); // idx0 read sibling 1
    // The REAL path keeps idx0 free of bob (single-slot read) — pointwise holds.
    expect(real.confs[0]).not.toContainEqual("bob-secret");
    expect(real.confs[0]).toContainEqual("alice-secret");

    // The teeth are non-trivial: under the broken read-set the smear is REAL
    // (broken.confs[0] strictly contains a sibling atom the real path excludes),
    // so the axis-(3) assertion `interp.confs[0] not containing bob` would FAIL
    // if production regressed to this wider read-set.
    expect(broken.confs[0]).not.toEqual(real.confs[0]);
  });
});

// ---------------------------------------------------------------------------
// (4) Reactivity.
// ---------------------------------------------------------------------------

describe("collection prod-wire: (4) reactivity", () => {
  it("an element-value change re-runs only that element; a list-length change reconciles", async () => {
    const env = makeEnv(true);
    try {
      const { runtime, cf } = env;
      // Seed 3 element docs.
      const seed = runtime.edit();
      const items: Cell<number>[] = [];
      for (let i = 0; i < 3; i++) {
        const c = runtime.getCell<number>(space, `react:el:${i}`, num, seed);
        c.set(i + 1);
        items.push(c);
      }
      await seed.commit();
      await runtime.idle();

      const tx = runtime.edit();
      const listCell = runtime.getCell<number[]>(
        space,
        "react:list",
        { type: "array", items: num },
        tx,
      );
      listCell.set(items as unknown as number[]);
      const resultCell = runtime.getCell(space, "react:result", undefined, tx);
      const result = runtime.run(
        tx,
        buildMapPattern(cf),
        { values: listCell },
        resultCell,
      );
      await tx.commit();
      await runtime.idle();
      const mappedCell = result.key("mapped") as Cell<
        Array<{ doubled: number }>
      >;
      mappedCell.sink(() => {});
      await runtime.idle();
      await mappedCell.pull();
      await runtime.idle();
      expect(mappedCell.get()).toEqual([
        { doubled: 2 },
        { doubled: 4 },
        { doubled: 6 },
      ]);
      expect(env.census().interpreted_ok).toBeGreaterThan(0);

      // Change ONE element value → only mapped[1] updates.
      const etx = runtime.edit();
      items[1].withTx(etx).set(50);
      await etx.commit();
      await runtime.idle();
      await mappedCell.pull();
      await runtime.idle();
      expect(mappedCell.get()).toEqual([
        { doubled: 2 },
        { doubled: 100 },
        { doubled: 6 },
      ]);

      // GROW the list → result reconciles to 4 elements.
      const gtx = runtime.edit();
      const extra = runtime.getCell<number>(space, "react:el:extra", num, gtx);
      extra.set(10);
      listCell.withTx(gtx).set([...items, extra] as unknown as number[]);
      await gtx.commit();
      await runtime.idle();
      await mappedCell.pull();
      await runtime.idle();
      expect(mappedCell.get()).toEqual([
        { doubled: 2 },
        { doubled: 100 },
        { doubled: 6 },
        { doubled: 20 },
      ]);

      // SHRINK the list → result reconciles back down.
      const stx = runtime.edit();
      listCell.withTx(stx).set([items[0], items[2]] as unknown as number[]);
      await stx.commit();
      await runtime.idle();
      await mappedCell.pull();
      await runtime.idle();
      expect(mappedCell.get()).toEqual([{ doubled: 2 }, { doubled: 6 }]);
    } finally {
      await env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// (5) Negative axis: filter / flatMap / scoped / nested-pattern element.
// ---------------------------------------------------------------------------

async function runCollection(
  env: Env,
  cause: string,
  build: (cf: any) => unknown,
  values: number[],
  listSchema: JSONSchema | undefined,
): Promise<unknown> {
  const { runtime, cf } = env;
  const tx = runtime.edit();
  const v = runtime.getCell(space, `${cause}:list`, listSchema, tx);
  v.set(values);
  const res = runtime.getCell(space, `${cause}:res`, undefined, tx);
  // deno-lint-ignore no-explicit-any
  const r = runtime.run(tx, build(cf) as any, { values: v }, res);
  await tx.commit();
  await runtime.idle();
  r.sink(() => {});
  await runtime.idle();
  return await r.pull();
}

interface NegCase {
  name: string;
  build: (cf: any) => unknown;
  listSchema?: JSONSchema;
  expectReason: keyof InterpreterCensus["fallback_by_reason"];
}

const negCases: NegCase[] = [
  {
    name: "filter",
    expectReason: "ineligible_opkind",
    build: (cf) => {
      const pred = cf.pattern(
        ({ element }: any) =>
          cf.lift((x: number) => x > 1, num, { type: "boolean" })(element),
        { type: "object", properties: { element: num }, required: ["element"] },
        { type: "boolean" },
      );
      return cf.pattern(({ values }: any) => ({
        out: (values as any).filterWithPattern(pred, {}),
      }));
    },
  },
  {
    name: "flatMap",
    expectReason: "ineligible_opkind",
    build: (cf) => {
      const fm = cf.pattern(
        ({ element }: any) =>
          cf.lift((x: number) => [x, x], num, { type: "array", items: num })(
            element,
          ),
        { type: "object", properties: { element: num }, required: ["element"] },
        { type: "array", items: num },
      );
      return cf.pattern(({ values }: any) => ({
        out: (values as any).flatMapWithPattern(fm, {}),
      }));
    },
  },
  {
    name: "scoped (PerUser list)",
    expectReason: "scoped",
    listSchema: { type: "array", items: num, scope: "user" } as JSONSchema,
    build: (cf) => {
      const dbl = cf.lift((x: number) => x * 2, num, num);
      const el = cf.pattern(
        ({ element }: any) => ({ d: dbl(element) }),
        { type: "object", properties: { element: num }, required: ["element"] },
        { type: "object", properties: { d: num } },
      );
      return cf.pattern(
        ({ values }: any) => ({ out: (values as any).mapWithPattern(el, {}) }),
        {
          type: "object",
          properties: { values: { type: "array", items: num, scope: "user" } },
          required: ["values"],
        },
        { type: "object", properties: { out: { type: "array" } } },
      );
    },
  },
  {
    name: "map with nested-pattern element",
    // The byKind/nested gate catches this in prod: the element-internal `pattern`
    // op is invisible in `rog.ops` but `coverage.byKind.pattern > 0` rejects it
    // (→ `ineligible_opkind`). (Depending on how the list is materialized this
    // can also surface as `unrecognized_alias` via the nested pattern's `defer:1`
    // serialization; the load-bearing guarantee — that the byKind/nested gate has
    // teeth — is proven directly in collection-eligibility-hole.test.ts. The
    // fail-closed INVARIANT below is what matters: a fallback was recorded.)
    expectReason: "ineligible_opkind",
    build: (cf) => {
      const inner = cf.pattern(
        ({ v }: any) => ({ r: cf.lift((x: number) => x + 1, num, num)(v) }),
        { type: "object", properties: { v: num }, required: ["v"] },
        { type: "object", properties: { r: num } },
      );
      const el = cf.pattern(
        ({ element }: any) => ({ nested: inner({ v: element }) }),
        { type: "object", properties: { element: num }, required: ["element"] },
        {
          type: "object",
          properties: { nested: { type: "object", properties: { r: num } } },
        },
      );
      return cf.pattern(({ values }: any) => ({
        out: (values as any).mapWithPattern(el, {}),
      }));
    },
  },
];

describe("collection prod-wire: (5) negative axis falls back + matches legacy", () => {
  for (const c of negCases) {
    it(`${c.name} falls back (no collection-interpret) and matches legacy`, async () => {
      const off = makeEnv(false);
      const on = makeEnv(true);
      try {
        const legacy = await runCollection(
          off,
          `legacy:${c.name}`,
          c.build,
          [1, 2, 3],
          c.listSchema,
        );
        const sumFb = (x: InterpreterCensus) =>
          Object.values(x.fallback_by_reason).reduce((a, b) => a + b, 0);
        const before = sumFb(on.census());
        const interp = await runCollection(
          on,
          `interp:${c.name}`,
          c.build,
          [1, 2, 3],
          c.listSchema,
        );
        const after = on.census();

        // Output parity with legacy (the legacy collection path produced it).
        expect(interp).toEqual(legacy);
        // A fail-closed reason was recorded — the OUTER collection did NOT get
        // silently interpreted through `$ri-collection-map`.
        expect(sumFb(after)).toBeGreaterThan(before);
        // And the specific expected reason fired at least once.
        expect(after.fallback_by_reason[c.expectReason]).toBeGreaterThan(0);
      } finally {
        await off.dispose();
        await on.dispose();
      }
    });
  }
});
