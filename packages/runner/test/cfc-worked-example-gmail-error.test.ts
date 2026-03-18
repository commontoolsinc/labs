import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { setPatternEnvironment } from "../src/env.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
} from "../src/cfc/shared.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import type { Labels } from "../src/storage/interface.ts";

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

const declassifiedErrorFieldIfc = {
  declassify: {
    confidentialityPre: [secretQueryAtom],
    integrityPre: [
      authorizedRequestPattern,
      networkProvenancePattern,
    ],
    removeMatchedClauses: true,
    addAlternatives: [userAliceAtom],
    releaseCondition: true,
  },
} as const;

const gmailErrorViewSchema = {
  type: "object",
  properties: {
    code: {
      type: "number",
      ifc: declassifiedErrorFieldIfc,
    },
    status: {
      type: "string",
      ifc: declassifiedErrorFieldIfc,
    },
    message: {
      type: "string",
      ifc: {
        integrity: [sanitizedErrorMessageAtom],
        declassify: {
          confidentialityPre: [secretQueryAtom],
          integrityPre: [
            authorizedRequestPattern,
            networkProvenancePattern,
            sanitizedErrorMessageAtom,
          ],
          removeMatchedClauses: true,
          addAlternatives: [userAliceAtom],
          releaseCondition: true,
        },
      },
    },
    details: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
    headers: {
      type: "object",
      additionalProperties: {
        type: "string",
      },
    },
  },
  required: ["code", "status", "message", "details", "headers"],
} as const satisfies JSONSchema;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CFC worked example: Gmail error declassification", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let originalFetch: typeof globalThis.fetch;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });

    const { commontools } = createBuilder();
    pattern = commontools.pattern;
    byRef = commontools.byRef;

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
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
      );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
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

  async function readLabels(
    link: NormalizedFullLink,
  ): Promise<Record<string, Labels>> {
    const tx = runtime.edit();
    const raw = tx.readOrThrow(cfcLabelsAddress(link));
    await tx.abort();
    return normalizePersistedLabels(raw);
  }

  it("keeps full request confidentiality on error details while declassifying sanitized operator fields", async () => {
    let tx = runtime.edit();
    const requestCell = runtime.getCell(
      space,
      "gmail-error-request",
      gmailErrorRequestSchema,
      tx,
    );
    requestCell.withTx(tx).set({
      url:
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=project-x",
      mode: "json",
      options: {
        method: "GET",
        headers: {
          Authorization: "Bearer token",
        },
      },
    });
    await prepareBoundaryCommit(tx);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const fetchPattern = pattern<{ request: unknown }>(({ request }) =>
      fetchData(request)
    );
    const wrapperCell = runtime.getCell(
      space,
      "gmail-error-fetch-wrapper",
      undefined,
      tx,
    );
    const wrapperResult = runtime.run(
      tx,
      fetchPattern,
      { request: requestCell },
      wrapperCell,
    );
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const raw = await pullFinalResult(wrapperResult);
    expect(raw?.pending).toBe(false);
    expect(raw?.result).toBeUndefined();
    expect(raw?.error).toBeDefined();

    const errorCell = wrapperResult.key("error").resolveAsCell();
    const errorLink = errorCell.getAsNormalizedFullLink();
    const errorLabels = await readLabels(errorLink);
    expect(errorLabels["/"]?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [secretQueryAtom],
      ]),
    );
    expect(errorLabels["/"]?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "https://commonfabric.org/cfc/atom/AuthorizedRequest",
        }),
        expect.objectContaining({
          type: "https://commonfabric.org/cfc/atom/NetworkProvenance",
        }),
      ]),
    );

    tx = runtime.edit();
    const structuredError = errorCell.withTx(tx).get() as {
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

    const errorView = runtime.getCell(
      space,
      "gmail-error-sanitized-view",
      gmailErrorViewSchema,
      tx,
    );
    errorView.withTx(tx).set({
      code: gmailError?.code ?? 0,
      status: gmailError?.status ?? "",
      message: gmailError?.message ?? "",
      details: gmailError?.details ?? [],
      headers: errorHeaders ?? {},
    });

    await prepareCfcCommitIfNeeded(tx);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const viewLabels = await readLabels(errorView.getAsNormalizedFullLink());
    expect(viewLabels["/code"]?.classification).toEqual([[userAliceAtom]]);
    expect(viewLabels["/status"]?.classification).toEqual([[userAliceAtom]]);
    expect(viewLabels["/message"]?.classification).toEqual([[userAliceAtom]]);
    expect(viewLabels["/message"]?.integrity).toEqual(
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
    expect(viewLabels["/details"]?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [secretQueryAtom],
      ]),
    );
    expect(viewLabels["/headers"]?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [secretQueryAtom],
      ]),
    );
  });
});
