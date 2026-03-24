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
  type PersistedPathLabels,
  resolveObservationLabel,
} from "../src/cfc/shared.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";

const signer = await Identity.fromPassphrase("cfc fetchData sink labels test");
const space = signer.did();

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const googleAuthAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/GoogleAuth",
  subject: space,
} as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFetchRequestSchema(options: {
  readonly allowedPaths: readonly (readonly string[])[];
}) {
  return {
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
                    allowedPaths: options.allowedPaths,
                  },
                },
              },
            },
          },
        },
      },
    },
  } as const satisfies JSONSchema;
}

describe("fetchData sink label rewriting", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];
  let originalFetch: typeof globalThis.fetch;

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

    originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            messages: [{ id: "m-1", snippet: "hello" }],
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

  async function readLabels(
    cell: { getAsNormalizedFullLink: () => NormalizedFullLink },
  ): Promise<PersistedPathLabels> {
    const readTx = runtime.edit();
    const link = cell.getAsNormalizedFullLink();
    const raw = readTx.readOrThrow(
      cfcLabelsAddress(link),
    );
    await readTx.abort();
    return normalizePersistedLabels(raw);
  }

  async function readObservationLabel(
    cell: { getAsNormalizedFullLink: () => NormalizedFullLink },
    path: string,
    op: "shape" | "value" | "enumerate" | "count" | "followRef" = "value",
  ) {
    return resolveObservationLabel(await readLabels(cell), path, op);
  }

  async function runFetchWithSchema(schema: JSONSchema, cause: string) {
    const requestCell = runtime.getCell(space, `${cause}-request`, schema, tx);
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
    await tx.commit();
    tx = runtime.edit();

    const fetchData = byRef("fetchData") as (params: unknown) => unknown;
    const testPattern = pattern<{ request: unknown }>(({ request }) =>
      fetchData(request)
    );
    const resultCell = runtime.getCell(space, `${cause}-result`, undefined, tx);
    const result = runtime.run(
      tx,
      testPattern,
      { request: requestCell },
      resultCell,
    );
    await tx.commit();
    tx = runtime.edit();

    const raw = await pullFinalResult(result);
    return {
      requestCell,
      result,
      raw,
    };
  }

  it("strips authority-only auth clauses and mints fetch evidence on the result", async () => {
    const schema = createFetchRequestSchema({
      allowedPaths: [["options", "headers", "Authorization"]],
    });

    const { requestCell, result, raw } = await runFetchWithSchema(
      schema,
      "fetch-sink-labels-allowed",
    );

    expect(raw?.pending).toBe(false);

    expect(
      (await readObservationLabel(requestCell, "/url", "value"))
        ?.classification,
    ).toEqual([[
      userAliceAtom,
    ]]);
    expect(
      (
        await readObservationLabel(
          requestCell,
          "/options/headers/Authorization",
          "value",
        )
      )?.classification,
    )
      .toEqual([[googleAuthAliceAtom]]);

    const resultLabels = await readLabels(result.key("result").resolveAsCell());
    expect(resultLabels["/"]?.label?.classification).toEqual([[userAliceAtom]]);
    expect(resultLabels["/"]?.label?.integrity).toEqual(
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

  it("preserves the auth clause when no fetch sink rule matches", async () => {
    const schema = createFetchRequestSchema({
      allowedPaths: [["options", "headers", "X-Authorization"]],
    });

    const { result, raw } = await runFetchWithSchema(
      schema,
      "fetch-sink-labels-unmatched",
    );

    expect(raw?.pending).toBe(false);
    const resultLabels = await readLabels(result.key("result").resolveAsCell());
    expect(resultLabels["/"]?.label?.classification).toEqual([
      [googleAuthAliceAtom],
      [userAliceAtom],
    ]);
  });
});
