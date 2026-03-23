import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { createCfcIntentOnce } from "../src/cfc/intent-refinement.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example return-to-sender test",
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

function createMembershipSendSchema(
  options: { readonly includeReturnRule: boolean },
) {
  return {
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
                  ...(options.includeReturnRule
                    ? {
                      exchange: {
                        confidentialityPre: [authoredByHotelAtom],
                        integrityPre: [audienceRepresentsHotelAtom],
                        removeMatchedClauses: true,
                        allowedSink: "fetchData",
                        allowedPaths: [["options", "body", "membershipNumber"]],
                      },
                    }
                    : {}),
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
    },
  } as const satisfies JSONSchema;
}

function createReturnIntent(now: number) {
  const sourceIntent = createCfcIntentEventEnvelope({
    action: "SendMembershipNumber",
    sourceGestureId: "gesture-return-membership-number",
    conditionHash: "Cond.SendMembershipNumberClicked",
    parameters: {
      targetPrincipal: hotelPrincipal,
      valueDigest: "digest:membership-number",
    },
    integrity: [
      { type: "https://commonfabric.org/cfc/atom/UIRuntime", hash: "ui-99" },
    ],
  });

  return createCfcIntentOnce(sourceIntent, {
    refinerHash: "sha256:return-membership-refiner",
    operation: "Hotel.SendMembershipNumber",
    audience: hotelAudience,
    endpoint: "hotel.membership.send",
    targetPrincipal: hotelPrincipal,
    parameters: JSON.stringify({
      membershipNumber: "H-1234",
    }),
    exp: now + 4_000,
    maxAttempts: 3,
    duration: "short",
  });
}

describe("CFC worked example: return-to-sender", () => {
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

  async function runMembershipSend(
    schema: JSONSchema,
    entityId: string,
  ) {
    const intent = createReturnIntent(Date.now());
    const requestCell = await harness.writeCellValue({
      id: `${entityId}-request`,
      schema,
      value: {
        url: `${hotelAudience}/membership/return`,
        mode: "json",
        options: {
          method: "POST",
          body: {
            membershipNumber: "H-1234",
          },
          headers: {
            "X-Idempotency-Key": intent.idempotencyKey,
          },
        },
        cfc: {
          intent,
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
      id: `${entityId}-result`,
      pattern: testPattern,
      inputs: { request: requestCell },
    });

    return {
      result: run.result,
      raw: await harness.pullSettledResult(run.result) as SettledFetchResult,
    };
  }

  it("blocks return-to-sender sends when no sink rule releases the sender-bound clause", async () => {
    verifiedBindings.add(`${hotelPrincipal}@@${hotelAudience}`);

    const { raw } = await runMembershipSend(
      createMembershipSendSchema({ includeReturnRule: false }),
      "return-to-sender-no-rule",
    );

    expect(raw?.pending).toBe(false);
    expect(raw?.result).toBeUndefined();
    expect(raw?.error).toBe("fetch_request_not_authorized");
    expect(fetchCalls.length).toBe(0);
  });

  it("allows return-to-sender sends when fresh audience verification satisfies the release rule", async () => {
    verifiedBindings.add(`${hotelPrincipal}@@${hotelAudience}`);

    const { raw, result } = await runMembershipSend(
      createMembershipSendSchema({ includeReturnRule: true }),
      "return-to-sender-allowed",
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
        expect.objectContaining(audienceRepresentsHotelAtom),
      ]),
    );
  });
});
