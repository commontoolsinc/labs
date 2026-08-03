// pull() must await its own first sync — the root-doc half of the
// fresh-replica story (fresh-replica-read-asymmetry.test.ts covers the
// link-target half).
//
// pull() used to KICK the cell's first sync without registering it anywhere
// ("No await, just kicking this off"), then wait only on scheduler idle plus
// the cross-space load pool. The root doc's own round-trip was in neither, so
// pull resolved whenever the scheduler quiesced — which over a low-latency
// link is AFTER the doc arrives, and over a real network is BEFORE. Measured
// in production shape: a same-id retry's receipt readback (`cf piece call
// --invocation`, the WS-D collision path reading the winner's receipt via
// getCellFromLink → pull) returned the original result against a local
// toolshed and `undefined` against a remote host, every time. sync()'s own
// doc comment names the trap: code gating on idle() alone can race the
// deferred sync; register it with trackUntilSettled so pull() awaits it.
//
// The gate below makes the race deterministic instead of latency-shaped: the
// reader's syncCell for the target doc is held until the test has SEEN the
// reader's scheduler go idle — the exact moment the unregistered kick used to
// lose — and only then lets the "network" answer.
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }

  private sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const signer = await Identity.fromPassphrase("pull-first-sync-race");
const space = signer.did();

const RECEIPT_CAUSE = "receipt-race-doc";
const RECEIPT_VALUE = { note: { title: "Original", revision: 1 } };

describe("pull() and the first sync of an unseen doc", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: SharedServerStorageManager;
  let writerRt: Runtime;

  beforeEach(async () => {
    server = newSharedServer();
    writerStorage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    writerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });

    // The winner's receipt, as the collision path leaves it: a plain-JSON
    // outcome in a doc this writer committed and a later reader never saw.
    const tx = writerRt.edit();
    const receipt = writerRt.getCell(space, RECEIPT_CAUSE, undefined, tx);
    receipt.set(RECEIPT_VALUE);
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
    await writerStorage.synced();
  });

  afterEach(async () => {
    await writerRt?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  it("resolves the doc's value even when the sync answer arrives after idle", async () => {
    const readerStorage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const link = writerRt
        .getCell(space, RECEIPT_CAUSE, undefined)
        .getAsNormalizedFullLink();

      // Hold the target doc's sync until the test releases it; everything
      // else passes through. The gated promise is what pull() must await.
      const gate = Promise.withResolvers<void>();
      const originalSyncCell = readerStorage.syncCell.bind(readerStorage);
      readerStorage.syncCell = (<T>(cell: Cell<T>): Promise<Cell<T>> => {
        const target = cell.getAsNormalizedFullLink();
        if (target.id === link.id) {
          return gate.promise.then(() => originalSyncCell(cell));
        }
        return originalSyncCell(cell);
      }) as typeof readerStorage.syncCell;

      // The CLI readback shape exactly: getCellFromLink → pull, no schema.
      const receipt = readerRt.getCellFromLink<typeof RECEIPT_VALUE>(link);
      const pullPromise = receipt.pull();

      // Let the reader's scheduler go fully idle. This is the moment the
      // unregistered kick used to resolve at — with the doc still in flight.
      await readerRt.scheduler.idle();

      // Only now does the "network" answer.
      gate.resolve();

      expect(await pullPromise).toEqual(RECEIPT_VALUE);
    } finally {
      await readerRt.dispose();
      await readerStorage.close();
    }
  });

  it("still resolves promptly when the doc is already in the replica (control)", async () => {
    // The writer's own replica: pull() must not begin waiting on network
    // confirmation it already has.
    const receipt = writerRt.getCell<typeof RECEIPT_VALUE>(
      space,
      RECEIPT_CAUSE,
      undefined,
    );
    expect(await receipt.pull()).toEqual(RECEIPT_VALUE);
  });
});
