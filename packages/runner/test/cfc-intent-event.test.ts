import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  createCfcIntentEventEnvelope,
  deriveCfcIntentEventId,
} from "../src/cfc/intent-event.ts";

const signer = await Identity.fromPassphrase("cfc intent event test");
const space = signer.did();

describe("CFC intent events", () => {
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

  it("derives stable intent ids for equivalent parameters", () => {
    const a = deriveCfcIntentEventId({
      sourceGestureId: "gesture-1",
      conditionHash: "cond-forward",
      parameters: {
        emailId: "m-1",
        recipientSet: ["a@example.com", "b@example.com"],
      },
    });
    const b = deriveCfcIntentEventId({
      sourceGestureId: "gesture-1",
      conditionHash: "cond-forward",
      parameters: {
        recipientSet: ["a@example.com", "b@example.com"],
        emailId: "m-1",
      },
    });
    const c = deriveCfcIntentEventId({
      sourceGestureId: "gesture-1",
      conditionHash: "cond-forward",
      parameters: {
        emailId: "m-2",
        recipientSet: ["a@example.com", "b@example.com"],
      },
    });

    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("creates intent event envelopes with trusted event metadata", () => {
    const intent = createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-1",
      conditionHash: "Cond.ForwardClicked",
      parameters: {
        emailId: "m-1",
        recipientSet: ["a@example.com"],
      },
      evidence: {
        renderRef: {
          seq: 42,
          rootRef: { space: "ui", id: "render-42" },
        },
        snapshotDigest: "snap-42",
        targetPath: "/children/3",
      },
      integrity: [
        { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-1" },
        {
          type: "https://commonfabric.org/cfc/atom/GestureProvenance",
          renderRef: { seq: 42, rootRef: { space: "ui", id: "render-42" } },
          snapshot: "snap-42",
          targetPath: "/children/3",
        },
      ],
    });

    expect(intent.delivery).toBe("once-per-handler");
    expect(intent.sourceGestureId).toBe("gesture-forward-1");
    expect(intent.payload).toEqual({
      action: "ForwardEmail",
      conditionHash: "Cond.ForwardClicked",
      parameters: {
        emailId: "m-1",
        recipientSet: ["a@example.com"],
      },
    });
    expect(intent.integrity).toHaveLength(2);
    expect(intent.evidence).toEqual({
      renderRef: {
        seq: 42,
        rootRef: { space: "ui", id: "render-42" },
      },
      snapshotDigest: "snap-42",
      targetPath: "/children/3",
    });
  });

  it("deduplicates queued intent events by derived semantic id", async () => {
    const triggerStream = await createStreamCell("cfc-intent-event-trigger");
    const seen: Array<{ action: string; eventId: string | undefined }> = [];

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        seen.push({
          action: (event as { action: string }).action,
          eventId: tx.currentCfcEvent?.id,
        });
      },
      triggerStream.getAsNormalizedFullLink(),
    );

    const intentEvent = createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-2",
      conditionHash: "Cond.ForwardClicked",
      parameters: {
        emailId: "m-9",
        recipientSet: ["x@example.com"],
      },
      evidence: {
        renderRef: {
          seq: 7,
          rootRef: { space: "ui", id: "render-7" },
        },
        snapshotDigest: "snap-7",
        targetPath: "/children/5",
      },
      integrity: [{ type: "GestureProvenance" }],
    });

    runtime.scheduler.queueEvent(triggerStream.getAsNormalizedFullLink(), intentEvent, 0);
    runtime.scheduler.queueEvent(triggerStream.getAsNormalizedFullLink(), intentEvent, 0);

    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(seen).toEqual([
      {
        action: "ForwardEmail",
        eventId: intentEvent.id,
      },
    ]);
  });
});
