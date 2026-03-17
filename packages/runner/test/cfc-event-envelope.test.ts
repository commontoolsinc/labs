import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createCfcEventEnvelope } from "../src/cfc/event-envelope.ts";

const signer = await Identity.fromPassphrase("cfc event envelope test");
const space = signer.did();

describe("CFC event envelopes", () => {
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

  it("exposes the current event envelope on the handler transaction", async () => {
    const triggerStream = await createStreamCell("cfc-event-envelope-trigger");
    const seen: Array<{
      payload: unknown;
      eventId: string | undefined;
      integrityCount: number;
    }> = [];

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        seen.push({
          payload: event,
          eventId: tx.currentCfcEvent?.id,
          integrityCount: tx.currentCfcEvent?.integrity.length ?? 0,
        });
      },
      triggerStream.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        triggerStream.getAsNormalizedFullLink(),
        createCfcEventEnvelope({
          id: "event-envelope-test-1",
          payload: { value: 7 },
          integrity: [{ type: "TestIntegrity" }],
        }),
        0,
        () => resolve(),
      );
    });

    expect(seen).toEqual([
      {
        payload: { value: 7 },
        eventId: "event-envelope-test-1",
        integrityCount: 1,
      },
    ]);
  });

  it("deduplicates once-per-handler delivery for duplicate semantic event ids", async () => {
    const triggerStream = await createStreamCell("cfc-event-envelope-dedup");
    let deliveries = 0;

    runtime.scheduler.addEventHandler(
      (_tx, event) => {
        deliveries++;
        expect(event).toEqual({ value: 1 });
      },
      triggerStream.getAsNormalizedFullLink(),
    );

    const event = createCfcEventEnvelope({
      id: "event-envelope-dedup-1",
      payload: { value: 1 },
      delivery: "once-per-handler",
    });

    runtime.scheduler.queueEvent(
      triggerStream.getAsNormalizedFullLink(),
      event,
      0,
    );
    runtime.scheduler.queueEvent(
      triggerStream.getAsNormalizedFullLink(),
      event,
      0,
    );

    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(deliveries).toBe(1);
  });

  it("preserves legacy raw event delivery semantics", async () => {
    const triggerStream = await createStreamCell("cfc-event-envelope-legacy");
    const delivered: number[] = [];

    runtime.scheduler.addEventHandler(
      (_tx, event) => {
        delivered.push(event as number);
      },
      triggerStream.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(triggerStream.getAsNormalizedFullLink(), 1, 0);
    runtime.scheduler.queueEvent(triggerStream.getAsNormalizedFullLink(), 1, 0);

    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(delivered).toEqual([1, 1]);
  });
});
