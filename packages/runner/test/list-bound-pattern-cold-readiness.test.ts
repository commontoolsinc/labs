import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { createNodeFactory } from "../src/builder/module.ts";
import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import { withPatternParamsSchema } from "../src/builder/pattern.ts";
import type {
  BuilderFunctionsAndConstants,
  FabricValue,
  JSONSchema,
  PatternFactory,
} from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "bound list pattern cold readiness test",
);
const parentSpace = signer.did();
const sourceSpace = (await Identity.fromPassphrase(
  "bound list pattern artifact source",
)).did();

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
const PARAMS_SCHEMA = {
  type: "object",
  properties: { factor: { type: "number" } },
  required: ["factor"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const PATTERN_CONTRACT = {
  kind: "pattern",
  argumentSchema: LIST_ARGUMENT_SCHEMA,
  resultSchema: NUMBER_RESULT_SCHEMA,
} as const;
const OUTER_ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "number" } },
    selector: { asFactory: PATTERN_CONTRACT },
  },
  required: ["values", "selector"],
  additionalProperties: false,
} as unknown as JSONSchema;
const REFS = {
  a: {
    identity: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "coldListA",
  },
  b: {
    identity: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "coldListB",
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
  timeoutMs = 3_000,
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

describe("cold bound PatternFactory list readiness", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;
  let executions: string[];
  let warmArtifacts: Map<string, PatternFactory<any, any>>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    commonfabric = createTrustedBuilder(runtime).commonfabric;
    executions = [];
    warmArtifacts = new Map();
    runtime.patternManager.isArtifactAvailableInSpace = (
      _identity,
      artifactSpace,
    ) => artifactSpace === sourceSpace;
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warmArtifacts.get(`${identity}#${symbol}`);
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
      expect((await tx.commit()).error).toBeUndefined();
    }
    tx = runtime.edit();
  }

  function makeBase(label: "A" | "B", ref: typeof REFS.a | typeof REFS.b) {
    const calculate = commonfabric.lift(
      ({ element, factor }: { element: number; factor: number }) => {
        executions.push(`${label}:${element}`);
        return element * factor;
      },
    );
    const base = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          calculate({
            element: argument.element,
            factor: params.factor,
          })) as any,
        PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      NUMBER_RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(base, ref);
    return base;
  }

  function shell(
    base: PatternFactory<any, any>,
    factor: number,
  ): FabricValue {
    return createFactoryShell(sealFactoryState(curry(base, { factor })));
  }

  async function seedSelector(value: FabricValue) {
    const selector = runtime.getCell<unknown>(
      sourceSpace,
      "cold canonical list selector",
      undefined,
      tx,
    );
    selector.set(value);
    await commitAndRenew();
    return runtime.getCellFromLink(selector.getAsNormalizedFullLink());
  }

  function outerPattern() {
    const mapNode = createNodeFactory({ type: "ref", implementation: "map" });
    const outer = commonfabric.pattern(
      (({ values, selector }: any) => ({
        values,
        mapped: mapNode({ list: values, op: selector }),
      })) as any,
      OUTER_ARGUMENT_SCHEMA,
    );
    expect(Object.hasOwn(outer.nodes[0]!.inputs as object, "params")).toBe(
      false,
    );
    return outer;
  }

  function installColdLoader(base: PatternFactory<any, any>) {
    const entered = Promise.withResolvers<{
      identity: string;
      symbol: string;
      artifactSpace: string;
    }>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      artifactSpace,
    ) => {
      entered.resolve({ identity, symbol, artifactSpace });
      await release.promise;
      warmArtifacts.set(`${identity}#${symbol}`, base);
      returned.resolve();
      return base;
    };
    return { entered, release, returned };
  }

  it("loads from the op source and reruns the current list after readiness", async () => {
    const baseA = makeBase("A", REFS.a);
    const selector = await seedSelector(shell(baseA, 10));
    const load = installColdLoader(baseA);
    const outer = outerPattern();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      parentSpace,
      "cold canonical list current reread",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { values: [1, 2], selector },
      resultCell,
    );
    await commitAndRenew();
    const pendingOutput = result.key("mapped").pull();

    expect(await within(load.entered.promise, "cold list load")).toEqual({
      ...REFS.a,
      artifactSpace: sourceSpace,
    });
    expect(executions).toEqual([]);

    result.withTx(tx).key("values").set([3, 4]);
    await commitAndRenew();
    expect(executions).toEqual([]);
    load.release.resolve();

    expect(await within(pendingOutput, "ready current list"))
      .toEqual([30, 40]);
    expect(executions).toEqual(["A:3", "A:4"]);
  });

  it("retries transient cold loads without requiring a selector change", async () => {
    const baseA = makeBase("A", REFS.a);
    const selector = await seedSelector(shell(baseA, 10));
    const retryGates = [
      {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      },
      {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      },
    ];
    let loadAttempts = 0;
    runtime.patternManager.loadArtifactByIdentity = (
      identity,
      symbol,
      artifactSpace,
    ) => {
      const attempt = loadAttempts++;
      expect({ identity, symbol, artifactSpace }).toEqual({
        ...REFS.a,
        artifactSpace: sourceSpace,
      });
      if (attempt < retryGates.length) {
        return Promise.reject(Object.assign(
          new Error(`transient list factory load ${attempt + 1}`),
          {
            readyToRetry: () => {
              retryGates[attempt]!.entered.resolve();
              return retryGates[attempt]!.release.promise;
            },
          },
        ));
      }
      warmArtifacts.set(`${identity}#${symbol}`, baseA);
      return Promise.resolve(baseA);
    };

    const outer = outerPattern();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      parentSpace,
      "transient cold canonical list",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { values: [2], selector },
      resultCell,
    );
    const recovered = Promise.withResolvers<number[]>();
    const cancelObservation = result.key("mapped").sink((current) => {
      if (Array.isArray(current)) recovered.resolve(current as number[]);
    });
    await commitAndRenew();
    try {
      await within(
        retryGates[0]!.entered.promise,
        "first transient list retry gate",
        500,
      );
      expect(executions).toEqual([]);
      retryGates[0]!.release.resolve();
      await within(
        retryGates[1]!.entered.promise,
        "second transient list retry gate",
        500,
      );
      expect(executions).toEqual([]);
      retryGates[1]!.release.resolve();

      expect(await within(recovered.promise, "transient list recovery"))
        .toEqual([20]);
      expect(loadAttempts).toBe(3);
      expect(executions).toEqual(["A:2"]);
    } finally {
      cancelObservation();
    }
  });

  it("drops a cold selection when the op changes before readiness", async () => {
    const baseA = makeBase("A", REFS.a);
    const baseB = makeBase("B", REFS.b);
    const selector = await seedSelector(shell(baseA, 10));
    const load = installColdLoader(baseA);
    const outer = outerPattern();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      parentSpace,
      "cold canonical list replacement",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { values: [2], selector },
      resultCell,
    );
    await commitAndRenew();
    const pendingOutput = result.key("mapped").pull();
    await within(load.entered.promise, "replaced cold list load");
    expect(executions).toEqual([]);

    warmArtifacts.set(`${REFS.b.identity}#${REFS.b.symbol}`, baseB);
    const selectorTx = runtime.edit();
    selector.withTx(selectorTx).set(shell(baseB, 100));
    runtime.prepareTxForCommit(selectorTx);
    expect((await selectorTx.commit()).error).toBeUndefined();
    expect(await within(pendingOutput, "warm replacement list"))
      .toEqual([200]);
    expect(executions).toEqual(["B:2"]);

    load.release.resolve();
    await within(load.returned.promise, "stale cold list load return");
    await runtime.idle();
    expect(result.key("mapped").get()).toEqual([200]);
    expect(executions).toEqual(["B:2"]);
  });

  it("drops cold readiness when the owning list node stops", async () => {
    const baseA = makeBase("A", REFS.a);
    const selector = await seedSelector(shell(baseA, 10));
    const load = installColdLoader(baseA);
    const outer = outerPattern();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      parentSpace,
      "cold canonical list owner stop",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { values: [5], selector },
      resultCell,
    );
    await commitAndRenew();
    void result.key("mapped").pull().catch(() => undefined);
    await within(load.entered.promise, "stopped cold list load");
    expect(executions).toEqual([]);

    runtime.runner.stop(resultCell);
    load.release.resolve();
    await within(load.returned.promise, "stopped cold list load return");
    await runtime.idle();
    expect(executions).toEqual([]);
    expect(result.key("mapped").get()).toBeUndefined();
  });
});
