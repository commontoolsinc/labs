import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { refineCfcDirectCommandIntentOnce } from "../src/cfc/direct-command-intent.ts";
import { refineCfcFactCheckedEmailSendIntent } from "../src/cfc/fact-checked-email-intent.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CFC worked example: agentic fact-checked email", () => {
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
            accepted: true,
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
    await tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  function createRootIntent() {
    const sourceIntent = createCfcIntentEventEnvelope({
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

    return refineCfcDirectCommandIntentOnce(runtime, tx, space, sourceIntent, {
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

  it("requires fact-check assurance before refining and sending the final email intent", async () => {
    const rootIntent = createRootIntent();
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

    const requestCell = runtime.getCell(
      space,
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
    await prepareBoundaryCommit(tx);
    const prepared = await tx.commit();
    expect(prepared.error).toBeUndefined();

    tx = runtime.edit();
    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const testPattern = pattern<{ request: unknown }>(({ request }) =>
      fetchData(request)
    );
    const resultCell = runtime.getCell(
      space,
      "agentic-fact-checked-email-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      { request: requestCell },
      resultCell,
    );
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const raw = await pullFinalResult(result);
    expect(raw?.pending).toBe(false);
    expect(raw?.error).toBeUndefined();
    expect(raw?.result).toEqual({
      ok: true,
      accepted: true,
    });
    expect(fetchCalls.length).toBe(1);
  });
});
