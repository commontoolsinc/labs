/**
 * Repro test for manager.add() silent failure.
 *
 * When a stream event handler's transaction fails after exhausting all retries,
 * the scheduler still calls the onCommit callback (scheduler.ts ~line 2089).
 * The callback receives a transaction with status "error", but manager.add()
 * previously ignored the tx parameter entirely — it just resolved the Promise.
 * This meant manager.add() could report success even though the piece was never
 * committed to allPieces.
 *
 * In production this manifests when deploying a piece to a freshly-created
 * space: the default-app's reactive graph (visiblePieces computed, BacklinksIndex)
 * is still stabilizing and causes transaction conflicts. The addPiece handler's
 * write to allPieces fails silently, and the piece never appears in the list.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

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
    });
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("onCommit-based promise resolves even when handler transaction is aborted", async () => {
    // Setup: create a stream cell and a data cell the handler writes to
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

    // Register handler that simulates addPiece but always aborts
    // (simulating transaction conflict from concurrent reactive graph updates)
    let handlerCallCount = 0;
    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        handlerCallCount++;
        // Simulate the conflict: handler tries to write but tx is aborted
        // This is what happens when computed values (visiblePieces, BacklinksIndex)
        // cause transaction conflicts during default-app stabilization
        handlerTx.abort("Simulated transaction conflict from reactive graph");
      },
      streamCell.getAsNormalizedFullLink(),
    );

    // This mirrors what manager.add() USED TO do: send event, resolve on callback
    // ignoring the tx status entirely.
    // Old code (manager.ts:193): addPieceHandler.send({ piece }, () => resolve())
    const addResult = await new Promise<{
      resolved: boolean;
      txStatus: string;
    }>((resolve) => {
      runtime.scheduler.queueEvent(
        streamCell.getAsNormalizedFullLink(),
        { piece: "test-piece-id" },
        2, // Low retry count to speed up test
        (committedTx) => {
          resolve({
            resolved: true,
            txStatus: committedTx.status().status,
          });
        },
      );
    });

    // Wait for scheduler to settle
    await runtime.idle();
    await runtime.storageManager.synced();

    // The promise resolved successfully...
    expect(addResult.resolved).toBe(true);

    // ...but the transaction actually FAILED
    expect(addResult.txStatus).toBe("error");

    // Handler was called multiple times (initial + retries) but all aborted
    expect(handlerCallCount).toBe(3); // 1 initial + 2 retries

    // allPieces was never updated — the piece would be silently lost
    // if the caller doesn't check tx.status()
    expect(allPiecesCell.get()).toEqual([]);
  });

  it("checking tx.status() in callback correctly detects failure", async () => {
    // This test validates the fix: callers that check tx.status()
    // can properly detect and surface the failure.

    const streamCell = runtime.getCell<number>(
      space,
      "fix-demo-stream",
      undefined,
      tx,
    );
    streamCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Handler that always aborts (simulates persistent conflict)
    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        handlerTx.abort("Always fails");
      },
      streamCell.getAsNormalizedFullLink(),
    );

    // OLD behavior (broken): ignores tx, always resolves
    const brokenPattern = new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        streamCell.getAsNormalizedFullLink(),
        1,
        1, // minimal retries
        () => resolve(), // ignores tx — this is the bug
      );
    });

    // This resolves without error even though the handler always aborted
    await brokenPattern;

    // FIXED behavior: check tx.status() to detect failure
    const fixedPattern = new Promise<void>((resolve, reject) => {
      runtime.scheduler.queueEvent(
        streamCell.getAsNormalizedFullLink(),
        2,
        1,
        (committedTx) => {
          if (committedTx.status().status === "error") {
            reject(
              new Error(
                "Piece registration failed: transaction aborted after retries",
              ),
            );
          } else {
            resolve();
          }
        },
      );
    });

    // With the fix, this correctly throws
    await expect(fixedPattern).rejects.toThrow(/transaction aborted/);
  });
});
