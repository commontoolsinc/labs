import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  commitCfcFetchIntentWithRetries,
} from "../src/cfc/fetch-intent-commit.ts";
import { claimCfcIntentConsumed } from "../src/cfc/intent-consumption.ts";
import { normalizeFetchDataInputs } from "../src/builtins/fetch-request.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { createCfcIntentOnce } from "../src/cfc/intent-refinement.ts";

const signer = await Identity.fromPassphrase("cfc fetch intent commit test");
const space = signer.did();

describe("CFC fetch intent commit helper", () => {
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

  function createIntent(exp: number) {
    const sourceIntent = createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-fetch-1",
      conditionHash: "Cond.ForwardClicked",
      parameters: {
        emailId: "m-77",
        recipientSet: ["a@example.com"],
      },
      integrity: [
        { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-77" },
      ],
    });

    return createCfcIntentOnce(sourceIntent, {
      refinerHash: "sha256:gmail-forward-refiner",
      operation: "Gmail.Forward",
      audience: "https://gmail.googleapis.com",
      endpoint: "gmail.messages.send",
      parameters: JSON.stringify({
        raw: "base64url-rfc2822",
      }),
      exp,
      maxAttempts: 3,
      duration: "short",
    });
  }

  function createMatchingFetchInputs() {
    return normalizeFetchDataInputs({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      options: {
        method: "POST",
        body: {
          raw: "base64url-rfc2822",
        },
        headers: {
          Authorization: "Bearer token",
          "X-Idempotency-Key": "unused-by-test",
        },
      },
    });
  }

  it("commits matching fetch requests with retries and consumes once", async () => {
    const now = 1_700_000_000_000;
    const intent = createIntent(now + 4_000);
    const inputs = normalizeFetchDataInputs({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      options: {
        method: "POST",
        body: {
          raw: "base64url-rfc2822",
        },
        headers: {
          Authorization: "Bearer token",
          "X-Idempotency-Key": intent.idempotencyKey,
        },
      },
    });
    const attempts: number[] = [];

    const result = await commitCfcFetchIntentWithRetries(
      runtime,
      space,
      intent,
      inputs,
      (attemptNumber: number) => {
        attempts.push(attemptNumber);
        return Promise.resolve({
          success: attemptNumber === 2,
          error: attemptNumber === 2 ? undefined : "temporary_failure",
        });
      },
      {
        now: () => now,
        endpoint: "gmail.messages.send",
      },
    );

    expect(result).toEqual({
      success: true,
      attemptNumber: 2,
    });
    expect(attempts).toEqual([1, 2]);

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

  it("fails closed on intent binding mismatch without executing the request", async () => {
    const now = 1_700_000_000_000;
    const intent = createIntent(now + 4_000);
    const inputs = createMatchingFetchInputs();
    let executions = 0;

    const result = await commitCfcFetchIntentWithRetries(
      runtime,
      space,
      intent,
      inputs,
      () => {
        executions++;
        return Promise.resolve({ success: true });
      },
      {
        now: () => now,
        endpoint: "gmail.messages.insert",
      },
    );

    expect(executions).toBe(0);
    expect(result).toEqual({
      success: false,
      error: "intent_binding_mismatch",
    });
  });

  it("fails closed when fetch inputs cannot derive semantics", async () => {
    const now = 1_700_000_000_000;
    const intent = createIntent(now + 4_000);
    let executions = 0;

    const result = await commitCfcFetchIntentWithRetries(
      runtime,
      space,
      intent,
      normalizeFetchDataInputs({}),
      () => {
        executions++;
        return Promise.resolve({ success: true });
      },
      {
        now: () => now,
        endpoint: "gmail.messages.send",
      },
    );

    expect(executions).toBe(0);
    expect(result).toEqual({
      success: false,
      error: "intent_binding_mismatch",
    });
  });
});
