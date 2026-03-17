import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  commitCfcIntentWithRetries,
  type CfcIntentCommitResult,
} from "../src/cfc/intent-commit.ts";
import { claimCfcIntentConsumed } from "../src/cfc/intent-consumption.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { createCfcIntentOnce } from "../src/cfc/intent-refinement.ts";

const signer = await Identity.fromPassphrase("cfc intent commit test");
const space = signer.did();

describe("CFC intent commit helper", () => {
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

  function createShortIntent(exp: number, maxAttempts = 3) {
    const sourceIntent = createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-commit-1",
      conditionHash: "Cond.ForwardClicked",
      parameters: {
        emailId: "m-55",
        recipientSet: ["a@example.com"],
      },
      integrity: [
        { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-55" },
      ],
    });

    return createCfcIntentOnce(sourceIntent, {
      refinerHash: "sha256:gmail-forward-refiner",
      operation: "Gmail.Forward",
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      parameters: {
        emailId: "m-55",
        recipientSet: ["a@example.com"],
      },
      exp,
      maxAttempts,
      duration: "short",
    });
  }

  it("retries until success and consumes once", async () => {
    const now = 1_700_000_000_000;
    const intent = createShortIntent(now + 4_000, 3);
    const seenAttempts: number[] = [];

    const result = await commitCfcIntentWithRetries(
      runtime,
      space,
      intent,
      async (attemptNumber: number) => {
        seenAttempts.push(attemptNumber);
        return {
          success: attemptNumber === 3,
          error: attemptNumber === 3 ? undefined : "temporary_failure",
        } satisfies CfcIntentCommitResult;
      },
      { now: () => now },
    );

    expect(result).toEqual({
      success: true,
      attemptNumber: 3,
    });
    expect(seenAttempts).toEqual([1, 2, 3]);

    const verifyTx = runtime.edit();
    const consumed = claimCfcIntentConsumed(
      runtime,
      verifyTx,
      space,
      intent.id,
    );
    expect(consumed.alreadyClaimed).toBe(true);
    await verifyTx.abort();
  });

  it("returns deduplicated success when the consumed marker already exists", async () => {
    const now = 1_700_000_000_000;
    const intent = createShortIntent(now + 4_000, 3);

    const seedTx = runtime.edit();
    claimCfcIntentConsumed(runtime, seedTx, space, intent.id);
    await seedTx.commit();

    let executions = 0;
    const result = await commitCfcIntentWithRetries(
      runtime,
      space,
      intent,
      async () => {
        executions++;
        return { success: true } satisfies CfcIntentCommitResult;
      },
      { now: () => now },
    );

    expect(executions).toBe(1);
    expect(result).toEqual({
      success: true,
      deduplicated: true,
      attemptNumber: 1,
    });
  });

  it("fails closed when the intent is expired before any attempt", async () => {
    const now = 1_700_000_000_000;
    const intent = createShortIntent(now - 1, 3);
    let executions = 0;

    const result = await commitCfcIntentWithRetries(
      runtime,
      space,
      intent,
      async () => {
        executions++;
        return { success: true } satisfies CfcIntentCommitResult;
      },
      { now: () => now },
    );

    expect(executions).toBe(0);
    expect(result).toEqual({
      success: false,
      error: "intent_expired",
    });
  });
});
