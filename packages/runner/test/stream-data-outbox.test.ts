import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { streamData as rawStreamData } from "../src/builtins/stream-data.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { createCell } from "../src/cell.ts";
import {
  DataUnavailable,
  isDataUnavailable,
} from "@commonfabric/data-model/fabric-instances";
import type { JSONSchema } from "@commonfabric/api";

const signer = await Identity.fromPassphrase("test stream-data outbox");
const space = signer.did();

describe("stream-data outbox mechanism", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let streamData: ReturnType<
    typeof createBuilder
  >["commonfabric"]["streamData"];
  let partialResultOf: ReturnType<
    typeof createBuilder
  >["commonfabric"]["partialResultOf"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, byRef, streamData, partialResultOf } = commonfabric);

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      fetchCalls.push({ url, init });

      return Promise.resolve(
        new Response(
          'id:1\nevent:message\ndata:{"value":true}\n\n',
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        ),
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("publishes live partial events and the last event on clean close", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push({ url, init });
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        ),
      );
    };

    const eventSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        event: { type: "string" },
        data: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      },
      required: ["id", "event", "data"],
    } as const satisfies JSONSchema;
    type Event = { id: string; event: string; data: { value: number } };
    const outputSchema = {
      type: "object",
      properties: { final: {}, partial: {} },
      required: ["final", "partial"],
    } as const satisfies JSONSchema;
    const testPattern = pattern(
      () => {
        const request = streamData<Event>({
          url: "http://mock-test-server.local/live",
          schema: eventSchema,
        });
        return { final: request, partial: partialResultOf(request) };
      },
      false,
      outputSchema,
    );
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      testPattern,
      {},
      runtime.getCell(space, "stream-direct-lifecycle", outputSchema, tx),
    );
    await tx.commit();
    await result.pull();

    expect(rawResult(result.key("final"))).toBe(DataUnavailable.pending());
    expect(rawResult(result.key("partial"))).toBe(DataUnavailable.pending());

    const encoder = new TextEncoder();
    controller.enqueue(
      encoder.encode('id:1\nevent:message\ndata:{"value":1}\n\n'),
    );
    await waitForRawResult(
      result.key("partial"),
      (value) => (value as Event | undefined)?.data?.value === 1,
    );
    expect(rawResult(result.key("final"))).toBe(DataUnavailable.pending());

    controller.enqueue(
      encoder.encode('id:2\nevent:message\ndata:{"value":2}'),
    );
    controller.close();

    await waitForRawResult(
      result.key("final"),
      (value) => (value as Event | undefined)?.data?.value === 2,
    );
    expect(rawResult(result.key("partial"))).toEqual({
      id: "2",
      event: "message",
      data: { value: 2 },
    });
  });

  it("starts streamData only after the transaction commits", async () => {
    const streamData = byRef("streamData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => streamData({ url }),
    );

    const tx = runtime.edit();
    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxEnqueue = txPrototype.enqueuePostCommitEffect;
    const originalWrapperEnqueue = wrapperPrototype.enqueuePostCommitEffect;
    const outboxEffects: Array<{ id: string; kind: string }> = [];

    txPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalTxEnqueue.apply(this, args as never);
    };
    wrapperPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalWrapperEnqueue.apply(this, args as never);
    };

    const resultCell = runtime.getCell(
      space,
      "stream-pre-commit-test",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/stream",
    }, resultCell);

    try {
      expect(fetchCalls).toEqual([]);

      const commitPromise = tx.commit();

      expect(fetchCalls).toEqual([]);

      await commitPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(outboxEffects.length).toBeGreaterThan(0);
      expect(outboxEffects[0].kind).toBe("streamData-start");
      expect(fetchCalls.length).toBeGreaterThan(0);
      expect(fetchCalls[0].url).toContain("/stream");
      await result.pull();
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
    }
  });

  it("uses a stable streamData idempotency key for identical inputs", async () => {
    const streamData = byRef("streamData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => streamData({ url }),
    );

    const tx = runtime.edit();
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
        "stream-idempotency-test",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, {
        url: "http://mock-test-server.local/stream-idempotency",
      }, resultCell);
      const commitPromise = tx.commit();
      await commitPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));

      const expectedHash = hashOf(
        createFrozenRequestSnapshot({
          url: "http://mock-test-server.local/stream-idempotency",
        }),
      ).toString();

      expect(outboxIds.length).toBeGreaterThan(0);
      expect(outboxIds[0]).toBe(`streamData:${expectedHash}`);
      await result.pull();
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
    }
  });

  it("retries streamData start after a rejected post-commit transaction", async () => {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "stream-retry-parent",
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<{
      url: string;
      options?: {
        body?: any;
        method?: string;
        headers?: Record<string, string>;
      };
      result?: any;
    }>(
      space,
      "stream-retry-inputs",
      undefined,
      setupTx,
    );
    inputsCell.set({
      url: "http://mock-test-server.local/stream-retry",
    });
    const setupResult = await setupTx.commit();
    expect(setupResult.ok).toBeDefined();

    const action = rawStreamData(
      inputsCell,
      () => {},
      () => {},
      [],
      parentCell,
      runtime,
    );

    const rejectedTx = runtime.edit();
    rejectedTx.setCfcEnforcementMode("enforce-explicit");
    rejectedTx.markCfcRelevant("streamData retry regression");
    action(rejectedTx);
    const rejectedResult = await rejectedTx.commit();
    expect(rejectedResult.error).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls).toEqual([]);

    const retryTx = runtime.edit();
    action(retryTx);
    const retryResult = await retryTx.commit();
    expect(retryResult.ok).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/stream-retry");
  });

  it("restarts streamData when identical inputs move to a narrower scope", async () => {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "stream-scope-change-parent",
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<{
      url: string;
      options?: {
        body?: any;
        method?: string;
        headers?: Record<string, string>;
      };
      result?: any;
    }>(
      space,
      "stream-scope-change-inputs",
      undefined,
      setupTx,
    );
    inputsCell.set({
      url: "http://mock-test-server.local/stream-scope-change",
    });
    const setupResult = await setupTx.commit();
    expect(setupResult.ok).toBeDefined();

    const action = rawStreamData(
      inputsCell,
      () => {},
      () => {},
      [],
      parentCell,
      runtime,
    );

    const firstTx = runtime.edit();
    action(firstTx);
    const firstResult = await firstTx.commit();
    expect(firstResult.ok).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls.length).toBe(1);

    const linkTx = runtime.edit();
    const userUrlBase = runtime.getCell<string>(
      space,
      "stream-scope-change-user-url",
      undefined,
      linkTx,
    );
    const userUrl = createCell<string>(
      runtime,
      { ...userUrlBase.getAsNormalizedFullLink(), scope: "user" },
      linkTx,
    );
    userUrl.set("http://mock-test-server.local/stream-scope-change");
    inputsCell.withTx(linkTx).key("url").set(userUrl);
    const linkResult = await linkTx.commit();
    expect(linkResult.ok).toBeDefined();

    const secondTx = runtime.edit();
    action(secondTx);
    const secondResult = await secondTx.commit();
    expect(secondResult.ok).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchCalls.length).toBe(2);
  });
});

function rawResult(cell: any): unknown {
  return cell.resolveAsCell().getRaw();
}

function waitForRawResult(
  cell: any,
  predicate: (value: unknown) => boolean,
): Promise<void> {
  let cancel: () => void;
  let timeout: ReturnType<typeof setTimeout>;
  return new Promise<void>((resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Timed out waiting for streamData result")),
      5000,
    );
    cancel = cell.sink(() => {
      if (predicate(rawResult(cell))) resolve();
    });
  }).finally(() => {
    clearTimeout(timeout);
    cancel();
  });
}
