import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example gmail error test",
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

const secretQueryAtom = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "SECRET_QUERY",
  source: "gmail-search",
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

const sanitizedErrorMessageAtom = {
  type: "https://commonfabric.org/cfc/atom/SanitizedErrorMessage",
  sanitizer: "error-message-sanitizer-v1",
} as const;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const gmailErrorRequestSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      ifc: {
        classification: [[userAliceAtom], [secretQueryAtom]],
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

function createDeclassifiedErrorFieldIfc() {
  return {
    classification: [cloneJson(userAliceAtom)],
    declassify: {
      confidentialityPre: [cloneJson(secretQueryAtom)],
      integrityPre: [
        cloneJson(authorizedRequestPattern),
        cloneJson(networkProvenancePattern),
      ],
      removeMatchedClauses: true,
      addAlternatives: [cloneJson(userAliceAtom)],
      releaseCondition: true,
    },
  } as const;
}

const gmailErrorCodeSchema = {
  type: "number",
  ifc: {
    ...createDeclassifiedErrorFieldIfc(),
  },
} as const satisfies JSONSchema;

const gmailErrorStatusSchema = {
  type: "string",
  ifc: {
    ...createDeclassifiedErrorFieldIfc(),
  },
} as const satisfies JSONSchema;

const gmailErrorMessageSchema = {
  type: "string",
  ifc: {
    classification: [cloneJson(userAliceAtom)],
    integrity: [cloneJson(sanitizedErrorMessageAtom)],
    declassify: {
      confidentialityPre: [cloneJson(secretQueryAtom)],
      integrityPre: [
        cloneJson(authorizedRequestPattern),
        cloneJson(networkProvenancePattern),
        cloneJson(sanitizedErrorMessageAtom),
      ],
      removeMatchedClauses: true,
      addAlternatives: [cloneJson(userAliceAtom)],
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

const gmailErrorDetailsSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: true,
  },
  ifc: {
    classification: [[cloneJson(userAliceAtom)], [cloneJson(secretQueryAtom)]],
  },
} as const satisfies JSONSchema;

const gmailErrorHeadersSchema = {
  type: "object",
  additionalProperties: {
    type: "string",
  },
  ifc: {
    classification: [[cloneJson(userAliceAtom)], [cloneJson(secretQueryAtom)]],
  },
} as const satisfies JSONSchema;

const gmailOperatorViewSchema = {
  type: "object",
  properties: {
    code: gmailErrorCodeSchema,
    status: gmailErrorStatusSchema,
    message: gmailErrorMessageSchema,
    details: gmailErrorDetailsSchema,
    headers: gmailErrorHeadersSchema,
  },
  ifc: {
    classification: [[cloneJson(userAliceAtom)], [cloneJson(secretQueryAtom)]],
  },
} as const satisfies JSONSchema;

const gmailOperatorViewInputSchema = {
  type: "object",
  properties: {
    error: true,
  },
} as const satisfies JSONSchema;

const gmailFetchErrorEnvelopeSchema = {
  type: "object",
  properties: {
    "@Error": {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: { type: "number" },
            status: { type: "string" },
            message: { type: "string" },
            details: gmailErrorDetailsSchema,
          },
        },
        headers: gmailErrorHeadersSchema,
      },
    },
  },
} as const satisfies JSONSchema;

