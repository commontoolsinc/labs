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
   * A counter a stream handler increments, read by one derivation whose runs
   * are counted. Three events are queued before the scheduler takes any, each
   * under its own durable id so that none collapses into another.
   */
  async function queueThreeEvents(servingPosture: boolean) {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture,
    });
    const tx = runtime.edit();
    const counter = runtime.getCell<number>(
      space,
      `serving event batch counter ${servingPosture}`,
      undefined,
      tx,
    );
    counter.set(0);
    const stream = runtime.getCell<unknown>(
      space,
      `serving event batch stream ${servingPosture}`,
      undefined,
      tx,
    );
    stream.setRaw({ $stream: true });
    tx.commit();
    await runtime.idle();

    let derivationRuns = 0;
    const derivation: Action = (readTx) => {
      derivationRuns++;
      counter.withTx(readTx).get();
    };
    runtime.scheduler.subscribe(derivation, {
      reads: [toMemorySpaceAddress(counter.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.idle();
    expect(derivationRuns).toBe(1);

    const seen: number[] = [];
    runtime.scheduler.addEventHandler(
      (handlerTx: IExtendedStorageTransaction, event: { by: number }) => {
        seen.push(counter.withTx(handlerTx).get());
        counter.withTx(handlerTx).set(
          counter.withTx(handlerTx).get() + event.by,
        );
      },
      stream.getAsNormalizedFullLink(),
    );
    const link = stream.getAsNormalizedFullLink();
    for (const by of [1, 2, 3]) {
      runtime.scheduler.queueEvent(link, { by }, true, undefined, false, {
        eventId: `serving-event-batch-${servingPosture}-${by}`,
      });
    }
    await runtime.idle();
    return { seen, derivationRuns: () => derivationRuns, counter };
  }

  it("runs every ready event's handler before one derivation pass under the serving posture", async () => {
    const { seen, derivationRuns, counter } = await queueThreeEvents(true);
    // Each handler read what the one before it wrote, and the derivation
    // ran once over all three rather than once per event.
    expect(seen).toEqual([0, 1, 3]);
    expect(counter.get()).toBe(6);
    expect(derivationRuns()).toBe(2);
  });

  it("settles the derivations after each event outside the serving posture", async () => {
    const { seen, derivationRuns, counter } = await queueThreeEvents(false);
    expect(seen).toEqual([0, 1, 3]);
    expect(counter.get()).toBe(6);
    expect(derivationRuns()).toBe(4);
  });
});
