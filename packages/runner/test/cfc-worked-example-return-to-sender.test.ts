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
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Labels } from "../src/storage/interface.ts";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CFC worked example: return-to-sender", () => {
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

  async function runMembershipSend(
    schema: JSONSchema,
    entityId: string,
  ) {
    const intent = createReturnIntent(Date.now());
    const requestCell = runtime.getCell(space, `${entityId}-request`, schema, tx);
    requestCell.withTx(tx).set({
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
    });
    await prepareBoundaryCommit(tx);
    const prepared = await tx.commit();
    expect(prepared.error).toBeUndefined();

    tx = runtime.edit();
    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const testPattern = pattern<{ request: unknown }>(({ request }) =>
      fetchData(request)
    );
    const resultCell = runtime.getCell(space, `${entityId}-result`, undefined, tx);
    const result = runtime.run(tx, testPattern, { request: requestCell }, resultCell);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();
    tx = runtime.edit();

    return {
      result,
      raw: await pullFinalResult(result),
    };
  }

  async function readLabels(
    link: NormalizedFullLink,
  ): Promise<Record<string, Labels>> {
    const readTx = runtime.edit();
    const raw = readTx.readOrThrow(cfcLabelsAddress(link));
    await readTx.abort();
    return normalizePersistedLabels(raw);
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

    const resultLabels = await readLabels(result.key("result").resolveAsCell()
      .getAsNormalizedFullLink());
    expect(resultLabels["/"]?.classification).toEqual([[userAliceAtom]]);
    expect(resultLabels["/"]?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining(audienceRepresentsHotelAtom),
      ]),
    );
  });
});
