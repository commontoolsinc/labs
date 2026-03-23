import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example gmail read test",
);
const space = signer.did();

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const googleAuthAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/GoogleAuth",
  subject: space,
} as const;

const authorizedRequestPattern = {
  type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
  endpoint: "GET /gmail/v1/users/me/messages",
} as const;

const networkProvenancePattern = {
  type: "https://commonfabric.org/cfc/atom/NetworkProvenance",
  host: "gmail.googleapis.com",
  tls: true,
} as const;

const gmailFetchRequestSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      ifc: {
        classification: [userAliceAtom],
      },
    },
    mode: { type: "string" },
    options: {
      type: "object",
      properties: {
        method: { type: "string" },
        headers: {
          type: "object",
          properties: {
            Authorization: {
              type: "string",
              ifc: {
                classification: [googleAuthAliceAtom],
                exchange: {
                  confidentialityPre: [googleAuthAliceAtom],
                  removeMatchedClauses: true,
                  allowedSink: "fetchData",
                  allowedPaths: [["options", "headers", "Authorization"]],
                },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies JSONSchema;

const gmailMessagesSchema = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          snippet: { type: "string" },
        },
        required: ["id", "snippet"],
      },
    },
  },
  required: ["messages"],
  ifc: {
    classification: [userAliceAtom],
    requiredIntegrity: [
      authorizedRequestPattern,
      networkProvenancePattern,
    ],
  },
} as const satisfies JSONSchema;

const downstreamRenderSchema = {
  type: "number",
  ifc: {
    declassify: {
      confidentialityPre: [userAliceAtom],
      integrityPre: [
        authorizedRequestPattern,
        networkProvenancePattern,
      ],
      removeMatchedClauses: true,
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

const downstreamRenderInputSchema = {
  type: "object",
  properties: {
    response: gmailMessagesSchema,
  },
  required: ["response"],
} as const satisfies JSONSchema;

const downstreamRenderOutputSchema = {
  type: "object",
  properties: {
    count: downstreamRenderSchema,
  },
  required: ["count"],
} as const satisfies JSONSchema;

describe("CFC worked example: Gmail read", () => {
  let harness: ReturnType<typeof createCfcPatternTestHarness>;
  let originalFetch: typeof globalThis.fetch;

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

    originalFetch = globalThis.fetch;
    harness.stubFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            messages: [
              { id: "m-1", snippet: "hello" },
              { id: "m-2", snippet: "world" },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
    );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await harness.dispose();
  });

  it("persists fetch evidence across runtime restart and reuses it in downstream policy checks", async () => {
    const requestCell = await harness.writeCellValue({
      id: "gmail-read-request",
      schema: gmailFetchRequestSchema,
      value: {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        mode: "json",
        options: {
          method: "GET",
          headers: {
            Authorization: "Bearer token",
          },
        },
      },
      prepare: "boundary",
    });
    const fetchData = harness.byRef("fetchData") as (
      params: unknown,
    ) => unknown;
    const fetchPattern = harness.pattern<{ request: unknown }>(
      ({ request }: { request: unknown }) => fetchData(request),
    );
    const wrapperRun = await harness.runPattern({
      id: "gmail-read-fetch-wrapper",
      pattern: fetchPattern,
      inputs: { request: requestCell },
    });

    const raw = await harness.pullSettledResult(
      wrapperRun.result,
    ) as SettledFetchResult;
    expect(raw?.pending).toBe(false);
    expect(raw?.error).toBeUndefined();

    const fetchedResultCell = wrapperRun.result.key("result").resolveAsCell();
    const fetchedResultLink = fetchedResultCell.getAsNormalizedFullLink();
    const phaseOneLabels = await harness.readLabels(fetchedResultLink);
    expect(phaseOneLabels["/"]?.label?.classification).toEqual([[
      userAliceAtom,
    ]]);
    expect(phaseOneLabels["/"]?.label?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
        }),
        expect.objectContaining({
          type: "https://commonfabric.org/cfc/atom/NetworkProvenance",
          host: "gmail.googleapis.com",
          tls: true,
        }),
      ]),
    );

    await harness.restart();

    const persistedFetchResult = harness.getCellFromLink(
      fetchedResultLink,
      undefined,
    );
    const downstreamPattern = harness.pattern(
      ({ response }) => ({
        count: harness.lift(gmailMessagesSchema, downstreamRenderSchema, (
          messages,
        ) => Array.isArray(messages.messages) ? messages.messages.length : 0)(
          response,
        ),
      }),
      downstreamRenderInputSchema,
      downstreamRenderOutputSchema,
    );
    const downstreamRun = await harness.runPattern({
      id: "gmail-read-downstream-target",
      pattern: downstreamPattern,
      inputs: { response: persistedFetchResult },
      outputSchema: downstreamRenderOutputSchema,
      initialOutput: { count: 0 },
      prepare: "cfc",
    });
    expect(await downstreamRun.result.pull()).toEqual({ count: 2 });

    const downstreamLabels = await harness.readLabels(
      downstreamRun.outputLink,
    );
    expect(downstreamLabels["/count"]?.label?.classification).toBeUndefined();
  });
});
