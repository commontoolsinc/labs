import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("serving event batch");
const space = signer.did();

describe("scheduler serving event batch", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /**
   * Three cells, each set by a stream handler from one event, read together
   * by one derivation whose runs are counted. Three events are queued before
   * the scheduler takes any, each under its own durable id so that none
   * collapses into another. Each handler writes a cell of its own. With no
   * serving loop to seal them into one wave, each handler commits on its
   * own, and a commit can be refused and its handler run again; that run
   * comes after the first derivation run behind the events, which is what
   * these tests read.
   */
  async function queueThreeEvents(servingPosture: boolean) {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture,
    });
    const tx = runtime.edit();
    const slots = [1, 2, 3].map((by) => {
      const slot = runtime!.getCell<number>(
        space,
        `serving event batch slot ${by} ${servingPosture}`,
        undefined,
        tx,
      );
      slot.set(0);
      return slot;
    });
    const stream = runtime.getCell<unknown>(
      space,
      `serving event batch stream ${servingPosture}`,
      undefined,
      tx,
    );
    stream.setRaw({ $stream: true });
    tx.commit();
    await runtime.idle();

    const derived: number[] = [];
    const derivation: Action = (readTx) => {
      derived.push(
        slots.reduce((sum, slot) => sum + slot.withTx(readTx).get(), 0),
      );
    };
    runtime.scheduler.subscribe(derivation, {
      reads: slots.map((slot) =>
        toMemorySpaceAddress(slot.getAsNormalizedFullLink())
      ),
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.idle();
    expect(derived).toEqual([0]);

    runtime.scheduler.addEventHandler(
      (handlerTx: IExtendedStorageTransaction, event: { by: number }) => {
        slots[event.by - 1].withTx(handlerTx).set(event.by);
      },
      stream.getAsNormalizedFullLink(),
    );
    const link = stream.getAsNormalizedFullLink();
    for (const by of [1, 2, 3]) {
      runtime.scheduler.queueEvent(link, { by }, true, undefined, false, {
        eventId: `serving-event-batch-${servingPosture}-${by}`,
      });
    }
    // `idle()` returns ahead of the handler commits' writeback; a commit
    // still in flight when the runtime is disposed fails against the closed
    // store.
    await runtime.settled();
    // Read through the derivation's own transaction: a read outside one
    // under the serving posture reaches for the store, and a pull left
    // behind would outlive the test.
    return derived;
  }

  it("runs every ready event's handler before one derivation pass under the serving posture", async () => {
    const derived = await queueThreeEvents(true);
    // The first run behind the events read all three handlers' writes.
    expect(derived[1]).toBe(6);
    expect(derived.at(-1)).toBe(6);
  });

  it("settles the derivations after each event outside the serving posture", async () => {
    const derived = await queueThreeEvents(false);
    // A run behind each event, the first reading only its write.
    expect(derived).toEqual([0, 1, 3, 6]);
  });
});
