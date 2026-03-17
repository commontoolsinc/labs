import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { CfcEventEnvelope } from "../src/cfc/event-envelope.ts";
import type { CfcIntentEventPayload } from "../src/cfc/intent-event.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { refineCfcIntentEventOnce } from "../src/cfc/intent-refinement.ts";

const signer = await Identity.fromPassphrase("cfc intent refiner flow test");
const space = signer.did();

describe("CFC intent refiner flow", () => {
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

  async function createCell(id: string, initialValue?: unknown) {
    const tx = runtime.edit();
    const cell = runtime.getCell<any>(space, id, undefined, tx);
    if (initialValue !== undefined) {
      cell.set(initialValue);
    }
    await tx.commit();
    return cell;
  }

  it("refines duplicate semantic events into one stored short intent", async () => {
    const triggerStream = await createCell("cfc-intent-refiner-trigger", {
      $stream: true,
    });
    const intentCell = await createCell("cfc-intent-refiner-output");
    let handlerRuns = 0;

    runtime.scheduler.addEventHandler(
      (tx) => {
        handlerRuns++;
        const sourceIntent = tx.currentCfcEvent as CfcEventEnvelope<
          CfcIntentEventPayload
        >;
        const intentOnce = refineCfcIntentEventOnce(
          runtime,
          tx,
          space,
          sourceIntent,
          {
            refinerHash: "sha256:gmail-forward-refiner",
            operation: "Gmail.Forward",
            audience: "https://gmail.googleapis.com",
            endpoint: "gmail.messages.send",
            parameters: sourceIntent.payload.parameters,
            exp: 1_700_000_000_000 + 4_000,
            maxAttempts: 3,
            duration: "short",
          },
        );

        if (intentOnce) {
          intentCell.withTx(tx).set(intentOnce);
        }
      },
      triggerStream.getAsNormalizedFullLink(),
    );

    const intentEvent = createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-flow-1",
      conditionHash: "Cond.ForwardClicked",
      parameters: {
        emailId: "m-44",
        recipientSet: ["a@example.com"],
      },
      delivery: "default",
      integrity: [
        { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-44" },
      ],
    });

    runtime.scheduler.queueEvent(
      triggerStream.getAsNormalizedFullLink(),
      intentEvent,
      0,
    );
    runtime.scheduler.queueEvent(
      triggerStream.getAsNormalizedFullLink(),
      intentEvent,
      0,
    );

    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(handlerRuns).toBe(2);
    expect(intentCell.get()).toMatchObject({
      sourceIntentId: intentEvent.id,
      operation: "Gmail.Forward",
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      duration: "short",
      maxAttempts: 3,
      idempotencyKey: expect.any(String),
    });
  });
});
