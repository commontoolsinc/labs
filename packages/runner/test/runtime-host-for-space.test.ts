import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Runtime } from "@commonfabric/runner";
import type { ServerBuiltinActionDescriptor } from "../src/builtins/server-execution.ts";
import type { Cell } from "../src/cell.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runtime-host-for-space");
const spaceA = signer.did();
const spaceB = "did:key:z6Mk-host-for-space-b" as MemorySpace;

function makeRuntime(spaceHostMap?: Record<string, string>) {
  const storageManager = StorageManager.emulate({ as: signer });
  return new Runtime({
    apiUrl: new URL("http://host-a.test/"),
    spaceHostMap,
    storageManager,
  });
}

describe("Runtime.registerSpaceHost", () => {
  it("follows storage's verdict and routes compute on acceptance", async () => {
    const storageVerdicts: Array<[string, string]> = [];
    const storageManager = Object.assign(
      StorageManager.emulate({ as: signer }),
      {
        registerSpaceHost(space: string, host: string) {
          storageVerdicts.push([space, host]);
          return host !== "http://refused.test/";
        },
      },
    );
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      storageManager,
    });
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(true);
      expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
      expect(runtime.hostForSpace(spaceB).toString()).toBe(
        "http://host-b.test/",
      );
      // Storage refusal ⇒ compute routing must NOT diverge.
      const spaceC = "did:key:z6Mk-host-for-space-c" as MemorySpace;
      expect(runtime.registerSpaceHost(spaceC, "http://refused.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceC)).toBeUndefined();
      expect(storageVerdicts.length).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns false when the manager has no remote resolution", async () => {
    const runtime = makeRuntime();
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});

describe("Runtime.hostForSpace", () => {
  it("resolves mapped spaces to their host and others to apiUrl", async () => {
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(runtime.hostForSpace(spaceA).toString()).toBe(
        "http://host-a.test/",
      );
      expect(runtime.hostForSpace(spaceB).toString()).toBe(
        "http://host-b.test/",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("healthCheck fans out over the default and every mapped host", async () => {
    const dialed: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      dialed.push(String(input));
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;
    const runtime = makeRuntime({
      [spaceB]: "http://host-b.test",
      "did:key:z6Mk-host-for-space-c": "http://host-b.test", // dupe host
    });
    try {
      expect(await runtime.healthCheck()).toBe(true);
      expect(dialed.sort()).toEqual([
        "http://host-a.test/_health",
        "http://host-b.test/_health",
      ]);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck is false when any host is unreachable", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response("", {
          status: String(input).includes("host-b") ? 500 : 200,
        }),
      )) as typeof fetch;
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(await runtime.healthCheck()).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });
});

describe("Runtime.fetchBuiltin", () => {
  it("preserves mapped-host resolution when routing through the server broker", async () => {
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      patternEnvironment: { apiUrl: new URL("http://host-a.test/") },
      spaceHostMap: { [spaceB]: "http://host-b.test" },
      storageManager: StorageManager.emulate({ as: signer }),
      experimental: { serverPrimaryExecution: true },
    });
    const brokerUrls: string[] = [];
    runtime.installServerBuiltinFetch((_builtinId, url) => {
      brokerUrls.push(url);
      return Promise.resolve(new Response("ok"));
    });
    try {
      await runtime.fetchBuiltin(
        "fetchJson",
        "/api/value",
        new URL("http://host-b.test/api/value"),
      );
      await runtime.fetchBuiltin(
        "fetchJson",
        "/api/local",
        new URL("http://host-a.test/api/local"),
      );
      await runtime.fetchBuiltin(
        "fetchJson",
        "http://[",
        undefined,
      );
      expect(brokerUrls).toEqual([
        "http://host-b.test/api/value",
        "/api/local",
        "http://[",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  // A1: the `llm` builtin shares `executeWithToolsLoop`/`llmClientOptions`
  // with `generateText`, so under a server-primary runtime it must dial the
  // same `/api/ai/llm` broker. Before it was server-executable it passed no
  // `serverBuiltinId` and `llmClientOptions` threw "unsupported LLM builtin
  // has no server broker route" — the broker was never dialed and the node
  // settled into `error`.
  it("routes the `llm` builtin's model call through the broker", async () => {
    // Passive observer: capture the runner-minted effect descriptor and the
    // writes the run actually produced, then let the commit proceed upstream.
    let descriptor: ServerBuiltinActionDescriptor | undefined;
    let observedWrites: readonly { id: `${string}:${string}` }[] = [];
    const storageManager = StorageManager.emulate({
      as: signer,
      actionTransactionRouter: (input) => {
        const annotated = input.sourceAction as
          | { serverBuiltin?: ServerBuiltinActionDescriptor }
          | undefined;
        const observation = input.commit.schedulerObservation as
          | { implementationFingerprint?: string; actualChangedWrites?: [] }
          | undefined;
        if (
          annotated?.serverBuiltin?.id === "llm" &&
          observation?.implementationFingerprint ===
            "impl:cf:builtin/llm:server-v1"
        ) {
          descriptor = annotated.serverBuiltin;
          observedWrites = observation.actualChangedWrites ?? [];
        }
        return { disposition: "upstream" };
      },
    });
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      patternEnvironment: { apiUrl: new URL("http://host-a.test/") },
      storageManager,
      experimental: { serverPrimaryExecution: true },
      // Sole party performing the effect under test, so it declares that
      // authority; a runtime that declares nothing is "suppress" (runtime.ts).
      externalSinkDisposition: "server-executor",
    });
    const brokered: Array<{ builtinId: string; url: string }> = [];
    runtime.installServerBuiltinFetch((builtinId, url) => {
      brokered.push({ builtinId, url });
      return Promise.resolve(
        Response.json({ role: "assistant", content: "brokered" }),
      );
    });
    try {
      const { commonfabric } = createTrustedBuilder(runtime);
      const testPattern = commonfabric.pattern(() =>
        commonfabric.llm({
          messages: [{ role: "user", content: "route me" }],
        })
      );
      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        spaceA,
        "llm-server-broker-route",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      await tx.commit();
      await runtime.idle();
      await waitForSettled(result);

      expect(brokered).toEqual([{ builtinId: "llm", url: "/api/ai/llm" }]);
      expect(result.key("error").get()).toBeUndefined();
      expect(result.key("pending").get()).toBe(false);

      // Membership in the allowlist alone would mint a descriptor whose write
      // surface is only the direct output spot: `llm` mints its
      // `{ llm: { result: cause } }` document lazily inside the run, so the
      // runner can only learn about it through `serverBuiltinRuntimeWrites`.
      // Without that plumbing every claimed server run de-claims fail-closed
      // as dynamic-write-outside-static-surface. Pin the coverage, not just
      // the array's presence.
      expect(descriptor).toBeDefined();
      const declared = new Set([
        ...(descriptor?.writes ?? []).map((link) => link.id),
        ...(descriptor?.runtimeWrites ?? []).map((link) => link.id),
      ]);
      expect(observedWrites.length).toBeGreaterThan(0);
      expect(
        observedWrites.filter((write) => !declared.has(write.id)),
      ).toEqual([]);
      // The minted result document is genuinely extra — it is NOT one of the
      // registered output cells, so this assertion would hold vacuously if
      // `runtimeWrites` were dropped only because the run wrote nothing new.
      const directOutputs = new Set(
        (descriptor?.directOutputs ?? []).map((link) => link.id),
      );
      expect(
        (descriptor?.runtimeWrites ?? []).filter((link) =>
          !directOutputs.has(link.id)
        ).length,
      ).toBe(1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

/** Resolve once the llm node stops pending with a result or an error. */
function waitForSettled(
  cell: Cell<unknown>,
  timeoutMs = 2000,
): Promise<void> {
  let cancel: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout>;
  return new Promise<void>((resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("timed out waiting for the llm node to settle")),
      timeoutMs,
    );
    cancel = cell.asSchema({
      type: "object",
      properties: { pending: { type: "boolean" }, error: true, result: true },
      default: {},
    }).sink(({ pending, error, result } = {}) => {
      if (pending === false && (error !== undefined || result !== undefined)) {
        resolve();
      }
    });
  }).finally(() => {
    clearTimeout(timeout);
    cancel?.();
  });
}
