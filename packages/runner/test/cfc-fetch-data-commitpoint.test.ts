import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { setPatternEnvironment } from "../src/env.ts";
import {
  claimCfcIntentConsumed,
} from "../src/cfc/intent-consumption.ts";
import {
  createCfcIntentEventEnvelope,
} from "../src/cfc/intent-event.ts";
import { createCfcIntentOnce } from "../src/cfc/intent-refinement.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc fetchData commit-point test");
const space = signer.did();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("fetchData commit-point intent wiring", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push({ url, init });
      await delay(10);
      return new Response(
        JSON.stringify({
          ok: true,
          messageId: "m-1",
          fetchCount: fetchCalls.length,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  function createIntent(now: number) {
    const sourceIntent = createCfcIntentEventEnvelope({
      action: "ForwardEmail",
      sourceGestureId: "gesture-forward-fetch-live-1",
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
      parameters: {
        raw: "base64url-rfc2822",
      },
      exp: now + 4_000,
      maxAttempts: 3,
      duration: "short",
    });
  }

  async function pullFinalResult(resultCell: { pull: () => Promise<unknown>; get: () => unknown }) {
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

  it("preserves the legacy non-intent fetch path", async () => {
    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const testPattern = pattern(() =>
      fetchData({
        url: "http://mock-test-server.local/api/legacy",
        mode: "json",
      }));

    const resultCell = runtime.getCell(space, "fetch-legacy-live", undefined, tx);
    const result = runtime.run(tx, testPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    const raw = await pullFinalResult(result);

    expect(raw?.pending).toBe(false);
    expect(raw?.error).toBeUndefined();
    expect(raw?.result).toEqual({
      ok: true,
      messageId: "m-1",
      fetchCount: 1,
    });
    expect(fetchCalls.length).toBe(1);
  });

  it("reuses the stored committed result for an already-consumed intent", async () => {
    const now = 1_700_000_000_000;
    const intent = createIntent(now);
    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const testPattern = pattern(() =>
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
      }));

    const firstResultCell = runtime.getCell(
      space,
      "fetch-intent-live-1",
      undefined,
      tx,
    );
    const firstResult = runtime.run(tx, testPattern, {}, firstResultCell);
    await tx.commit();
    tx = runtime.edit();

    const firstRaw = await pullFinalResult(firstResult);
    expect(firstRaw?.error).toBeUndefined();
    expect(firstRaw?.result).toEqual({
      ok: true,
      messageId: "m-1",
      fetchCount: 1,
    });
    expect(fetchCalls.length).toBe(1);

    const verifyTx = runtime.edit();
    const consumed = claimCfcIntentConsumed(
      runtime,
      verifyTx,
      space,
      intent.id,
    );
    expect(consumed.alreadyClaimed).toBe(true);
    await verifyTx.abort();

    tx = runtime.edit();
    const secondResultCell = runtime.getCell(
      space,
      "fetch-intent-live-2",
      undefined,
      tx,
    );
    const secondResult = runtime.run(tx, testPattern, {}, secondResultCell);
    await tx.commit();
    tx = runtime.edit();

    const secondRaw = await pullFinalResult(secondResult);
    expect(secondRaw?.error).toBeUndefined();
    expect(secondRaw?.result).toEqual({
      ok: true,
      messageId: "m-1",
      fetchCount: 1,
    });
    expect(fetchCalls.length).toBe(1);
  });

  it("blocks network execution when the request does not match the bound intent", async () => {
    const now = 1_700_000_000_000;
    const intent = createIntent(now);
    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const testPattern = pattern(() =>
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
          endpoint: "gmail.messages.insert",
        },
      }));

    const resultCell = runtime.getCell(
      space,
      "fetch-intent-binding-mismatch",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    const raw = await pullFinalResult(result);
    expect(raw?.pending).toBe(false);
    expect(raw?.result).toBeUndefined();
    expect(raw?.error).toBe("intent_binding_mismatch");
    expect(fetchCalls.length).toBe(0);
  });

  it("blocks network execution when the auth token appears outside Authorization", async () => {
    const now = 1_700_000_000_000;
    const intent = createIntent(now);
    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const testPattern = pattern(() =>
      fetchData({
        url:
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send?access_token=Bearer%20token",
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
      }));

    const resultCell = runtime.getCell(
      space,
      "fetch-intent-auth-structure",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    await tx.commit();
    tx = runtime.edit();

    const raw = await pullFinalResult(result);
    expect(raw?.pending).toBe(false);
    expect(raw?.result).toBeUndefined();
    expect(raw?.error).toBe("authorization_header_placement_invalid");
    expect(fetchCalls.length).toBe(0);
  });
});
