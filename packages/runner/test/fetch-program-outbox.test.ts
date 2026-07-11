import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DataUnavailable,
  FabricError,
} from "@commonfabric/data-model/fabric-instances";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { computeInputHashFromValue } from "../src/builtins/fetch-utils.ts";
import { scheduleFetchProgramClaimRetry } from "../src/builtins/fetch-program.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("test fetch-program outbox");
const space = signer.did();
const remoteSpace = (await Identity.fromPassphrase(
  "test fetch-program outbox remote",
)).did();

async function rawResultChild(
  runtime: Runtime,
  container: any,
): Promise<unknown> {
  const link = parseLink(container.key("result").getRaw(), container);
  if (!link) {
    throw new Error("fetchProgram result child link was not materialized");
  }
  const child = runtime.getCellFromLink(link);
  await child.sync();
  return child.getRaw();
}

describe("fetch-program outbox mechanism", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    byRef = commonfabric.byRef;

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      fetchCalls.push({ url, init });

      await new Promise((resolve) => setTimeout(resolve, 10));

      return new Response("export const value = 1;\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should enqueue fetchProgram work behind the post-commit outbox", async () => {
    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
    );

    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxCommit = txPrototype.commit;
    const originalWrapperCommit = wrapperPrototype.commit;
    let committed = false;

    txPrototype.commit = function (...args) {
      committed = true;
      return originalTxCommit.apply(this, args as never);
    };
    wrapperPrototype.commit = function (...args) {
      committed = true;
      return originalWrapperCommit.apply(this, args as never);
    };

    const resultCell = runtime.getCell(
      space,
      "program-pre-commit-test",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/program.ts",
    }, resultCell);
    tx.commit();

    try {
      await result.pull();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await result.pull();

      expect(committed).toBe(true);
      expect(fetchCalls.length).toBeGreaterThan(0);
      expect(fetchCalls[0].url).toContain("/program.ts");
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      txPrototype.commit = originalTxCommit;
      wrapperPrototype.commit = originalWrapperCommit;
    }
  });

  it("uses a stable fetchProgram idempotency key for identical inputs", async () => {
    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
    );

    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxEnqueue = txPrototype.enqueuePostCommitEffect;
    const originalWrapperEnqueue = wrapperPrototype.enqueuePostCommitEffect;
    const outboxIds: string[] = [];

    txPrototype.enqueuePostCommitEffect = function (...args) {
      outboxIds.push((args[0] as { id: string }).id);
      return originalTxEnqueue.apply(this, args as never);
    };
    wrapperPrototype.enqueuePostCommitEffect = function (...args) {
      outboxIds.push((args[0] as { id: string }).id);
      return originalWrapperEnqueue.apply(this, args as never);
    };

    try {
      const resultCell = runtime.getCell(
        space,
        "program-idempotency-test",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, {
        url: "http://mock-test-server.local/program-idempotency.ts",
      }, resultCell);
      tx.commit();
      await result.pull();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const expectedHash = computeInputHashFromValue({
        url: "http://mock-test-server.local/program-idempotency.ts",
      });

      expect(outboxIds.length).toBeGreaterThan(0);
      expect(outboxIds[0]).toBe(`fetchProgram:${expectedHash}`);
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
    }
  });

  it("releases a persisted program claim when its lease expires", async () => {
    const cache = runtime.getCell<Record<string, any>>(
      space,
      "fetch-program-persisted-cache",
      undefined,
      tx,
    );
    const inputHash = computeInputHashFromValue({
      url: "http://mock-test-server.local/recover-program.ts",
    });
    const requestId = "persisted-program-owner";
    const startTime = Date.now();
    cache.setRaw({
      [inputHash]: {
        inputHash,
        state: { type: "fetching", requestId, startTime },
      },
    });
    tx.commit();
    tx = runtime.edit();

    const cancel = scheduleFetchProgramClaimRetry(
      runtime,
      cache,
      inputHash,
      requestId,
      startTime,
      20,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await runtime.idle();
      const readTx = runtime.edit();
      try {
        expect(
          (cache.withTx(readTx).getRaw() as Record<string, any>)[inputHash]
            .state.type,
        ).toBe("idle");
      } finally {
        readTx.abort();
      }
    } finally {
      cancel();
    }
  });

  it("does not launch a released program fetch after its input becomes unavailable", async () => {
    const urlCell = runtime.getCell<string | DataUnavailable>(
      space,
      "program-outbox-handoff-url",
      undefined,
      tx,
    );
    urlCell.set("http://mock-test-server.local/approved-program.ts");

    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchProgram({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "program-outbox-handoff-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url: urlCell }, resultCell);

    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxEnqueue = txPrototype.enqueuePostCommitEffect;
    const originalWrapperEnqueue = wrapperPrototype.enqueuePostCommitEffect;
    type TestEffect = Parameters<typeof originalTxEnqueue>[0] & {
      __testGated?: true;
    };
    const gate = (effect: TestEffect): TestEffect => {
      if (effect.kind !== "fetchProgram-start" || effect.__testGated) {
        return effect;
      }
      return {
        ...effect,
        __testGated: true,
        flush: async (committedTx) => {
          ready.resolve();
          await release.promise;
          return await effect.flush(committedTx);
        },
      };
    };
    txPrototype.enqueuePostCommitEffect = function (effect) {
      return originalTxEnqueue.call(this, gate(effect));
    };
    wrapperPrototype.enqueuePostCommitEffect = function (effect) {
      return originalWrapperEnqueue.call(this, gate(effect));
    };

    try {
      tx.commit();
      tx = runtime.edit();
      const initialPull = result.pull();
      await ready.promise;

      urlCell.withTx(tx).setRaw(DataUnavailable.syncing());
      tx.commit();
      tx = runtime.edit();
      await result.pull();

      expect(await rawResultChild(runtime, result)).toBe(
        DataUnavailable.syncing(),
      );
      expect(fetchCalls).toEqual([]);

      release.resolve();
      await initialPull;
      await runtime.settled();
      await runtime.idle();

      expect(fetchCalls).toEqual([]);
      expect(await rawResultChild(runtime, result)).toBe(
        DataUnavailable.syncing(),
      );
    } finally {
      release.resolve();
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
    }
  });

  it("reclaims the original URL after an in-flight request is abandoned", async () => {
    const url = "http://mock-test-server.local/reclaimed-program.ts";
    const urlCell = runtime.getCell<string | DataUnavailable>(
      space,
      "program-reclaim-url",
      undefined,
      tx,
    );
    urlCell.set(url);

    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstResponse = Promise.withResolvers<Response>();
    const secondResponse = Promise.withResolvers<Response>();
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      if (calls === 1) {
        firstStarted.resolve();
        return firstResponse.promise;
      }
      secondStarted.resolve();
      return secondResponse.promise;
    };

    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchProgram({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "program-reclaim-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url: urlCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    try {
      await result.pull();
      await firstStarted.promise;

      urlCell.withTx(tx).setRaw(DataUnavailable.syncing());
      tx.commit();
      tx = runtime.edit();
      await result.pull();
      expect(await rawResultChild(runtime, result)).toBe(
        DataUnavailable.syncing(),
      );

      urlCell.withTx(tx).setRaw(url);
      tx.commit();
      tx = runtime.edit();
      await result.pull();
      await secondStarted.promise;
      expect(await rawResultChild(runtime, result)).toBe(
        DataUnavailable.pending(),
      );

      firstResponse.resolve(
        new Response("export const stale = 1;\n", { status: 200 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await rawResultChild(runtime, result)).toBe(
        DataUnavailable.pending(),
      );

      secondResponse.resolve(
        new Response("export const fresh = 2;\n", { status: 200 }),
      );
      await runtime.settled();
      await result.pull();

      const program = await rawResultChild(runtime, result) as {
        files: Array<{ contents: string }>;
      };
      expect(program.files[0].contents).toContain("fresh = 2");
      expect(calls).toBe(2);
    } finally {
      firstResponse.resolve(new Response("export {};\n", { status: 200 }));
      secondResponse.resolve(new Response("export {};\n", { status: 200 }));
    }
  });

  it("replaces a prior success with pending on input change, then publishes the new program", async () => {
    const urlCell = runtime.getCell<string>(
      space,
      "program-transition-url",
      undefined,
      tx,
    );
    urlCell.set("http://mock-test-server.local/first-program.ts");

    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "program-transition-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url: urlCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();
    await runtime.settled();
    await result.pull();
    const first = await rawResultChild(runtime, result) as {
      files: Array<{ name: string; contents: string }>;
      main: string;
    };
    expect(first.files.length).toBeGreaterThan(0);
    expect(first.files[0].contents).toContain("value = 1");

    const secondStarted = Promise.withResolvers<void>();
    const secondResponse = Promise.withResolvers<Response>();
    globalThis.fetch = async () => {
      secondStarted.resolve();
      return await secondResponse.promise;
    };

    urlCell.withTx(tx).send(
      "http://mock-test-server.local/second-program.ts",
    );
    tx.commit();
    tx = runtime.edit();

    await result.pull();
    await secondStarted.promise;
    expect(await rawResultChild(runtime, result)).toBe(
      DataUnavailable.pending(),
    );

    secondResponse.resolve(
      new Response("export const value = 2;\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    await runtime.settled();
    await result.pull();
    const second = await rawResultChild(runtime, result) as {
      files: Array<{ name: string; contents: string }>;
      main: string;
    };
    expect(second.files.length).toBeGreaterThan(0);
    expect(second.files[0].contents).toContain("value = 2");
  });

  it("publishes operational resolution failures as error markers", async () => {
    const failure = new TypeError("program resolution exploded");
    failure.stack = "original program resolver stack";
    failure.cause = { code: "ECONNRESET" };
    (failure as TypeError & { retryable: boolean }).retryable = true;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push({ url });
      return Promise.reject(failure);
    };

    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "program-error-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/missing-program.ts",
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();
    await runtime.settled();
    await result.pull();

    const unavailable = await rawResultChild(
      runtime,
      result,
    ) as DataUnavailable;
    expect(unavailable).toBeInstanceOf(DataUnavailable);
    expect(unavailable.reason).toBe("error");
    expect(unavailable.error).toBeInstanceOf(FabricError);
    expect(unavailable.error?.type).toBe("TypeError");
    expect(unavailable.error?.message).toBe("program resolution exploded");
    expect(unavailable.error?.stack).toBe("original program resolver stack");
    expect(unavailable.error?.cause).toEqual({ code: "ECONNRESET" });
    expect(unavailable.error?.getExtra("retryable")).toBe(true);
    expect(isDeepFrozen(unavailable.error!)).toBe(true);
  });

  it("publishes schema mismatch for a locally invalid URL", async () => {
    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "program-schema-mismatch-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url: "" }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    expect(await rawResultChild(runtime, result)).toBe(
      DataUnavailable.schemaMismatch(),
    );
    expect(fetchCalls).toEqual([]);
  });

  it("propagates unavailable raw input without enqueueing program resolution", async () => {
    const marker = DataUnavailable.pending();
    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchProgram({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "program-unavailable-input",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url: marker }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    const state = result.get() as {
      pending: boolean;
      result: unknown;
      error: unknown;
    };
    const propagated = await rawResultChild(
      runtime,
      result,
    ) as DataUnavailable;
    expect(propagated).toBeInstanceOf(DataUnavailable);
    expect(propagated.reason).toBe("pending");
    expect(state.pending).toBe(true);
    expect(state.error).toBeUndefined();
    expect(fetchCalls).toEqual([]);
  });

  it("settles an absent cross-space program URL as schema mismatch", async () => {
    const missingRemote = runtime.getCell(
      remoteSpace,
      "program-missing-remote-url",
    );
    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchProgram({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "program-missing-remote-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      { url: missingRemote.getAsLink() },
      resultCell,
    );
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    const unavailable = await rawResultChild(
      runtime,
      result,
    ) as DataUnavailable;
    expect(unavailable).toBeInstanceOf(DataUnavailable);
    expect(unavailable.reason).toBe("schema-mismatch");
    expect(fetchCalls).toEqual([]);
  });
});
