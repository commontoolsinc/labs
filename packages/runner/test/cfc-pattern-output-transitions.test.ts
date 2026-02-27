import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import type { JSONSchema, Schema } from "../src/builder/types.ts";
import {
  getCfcDebugCounters,
  resetCfcDebugCounters,
} from "../src/cfc/debug-counters.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { Runtime } from "../src/runtime.ts";
import type { Labels, URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc pattern output transition test",
);
const space = signer.did();

// Source schemas carry IFC annotations so reads are CFC-relevant.
const sourceNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const sourceObjectSchema = {
  type: "object",
  properties: {
    count: { type: "number" },
  },
  required: ["count"],
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const sourceArraySchema = {
  type: "array",
  items: { type: "number" },
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const sourceCoordsSchema = {
  type: "object",
  properties: {
    latitude: { type: "number" },
    longitude: { type: "number" },
  },
  required: ["latitude", "longitude"],
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const numberSchema = {
  type: "number",
} as const satisfies JSONSchema;

const numberArraySchema = {
  type: "array",
  items: numberSchema,
} as const satisfies JSONSchema;

const countObjectSchema = {
  type: "object",
  properties: {
    count: numberSchema,
  },
  required: ["count"],
} as const satisfies JSONSchema;

const latLongSchema = {
  type: "object",
  properties: {
    lat: numberSchema,
    long: numberSchema,
  },
  required: ["lat", "long"],
} as const satisfies JSONSchema;

const tickEventSchema = {
  type: "object",
  properties: {
    step: numberSchema,
  },
  required: ["step"],
} as const satisfies JSONSchema;

const tickHandlerStateSchema = {
  type: "object",
  properties: {
    runtimeState: {
      type: "object",
      properties: {
        eventCount: numberSchema,
      },
      required: ["eventCount"],
      asCell: true,
    },
  },
  required: ["runtimeState"],
} as const satisfies JSONSchema;

// Result schemas define the CFC transition relation expected for each case.
const monotoneResultSchema = {
  type: "object",
  properties: {
    result: { type: "number" },
  },
  required: ["result"],
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const exactCopyResultSchema = {
  type: "object",
  properties: {
    result: {
      type: "number",
      ifc: {
        classification: ["secret"],
        exactCopyOf: "/source",
      },
    },
  },
  required: ["result"],
} as const satisfies JSONSchema;

const projectionResultSchema = {
  type: "object",
  properties: {
    result: {
      type: "number",
      ifc: {
        classification: ["secret"],
        projection: {
          from: "/source",
          path: "/count",
        },
      },
    },
  },
  required: ["result"],
} as const satisfies JSONSchema;

const exactCopyObjectResultSchema = {
  type: "object",
  properties: {
    result: {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
      ifc: {
        classification: ["secret"],
        exactCopyOf: "/source",
      },
    },
  },
  required: ["result"],
} as const satisfies JSONSchema;

const projectionLatitudeResultSchema = {
  type: "object",
  properties: {
    result: {
      type: "number",
      ifc: {
        classification: ["secret"],
        projection: {
          from: "/source",
          path: "/latitude",
        },
      },
    },
  },
  required: ["result"],
} as const satisfies JSONSchema;

const subsetResultSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "number" },
      ifc: {
        classification: ["secret"],
        collection: {
          subsetOf: "/source",
        },
      },
    },
  },
  required: ["items"],
} as const satisfies JSONSchema;

const permutationResultSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "number" },
      ifc: {
        classification: ["secret"],
        collection: {
          permutationOf: "/source",
        },
      },
    },
  },
  required: ["items"],
} as const satisfies JSONSchema;

const filteredFromResultSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "number" },
      ifc: {
        classification: ["secret"],
        collection: {
          filteredFrom: "/source",
        },
      },
    },
  },
  required: ["items"],
} as const satisfies JSONSchema;

const lengthPreservedResultSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "number" },
      ifc: {
        classification: ["secret"],
        collection: {
          sourceCollection: "/source",
          lengthPreserved: true,
        },
      },
    },
  },
  required: ["items"],
} as const satisfies JSONSchema;

