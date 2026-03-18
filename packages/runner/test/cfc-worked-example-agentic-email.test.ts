import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { createCfcIntentOnce } from "../src/cfc/intent-refinement.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
} from "../src/cfc/shared.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import type { IExtendedStorageTransaction, Labels } from "../src/storage/interface.ts";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CFC worked example: agentic email send", () => {
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

  async function readLabels(
    link: NormalizedFullLink,
  ): Promise<Record<string, Labels>> {
    const readTx = runtime.edit();
    const raw = readTx.readOrThrow(cfcLabelsAddress(link));
    await readTx.abort();
    return normalizePersistedLabels(raw);
  }

  async function runEmailSend(intent = createEmailSendIntent()) {
    const requestCell = runtime.getCell(space, "agentic-email-request", emailRequestSchema, tx);
    requestCell.withTx(tx).set({
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
    });
    await prepareBoundaryCommit(tx);
    const prepared = await tx.commit();
    expect(prepared.error).toBeUndefined();

    tx = runtime.edit();
    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const testPattern = pattern<{ request: unknown }>(({ request }) =>
      fetchData(request)
    );
    const resultCell = runtime.getCell(space, "agentic-email-result", undefined, tx);
    const result = runtime.run(tx, testPattern, { request: requestCell }, resultCell);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();
    tx = runtime.edit();
    return {
      result,
      raw: await pullFinalResult(result),
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

    const resultLabels = await readLabels(result.key("result").resolveAsCell()
      .getAsNormalizedFullLink());
    expect(resultLabels["/"]?.classification).toEqual([[userAliceAtom]]);
    expect(resultLabels["/"]?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining(disclaimerAttachedAtom),
      ]),
    );
  });
});
