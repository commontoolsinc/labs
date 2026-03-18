import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { createCfcIntentOnce } from "../src/cfc/intent-refinement.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example gmail send test",
);
const space = signer.did();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CFC worked example: Gmail send", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let phaseOneRuntime: Runtime | undefined;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    pattern = commontools.pattern;
    byRef = commontools.byRef;

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push({ url, init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            messageId: "m-sent-1",
            fetchCount: fetchCalls.length,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (phaseOneRuntime && phaseOneRuntime !== runtime) {
      phaseOneRuntime.runner.stopAll();
      phaseOneRuntime.moduleRegistry.clear();
      phaseOneRuntime.scheduler.dispose();
      phaseOneRuntime.harness.dispose();
      phaseOneRuntime = undefined;
    }
    await tx.abort();
    await runtime.dispose();
  });

  function createIntent(now: number) {
    const sourceIntent = createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-gmail-send",
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
      exp: now + 4_000,
      maxAttempts: 3,
      duration: "short",
    });
  }

  async function pullFinalResult(
    resultCell: { pull: () => Promise<unknown>; get: () => unknown },
  ) {
    for (let attempt = 0; attempt < 8; attempt++) {
      await resultCell.pull();
      await delay(50);
      const value = resultCell.get() as
        | { pending?: boolean; result?: unknown; error?: unknown }
        | undefined;
      if (value?.pending === false) {
        return value;
      }
    }
    return resultCell.get() as
      | { pending?: boolean; result?: unknown; error?: unknown }
      | undefined;
  }

  it("reuses the committed send result across a fresh runtime instance", async () => {
    const intent = createIntent(Date.now());
    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const sendPattern = pattern(() =>
      fetchData({
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        mode: "json",
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
        cfc: {
          intent,
          endpoint: "gmail.messages.send",
        },
      })
    );

    const firstResultCell = runtime.getCell(
      space,
      "gmail-send-worked-example-1",
      undefined,
      tx,
    );
    const firstResult = runtime.run(tx, sendPattern, {}, firstResultCell);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const firstRaw = await pullFinalResult(firstResult);
    expect(firstRaw?.error).toBeUndefined();
    expect(firstRaw?.result).toEqual({
      ok: true,
      messageId: "m-sent-1",
      fetchCount: 1,
    });
    expect(fetchCalls.length).toBe(1);

    phaseOneRuntime = runtime;
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    tx = runtime.edit();

    const secondResultCell = runtime.getCell(
      space,
      "gmail-send-worked-example-2",
      undefined,
      tx,
    );
    const secondResult = runtime.run(tx, sendPattern, {}, secondResultCell);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const secondRaw = await pullFinalResult(secondResult);
    expect(secondRaw?.error).toBeUndefined();
    expect(secondRaw?.result).toEqual({
      ok: true,
      messageId: "m-sent-1",
      fetchCount: 1,
    });
    expect(fetchCalls.length).toBe(1);
  });
});