const recomposeResultSchema = {
  type: "object",
  properties: {
    coords: {
      type: "object",
      properties: {
        lat: { type: "number" },
        long: { type: "number" },
      },
      required: ["lat", "long"],
      ifc: {
        classification: ["secret"],
        recomposeProjections: {
          from: "/source",
          baseIntegrityType: "https://commonfabric.org/cfc/atom/Coordinates",
          parts: [
            { outputPath: "/lat", projectionPath: "/latitude" },
            { outputPath: "/long", projectionPath: "/longitude" },
          ],
        },
      },
    },
  },
  required: ["coords"],
} as const satisfies JSONSchema;

const numberArgSchema = {
  type: "object",
  properties: {
    source: sourceNumberSchema,
  },
  required: ["source"],
} as const satisfies JSONSchema;

const objectArgSchema = {
  type: "object",
  properties: {
    source: sourceObjectSchema,
  },
  required: ["source"],
} as const satisfies JSONSchema;

const arrayArgSchema = {
  type: "object",
  properties: {
    source: sourceArraySchema,
  },
  required: ["source"],
} as const satisfies JSONSchema;

const coordsArgSchema = {
  type: "object",
  properties: {
    source: sourceCoordsSchema,
  },
  required: ["source"],
} as const satisfies JSONSchema;

type Lift = ReturnType<typeof createBuilder>["commontools"]["lift"];
type TickEvent = Schema<typeof tickEventSchema>;

type Case = {
  caseId: string;
  sourceValue: unknown;
  initialResult: unknown;
  expectedResult: unknown;
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  transform: (
    source: any,
    lift: Lift,
  ) => unknown;
};

