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
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";
import {
  attachDocRecorder,
  type DocRecorder,
} from "../support/interpreter-measure.ts";
import { buildElementEvaluator } from "../../src/reactive-interpreter/element-evaluator.ts";
import { raw } from "../../src/module.ts";
import type { Action } from "../../src/scheduler.ts";
import type { AddCancel } from "../../src/cancel.ts";
import type { Cell, JSONSchema } from "../../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { setResultCell } from "../../src/result-utils.ts";
import { outputSpotFromBinding } from "../../src/builtins/scope-policy.ts";
import {
  isPrimitiveCellLink,
  parseLink,
  toMemorySpaceAddress,
} from "../../src/link-utils.ts";
import { resolveLink } from "../../src/link-resolution.ts";
import { linkResolutionProbe } from "../../src/storage/reactivity-log.ts";

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

// Coordinator reads only `op` (the element pattern, raw) + the list's link
// structure. `list` slots stay cells (identity-only); `op` is an opaque cell.
const MAP_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: {
    list: { type: "array", items: { asCell: ["cell"], type: "unknown" } },
    op: { asCell: ["cell"] },
  },
  required: ["op"],
});
const RESULT_SCHEMA = internSchema({
  type: "array",
  items: { type: "object" },
});
// Links-only view of the container: slots stay cell links so the coordinator's
// container write is pure link structure (no element content read).
const RESULT_PRESENCE_SCHEMA = internSchema({
  type: "array",
  items: { asCell: ["cell"], type: "unknown" },
});

/**
 * The W3 collection interpreter (prototype-grade, test-only — does NOT touch
 * builtins/map.ts or cfc/ core). Generalizes the spike's "isolated" mode: per
 * element, a scheduled effect reads ONLY element i and computes the element op
 * by running `evalRog` over the element pattern's ROG via `buildElementEvaluator`
 * (NOT a hardcoded leaf). Writes a per-element result doc; container holds links.
 */
function mapInterpreted(
  inputsCell: Cell<{ list: unknown[]; op: unknown }>,
  // deno-lint-ignore no-explicit-any
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  _cause: unknown,
  // deno-lint-ignore no-explicit-any
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
): Action {
  // deno-lint-ignore no-explicit-any
  let result: Cell<any> | undefined;
  let evaluate: ReturnType<typeof buildElementEvaluator> | undefined;
  const elementActions = new Set<number>();

  return (tx: IExtendedStorageTransaction) => {
    const mapped = inputsCell.asSchema(MAP_INPUT_SCHEMA).withTx(tx);

    if (!result) {
      const outputSpot = outputSpotFromBinding(outputBinding);
      if (!outputSpot) throw new Error("mapInterpreted: needs output binding");
      // deno-lint-ignore no-explicit-any
      result = runtime.getCell<any>(
        parentCell.space,
        { mapInterpreted: parentCell.entityId, outputSpot },
        RESULT_SCHEMA,
        tx,
      );
      result.send([]);
      setResultCell(result, parentCell);
      sendResult(tx, result);
    }
    const resultCell = result;

    if (!evaluate) {
      // Read the element pattern raw (the inline pattern graph; same idiom as
      // legacy map's `op.getRaw()`), and build the per-element evaluator ONCE.
      // This is the ROG path: extractRog + resolveLeafImpls + evalRog.
      const opRaw = mapped.key("op").getRaw() as unknown;
      // The graph read back from the cell is serialized: leaf bodies are no
      // longer live callables (only `$implRef` survives). Resolve those through
      // the harness's verified-implementation index — the W1b-bridge path for a
      // serialized element graph. Still NOT a hardcoded leaf: it is the actual
      // registered lift body, looked up by content-addressed ref.
      // deno-lint-ignore no-explicit-any
      const harness = (runtime as any).harness;
      evaluate = buildElementEvaluator(
        opRaw as Record<string, unknown>,
        (identity: string, symbol: string) =>
          harness?.getVerifiedImplementation?.(identity, symbol),
      );
      // Honest boundary check: an in-memory element pattern must fully resolve.
      if (evaluate.unresolvedLeafOps.length > 0) {
        throw new Error(
          `mapInterpreted: unresolved element leaf ops ${
            JSON.stringify(evaluate.unresolvedLeafOps)
          } (serialized/SES boundary)`,
        );
      }
    }
    const evaluateElement = evaluate;

    // Identity-only list materialization (copied from legacy map / the spike):
    // read RAW slots under the linkResolutionProbe scope so no element value
    // enters the coordinator's tx — its flow-join J stays empty.
    const listCell = tx.runWithAmbientReadMeta(
      linkResolutionProbe,
      () => inputsCell.key("list").withTx(tx).resolveAsCell(),
    );
    const listBase = listCell.getAsNormalizedFullLink();
    const rawList = tx.runWithAmbientReadMeta(
      linkResolutionProbe,
      () => listCell.withTx(tx).getRaw() as unknown,
    );
    const len = Array.isArray(rawList) ? rawList.length : 0;
    const slotLink = (i: number): NormalizedFullLink => {
      const slot = (rawList as unknown[])[i];
      const link: NormalizedFullLink = isPrimitiveCellLink(slot)
        ? parseLink(slot, listBase)
        : { ...listBase, path: [...listBase.path, String(i)] };
      return tx.runWithAmbientReadMeta(
        linkResolutionProbe,
        () => resolveLink(runtime, tx, link, "value"),
      );
    };

    const resultPresence = resultCell.asSchema(RESULT_PRESENCE_SCHEMA);
    // deno-lint-ignore no-explicit-any
    const slots = new Array<Cell<any>>(len);
    for (let i = 0; i < len; i++) {
      const index = i;
      // deno-lint-ignore no-explicit-any
      const elemResult = runtime.getCell<any>(
        parentCell.space,
        { mapInterpretedElem: resultCell.entityId, index },
        undefined,
        tx,
      );
      slots[index] = elemResult;
      if (elementActions.has(index)) continue;
      elementActions.add(index);

      const elementAction: Action = (childTx) => {
        // Read ONLY element `index` (its own isolated tx → pointwise label).
        const elemValue = runtime.getCellFromLink(
          slotLink(index),
          undefined,
          childTx,
        )!.withTx(childTx).get() as unknown;
        // ELEMENT OP VIA evalRog over the element ROG (not a hardcoded leaf):
        const out = evaluateElement(elemValue);
        elemResult.withTx(childTx).set(out);
      };
      setResultCell(elemResult, parentCell);
      addCancel(
        runtime.scheduler.subscribe(
          elementAction,
          {
            reads: [toMemorySpaceAddress(slotLink(index))],
            shallowReads: [],
            writes: [
              toMemorySpaceAddress(elemResult.getAsNormalizedFullLink()),
            ],
          },
          { isEffect: true },
        ),
      );
    }
    // Pure-link-structure container write (empty coordinator J → only
    // `structure` stamps, never a smearing `derived` one).
    resultPresence.withTx(tx).set(slots as unknown as unknown[]);
  };
}

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
