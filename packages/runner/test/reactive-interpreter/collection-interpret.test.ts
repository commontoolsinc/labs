/**
 * W3 — the COLLECTION interpreter, verified by the differential oracle against
 * legacy `map` (mapWithPattern). This generalizes the W2 spike's "isolated"
 * coordinator (spike-cfc-oracle.test.ts) from a HARDCODED leaf (x*2) to the
 * element **ROG**: per list element, a scheduled effect reads ONLY element i
 * (read-isolated → structurally pointwise) and computes the element op by
 * running `evalRog` over the element pattern's ROG (leaves resolved via the
 * W1b-bridge `resolveLeafImpls` path — see element-evaluator.ts). It writes a
 * per-element result document; the container holds cell LINKS to them.
 *
 * Per DECISIONS.md D-W3-PRECISION (Option A): collections drop per-element child
 * PATTERNS but keep one result doc + one scheduled effect per element. ~3× fewer
 * docs/nodes than legacy (`~1+N` vs `~3N` docs), still O(N), sound, pointwise.
 *
 * The three acceptance axes (differential oracle vs legacy):
 *   (1) OUTPUT PARITY — mapped array equals legacy element-for-element.
 *   (2) FOOTPRINT — interpreter docs grow ~1/element and are substantially
 *       fewer than legacy ~3N (slope materially lower). Printed at N=5/20.
 *   (3) POINTWISE LABELS — under cfc "observe" + flow "persist", seed element 0
 *       with a confidentiality atom; mapped[0] picks it up, mapped[1..] do NOT.
 *
 * HARD RULE honored: the element computation goes through `evalRog` over the
 * element ROG (no hardcoded leaf); leaf values come from real per-element reads.
 *
 * Run:
 *   cd packages/runner
 *   deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     test/reactive-interpreter/collection-interpret.test.ts
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";
import {
  attachDocRecorder,
  type DocRecorder,
} from "../support/interpreter-measure.ts";
import { collectionInterpreter } from "../../src/reactive-interpreter/collection-interpreter.ts";
import { raw } from "../../src/module.ts";
import type { Cell, JSONSchema } from "../../src/builder/types.ts";

// The W3 collection interpreter has been promoted to
// `src/reactive-interpreter/collection-interpreter.ts`. This differential oracle
// continues to exercise it end-to-end via a test-only `addModuleByRef`
// registration (the prod-wire registration is flag-gated; see
// `collection-prod-wire.test.ts` for the real-dispatch oracle).
const mapInterpreted = collectionInterpreter("map");

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-collection-interpret");
const space = signer.did();

const num = { type: "number" } as const satisfies JSONSchema;
// Element result is an object { doubled } — exercises a multi-op element ROG
// (a leaf x*2 feeding an object construct), not just a bare leaf value.
const elementResultSchema = {
  type: "object",
  properties: { doubled: num },
} as const satisfies JSONSchema;

// ---------------------------------------------------------------------------
// Shared pattern builders.
// ---------------------------------------------------------------------------

function buildElementPattern(
  // deno-lint-ignore no-explicit-any
  cf: any,
) {
  const argSchema = {
    type: "object",
    properties: { element: num },
    required: ["element"],
  } as const satisfies JSONSchema;
  const double = cf.lift((x: number) => x * 2, num, num);
  // Two-op element op: a leaf (double) feeding an object construct {doubled}.
  // Exercises a multi-op element ROG (leaf -> construct), not just a bare leaf.
  return cf.pattern(
    ({ element }: { element: number }) => ({ doubled: double(element) }),
    argSchema,
    elementResultSchema,
  );
}

/** Scalar element op: a single leaf (element*2 → number). Used for the
 * pointwise-label oracle, where a scalar element result carries the per-element
 * `derived` content label directly at path [] (an object-valued element nests
 * the label under a property and the probe-copy does not surface it — true for
 * legacy `map` too, so the pointwise oracle uses the scalar shape both sides
 * read identically). Still goes through `evalRog` (no hardcoded leaf). */
function buildScalarElementPattern(
  // deno-lint-ignore no-explicit-any
  cf: any,
) {
  const argSchema = {
    type: "object",
    properties: { element: num },
    required: ["element"],
  } as const satisfies JSONSchema;
  const double = cf.lift((x: number) => x * 2, num, num);
  return cf.pattern(
    ({ element }: { element: number }) => double(element),
    argSchema,
    num,
  );
}

// ---------------------------------------------------------------------------
// (1)+(2) Output parity + footprint — measured on a plain runtime.
// ---------------------------------------------------------------------------

