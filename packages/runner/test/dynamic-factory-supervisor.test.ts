import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import type {
  BuilderFunctionsAndConstants,
  JSONSchema,
  Reactive,
} from "../src/builder/types.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "dynamic factory supervisor test",
);
const space = signer.did();

const ARGUMENT_SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: { result: { type: "number" } },
  required: ["result"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const MODULE_CONTRACT = {
  kind: "module",
  argumentSchema: ARGUMENT_SCHEMA,
  resultSchema: RESULT_SCHEMA,
} as const satisfies FactoryContract;

const REFS = {
  a: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "factoryA",
  },
  b: {
    identity: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "factoryB",
  },
  wrong: {
    identity: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA",
    symbol: "wrongKindFactory",
  },
} as const;

type InvokeFactory = <T, R>(
  factory: unknown,
  input: T,
  expected: FactoryContract,
) => Reactive<R>;

type Execution = {
  factory: "A" | "B";
  value: number;
};

function refKey(identity: string, symbol: string): string {
  return `${identity}#${symbol}`;
}

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
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

describe("dynamic Factory@1 supervisor", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;
  let invokeFactory: InvokeFactory;
  let warmArtifacts: Map<string, unknown>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    commonfabric = createTrustedBuilder(runtime).commonfabric;
    invokeFactory = (commonfabric as unknown as {
      invokeFactory: InvokeFactory;
    }).invokeFactory;
    warmArtifacts = new Map();
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warmArtifacts.get(refKey(identity, symbol));
    runtime.patternManager.isArtifactAvailableInSpace = (identity) =>
      [...warmArtifacts.keys()].some((candidate) =>
        candidate.startsWith(`${identity}#`)
      );
  });

  async function commitAndRenew(): Promise<void> {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      const { error } = await tx.commit();
      expect(error).toBeUndefined();
    }
    tx = runtime.edit();
  }

  afterEach(async () => {
    if (tx.status().status === "ready") {
      tx.abort(new Error("test cleanup"));
    }
    await runtime.dispose();
    await storageManager.close();
  });

  function outerPattern() {
    const argumentSchema = {
      type: "object",
      properties: {
        factory: { asFactory: MODULE_CONTRACT },
        value: { type: "number" },
      },
      required: ["factory", "value"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    return commonfabric.pattern<
      { factory: unknown; value: number },
      { result: number }
    >(
      ({ factory, value }) =>
        invokeFactory<{ value: number }, { result: number }>(
          factory,
          { value },
          MODULE_CONTRACT,
        ),
      argumentSchema,
      RESULT_SCHEMA,
    );
  }

  function makeFactories(executions: Execution[]) {
    const factoryA = commonfabric.lift(
      ({ value }: { value: number }) => {
        executions.push({ factory: "A", value });
        return { result: value * 10 };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    const factoryB = commonfabric.lift(
      ({ value }: { value: number }) => {
        executions.push({ factory: "B", value });
        return { result: value * 100 };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(factoryA, REFS.a);
    setDurableArtifactEntryRef(factoryB, REFS.b);
    return { factoryA, factoryB };
  }

  it("treats a logically equal Factory@1 replay as a no-op", async () => {
    const executions: Execution[] = [];
    const { factoryA } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), factoryA);
    const stateA = sealFactoryState(factoryA);
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-equal-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(stateA));
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-equal-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 2 },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.pull(), "initial equal-state result")).toEqual({
      result: 20,
    });
    await runtime.idle();
    const executionsBeforeReplay = executions.length;

    selector.withTx(tx).set(createFactoryShell({ ...stateA }));
    await commitAndRenew();
    await runtime.idle();

    expect(executions).toHaveLength(executionsBeforeReplay);
    expect(await within(result.pull(), "equal-state replay result")).toEqual({
      result: 20,
    });
  });

  it("replaces warm A with B, cancels A, and retains the output identity", async () => {
    const executions: Execution[] = [];
    const { factoryA, factoryB } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), factoryA);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), factoryB);
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-replacement-selector",
      undefined,
      tx,
    );
    const value = runtime.getCell<number>(
      space,
      "dynamic-factory-replacement-value",
      { type: "number" },
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    value.set(2);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-replacement-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value },
      resultCell,
    );
    const outputIdentity = result.key("result").getAsNormalizedFullLink();
    await commitAndRenew();

    expect(await within(result.pull(), "warm A result")).toEqual({
      result: 20,
    });
    await runtime.idle();

    selector.withTx(tx).set(
      createFactoryShell(sealFactoryState(factoryB)),
    );
    await commitAndRenew();
    expect(await within(result.pull(), "warm B replacement result")).toEqual({
      result: 200,
    });
    await runtime.idle();

    expect(result.key("result").getAsNormalizedFullLink()).toEqual(
      outputIdentity,
    );
    const aExecutionsAfterReplacement =
      executions.filter((entry) => entry.factory === "A").length;

    value.withTx(tx).set(3);
    await commitAndRenew();
    expect(await within(result.pull(), "B result after input change")).toEqual({
      result: 300,
    });
    await runtime.idle();

    expect(
      executions.filter((entry) => entry.factory === "A"),
    ).toHaveLength(aExecutionsAfterReplacement);
    expect(executions).toContainEqual({ factory: "B", value: 3 });
  });

  it("never executes cold A when its load completes after warm B is selected", async () => {
    const executions: Execution[] = [];
    const { factoryA, factoryB } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), factoryB);

    let observeLoadEntered!: () => void;
    const loadEntered = new Promise<void>((resolve) => {
      observeLoadEntered = resolve;
    });
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let observeLoadReturned!: () => void;
    const loadReturned = new Promise<void>((resolve) => {
      observeLoadReturned = resolve;
    });
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.a);
      observeLoadEntered();
      await loadGate;
      warmArtifacts.set(refKey(identity, symbol), factoryA);
      observeLoadReturned();
      return factoryA;
    };

    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-stale-cold-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-stale-cold-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 4 },
      resultCell,
    );
    await commitAndRenew();

    let cancelResultSink: (() => void) | undefined;
    const warmBResult = new Promise<{ result: number }>((resolve) => {
      cancelResultSink = result.sink((value) => {
        if (value?.result === 400) resolve({ result: value.result });
      });
    });
    try {
      await within(loadEntered, "cold A load to enter");

      selector.withTx(tx).set(
        createFactoryShell(sealFactoryState(factoryB)),
      );
      await commitAndRenew();
      expect(await within(warmBResult, "warm B during cold A load")).toEqual({
        result: 400,
      });
    } finally {
      cancelResultSink?.();
      releaseLoad();
    }

    await within(loadReturned, "cold A load to return");
    await runtime.idle();

    expect(executions.filter((entry) => entry.factory === "A")).toEqual([]);
    expect(executions).toContainEqual({ factory: "B", value: 4 });
    expect(await within(result.pull(), "result after stale A load")).toEqual({
      result: 400,
    });
  });

  it("gives two dynamic call sites distinct output identities", async () => {
    const executions: Execution[] = [];
    const { factoryA } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), factoryA);
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-two-call-sites-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    const pairedResultSchema = {
      type: "object",
      properties: {
        first: RESULT_SCHEMA,
        second: RESULT_SCHEMA,
      },
      required: ["first", "second"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const outer = commonfabric.pattern<
      { factory: unknown; value: number },
      {
        first: { result: number };
        second: { result: number };
      }
    >(
      ({ factory, value }) => ({
        first: invokeFactory(factory, { value }, MODULE_CONTRACT),
        second: invokeFactory(factory, { value }, MODULE_CONTRACT),
      }),
      {
        type: "object",
        properties: {
          factory: { asFactory: MODULE_CONTRACT },
          value: { type: "number" },
        },
        required: ["factory", "value"],
        additionalProperties: false,
      },
      pairedResultSchema,
    );
    const resultCell = runtime.getCell<{
      first: { result: number };
      second: { result: number };
    }>(
      space,
      "dynamic-factory-two-call-sites-result",
      pairedResultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { factory: selector, value: 5 },
      resultCell,
    );
    const firstIdentity = result.key("first").key("result")
      .getAsNormalizedFullLink();
    const secondIdentity = result.key("second").key("result")
      .getAsNormalizedFullLink();
    await commitAndRenew();

    expect(await within(result.pull(), "two call-site results")).toEqual({
      first: { result: 50 },
      second: { result: 50 },
    });
    expect(firstIdentity).not.toEqual(secondIdentity);
    expect(executions.filter((entry) => entry.factory === "A")).toHaveLength(
      2,
    );
  });

  it("retains prior output across a wrong-kind replacement and later recovers", async () => {
    const executions: Execution[] = [];
    const { factoryA, factoryB } = makeFactories(executions);
    const wrongKindFactory = commonfabric.pattern(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(wrongKindFactory, REFS.wrong);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), factoryA);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), factoryB);
    warmArtifacts.set(
      refKey(REFS.wrong.identity, REFS.wrong.symbol),
      wrongKindFactory,
    );

    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-wrong-kind-recovery-selector",
      undefined,
      tx,
    );
    const value = runtime.getCell<number>(
      space,
      "dynamic-factory-wrong-kind-recovery-value",
      { type: "number" },
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    value.set(2);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-wrong-kind-recovery-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value },
      resultCell,
    );
    await commitAndRenew();
    expect(await within(result.pull(), "wrong-kind prior result")).toEqual({
      result: 20,
    });
    await runtime.idle();

    const diagnostic = Promise.withResolvers<Error>();
    runtime.scheduler.onError((error) => diagnostic.resolve(error));
    selector.withTx(tx).set(
      createFactoryShell(sealFactoryState(wrongKindFactory)),
    );
    await commitAndRenew();

    expect(
      (await within(diagnostic.promise, "wrong-kind replacement error"))
        .message,
    ).toContain("expected module, got pattern");
    expect(await within(result.pull(), "retained wrong-kind result")).toEqual({
      result: 20,
    });
    const aExecutions = executions.filter((entry) => entry.factory === "A")
      .length;

    value.withTx(tx).set(3);
    await commitAndRenew();
    await runtime.idle();
    expect(executions.filter((entry) => entry.factory === "A")).toHaveLength(
      aExecutions,
    );
    expect(await within(result.pull(), "retained result after input change"))
      .toEqual({ result: 20 });

    selector.withTx(tx).set(createFactoryShell(sealFactoryState(factoryB)));
    await commitAndRenew();
    expect(await within(result.pull(), "valid recovery after wrong kind"))
      .toEqual({ result: 300 });
  });

  it("reports a rejected cold load and recovers from a later valid selection", async () => {
    const executions: Execution[] = [];
    const { factoryA, factoryB } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), factoryB);
    const loadEntered = Promise.withResolvers<void>();
    const rejectLoad = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.a);
      loadEntered.resolve();
      await rejectLoad.promise;
      throw new Error("rejected cold factory load");
    };
    const diagnostic = Promise.withResolvers<Error>();
    runtime.scheduler.onError((error) => diagnostic.resolve(error));

    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-rejected-cold-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-rejected-cold-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 6 },
      resultCell,
    );
    await commitAndRenew();

    await within(loadEntered.promise, "rejected cold load to enter");
    rejectLoad.resolve();
    expect(
      (await within(diagnostic.promise, "rejected cold diagnostic"))
        .message,
    ).toContain("rejected cold factory load");
    expect(executions).toEqual([]);
    expect(result.key("result").get()).toBeUndefined();

    selector.withTx(tx).set(createFactoryShell(sealFactoryState(factoryB)));
    await commitAndRenew();
    expect(await within(result.pull(), "valid recovery after cold rejection"))
      .toEqual({ result: 600 });
    expect(executions).toEqual([{ factory: "B", value: 6 }]);
  });

  it("does not revive a cold selection after its owning piece is stopped", async () => {
    const executions: Execution[] = [];
    const { factoryA } = makeFactories(executions);
    const loadEntered = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const loadReturned = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.a);
      loadEntered.resolve();
      await releaseLoad.promise;
      warmArtifacts.set(refKey(identity, symbol), factoryA);
      loadReturned.resolve();
      return factoryA;
    };

    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-owner-stop-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-owner-stop-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 7 },
      resultCell,
    );
    await commitAndRenew();

    await within(loadEntered.promise, "owner-stop cold load to enter");
    runtime.runner.stop(resultCell);
    releaseLoad.resolve();
    await within(loadReturned.promise, "owner-stop cold load to return");
    await runtime.idle();

    expect(executions).toEqual([]);
    expect(result.key("result").get()).toBeUndefined();
  });

  it("unsubscribes handler A and routes later events only to handler B", async () => {
    const eventSchema = {
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const handlerContract = {
      kind: "handler",
      contextSchema: ARGUMENT_SCHEMA,
      eventSchema,
    } as const satisfies FactoryContract;
    const events: Array<{
      factory: "A" | "B";
      amount: number;
      value: number;
    }> = [];
    const handlerA = commonfabric.handler(
      eventSchema,
      ARGUMENT_SCHEMA,
      ({ amount }, { value }) => {
        events.push({ factory: "A", amount, value });
      },
    );
    const handlerB = commonfabric.handler(
      eventSchema,
      ARGUMENT_SCHEMA,
      ({ amount }, { value }) => {
        events.push({ factory: "B", amount, value });
      },
    );
    setDurableArtifactEntryRef(handlerA, REFS.a);
    setDurableArtifactEntryRef(handlerB, REFS.b);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), handlerA);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), handlerB);

    const outer = commonfabric.pattern<
      { factory: unknown; value: number },
      { events: unknown }
    >(
      ({ factory, value }) => ({
        events: invokeFactory(factory, { value }, handlerContract),
      }),
      {
        type: "object",
        properties: {
          factory: { asFactory: handlerContract },
          value: { type: "number" },
        },
        required: ["factory", "value"],
        additionalProperties: false,
      },
    );
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-handler-replacement-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(handlerA)));
    const resultCell = runtime.getCell<any>(
      space,
      "dynamic-factory-handler-replacement-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { factory: selector, value: 8 },
      resultCell,
    );
    await commitAndRenew();
    await result.pull();
    await runtime.idle();
    const streamIdentity = result.key("events").getAsNormalizedFullLink();

    result.key("events").send({ amount: 1 });
    await runtime.idle();
    expect(events).toEqual([{ factory: "A", amount: 1, value: 8 }]);

    selector.withTx(tx).set(createFactoryShell(sealFactoryState(handlerB)));
    await commitAndRenew();
    await runtime.idle();
    expect(result.key("events").getAsNormalizedFullLink()).toEqual(
      streamIdentity,
    );

    result.key("events").send({ amount: 2 });
    await runtime.idle();
    expect(events).toEqual([
      { factory: "A", amount: 1, value: 8 },
      { factory: "B", amount: 2, value: 8 },
    ]);
  });
});
