import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { createCfcIntentOnce } from "../src/cfc/intent-refinement.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example agentic email test",
);
const space = signer.did();
const sinkAudience = "https://mail.example.com";

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const promptInfluenceAtom = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "PROMPT_INFLUENCE",
  source: "ref:report-1",
} as const;

const disclaimerAttachedAtom = {
  type: "https://commonfabric.org/cfc/atom/SinkContentDisclaimerAttached",
  kind: "PROMPT_INFLUENCE",
  sink: "email-send:body",
  source: "ref:report-1",
} as const;

const emailRequestSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    mode: { type: "string" },
    options: {
      type: "object",
      properties: {
        method: { type: "string" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        body: {
          type: "object",
          properties: {
            to: {
              type: "string",
              ifc: {
                classification: [[userAliceAtom]],
              },
            },
            body: {
              type: "string",
              ifc: {
                classification: [[userAliceAtom], [promptInfluenceAtom]],
                exchange: {
                  confidentialityPre: [promptInfluenceAtom],
                  integrityPre: [disclaimerAttachedAtom],
                  removeMatchedClauses: true,
                  allowedSink: "fetchData",
                  allowedPaths: [["options", "body", "body"]],
                },
              },
            },
          },
          required: ["to", "body"],
        },
      },
    },
    cfc: {},
  },
} as const satisfies JSONSchema;

describe("CFC worked example: agentic email send", () => {
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
            accepted: true,
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

  function createEmailSendIntent(additionalIntegrity: readonly unknown[] = []) {
    const sourceIntent = createCfcIntentEventEnvelope({
      action: "AssistantSurfaceSubmitted",
      sourceGestureId: "gesture-agentic-email",
      conditionHash: "Cond.DirectCommand",
      parameters: {
        topic: "hotels in berlin",
        to: "alice@example.com",
      },
      integrity: [
        { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-88" },
      ],
    });

    return createCfcIntentOnce(sourceIntent, {
      refinerHash: "sha256:agent-email-refiner",
      operation: "Agent.EmailSend",
      audience: sinkAudience,
      endpoint: "email-send",
      parameters: JSON.stringify({
        to: "alice@example.com",
        body: "Research summary with prompt-influenced content",
      }),
      exp: Date.now() + 4_000,
      maxAttempts: 1,
      duration: "short",
      additionalIntegrity,
    });
  }

  async function runEmailSend(intent = createEmailSendIntent()) {
    const requestCell = await harness.writeCellValue({
      id: "agentic-email-request",
      schema: emailRequestSchema,
      value: {
        url: `${sinkAudience}/send`,
        mode: "json",
        options: {
          method: "POST",
          body: {
            to: "alice@example.com",
            body: "Research summary with prompt-influenced content",
          },
          headers: {
            "X-Idempotency-Key": intent.idempotencyKey,
          },
        },
        cfc: {
          intent,
          endpoint: "email-send",
        },
      },
      prepare: "boundary",
    });

    const fetchData = harness.byRef("fetchData") as (
      params: unknown,
    ) => unknown;
    const testPattern = harness.pattern<{ request: unknown }>(
      ({ request }: { request: unknown }) => fetchData(request),
    );
    const run = await harness.runPattern({
      id: "agentic-email-result",
      pattern: testPattern,
      inputs: { request: requestCell },
    });

    return {
      result: run.result,
      raw: await harness.pullSettledResult(run.result) as SettledFetchResult,
    };
  }

  it("allows the send when the refined intent carries the body-disclaimer evidence", async () => {
    const { raw, result } = await runEmailSend(
      createEmailSendIntent([disclaimerAttachedAtom]),
    );

    expect(raw?.pending).toBe(false);
    expect(raw?.error).toBeUndefined();
    expect(raw?.result).toEqual({
      ok: true,
      accepted: true,
    });
    expect(fetchCalls.length).toBe(1);

    const resultLabels = await harness.readLabels(
      result.key("result").resolveAsCell().getAsNormalizedFullLink(),
    );
    expect(resultLabels["/"]?.label?.classification).toEqual([[userAliceAtom]]);
    expect(resultLabels["/"]?.label?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining(disclaimerAttachedAtom),
      ]),
    );
  });
});
