import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { createNodeFactory } from "../src/builder/module.ts";
import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import { withPatternParamsSchema } from "../src/builder/pattern.ts";
import type {
  BuilderFunctionsAndConstants,
  JSONSchema,
  PatternFactory,
} from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("bound list pattern factory test");
const space = signer.did();

const LIST_ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    element: { type: "number" },
    index: { type: "number" },
    array: { type: "array", items: { type: "number" } },
  },
  required: ["element", "index", "array"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const NUMBER_RESULT_SCHEMA = { type: "number" } as const satisfies JSONSchema;
const BOOLEAN_RESULT_SCHEMA = {
  type: "boolean",
} as const satisfies JSONSchema;
const NUMBER_ARRAY_RESULT_SCHEMA = {
  type: "array",
  items: { type: "number" },
} as const satisfies JSONSchema;
const FACTOR_PARAMS_SCHEMA = {
  type: "object",
  properties: { factor: { type: "number" } },
  required: ["factor"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const THRESHOLD_PARAMS_SCHEMA = {
  type: "object",
  properties: { threshold: { type: "number" } },
  required: ["threshold"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const OUTER_ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "number" } },
  },
  required: ["values"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const REFS = {
  map: {
    identity: "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "mapOp",
  },
  filter: {
    identity: "FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "filterOp",
  },
  flatMap: {
    identity: "XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "flatMapOp",
  },
} as const;

type CurryView<T, R> = PatternFactory<T, R> & {
  curry(params: unknown): PatternFactory<T, R>;
};

function curry<T, R>(
  factory: PatternFactory<T, R>,
  params: unknown,
): PatternFactory<T, R> {
  return (factory as CurryView<T, R>).curry(params);
}

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 4_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("bound PatternFactory list operations", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    commonfabric = createTrustedBuilder(runtime).commonfabric;
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      tx.abort(new Error("test cleanup"));
    }
    await runtime.dispose();
    await storageManager.close();
  });

  async function commitAndRenew(): Promise<void> {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      const { error } = await tx.commit();
      expect(error).toBeUndefined();
    }
    tx = runtime.edit();
  }

  function installArtifact(
    factory: PatternFactory<any, any>,
    ref: { identity: string; symbol: string },
  ): void {
    setDurableArtifactEntryRef(factory, ref);
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) => {
      const key = `${identity}#${symbol}`;
      return artifacts.get(key);
    };
    artifacts.set(`${ref.identity}#${ref.symbol}`, factory);
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      artifactSpace,
    ) =>
      artifactSpace === space &&
      [...artifacts.keys()].some((key) => key.startsWith(`${identity}#`));
  }

  let artifacts: Map<string, PatternFactory<any, any>>;

  beforeEach(() => {
    artifacts = new Map();
  });

  function boundMapOp() {
    const calculate = commonfabric.lift(
      (
        { element, index, array, factor }: {
          element: number;
          index: number;
          array: number[];
          factor: number;
        },
      ) => element * factor + index + array.length,
    );
    const base = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          calculate({
            element: argument.element,
            index: argument.index,
            array: argument.array,
            factor: params.factor,
          })) as any,
        FACTOR_PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      NUMBER_RESULT_SCHEMA,
    );
    installArtifact(base, REFS.map);
    return curry(base, { factor: 10 });
  }

  function boundFilterOp() {
    const predicate = commonfabric.lift(
      (
        { element, index, array, threshold }: {
          element: number;
          index: number;
          array: number[];
          threshold: number;
        },
      ) => element + index + array.length > threshold,
    );
    const base = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          predicate({
            element: argument.element,
            index: argument.index,
            array: argument.array,
            threshold: params.threshold,
          })) as any,
        THRESHOLD_PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      BOOLEAN_RESULT_SCHEMA,
    );
    installArtifact(base, REFS.filter);
    return curry(base, { threshold: 5 });
  }

  function boundFlatMapOp() {
    const expand = commonfabric.lift(
      (
        { element, index, array, factor }: {
          element: number;
          index: number;
          array: number[];
          factor: number;
        },
      ) => [element, element * factor + index + array.length],
    );
    const base = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          expand({
            element: argument.element,
            index: argument.index,
            array: argument.array,
            factor: params.factor,
          })) as any,
        FACTOR_PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      NUMBER_ARRAY_RESULT_SCHEMA,
    );
    installArtifact(base, REFS.flatMap);
    return curry(base, { factor: 10 });
  }

  it("runs canonical map/filter/flatMap nodes without sibling params", async () => {
    const mapNode = createNodeFactory({ type: "ref", implementation: "map" });
    const filterNode = createNodeFactory({
      type: "ref",
      implementation: "filter",
    });
    const flatMapNode = createNodeFactory({
      type: "ref",
      implementation: "flatMap",
    });
    const mapOp = boundMapOp();
    const filterOp = boundFilterOp();
    const flatMapOp = boundFlatMapOp();
    const outer = commonfabric.pattern(
      (({ values }: any) => ({
        values,
        mapped: mapNode({ list: values, op: mapOp }),
        filtered: filterNode({ list: values, op: filterOp }),
        flattened: flatMapNode({ list: values, op: flatMapOp }),
      })) as any,
      OUTER_ARGUMENT_SCHEMA,
    );

    for (const node of outer.nodes) {
      expect(Object.hasOwn(node.inputs as object, "params")).toBe(false);
    }

    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "canonical bound list operations",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(tx, outer, { values: [1, 2, 3] }, resultCell);
    await commitAndRenew();

    expect(await within(result.key("mapped").pull(), "canonical map"))
      .toEqual([13, 24, 35]);
    expect(await within(result.key("filtered").pull(), "canonical filter"))
      .toEqual([2, 3]);
    expect(await within(result.key("flattened").pull(), "canonical flatMap"))
      .toEqual([1, 13, 2, 24, 3, 35]);

    const outputIdentity = result.key("mapped").resolveAsCell()
      .getAsNormalizedFullLink();
    const rowIdentity = result.key("mapped").key(0).resolveAsCell()
      .getAsNormalizedFullLink();
    result.withTx(tx).key("values").set([4, 2, 3]);
    await commitAndRenew();

    expect(await within(result.key("mapped").pull(), "updated canonical map"))
      .toEqual([43, 24, 35]);
    expect(result.key("mapped").resolveAsCell().getAsNormalizedFullLink())
      .toMatchObject(outputIdentity);
    expect(
      result.key("mapped").key(0).resolveAsCell()
        .getAsNormalizedFullLink(),
    ).toMatchObject(rowIdentity);
  });

  it("keeps the explicit legacy op plus sibling params path", async () => {
    const mapNode = createNodeFactory({ type: "ref", implementation: "map" });
    const calculate = commonfabric.lift(
      ({ element, params }: { element: number; params: { factor: number } }) =>
        element * params.factor,
    );
    const legacyOp = commonfabric.pattern(
      ((argument: any) =>
        calculate({
          element: argument.element,
          params: argument.params,
        })) as any,
      {
        type: "object",
        properties: {
          element: { type: "number" },
          params: FACTOR_PARAMS_SCHEMA,
        },
        required: ["element", "params"],
        additionalProperties: true,
      },
      NUMBER_RESULT_SCHEMA,
    );
    const outer = commonfabric.pattern(
      (({ values }: any) => ({
        mapped: mapNode({
          list: values,
          op: legacyOp,
          params: { factor: 3 },
        }),
      })) as any,
      OUTER_ARGUMENT_SCHEMA,
    );
    expect(Object.hasOwn(outer.nodes[0]!.inputs as object, "params")).toBe(
      true,
    );

    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "legacy list operation",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(tx, outer, { values: [2, 4] }, resultCell);
    await commitAndRenew();
    expect(await within(result.key("mapped").pull(), "legacy map"))
      .toEqual([6, 12]);
  });
});