describe("CFC pattern output transitions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let lift: Lift;
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];

  beforeEach(() => {
    resetCfcDebugCounters();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
    const { commontools } = createBuilder();
    ({ pattern, lift, handler } = commontools);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedSourceLabels(id: URI, labels: Labels): Promise<void> {
    // Runtime labels on /cfc/labels are the concrete provenance source used by CFC checks.
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, { "/": labels });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  async function waitForScheduler(): Promise<void> {
    await runtime.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runtime.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runtime.scheduler.idle();
  }

  async function runCase(testCase: Case): Promise<void> {
    const tickHandler = handler(
      tickEventSchema,
      tickHandlerStateSchema,
      (event: TickEvent, { runtimeState }) => {
        const current = runtimeState.get();
        runtimeState.set({
          ...current,
          eventCount: current.eventCount + event.step,
        });
      },
    );

    const builtPattern = pattern(
      ({ source }) => {
        // Include lift and handler nodes so this runs through both reactive and event-bearing runtime paths.
        const transformed = testCase.transform(source, lift) as Record<
          string,
          unknown
        >;
        const runtimeState = { eventCount: 0 };
        const stream = tickHandler({ runtimeState });
        return {
          ...transformed,
          stream,
        };
      },
      testCase.argumentSchema,
      testCase.resultSchema,
    );
    expect(builtPattern.nodes.length).toBeGreaterThanOrEqual(2);

    // Bootstrap source/result cells in a setup tx; this is not the transition commit under test.
    let tx = runtime.edit();
    const sourceCell = runtime.getCell<any>(
      space,
      `${testCase.caseId}-source`,
      undefined,
      tx,
    );
    sourceCell.set(testCase.sourceValue);
    const resultCell = runtime.getCell<any>(
      space,
      `${testCase.caseId}-result`,
      testCase.resultSchema,
      tx,
    );
    resultCell.set(testCase.initialResult);

    // Prepare commit-gate digest, but keep boundary enforcement disabled in this transition-focused suite.
    await prepareCfcCommitIfNeeded(tx, { enforceBoundary: false });
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    // Explicitly seed source labels so transition checks have concrete classified input provenance.
    await seedSourceLabels(sourceCell.getAsNormalizedFullLink().id, {
      classification: ["secret"],
    });

    // Valid transition cases should not increment the CFC gate reject counter.
    const gateRejectsBefore = getCfcDebugCounters().cfcGateRejects;

    tx = runtime.edit();
    const result = runtime.run(
      tx,
      builtPattern,
      { source: sourceCell },
      resultCell,
    );
    // This commit is the one exercising CFC transition handling for the pattern output write.
    await prepareCfcCommitIfNeeded(tx, { enforceBoundary: false });
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    await waitForScheduler();
    let pulled: unknown = undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      pulled = await result.pull();
      if (pulled !== undefined) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runtime.scheduler.idle();
    }
    // Each case asserts both functional output shape/value and no unexpected CFC gate rejection.
    expect(pulled).toEqual(testCase.expectedResult);
    expect(getCfcDebugCounters().cfcGateRejects).toBe(gateRejectsBefore);
  }

  it("supports monotone output classification in pattern execution", async () => {
    await runCase({
      caseId: "cfc-pattern-monotone-pass",
      sourceValue: 1,
      initialResult: { result: 0 },
      expectedResult: { result: 2 },
      argumentSchema: numberArgSchema,
      resultSchema: monotoneResultSchema,
      transform: (source, lift) => ({
        result: lift(numberSchema, numberSchema, (value) => value + 1)(source),
      }),
    });
  });

  it("supports exactCopyOf in pattern execution", async () => {
    await runCase({
      caseId: "cfc-pattern-exact-copy-pass",
      sourceValue: 11,
      initialResult: { result: 0 },
      expectedResult: { result: 11 },
      argumentSchema: numberArgSchema,
      resultSchema: exactCopyResultSchema,
      transform: (source, lift) => ({
        result: lift(numberSchema, numberSchema, (value) => value)(source),
      }),
    });
  });

  it("supports projection in pattern execution", async () => {
    await runCase({
      caseId: "cfc-pattern-projection-pass",
      sourceValue: { count: 7 },
      initialResult: { result: 0 },
      expectedResult: { result: 7 },
      argumentSchema: objectArgSchema,
      resultSchema: projectionResultSchema,
      transform: (source, lift) => ({
        result: lift(countObjectSchema, numberSchema, (value) => value.count)(
          source,
        ),
      }),
    });
  });

  it("supports subsetOf in pattern execution", async () => {
    await runCase({
      caseId: "cfc-pattern-subset-pass",
      sourceValue: [1, 2, 3],
      initialResult: { items: [] },
      expectedResult: { items: [2, 3] },
      argumentSchema: arrayArgSchema,
      resultSchema: subsetResultSchema,
      transform: (source, lift) => ({
        items: lift(
          numberArraySchema,
          numberArraySchema,
          (values) => values.filter((value) => value !== 1),
        )(
          source,
        ),
      }),
    });
  });

  it("supports permutationOf in pattern execution", async () => {
    await runCase({
      caseId: "cfc-pattern-permutation-pass",
      sourceValue: [1, 2, 3],
      initialResult: { items: [] },
      expectedResult: { items: [3, 1, 2] },
      argumentSchema: arrayArgSchema,
      resultSchema: permutationResultSchema,
      transform: (source, lift) => ({
        items: lift(numberArraySchema, numberArraySchema, (values) => [
          values[2] ?? 0,
          values[0] ?? 0,
          values[1] ?? 0,
        ])(source),
      }),
    });
  });

  it("supports filteredFrom in pattern execution", async () => {
    await runCase({
      caseId: "cfc-pattern-filtered-pass",
      sourceValue: [1, 2, 3],
      initialResult: { items: [] },
      expectedResult: { items: [2, 3] },
      argumentSchema: arrayArgSchema,
      resultSchema: filteredFromResultSchema,
      transform: (source, lift) => ({
        items: lift(
          numberArraySchema,
          numberArraySchema,
          (values) => values.filter((value) => value > 1),
        )(source),
      }),
    });
  });

  it("supports lengthPreserved in pattern execution", async () => {
    await runCase({
      caseId: "cfc-pattern-length-preserved-pass",
      sourceValue: [1, 2, 3],
      initialResult: { items: [] },
      expectedResult: { items: [11, 12, 13] },
      argumentSchema: arrayArgSchema,
      resultSchema: lengthPreservedResultSchema,
      transform: (source, lift) => ({
        items: lift(
          numberArraySchema,
          numberArraySchema,
          (values) => values.map((value) => value + 10),
        )(source),
      }),
    });
  });

  it("supports recomposeProjections in pattern execution", async () => {
    await runCase({
      caseId: "cfc-pattern-recompose-pass",
      sourceValue: { latitude: 37.77, longitude: -122.41 },
      initialResult: { coords: { lat: 0, long: 0 } },
      expectedResult: { coords: { lat: 37.77, long: -122.41 } },
      argumentSchema: coordsArgSchema,
      resultSchema: recomposeResultSchema,
      transform: (source, lift) => ({
        coords: lift(sourceCoordsSchema, latLongSchema, (value) => ({
          lat: value.latitude,
          long: value.longitude,
        }))(source),
      }),
    });
  });

  it("supports monotone output classification on negative values", async () => {
    await runCase({
      caseId: "cfc-pattern-monotone-pass-negative",
      sourceValue: -4,
      initialResult: { result: 0 },
      expectedResult: { result: -3 },
      argumentSchema: numberArgSchema,
      resultSchema: monotoneResultSchema,
      transform: (source, lift) => ({
        result: lift(numberSchema, numberSchema, (value) => value + 1)(source),
      }),
    });
  });

  it("supports exactCopyOf for object payloads", async () => {
    await runCase({
      caseId: "cfc-pattern-exact-copy-object-pass",
      sourceValue: { count: 9 },
      initialResult: { result: { count: 0 } },
      expectedResult: { result: { count: 9 } },
      argumentSchema: objectArgSchema,
      resultSchema: exactCopyObjectResultSchema,
      transform: (source, lift) => ({
        result: lift(countObjectSchema, countObjectSchema, (value) => value)(
          source,
        ),
      }),
    });
  });

  it("supports projection on nested source coordinates", async () => {
    await runCase({
      caseId: "cfc-pattern-projection-latitude-pass",
      sourceValue: { latitude: 37.77, longitude: -122.41 },
      initialResult: { result: 0 },
      expectedResult: { result: 37.77 },
      argumentSchema: coordsArgSchema,
      resultSchema: projectionLatitudeResultSchema,
      transform: (source, lift) => ({
        result: lift(
          sourceCoordsSchema,
          numberSchema,
          (value) => value.latitude,
        )(
          source,
        ),
      }),
    });
  });

  it("supports subsetOf with duplicate values", async () => {
    await runCase({
      caseId: "cfc-pattern-subset-duplicates-pass",
      sourceValue: [1, 1, 2, 3],
      initialResult: { items: [] },
      expectedResult: { items: [1, 3] },
      argumentSchema: arrayArgSchema,
      resultSchema: subsetResultSchema,
      transform: (source, lift) => ({
        items: lift(
          numberArraySchema,
          numberArraySchema,
          (values) =>
            values.filter((value, index) => index === 1 || value === 3),
        )(source),
      }),
    });
  });

  it("supports permutationOf with duplicate values", async () => {
    await runCase({
      caseId: "cfc-pattern-permutation-duplicates-pass",
      sourceValue: [1, 1, 2],
      initialResult: { items: [] },
      expectedResult: { items: [1, 2, 1] },
      argumentSchema: arrayArgSchema,
      resultSchema: permutationResultSchema,
      transform: (source, lift) => ({
        items: lift(numberArraySchema, numberArraySchema, (values) => [
          values[0] ?? 0,
          values[2] ?? 0,
          values[1] ?? 0,
        ])(source),
      }),
    });
  });

  it("supports filteredFrom when filter keeps all source items", async () => {
    await runCase({
      caseId: "cfc-pattern-filtered-identity-pass",
      sourceValue: [1, 2, 3],
      initialResult: { items: [] },
      expectedResult: { items: [1, 2, 3] },
      argumentSchema: arrayArgSchema,
      resultSchema: filteredFromResultSchema,
      transform: (source, lift) => ({
        items: lift(
          numberArraySchema,
          numberArraySchema,
          (values) => values.filter(() => true),
        )(source),
      }),
    });
  });

  it("supports lengthPreserved for empty collections", async () => {
    await runCase({
      caseId: "cfc-pattern-length-preserved-empty-pass",
      sourceValue: [],
      initialResult: { items: [1] },
      expectedResult: { items: [] },
      argumentSchema: arrayArgSchema,
      resultSchema: lengthPreservedResultSchema,
      transform: (source, lift) => ({
        items: lift(
          numberArraySchema,
          numberArraySchema,
          (values) => values.map((value) => value + 10),
        )(source),
      }),
    });
  });

  it("supports recomposeProjections for zero and integer coordinates", async () => {
    await runCase({
      caseId: "cfc-pattern-recompose-zero-pass",
      sourceValue: { latitude: 0, longitude: 42 },
      initialResult: { coords: { lat: -1, long: -1 } },
      expectedResult: { coords: { lat: 0, long: 42 } },
      argumentSchema: coordsArgSchema,
      resultSchema: recomposeResultSchema,
      transform: (source, lift) => ({
        coords: lift(sourceCoordsSchema, latLongSchema, (value) => ({
          lat: value.latitude,
          long: value.longitude,
        }))(source),
      }),
    });
  });
});
