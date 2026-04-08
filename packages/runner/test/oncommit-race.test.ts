/**
 * Regression tests for stream-event success callbacks.
 *
 * Scheduler-delivered `onCommit` callbacks now run through the success-only
 * post-commit outbox, so they must not fire for exhausted failures and must
 * fire exactly once for the winning retry.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test oncommit race");
const space = signer.did();

describe("onCommit callback as success signal (race condition)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "enforce-explicit",
    });
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("does not fire onCommit when handler transaction is aborted", async () => {
    const streamCell = runtime.getCell<{ piece: string }>(
      space,
      "add-piece-stream",
      undefined,
      tx,
    );
    streamCell.set({} as { piece: string });
    await tx.commit();
    tx = runtime.edit();

    const allPiecesCell = runtime.getCell<string[]>(
      space,
      "all-pieces-list",
      undefined,
      tx,
    );
    allPiecesCell.set([]);
    await tx.commit();
    tx = runtime.edit();

    let handlerCallCount = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        handlerCallCount++;
        handlerTx.abort("Simulated transaction conflict from reactive graph");
      },
      streamCell.getAsNormalizedFullLink(),
    );

    let callbackCalled = false;
    runtime.scheduler.queueEvent(
      streamCell.getAsNormalizedFullLink(),
      { piece: "test-piece-id" },
      2,
      () => {
        callbackCalled = true;
      },
    );

    await runtime.idle();
    await runtime.storageManager.synced();

    expect(callbackCalled).toBe(false);
    expect(handlerCallCount).toBe(3);
    expect(allPiecesCell.get()).toEqual([]);
  });

  it("fires onCommit only after a successful retry", async () => {
    const streamCell = runtime.getCell<number>(
      space,
      "fix-demo-stream",
      undefined,
      tx,
    );
    streamCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let attempts = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, event) => {
        attempts++;
        if (attempts === 1) {
          handlerTx.abort("Always fails");
          return;
        }
        streamCell.withTx(handlerTx).set(event + 1);
      },
      streamCell.getAsNormalizedFullLink(),
    );

    const statuses: string[] = [];
    runtime.scheduler.queueEvent(
      streamCell.getAsNormalizedFullLink(),
      1,
      1,
      (committedTx) => {
        statuses.push(committedTx.status().status);
      },
    );

    await runtime.idle();
    await runtime.storageManager.synced();

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
            ifc: { classification: ["secret"] },
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
      0,
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
            ifc: { classification: ["secret"] },
          },
        },
        required: ["value"],
      },
      readTx,
    );
    expect(refreshed.get()).toEqual({ value: "event-1" });
  });
});
