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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CFC worked example: Gmail read", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let phaseOneRuntime: Runtime | undefined;
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
      );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (phaseOneRuntime && phaseOneRuntime !== runtime) {
      phaseOneRuntime.runner.stopAll();
      phaseOneRuntime.moduleRegistry.clear();
      phaseOneRuntime.scheduler.dispose();
      phaseOneRuntime.harness.dispose();
      phaseOneRuntime = undefined;
    }
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

  it("persists fetch evidence across runtime restart and reuses it in downstream policy checks", async () => {
    let tx = runtime.edit();
    const requestCell = runtime.getCell(
      space,
      "gmail-read-request",
      gmailFetchRequestSchema,
      tx,
    );
    requestCell.withTx(tx).set({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
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
      "gmail-read-fetch-wrapper",
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
    expect(raw?.error).toBeUndefined();

    const fetchedResultCell = wrapperResult.key("result").resolveAsCell();
    const fetchedResultLink = fetchedResultCell.getAsNormalizedFullLink();
    const phaseOneLabels = await readLabels(fetchedResultLink);
    expect(phaseOneLabels["/"]?.classification).toEqual([[userAliceAtom]]);
    expect(phaseOneLabels["/"]?.integrity).toEqual(
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

    phaseOneRuntime = runtime;

    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();

    tx = runtime.edit();
    const persistedFetchResult = runtime.getCellFromLink(
      fetchedResultLink,
      undefined,
      tx,
    );
    const downstreamTarget = runtime.getCell(
      space,
      "gmail-read-downstream-target",
      undefined,
      tx,
    );
    const messages = persistedFetchResult.withTx(tx).asSchema(
      gmailMessagesSchema,
    )
      .get();
    downstreamTarget.withTx(tx).asSchema(downstreamRenderSchema).set(
      Array.isArray(messages?.messages) ? messages.messages.length : 0,
    );

    await prepareCfcCommitIfNeeded(tx);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const downstreamLabels = await readLabels(
      downstreamTarget.getAsNormalizedFullLink(),
    );
    expect(downstreamLabels["/"]?.classification).toBeUndefined();
    expect(downstreamLabels["/"]?.integrity).toEqual(
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
  });
});