describe("CFC worked example: Gmail error declassification", () => {
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
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "Insufficient authentication scopes.",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
                },
              ],
            },
          }),
          {
            status: 403,
            statusText: "Forbidden",
            headers: {
              "Content-Type": "application/json",
              "X-Trace": "gmail-secret-trace",
            },
          },
        ),
      )
    );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await harness.dispose();
  });

  it("keeps full request confidentiality on error details while declassifying sanitized operator fields", async () => {
    const requestCell = await harness.writeCellValue({
      id: "gmail-error-request",
      schema: gmailErrorRequestSchema,
      value: {
        url:
          "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=project-x",
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
      id: "gmail-error-fetch-wrapper",
      pattern: fetchPattern,
      inputs: { request: requestCell },
    });

    const raw = await harness.pullSettledResult(
      wrapperRun.result,
    ) as SettledFetchResult;
    expect(raw?.pending).toBe(false);
    expect(raw?.result).toBeUndefined();
    expect(raw?.error).toBeDefined();

    const errorCell = wrapperRun.result.key("error").resolveAsCell();
    const errorLink = errorCell.getAsNormalizedFullLink();
    const errorLabels = await harness.readLabels(errorLink);
    expect(errorLabels["/"]?.label?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [secretQueryAtom],
      ]),
    );
    expect(errorLabels["/"]?.label?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
        }),
        expect.objectContaining({
          type: "https://commonfabric.org/cfc/atom/NetworkProvenance",
        }),
      ]),
    );

    const {
      codeView,
      statusView,
      messageView,
      detailsView,
      headersView,
    } = await harness.withCommittedEdit((tx) => {
      const errorInTx = harness.getCellFromLink(errorLink, undefined, tx);
      const structuredError = errorInTx.withTx(tx).get() as {
        "@Error"?: {
          error?: {
            code?: number;
            status?: string;
            message?: string;
            details?: Array<Record<string, unknown>>;
          };
          headers?: Record<string, string>;
        };
      };
      const gmailError = structuredError["@Error"]?.error;
      const errorHeaders = structuredError["@Error"]?.headers;

      const codeView = harness.getCell<number>(
        "gmail-error-operator-code",
        gmailErrorCodeSchema,
        tx,
      );
      const statusView = harness.getCell<string>(
        "gmail-error-operator-status",
        gmailErrorStatusSchema,
        tx,
      );
      const messageView = harness.getCell<string>(
        "gmail-error-operator-message",
        gmailErrorMessageSchema,
        tx,
      );
      const detailsView = harness.getCell<Array<Record<string, unknown>>>(
        "gmail-error-details",
        gmailErrorDetailsSchema,
        tx,
      );
      const headersView = harness.getCell<Record<string, string>>(
        "gmail-error-headers",
        gmailErrorHeadersSchema,
        tx,
      );
      codeView.withTx(tx).set(gmailError?.code ?? 0);
      statusView.withTx(tx).set(gmailError?.status ?? "");
      messageView.withTx(tx).set(gmailError?.message ?? "");
      detailsView.withTx(tx).set(gmailError?.details ?? []);
      headersView.withTx(tx).set(errorHeaders ?? {});

      return {
        codeView,
        statusView,
        messageView,
        detailsView,
        headersView,
      };
    }, {
      prepare: "cfc",
    });

    const codeLabels = await harness.readLabels(
      codeView.getAsNormalizedFullLink(),
    );
    const statusLabels = await harness.readLabels(
      statusView.getAsNormalizedFullLink(),
    );
    const messageLabels = await harness.readLabels(
      messageView.getAsNormalizedFullLink(),
    );
    const detailsLabels = await harness.readLabels(
      detailsView.getAsNormalizedFullLink(),
    );
    const headersLabels = await harness.readLabels(
      headersView.getAsNormalizedFullLink(),
    );

    expect(codeLabels["/"]?.label?.classification).toEqual([[userAliceAtom]]);
    expect(statusLabels["/"]?.label?.classification).toEqual([[userAliceAtom]]);
    expect(messageLabels["/"]?.label?.classification).toEqual([[
      userAliceAtom,
    ]]);
    expect(messageLabels["/"]?.label?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining(sanitizedErrorMessageAtom),
        expect.objectContaining({
          type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
        }),
        expect.objectContaining({
          type: "https://commonfabric.org/cfc/atom/NetworkProvenance",
        }),
      ]),
    );
    expect(detailsLabels["/"]?.label?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [secretQueryAtom],
      ]),
    );
    expect(headersLabels["/"]?.label?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [secretQueryAtom],
      ]),
    );
  });

  it("supports direct descendant release while retaining a secret parent whole-value label", async () => {
    const requestCell = await harness.writeCellValue({
      id: "gmail-error-request-observation",
      schema: gmailErrorRequestSchema,
      value: {
        url:
          "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=project-x",
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
      id: "gmail-error-fetch-wrapper-observation",
      pattern: fetchPattern,
      inputs: { request: requestCell },
    });

    const projectOperatorView = harness.lift(
      gmailFetchErrorEnvelopeSchema,
      gmailOperatorViewSchema,
      (error: any) => {
        const gmailError = error["@Error"]?.error;
        return {
          code: gmailError?.code ?? 0,
          status: gmailError?.status ?? "",
          message: gmailError?.message ?? "",
          details: gmailError?.details ?? [],
          headers: error["@Error"]?.headers ?? {},
        };
      },
    );
    const operatorPattern = harness.pattern<{ error: any }>(
      ({ error }: { error: any }) => projectOperatorView(error),
      gmailOperatorViewInputSchema,
      gmailOperatorViewSchema,
    );

    const operatorRun = await harness.runPattern({
      id: "gmail-error-operator-view",
      pattern: operatorPattern,
      inputs: { error: wrapperRun.result.key("error").resolveAsCell() },
      outputSchema: gmailOperatorViewSchema,
      initialOutput: {
        code: 0,
        status: "",
        message: "",
        details: [],
        headers: {},
      },
    });

    const operatorLabels = await harness.readLabels(
      operatorRun.outputLink,
    );
    expect(operatorLabels["/"]?.label?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [secretQueryAtom],
      ]),
    );
    expect(operatorLabels["/code"]?.label?.classification).toEqual([
      [userAliceAtom],
    ]);
    expect(operatorLabels["/status"]?.label?.classification).toEqual([
      [userAliceAtom],
    ]);
    expect(operatorLabels["/message"]?.label?.classification).toEqual([
      [userAliceAtom],
    ]);
    expect(operatorLabels["/details"]?.label?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [secretQueryAtom],
      ]),
    );
    expect(operatorLabels["/headers"]?.label?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [secretQueryAtom],
      ]),
    );
  });
});
