import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { refineCfcDirectCommandIntentOnce } from "../src/cfc/direct-command-intent.ts";
import { refineCfcFactCheckedEmailSendIntent } from "../src/cfc/fact-checked-email-intent.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example agentic fact checked email test",
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
  source: "ref:report-fact-check-1",
} as const;

const disclaimerAttachedAtom = {
  type: "https://commonfabric.org/cfc/atom/SinkContentDisclaimerAttached",
  kind: "PROMPT_INFLUENCE",
  sink: "email-send:body",
  source: "ref:report-fact-check-1",
} as const;

const factCheckedAtom = {
  type: "https://commonfabric.org/cfc/atom/FactChecked",
  checker: "Builtin(fact-check)",
  version: "test-v1",
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
                  integrityPre: [disclaimerAttachedAtom, factCheckedAtom],
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

describe("CFC worked example: agentic fact-checked email", () => {
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

  function createSourceIntent() {
    return createCfcIntentEventEnvelope({
      action: "AssistantSurfaceSubmitted",
      sourceGestureId: "gesture-agentic-fact-checked-email",
      conditionHash: "Cond.DirectCommand",
      parameters: {
        topic: "berlin hotels",
        to: "alice@example.com",
      },
      integrity: [
        {
          type: "https://commonfabric.org/cfc/atom/UserSurfaceInput",
          user: space,
          surface: "AssistantComposer",
        },
        {
          type: "https://commonfabric.org/cfc/atom/PromptSlotBound",
          role: "direct-command",
          kernelName: "agent-kernel",
          subject: space,
          surface: "AssistantComposer",
        },
        {
          type: "https://commonfabric.org/cfc/atom/Builtin",
          name: "agent-kernel",
        },
      ],
    });
  }

  it("requires fact-check assurance before refining and sending the final email intent", async () => {
    const requestCell = await harness.withCommittedEdit((tx) => {
      const rootIntent = refineCfcDirectCommandIntentOnce(
        harness.runtime,
        tx,
        space,
        createSourceIntent(),
        {
          actingUser: space,
          kernelName: "agent-kernel",
          requiredSurface: "AssistantComposer",
          refinerHash: "sha256:agent-root-refiner",
          operation: "Agent.ResearchFactCheckedAndEmail",
          audience: "agent://root",
          endpoint: "agent-root",
          parameters: {
            topic: "berlin hotels",
            to: "alice@example.com",
            requiresFactChecked: true,
          },
          exp: Date.now() + 4_000,
          maxAttempts: 1,
          duration: "short",
        },
      );
      expect(rootIntent).not.toBeNull();

      const missingFactCheckIntent = refineCfcFactCheckedEmailSendIntent(
        rootIntent!,
        {
          recipient: "alice@example.com",
          refinerHash: "sha256:agent-email-refiner",
          operation: "Agent.EmailSend",
          audience: sinkAudience,
          endpoint: "email-send",
          parameters: JSON.stringify({
            to: "alice@example.com",
            body: "Fact-checked report body",
          }),
          exp: Date.now() + 4_000,
          maxAttempts: 1,
          duration: "short",
          additionalIntegrity: [disclaimerAttachedAtom],
        },
      );
      expect(missingFactCheckIntent).toBeNull();

      const sendIntent = refineCfcFactCheckedEmailSendIntent(rootIntent!, {
        recipient: "alice@example.com",
        refinerHash: "sha256:agent-email-refiner",
        operation: "Agent.EmailSend",
        audience: sinkAudience,
        endpoint: "email-send",
        parameters: JSON.stringify({
          to: "alice@example.com",
          body: "Fact-checked report body",
        }),
        exp: Date.now() + 4_000,
        maxAttempts: 1,
        duration: "short",
        additionalIntegrity: [disclaimerAttachedAtom, factCheckedAtom],
      });
      expect(sendIntent).not.toBeNull();

      const requestCell = harness.getCell(
        "agentic-fact-checked-email-request",
        emailRequestSchema,
        tx,
      );
      requestCell.withTx(tx).set({
        url: `${sinkAudience}/send`,
        mode: "json",
        options: {
          method: "POST",
          body: {
            to: "alice@example.com",
            body: "Fact-checked report body",
          },
          headers: {
            "X-Idempotency-Key": sendIntent!.idempotencyKey,
          },
        },
        cfc: {
          intent: sendIntent,
          endpoint: "email-send",
        },
      });
      return requestCell;
    }, {
      prepare: "boundary",
    });

    const fetchData = harness.byRef("fetchData") as (
      params: unknown,
    ) => unknown;
    const testPattern = harness.pattern<{ request: unknown }>(
      ({ request }: { request: unknown }) => fetchData(request),
    );
    const run = await harness.runPattern({
      id: "agentic-fact-checked-email-result",
      pattern: testPattern,
      inputs: { request: requestCell },
    });

    const raw = await harness.pullSettledResult(
      run.result,
    ) as SettledFetchResult;
    expect(raw?.pending).toBe(false);
    expect(raw?.error).toBeUndefined();
    expect(raw?.result).toEqual({
      ok: true,
      accepted: true,
    });
    expect(fetchCalls.length).toBe(1);
  });
});
