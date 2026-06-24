/**
 * W0 baseline regression + harness smoke test.
 *
 * Uses the shared measurement harness (test/support/interpreter-measure.ts) to
 * pin the LEGACY `map` law — the "before" the interpreter is measured against:
 *   documents       ≈ 5 + 3N
 *   scheduler nodes ≈ 8 + 4N
 *   edit one element: O(1), path-scoped result writes
 *
 * If these slopes change, either legacy map changed or the harness drifted —
 * either way we want to know before trusting interpreter comparisons.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import {
  createMeasureEnv,
  type MeasureEnv,
  nodeStats,
} from "../support/interpreter-measure.ts";
import type { Cell, JSONSchema } from "../../src/builder/types.ts";

setGlobalLogFloor("error");
const signer = await Identity.fromPassphrase("ri-baseline");

const numberSchema = { type: "number" } as const satisfies JSONSchema;
const numberArraySchema = {
  type: "array",
  items: numberSchema,
} as const satisfies JSONSchema;
const listInputSchema = {
  type: "object",
  properties: { values: numberArraySchema },
  required: ["values"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const mappedResultSchema = {
  type: "object",
  properties: { mapped: numberArraySchema },
  required: ["mapped"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const elementArgumentSchema = {
  type: "object",
  properties: { element: numberSchema },
  required: ["element"],
  additionalProperties: false,
} as const satisfies JSONSchema;

interface LegacyMeasurement {
  docs: number;
  nodes: number;
  editReruns: number;
  editWritePathLens: number[];
}

// Fresh env per measurement: nodeStats.total is a cumulative snapshot of the
// runtime's graph, so reusing one env across N values double-counts nodes.
async function measureLegacyMap(
  prefix: string,
  N: number,
): Promise<LegacyMeasurement> {
  // Pin the interpreter OFF: this measures the genuine LEGACY map law (the
  // "before"). Without this the env-default flag (CF_EXPERIMENTAL_INTERPRETER=1)
  // would make the baseline runtime interpret the map's element children,
  // collapsing the per-element doc/node slope and failing the law assertion.
  const env = createMeasureEnv(signer, { experimentalInterpreter: false });
  try {
    return await measureLegacyMapIn(env, prefix, N);
  } finally {
    await env.dispose();
  }
}

async function measureLegacyMapIn(
  env: MeasureEnv,
  prefix: string,
  N: number,
): Promise<LegacyMeasurement> {
  const { runtime, space, commonfabric, docs } = env;
  const { lift, pattern } = commonfabric;

  const double = lift((x: number) => x * 2, numberSchema, numberSchema);
  const elementPattern = pattern<{ element: number }, unknown>(
    // deno-lint-ignore no-explicit-any
    ({ element }) => double(element as any),
    elementArgumentSchema,
    numberSchema,
  );
  const mapPattern = pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      mapped: (values as any).mapWithPattern(elementPattern as any, {}),
    }),
    listInputSchema,
    mappedResultSchema,
  );

  // Seed N item docs BEFORE the measurement window (they are inputs, not
  // scaffold).
  const seedTx = runtime.edit();
  const items: Cell<number>[] = [];
  for (let i = 0; i < N; i++) {
    const c = runtime.getCell<number>(
      space,
      `${prefix}:item:${i}`,
      numberSchema,
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
    numberArraySchema,
    tx,
  );
  valuesCell.set(items as unknown as number[]);
  const resultCell = runtime.getCell<{ mapped: number[] }>(
    space,
    `${prefix}:result`,
    mappedResultSchema,
    tx,
  );
  const result = runtime.run(
    tx,
    mapPattern,
    { values: valuesCell },
    resultCell,
  );
  await tx.commit();
  await runtime.idle();
  const mapped = result.key("mapped") as Cell<number[]>;
  const cancel = mapped.sink(() => {});
  await runtime.idle();
  await mapped.pull();
  await runtime.idle();

  const created = mark.createdSince().length;
  const nodes = nodeStats(runtime).total;

  // Edit one element.
  const editMark = docs.mark();
  const before = nodeStats(runtime).runCount;
  const etx = runtime.edit();
  items[0].withTx(etx).set(1000);
  await etx.commit();
  await runtime.idle();
  await mapped.pull();
  await runtime.idle();
  const editReruns = nodeStats(runtime).runCount - before;
  const editWritePathLens = editMark.writtenSince().map((w) => w.minPathLen);

  cancel();
  return { docs: created, nodes, editReruns, editWritePathLens };
}

describe("W0 baseline: legacy map law (harness smoke + regression)", () => {
  it("documents grow at ~3/element, nodes at ~4/element; edit is O(1)", async () => {
    const r5 = await measureLegacyMap("leg5", 5);
    const r50 = await measureLegacyMap("leg50", 50);

    const docSlope = (r50.docs - r5.docs) / (50 - 5);
    const nodeSlope = (r50.nodes - r5.nodes) / (50 - 5);
    console.log(
      `[baseline] N=5: ${r5.docs}d ${r5.nodes}n | N=50: ${r50.docs}d ${r50.nodes}n` +
        ` | docSlope=${docSlope} nodeSlope=${nodeSlope}` +
        ` | edit reruns ${r5.editReruns}/${r50.editReruns}` +
        ` | edit5 pathlens ${JSON.stringify(r5.editWritePathLens)}`,
    );

    // The law: per-element document/node cost is the defect the interpreter
    // removes. Pin the slope (constants are provenance-dependent).
    expect(docSlope).toBeCloseTo(3, 1);
    expect(nodeSlope).toBeCloseTo(4, 1);
    // Edit stays O(1): same rerun count regardless of N.
    expect(r5.editReruns).toBe(r50.editReruns);
    // Edit touches a small, N-independent set of docs (O(1) edit).
    expect(r5.editWritePathLens.length).toBe(r50.editWritePathLens.length);
  });
});
