import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { createCfcIntentOnce } from "../src/cfc/intent-refinement.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example gmail send test",
);

describe("CFC worked example: Gmail send", () => {
  let harness: ReturnType<typeof createCfcPatternTestHarness>;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  type SettledFetchResult = {
    pending?: boolean;
    result?: unknown;
    error?: unknown;
  } | undefined;

  beforeEach(() => {
    harness = createCfcPatternTestHarness({
      signer,
      apiUrl: new URL(import.meta.url),
      patternEnvironment: {
        apiUrl: new URL("http://mock-test-server.local"),
      },
    });

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    harness.stubFetch((
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
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await harness.dispose();
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

  it("reuses the committed send result across a fresh runtime instance", async () => {
    const intent = createIntent(Date.now());
    const fetchData = harness.byRef("fetchData") as (params: unknown) => unknown;
    const sendPattern = harness.pattern(() =>
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

    const firstRun = await harness.runPattern({
      id: "gmail-send-worked-example-1",
      pattern: sendPattern,
      inputs: {},
    });
    const firstRaw = await harness.pullSettledResult(
      firstRun.result,
    ) as SettledFetchResult;
    expect(firstRaw?.error).toBeUndefined();
    expect(firstRaw?.result).toEqual({
      ok: true,
      messageId: "m-sent-1",
      fetchCount: 1,
    });
    expect(fetchCalls.length).toBe(1);

    await harness.restart();

    const secondRun = await harness.runPattern({
      id: "gmail-send-worked-example-2",
      pattern: sendPattern,
      inputs: {},
    });
    const secondRaw = await harness.pullSettledResult(
      secondRun.result,
    ) as SettledFetchResult;
    expect(secondRaw?.error).toBeUndefined();
    expect(secondRaw?.result).toEqual({
      ok: true,
      messageId: "m-sent-1",
      fetchCount: 1,
    });
    expect(fetchCalls.length).toBe(1);
  });
});
