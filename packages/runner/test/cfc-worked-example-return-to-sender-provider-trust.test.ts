import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { refineCfcReturnToSenderIntent } from "../src/cfc/return-to-sender-intent.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

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

describe("CFC worked example: return-to-sender with provider trust", () => {
  let harness: ReturnType<typeof createCfcPatternTestHarness>;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let verifiedBindings = new Set<string>();

  type SettledFetchResult = {
    pending?: boolean;
    result?: unknown;
    error?: unknown;
  } | undefined;

  beforeEach(() => {
    verifiedBindings = new Set<string>();
    harness = createCfcPatternTestHarness({
      signer,
      apiUrl: new URL(import.meta.url),
      patternEnvironment: {
        apiUrl: new URL("http://mock-test-server.local"),
      },
      runtimeOptions: {
        cfcAudienceVerifier: ({ principal, audience }) =>
          verifiedBindings.has(`${principal}@@${audience}`),
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

    const requestCell = await harness.writeCellValue({
      id: "return-to-sender-provider-trust-request",
      schema: membershipSendSchema,
      value: {
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
      id: "return-to-sender-provider-trust-result",
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
