import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("cfc outbox test");
const space = signer.did();

describe("CFC commit-gated outbox", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function createStreamCell(id: string) {
    const tx = runtime.edit();
    const streamCell = runtime.getCell<any>(space, id, undefined, tx);
    streamCell.set({ $stream: true });
    await tx.commit();
    return streamCell;
  }

  it("does not deliver queued stream events when parent commit fails", async () => {
    const triggerStream = await createStreamCell("cfc-outbox-fail-trigger");
    const sideEffectStream = await createStreamCell("cfc-outbox-fail-sidefx");
    const delivered: unknown[] = [];
    let callbackStatus: string | undefined;

    runtime.scheduler.addEventHandler(
      (_tx, event) => {
        delivered.push(event);
      },
      sideEffectStream.getAsNormalizedFullLink(),
    );

    runtime.scheduler.addEventHandler(
      (tx, _event) => {
        sideEffectStream.withTx(tx).send({ value: 1 });
        tx.abort("force-parent-failure");
      },
      triggerStream.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        triggerStream.getAsNormalizedFullLink(),
        1,
        0,
        (commitTx) => {
          callbackStatus = commitTx.status().status;
          resolve();
        },
      );
    });
    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(callbackStatus).toBe("error");
    expect(delivered).toEqual([]);
  });

  it("delivers queued event after successful parent commit", async () => {
    const triggerStream = await createStreamCell("cfc-outbox-success-trigger");
    const sideEffectStream = await createStreamCell("cfc-outbox-success-sidefx");
    const delivered: unknown[] = [];
    let callbackStatus: string | undefined;

    runtime.scheduler.addEventHandler(
      (_tx, event) => {
        delivered.push(event);
      },
      sideEffectStream.getAsNormalizedFullLink(),
    );

    runtime.scheduler.addEventHandler(
      (tx, _event) => {
        sideEffectStream.withTx(tx).send({ value: 7 });
      },
      triggerStream.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        triggerStream.getAsNormalizedFullLink(),
        1,
        0,
        (commitTx) => {
          callbackStatus = commitTx.status().status;
          resolve();
        },
      );
    });
    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(callbackStatus).toBe("done");
    expect(delivered).toEqual([{ value: 7 }]);
  });

  it("preserves enqueue order for multiple queued events", async () => {
    const triggerStream = await createStreamCell("cfc-outbox-order-trigger");
    const sideEffectStream = await createStreamCell("cfc-outbox-order-sidefx");
    const delivered: number[] = [];
    let callbackStatus: string | undefined;

    runtime.scheduler.addEventHandler(
      (_tx, event) => {
        delivered.push(event as number);
      },
      sideEffectStream.getAsNormalizedFullLink(),
    );

    runtime.scheduler.addEventHandler(
      (tx, _event) => {
        sideEffectStream.withTx(tx).send(1);
        sideEffectStream.withTx(tx).send(2);
        sideEffectStream.withTx(tx).send(3);
      },
      triggerStream.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        triggerStream.getAsNormalizedFullLink(),
        1,
        0,
        (commitTx) => {
          callbackStatus = commitTx.status().status;
          resolve();
        },
      );
    });
    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(callbackStatus).toBe("done");
    expect(delivered).toEqual([1, 2, 3]);
  });

  it("emits queued events only from committed retry attempt", async () => {
    const triggerStream = await createStreamCell("cfc-outbox-retry-trigger");
    const sideEffectStream = await createStreamCell("cfc-outbox-retry-sidefx");
    const delivered: string[] = [];
    let attempts = 0;

    runtime.scheduler.addEventHandler(
      (_tx, event) => {
        delivered.push(event as string);
      },
      sideEffectStream.getAsNormalizedFullLink(),
    );

    runtime.scheduler.addEventHandler(
      (tx, _event) => {
        attempts++;
        sideEffectStream.withTx(tx).send(`attempt-${attempts}`);
        if (attempts === 1) {
          tx.abort("force-retry");
        }
      },
      triggerStream.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        triggerStream.getAsNormalizedFullLink(),
        1,
        1,
        () => resolve(),
      );
    });
    await runtime.scheduler.idle();
    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(attempts).toBe(2);
    expect(delivered).toEqual(["attempt-2"]);
  });
});
