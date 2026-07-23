/**
 * Regression tests for stream-event final-outcome callbacks.
 *
 * Scheduler-delivered `onCommit` callbacks fire exactly once for the final
 * result: after a transient conflict is retried and lands, or after a
 * non-retryable failure (a local abort) drops the write.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test oncommit race");
const space = signer.did();

describe("onCommit callback final outcome", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("fires onCommit once when a handler abort drops the write", async () => {
    const streamCell = runtime.getCell<{ piece: string }>(
      space,
      "add-piece-stream",
      undefined,
      tx,
    );
    streamCell.set({} as { piece: string });
    await tx.commit();
    tx = runtime.edit();

    const pieceRegistryCell = runtime.getCell<string[]>(
      space,
      "piece-registry-list",
      undefined,
      tx,
    );
    pieceRegistryCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    let handlerCallCount = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        handlerCallCount++;
        handlerTx.abort("Simulated handler-initiated abort");
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const statuses: string[] = [];
    runtime.scheduler.queueEvent(
      streamCell.getAsNormalizedFullLink(),
      { piece: "test-piece-id" },
      true,
      (committedTx) => {
        statuses.push(committedTx.status().status);
      },
    );

    await runtime.idle();
    await runtime.storageManager.synced();

    // A local abort is deterministic, not contention, so it is not retried
    // (the retries budget of 2 is irrelevant): the handler runs once and
    // onCommit fires exactly once with the failed final status.
    expect(statuses).toEqual(["error"]);
    expect(handlerCallCount).toBe(1);
    expect(pieceRegistryCell.get()).toEqual([]);
  });

  it("fires onCommit once after a conflict is retried and lands", async () => {
    const streamCell = runtime.getCell<number>(
      space,
      "fix-demo-stream",
      undefined,
      tx,
    );
    streamCell.set(0);
    await tx.commit();
    tx = runtime.edit();
    await runtime.storageManager.synced();

    let attempts = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, event) => {
        attempts++;
        streamCell.withTx(handlerTx).set(event + 1);
      },
      streamCell.getAsNormalizedFullLink(),
    );

    // Reject the first commit the handler attempts with a transient conflict —
    // a genuinely retryable failure, unlike a local abort. The scheduler retries
    // within the backpressure window and the second attempt lands. onCommit must
    // still fire exactly once, for the winning attempt, not once per attempt.
    const server = (storageManager as unknown as {
      server(): {
        transact: (m: { requestId: string }) => Promise<unknown>;
      };
    }).server();
    const originalTransact = server.transact.bind(server);
    // Reject every commit until the handler has run a second time, so the
    // handler's own first commit is the one that conflicts (rejecting only "the
    // next transact" can hit an unrelated observation commit instead). Once the
    // retry re-runs the handler, its commit lands.
    server.transact = (message: { requestId: string }) => {
      if (attempts < 2) {
        return Promise.resolve({
          type: "response",
          requestId: message.requestId,
          error: {
            name: "ConflictError",
            message: "forced retry-then-land conflict",
          },
        });
      }
      return originalTransact(message);
    };

    const statuses: string[] = [];
    try {
      runtime.scheduler.queueEvent(
        streamCell.getAsNormalizedFullLink(),
        1,
        true,
        (committedTx) => {
          statuses.push(committedTx.status().status);
        },
      );

      // The first commit fails on the server asynchronously; wait for the
      // backoff retry to re-run the handler before asserting.
      const deadline = performance.now() + 2_000;
      while (attempts < 2 && performance.now() < deadline) {
        await runtime.idle();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await runtime.idle();
      await runtime.storageManager.synced();
    } finally {
      server.transact = originalTransact;
    }

    expect(attempts).toBe(2);
    expect(statuses).toEqual(["done"]);
    expect(streamCell.get()).toBe(2);
  });

  it("prepares scheduler-managed relevant writes before commit", async () => {
    const streamCell = runtime.getCell<number>(
      space,
      "cfc-scheduler-prepare-stream",
      undefined,
      tx,
    );
    streamCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const guardedCell = runtime.getCell<{ value: string }>(
      space,
      "cfc-scheduler-prepare-output",
      {
        type: "object",
        properties: {
          value: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["value"],
      },
      tx,
    );
    guardedCell.set({ value: "seed" });
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.addEventHandler(
      (handlerTx, event) => {
        guardedCell.withTx(handlerTx).set({ value: `event-${event}` });
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const statuses: string[] = [];
    runtime.scheduler.queueEvent(
      streamCell.getAsNormalizedFullLink(),
      1,
      false,
      (committedTx) => {
        statuses.push(committedTx.status().status);
      },
    );

    await runtime.idle();
    await runtime.storageManager.synced();

    expect(statuses).toEqual(["done"]);
    const readTx = runtime.edit();
    const refreshed = runtime.getCell<{ value: string }>(
      space,
      "cfc-scheduler-prepare-output",
      {
        type: "object",
        properties: {
          value: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["value"],
      },
      readTx,
    );
    expect(refreshed.get()).toEqual({ value: "event-1" });
  });
});
