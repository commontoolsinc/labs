import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { refineCfcReturnToSenderIntent } from "../src/cfc/return-to-sender-intent.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example return to sender provider trust test",
);
const space = signer.did();

const hotelPrincipal = "did:mailto:hotel@example.com";
const hotelAudience = "https://api.hotel.example.com";

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const authoredByHotelAtom = {
  type: "https://commonfabric.org/cfc/atom/AuthoredBy",
  sender: hotelPrincipal,
  provider: "Gmail",
  messageId: "m-hotel-1",
} as const;

const audienceRepresentsHotelAtom = {
  type: "https://commonfabric.org/cfc/atom/AudienceRepresents",
  principal: hotelPrincipal,
  audience: hotelAudience,
} as const;

const trustedProviderGmailAtom = {
  type: "https://commonfabric.org/cfc/atom/TrustedProvider",
  provider: "Gmail",
} as const;

const membershipSendSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    mode: { type: "string" },
    options: {
      type: "object",
      properties: {
        method: { type: "string" },
        body: {
          type: "object",
          properties: {
            membershipNumber: {
              type: "string",
              ifc: {
                classification: [
                  [userAliceAtom],
                  [authoredByHotelAtom],
                ],
                exchange: {
                  confidentialityPre: [authoredByHotelAtom],
                  integrityPre: [
                    audienceRepresentsHotelAtom,
                    trustedProviderGmailAtom,
                  ],
                  removeMatchedClauses: true,
                  allowedSink: "fetchData",
                  allowedPaths: [["options", "body", "membershipNumber"]],
                },
              },
            },
          },
          required: ["membershipNumber"],
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    },
    cfc: {},
  },
} as const satisfies JSONSchema;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CFC worked example: return-to-sender with provider trust", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let verifiedBindings = new Set<string>();

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    verifiedBindings = new Set<string>();
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      cfcAudienceVerifier: ({ principal, audience }) =>
        verifiedBindings.has(`${principal}@@${audience}`),
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

  function createSourceIntent() {
    return createCfcIntentEventEnvelope({
      action: "SendMembershipNumber",
      sourceGestureId: "gesture-return-membership-number-provider-trust",
      conditionHash: "Cond.SendMembershipNumberClicked",
      parameters: {
        valueDigest: "digest:membership-number",
      },
      integrity: [
        { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-99" },
      ],
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

  it("requires trusted provider evidence before refining and sending the return intent", async () => {
    const sourceIntent = createSourceIntent();
    const missingProviderTrustIntent = refineCfcReturnToSenderIntent(
      sourceIntent,
      {
        sourceConfidentiality: [authoredByHotelAtom],
        refinerHash: "sha256:return-membership-refiner",
        operation: "Hotel.SendMembershipNumber",
        audience: hotelAudience,
        endpoint: "hotel.membership.send",
        parameters: JSON.stringify({
          membershipNumber: "H-1234",
        }),
        exp: Date.now() + 4_000,
        maxAttempts: 1,
        duration: "short",
      },
    );
    expect(missingProviderTrustIntent).toBeNull();

    const sendIntent = refineCfcReturnToSenderIntent(sourceIntent, {
      sourceConfidentiality: [authoredByHotelAtom],
      refinerHash: "sha256:return-membership-refiner",
      operation: "Hotel.SendMembershipNumber",
      audience: hotelAudience,
      endpoint: "hotel.membership.send",
      parameters: JSON.stringify({
        membershipNumber: "H-1234",
      }),
      exp: Date.now() + 4_000,
      maxAttempts: 1,
      duration: "short",
      additionalIntegrity: [trustedProviderGmailAtom],
    });
    expect(sendIntent).not.toBeNull();

    verifiedBindings.add(`${hotelPrincipal}@@${hotelAudience}`);

    const requestCell = runtime.getCell(
      space,
      "return-to-sender-provider-trust-request",
      membershipSendSchema,
      tx,
    );
    requestCell.withTx(tx).set({
      url: `${hotelAudience}/membership/return`,
      mode: "json",
      options: {
        method: "POST",
        body: {
          membershipNumber: "H-1234",
        },
        headers: {
          "X-Idempotency-Key": sendIntent!.idempotencyKey,
        },
      },
      cfc: {
        intent: sendIntent,
        endpoint: "hotel.membership.send",
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
      "return-to-sender-provider-trust-result",
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