interface Measurement {
  mapped: Array<{ doubled: number }>;
  docs: number;
}

async function measureLegacy(prefix: string, N: number): Promise<Measurement> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const docs = attachDocRecorder(storageManager);
  // deno-lint-ignore no-explicit-any
  const { commonfabric } = createTrustedBuilder(runtime) as any;
  try {
    const elementPattern = buildElementPattern(commonfabric);
    const listInputSchema = {
      type: "object",
      properties: { values: { type: "array", items: num } },
      required: ["values"],
    } as const satisfies JSONSchema;
    const mappedResultSchema = {
      type: "object",
      properties: { mapped: { type: "array", items: elementResultSchema } },
    } as const satisfies JSONSchema;
    const mapPattern = commonfabric.pattern(
      ({ values }: { values: number[] }) => ({
        mapped: (values as unknown as {
          mapWithPattern: (op: unknown, opts: unknown) => unknown;
        })
          .mapWithPattern(elementPattern, {}),
      }),
      listInputSchema,
      mappedResultSchema,
    );

    const { mapped, created } = await runAndMeasure(
      runtime,
      docs,
      prefix,
      N,
      mapPattern,
      num,
    );
    return { mapped, docs: created };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

async function measureInterpreted(
  prefix: string,
  N: number,
): Promise<Measurement> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const docs = attachDocRecorder(storageManager);
  runtime.moduleRegistry.addModuleByRef("mapInterpreted", raw(mapInterpreted));
  // deno-lint-ignore no-explicit-any
  const { commonfabric } = createTrustedBuilder(runtime) as any;
  try {
    const elementPattern = buildElementPattern(commonfabric);
    const listInputSchema = {
      type: "object",
      properties: { values: { type: "array", items: num } },
      required: ["values"],
    } as const satisfies JSONSchema;
    const mappedResultSchema = {
      type: "object",
      properties: { mapped: { type: "array", items: elementResultSchema } },
    } as const satisfies JSONSchema;
    const mapI = commonfabric.byRef("mapInterpreted");
    const mapPattern = commonfabric.pattern(
      ({ values }: { values: number[] }) => ({
        // Pass the element pattern as `op` (the coordinator reads it raw).
        // deno-lint-ignore no-explicit-any
        mapped: (mapI as any)({ list: values, op: elementPattern }),
      }),
      listInputSchema,
      mappedResultSchema,
    );

    const { mapped, created } = await runAndMeasure(
      runtime,
      docs,
      prefix,
      N,
      mapPattern,
      num,
    );
    return { mapped, docs: created };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

async function runAndMeasure(
  runtime: Runtime,
  docs: DocRecorder,
  prefix: string,
  N: number,
  // deno-lint-ignore no-explicit-any
  mapPattern: any,
  itemSchema: JSONSchema,
): Promise<{ mapped: Array<{ doubled: number }>; created: number }> {
  // Seed N item docs BEFORE the measurement window (inputs, not scaffold).
  const seedTx = runtime.edit();
  const items: Cell<number>[] = [];
  for (let i = 0; i < N; i++) {
    const c = runtime.getCell<number>(
      space,
      `${prefix}:item:${i}`,
      itemSchema,
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
    { type: "array", items: itemSchema },
    tx,
  );
  valuesCell.set(items as unknown as number[]);
  const resultCell = runtime.getCell(space, `${prefix}:result`, undefined, tx);
  const result = runtime.run(
    tx,
    mapPattern,
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
  return { mapped, created };
}

// ---------------------------------------------------------------------------
// (3) Pointwise labels — measured under cfc "observe" + flow "persist".
// ---------------------------------------------------------------------------

async function runPointwise(
  legacy: boolean,
  atoms: (string | undefined)[],
): Promise<{ mapped: number[]; confs: string[][] }> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "observe",
    cfcFlowLabels: "persist",
  });
  if (!legacy) {
    runtime.moduleRegistry.addModuleByRef(
      "mapInterpreted",
      raw(mapInterpreted),
    );
  }
  // deno-lint-ignore no-explicit-any
  const { commonfabric } = createTrustedBuilder(runtime) as any;
  try {
    const prefix = legacy ? "legacy-pw" : "interp-pw";
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

    // Scalar element op for the pointwise oracle (label rides path [] on a
    // scalar element doc — surfaced identically by legacy and the interpreter).
    const elementPattern = buildScalarElementPattern(commonfabric);
    const listInputSchema = {
      type: "object",
      properties: { values: { type: "array", items: num } },
      required: ["values"],
    } as const satisfies JSONSchema;
    const mappedResultSchema = {
      type: "object",
      properties: { mapped: { type: "array", items: num } },
    } as const satisfies JSONSchema;
    // deno-lint-ignore no-explicit-any
    const collectionPattern = legacy
      ? commonfabric.pattern(
        ({ values }: { values: number[] }) => ({
          mapped: (values as unknown as {
            mapWithPattern: (op: unknown, opts: unknown) => unknown;
          })
            .mapWithPattern(elementPattern, {}),
        }),
        listInputSchema,
        mappedResultSchema,
      )
      : commonfabric.pattern(
        ({ values }: { values: number[] }) => ({
          // deno-lint-ignore no-explicit-any
          mapped: (commonfabric.byRef("mapInterpreted") as any)({
            list: values,
            op: elementPattern,
          }),
        }),
        listInputSchema,
        mappedResultSchema,
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

    // Probe each index: read mapped[i], copy under prepareCfc, read derived conf.
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

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("W3 collection interpreter: differential oracle vs legacy map", () => {
  it("(1)+(2) output parity AND footprint ~1/element vs legacy ~3/element", async () => {
    const legacy5 = await measureLegacy("leg5", 5);
    const legacy20 = await measureLegacy("leg20", 20);
    const interp5 = await measureInterpreted("int5", 5);
    const interp20 = await measureInterpreted("int20", 20);

    // (1) OUTPUT PARITY: element-for-element equality with legacy, at both N.
    expect(interp5.mapped).toEqual(legacy5.mapped);
    expect(interp20.mapped).toEqual(legacy20.mapped);
    // Ground truth: { doubled: (i+1)*2 }.
    expect(interp5.mapped).toEqual(
      Array.from({ length: 5 }, (_, i) => ({ doubled: (i + 1) * 2 })),
    );

    const legSlope = (legacy20.docs - legacy5.docs) / (20 - 5);
    const intSlope = (interp20.docs - interp5.docs) / (20 - 5);
    console.log(
      `\n[W3 footprint] legacy:  N=5 ${legacy5.docs}d  N=20 ${legacy20.docs}d  slope=${legSlope}/el`,
    );
    console.log(
      `[W3 footprint] interp:  N=5 ${interp5.docs}d  N=20 ${interp20.docs}d  slope=${intSlope}/el`,
    );
    console.log(
      `[W3 footprint] doc reduction: ${
        (legacy20.docs / interp20.docs).toFixed(2)
      }x fewer @N=20; slope ${(legSlope / intSlope).toFixed(2)}x lower\n`,
    );

    // (2) FOOTPRINT: interpreter substantially fewer docs than legacy.
    expect(interp5.docs).toBeLessThan(legacy5.docs);
    expect(interp20.docs).toBeLessThan(legacy20.docs);
    // Per-element slope materially lower: interpreter ~1/element, legacy ~3.
    expect(intSlope).toBeLessThan(legSlope);
    expect(intSlope).toBeLessThanOrEqual(1.5); // ~1 doc/element
    expect(legSlope).toBeGreaterThanOrEqual(2.5); // legacy ~3 doc/element
    // The win is materially > 1.5x on slope.
    expect(legSlope / intSlope).toBeGreaterThan(1.5);
  });

  it("(3) pointwise labels: per-element secrets stay on their own index, parity with legacy", async () => {
    // Two distinct secrets on two indices + two clean elements: the strong
    // pointwise oracle (each label rides only its own element, no cross-smear).
    const atoms = ["alice-secret", "bob-secret", undefined, undefined];
    const legacy = await runPointwise(true, atoms);
    const interp = await runPointwise(false, atoms);

    console.log(
      "\n[W3 pointwise] legacy mapped =",
      JSON.stringify(legacy.mapped),
    );
    console.log(
      "[W3 pointwise] interp mapped =",
      JSON.stringify(interp.mapped),
    );
    legacy.confs.forEach((c, i) =>
      console.log(
        `[W3 pointwise] legacy mapped[${i}] conf = ${JSON.stringify(c)}`,
      )
    );
    interp.confs.forEach((c, i) =>
      console.log(
        `[W3 pointwise] interp mapped[${i}] conf = ${JSON.stringify(c)}`,
      )
    );
    console.log();

    // Output parity under labels too.
    expect(interp.mapped).toEqual(legacy.mapped);

    // POINTWISE: index 0 carries ONLY alice, index 1 ONLY bob, 2/3 clean — no
    // cross-element smear. (A batched coordinator would smear both onto every
    // index; cf. the spike's "batch" case.)
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
  });
});
