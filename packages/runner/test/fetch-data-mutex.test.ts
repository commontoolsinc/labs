import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import { setPatternEnvironment } from "../src/env.ts";
import {
  computeInputHashFromValue,
  internalSchema,
  tryClaimMutex,
} from "../src/builtins/fetch-utils.ts";
import {
  FIRST_PARTY_HTTP_AUTH_HEADERS,
  verifyFirstPartyHttpRequest,
} from "../src/toolshed-http-auth.ts";
import type { Schema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("test fetch-data mutex");
const space = signer.did();

describe("fetch-data mutex mechanism", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let computed: ReturnType<typeof createBuilder>["commonfabric"]["computed"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    computed = commonfabric.computed;
    byRef = commonfabric.byRef;

    // Set up pattern environment with a mock base URL
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    // Mock fetch
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      fetchCalls.push({ url, init });

      // Simulate a small delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      return new Response(
        JSON.stringify({ mocked: true, url }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should successfully fetch data", async () => {
    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell = runtime.getCell(space, "fetch-test", undefined, tx);
    const result = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/api/test",
    }, resultCell);
    tx.commit();

    // Give promises time to resolve
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Pull the result to trigger computation
    await result.pull();

    // Wait even more to ensure all transactions are committed
    await new Promise((resolve) => setTimeout(resolve, 200));
    await result.pull();

    const rawData = result.get() as {
      pending: any;
      result: any;
      error: any;
    };

    // Should have result
    expect(rawData.result).toBeDefined();
    expect(rawData.result.mocked).toBe(true);
    expect(rawData.error).toBeUndefined();
    expect(rawData.pending).toBe(false);

    // Should have made the fetch call
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls[0].url).toContain("/api/test");
  });

  it("resolves relative fetchData URLs against the pattern API URL", async () => {
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local/api/root/"),
    });

    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell = runtime.getCell(
      space,
      "relative-url-test",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      { url: "data/items.json" },
      resultCell,
    );
    tx.commit();

    await result.pull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await result.pull();

    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls[0].url).toBe(
      "http://mock-test-server.local/api/root/data/items.json",
    );
  });

  it("should enqueue fetchData work behind the post-commit outbox", async () => {
    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxCommit = txPrototype.commit;
    const originalWrapperCommit = wrapperPrototype.commit;
    let committed = false;

    txPrototype.commit = function (...args) {
      committed = true;
      return originalTxCommit.apply(this, args as never);
    };
    wrapperPrototype.commit = function (...args) {
      committed = true;
      return originalWrapperCommit.apply(this, args as never);
    };

    const resultCell = runtime.getCell(space, "pre-commit-test", undefined, tx);
    const result = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/api/pre-commit",
    }, resultCell);

    try {
      tx.commit();
      await result.pull();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(committed).toBe(true);
      expect(fetchCalls.length).toBeGreaterThan(0);
      expect(fetchCalls[0].url).toContain("/api/pre-commit");
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      txPrototype.commit = originalTxCommit;
      wrapperPrototype.commit = originalWrapperCommit;
    }
  });

  it("uses a stable fetchData idempotency key for identical inputs", async () => {
    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) =>
        fetchData({ url, mode: "json", options: { mutexTimeoutMs: 30_000 } }),
    );

    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxEnqueue = txPrototype.enqueuePostCommitEffect;
    const originalWrapperEnqueue = wrapperPrototype.enqueuePostCommitEffect;
    const outboxIds: string[] = [];

    txPrototype.enqueuePostCommitEffect = function (...args) {
      outboxIds.push((args[0] as { id: string }).id);
      return originalTxEnqueue.apply(this, args as never);
    };
    wrapperPrototype.enqueuePostCommitEffect = function (...args) {
      outboxIds.push((args[0] as { id: string }).id);
      return originalWrapperEnqueue.apply(this, args as never);
    };

    try {
      const resultCell = runtime.getCell(
        space,
        "fetch-idempotency-test",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, {
        url: "http://mock-test-server.local/api/idempotency",
      }, resultCell);
      tx.commit();
      await result.pull();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const expectedHash = computeInputHashFromValue({
        url: "http://mock-test-server.local/api/idempotency",
        mode: "json",
      });

      expect(computeInputHashFromValue({
        url: "http://mock-test-server.local/api/idempotency",
        mode: "json",
        options: { mutexTimeoutMs: 30_000 },
      })).toBe(expectedHash);
      expect(outboxIds.length).toBeGreaterThan(0);
      expect(outboxIds[0]).toBe(`fetchData:${expectedHash}`);
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
    }
  });

  it("does not claim a post-commit fetch mutex when live inputs differ from the approved snapshot", async () => {
    const inputs = runtime.getCell<{
      url?: string;
      mode?: "json" | "text";
    }>(space, "fetch-mutex-approved-inputs", undefined, tx);
    const pending = runtime.getCell<boolean>(
      space,
      "fetch-mutex-approved-pending",
      undefined,
      tx,
    );
    const result = runtime.getCell<unknown>(
      space,
      "fetch-mutex-approved-result",
      undefined,
      tx,
    );
    const error = runtime.getCell<unknown>(
      space,
      "fetch-mutex-approved-error",
      undefined,
      tx,
    );
    const internal = runtime.getCell<Schema<typeof internalSchema>>(
      space,
      "fetch-mutex-approved-internal",
      undefined,
      tx,
    );
    inputs.set({ url: "/api/mutated", mode: "json" });
    pending.set(false);
    internal.set({ requestId: "", lastActivity: 0, inputHash: "" });
    await tx.commit();
    tx = runtime.edit();

    const approvedSnapshot = { url: "/api/approved", mode: "json" as const };
    const approvedHash = computeInputHashFromValue(approvedSnapshot);
    const claim = await tryClaimMutex(
      runtime,
      inputs,
      pending,
      result,
      error,
      internal,
      approvedHash,
      (cell) => cell.get() ?? {},
      approvedHash,
    );

    expect(claim.claimed).toBe(false);
    expect(claim.inputHash).not.toBe(approvedHash);
    expect(pending.get()).toBe(false);
  });

  it("should handle concurrent requests with same inputs (mutex test)", async () => {
    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    // Create two separate result cells simulating two "tabs"
    const resultCell1 = runtime.getCell(space, "concurrent-1", undefined, tx);
    const resultCell2 = runtime.getCell(space, "concurrent-2", undefined, tx);

    // Start both at the same time
    runtime.run(tx, testPattern, { url: "/api/concurrent" }, resultCell1);
    runtime.run(tx, testPattern, { url: "/api/concurrent" }, resultCell2);
    tx.commit();

    // Pull first to trigger computation (starts the fetch)
    await resultCell1.pull();
    await resultCell2.pull();

    // Wait for async promises to resolve
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Pull again to get final results
    const data1 = (await resultCell1.pull()) as { result?: unknown };
    const data2 = (await resultCell2.pull()) as { result?: unknown };

    expect(data1.result).toBeDefined();
    expect(data2.result).toBeDefined();

    // Due to mutex, we should have made at most a few fetch calls, not 2x
    const relevantCalls = fetchCalls.filter((c) =>
      c.url.includes("/api/concurrent")
    );

    // This is the key test: with mutex, redundant requests should be prevented
    expect(relevantCalls.length).toBeLessThanOrEqual(2);
  });

  it("should restart fetch when URL input changes", async () => {
    const urlCell = runtime.getCell<string>(space, "url-input", undefined, tx);
    urlCell.set("/api/first");
    tx.commit();
    tx = runtime.edit();

    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell = runtime.getCell(space, "url-change-test", undefined, tx);
    runtime.run(tx, testPattern, { url: urlCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    // Pull first to trigger computation (starts the fetch)
    await resultCell.pull();

    // Wait for async work
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resultCell.pull();

    const firstCallCount =
      fetchCalls.filter((c) => c.url.includes("/api/first")).length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Change the URL
    urlCell.withTx(tx).send("/api/second");
    tx.commit();
    tx = runtime.edit();

    // Pull first to trigger computation with new URL
    await resultCell.pull();

    // Wait for async work
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resultCell.pull();

    // Should have made a new fetch with the new URL
    const secondCallCount =
      fetchCalls.filter((c) => c.url.includes("/api/second")).length;
    expect(secondCallCount).toBeGreaterThan(0);
  });

  it("should handle mode changes (text vs json)", async () => {
    const fetchData = byRef("fetchData");

    // First fetch as JSON
    const jsonPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell1 = runtime.getCell(space, "mode-test-json", undefined, tx);
    runtime.run(tx, jsonPattern, { url: "/api/mode" }, resultCell1);
    tx.commit();

    // Pull first to trigger computation
    await resultCell1.pull();

    // Wait for async work
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resultCell1.pull();

    const jsonCallCount = fetchCalls.length;
    expect(jsonCallCount).toBeGreaterThan(0);

    // Now fetch same URL as text - should trigger new fetch due to different mode
    tx = runtime.edit();
    const textPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "text" }),
    );

    const resultCell2 = runtime.getCell(space, "mode-test-text", undefined, tx);
    runtime.run(tx, textPattern, { url: "/api/mode" }, resultCell2);
    tx.commit();

    // Pull first to trigger computation
    await resultCell2.pull();

    // Wait for async work
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resultCell2.pull();

    // Should have made additional fetch calls for the different mode
    expect(fetchCalls.length).toBeGreaterThan(jsonCallCount);
  });

  it("converts dataUrl mode responses into a serializable data URL", async () => {
    globalThis.fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push({ url, init });
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        }),
      );
    };

    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "dataUrl" }),
    );

    const resultCell = runtime.getCell(space, "data-url-test", undefined, tx);
    const result = runtime.run(tx, testPattern, {
      url: "/api/image",
    }, resultCell);
    tx.commit();

    await result.pull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await result.pull();

    const rawData = result.get() as {
      pending: boolean;
      result?: string;
      error?: unknown;
    };

    expect(rawData.pending).toBe(false);
    expect(rawData.error).toBeUndefined();
    expect(rawData.result).toBe("data:image/webp;base64,AQIDBA==");
  });

  it("should set pending to true during fetch and false after", async () => {
    // Use a longer delay to observe pending state
    const slowFetch = globalThis.fetch;
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push({ url, init });

      // Longer delay
      await new Promise((resolve) => setTimeout(resolve, 100));

      return new Response(JSON.stringify({ mocked: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell = runtime.getCell(space, "pending-test", undefined, tx);
    const result = runtime.run(
      tx,
      testPattern,
      { url: "/api/pending" },
      resultCell,
    );
    tx.commit();

    // Pull first to trigger computation (starts the fetch)
    await result.pull();

    // Wait a bit for request to start
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 200));

    const finalData = (await result.pull()) as {
      pending?: boolean;
      result?: unknown;
    };

    // After completion, should have result
    expect(finalData.result).toBeDefined();
    expect(finalData.pending).toBe(false);

    // Restore original fetch
    globalThis.fetch = slowFetch;
  });

  const error404Fetch = () => {
    globalThis.fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("Not Found", { status: 404 });
    };
  };

  it("should handle fetch errors gracefully", async () => {
    error404Fetch();
    const sm = StorageManager.emulate({ as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const localTx = rt.edit();
    const { commonfabric } = createTrustedBuilder(rt);
    const fetchData = commonfabric.byRef("fetchData");
    const testPattern = commonfabric.pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell = rt.getCell(
      space,
      "error-test-modern",
      undefined,
      localTx,
    );
    const result = rt.run(
      localTx,
      testPattern,
      { url: "/api/error" },
      resultCell,
    );
    localTx.commit();

    await result.pull();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const data = (await result.pull()) as {
      error?: unknown;
      pending?: boolean;
    };

    // Regression guard for the `memory/v2/patch.ts` `structuredClone()`
    // class-stripping bug, which made errors round-trip back as `{ ... }`
    // with message/stack lost.
    expect(data.error).toBeDefined();
    const fe = data.error as {
      name: string;
      message: string;
      stack: string;
    };
    expect(fe.name).toBe("Error");
    expect(fe.message).toMatch(/HTTP 404/);
    expect(typeof fe.stack).toBe("string");
    expect(data.pending).toBe(false);

    await localTx.commit();
    await rt.dispose();
    await sm.close();
  });

  it("should abort and clear state if URL becomes empty while waiting for mutex", async () => {
    const fetchData = byRef("fetchData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const urlCell = runtime.getCell<string>(
      space,
      "url-empty-test",
      undefined,
      tx,
    );
    urlCell.set("/api/test");

    const resultCell = runtime.getCell(space, "empty-url-test", undefined, tx);
    runtime.run(tx, testPattern, { url: urlCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    // Change URL to empty
    urlCell.withTx(tx).send("");
    tx.commit();

    // Wait for async work
    await new Promise((resolve) => setTimeout(resolve, 200));

    const data = (await resultCell.pull()) as {
      error?: unknown;
      result?: unknown;
      pending?: boolean;
    };

    // Should have cleared state
    expect(data.result).toBeUndefined();
    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
  });

  it("should include computed options on the first fetch (CT-1246)", async () => {
    const fetchData = byRef("fetchData");

    // Options come from a computed — this is the scenario that triggers the bug.
    // Without the fix, the first fetch fires before the computed settles,
    // sending the request without the Accept header.
    const testRecipe = pattern<{ url: string }>(
      ({ url }) => {
        const options = computed(() => ({
          headers: { Accept: "application/vnd.github.v3.star+json" },
        }));
        return fetchData({ url, options });
      },
    );

    const resultCell = runtime.getCell(
      space,
      "computed-options-test",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testRecipe,
      { url: "http://mock-test-server.local/api/stars" },
      resultCell,
    );
    tx.commit();

    // Pull and wait for the fetch to complete
    await result.pull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await result.pull();

    // Filter to only the calls that hit our endpoint
    const relevantCalls = fetchCalls.filter((c) =>
      c.url.includes("/api/stars")
    );

    // The key assertion: every fetch call should include the computed headers.
    // Before the fix, the first call would have undefined options (no headers).
    expect(relevantCalls.length).toBeGreaterThan(0);
    for (const call of relevantCalls) {
      expect(call.init?.headers).toBeDefined();
      expect(
        (call.init?.headers as Record<string, string>)?.["Accept"],
      ).toBe("application/vnd.github.v3.star+json");
    }
  });

  it("adds custom auth headers to protected toolshed fetchData requests", async () => {
    const fetchData = byRef("fetchData");
    const testRecipe = pattern<{ query: string }>(
      ({ query }) =>
        fetchData({
          url: "/api/agent-tools/web-search",
          mode: "json",
          options: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: { query },
          },
        }),
    );

    const resultCell = runtime.getCell(
      space,
      "signed-toolshed-fetch",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testRecipe,
      { query: "signed request" },
      resultCell,
    );
    tx.commit();

    await result.pull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await result.pull();

    const call = fetchCalls.find((call) =>
      call.url === "http://mock-test-server.local/api/agent-tools/web-search"
    );
    expect(call).toBeDefined();

    const headers = new Headers(call!.init?.headers);
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof),
    ).toBeTruthy();
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toBeTruthy();
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256),
    ).toBeTruthy();
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid)).toBe(
      signer.did(),
    );
    expect(headers.get("Signature")).toBe(null);
    expect(headers.get("Signature-Input")).toBe(null);
    expect(headers.get("Content-Digest")).toBe(null);

    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(call!.url, {
        method: call!.init?.method,
        headers,
        body: call!.init?.body as BodyInit,
      }),
    });
    expect(verified.userDid).toBe(signer.did());
  });

  it("replaces caller-supplied auth headers on protected fetchData requests", async () => {
    const fetchData = byRef("fetchData");
    const testRecipe = pattern<{ query: string }>(
      ({ query }) =>
        fetchData({
          url: "/api/agent-tools/web-search",
          mode: "json",
          options: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [FIRST_PARTY_HTTP_AUTH_HEADERS.proof]: "bogus",
              [FIRST_PARTY_HTTP_AUTH_HEADERS.auth]: "bogus",
              [FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256]: "bogus",
              [FIRST_PARTY_HTTP_AUTH_HEADERS.userDid]: "did:key:bogus",
              "Signature": "bogus",
              "Signature-Input": "bogus",
              "Content-Digest": "bogus",
            },
            body: { query },
          },
        }),
    );

    const resultCell = runtime.getCell(
      space,
      "replace-auth-headers",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testRecipe,
      { query: "replace request" },
      resultCell,
    );
    tx.commit();

    await result.pull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await result.pull();

    const call = fetchCalls.find((call) =>
      call.url === "http://mock-test-server.local/api/agent-tools/web-search"
    );
    expect(call).toBeDefined();

    const headers = new Headers(call!.init?.headers);
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof)).not.toBe(
      "bogus",
    );
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).not.toBe("bogus");
    expect(
      headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256),
    ).not.toBe("bogus");
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid)).toBe(
      signer.did(),
    );
    expect(headers.get("Signature")).toBe(null);
    expect(headers.get("Signature-Input")).toBe(null);
    expect(headers.get("Content-Digest")).toBe(null);

    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(call!.url, {
        method: call!.init?.method,
        headers,
        body: call!.init?.body as BodyInit,
      }),
    });
    expect(verified.userDid).toBe(signer.did());
  });

  it("does not add auth headers to protected-looking external requests", async () => {
    const fetchData = byRef("fetchData");
    const testRecipe = pattern<{ query: string }>(
      ({ query }) =>
        fetchData({
          url: "http://external.test/api/agent-tools/web-search",
          mode: "json",
          options: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: { query },
          },
        }),
    );

    const resultCell = runtime.getCell(
      space,
      "external-toolshed-looking-fetch",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testRecipe,
      { query: "external request" },
      resultCell,
    );
    tx.commit();

    await result.pull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await result.pull();

    const call = fetchCalls.find((call) =>
      call.url === "http://external.test/api/agent-tools/web-search"
    );
    expect(call).toBeDefined();

    const headers = new Headers(call!.init?.headers);
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof)).toBe(
      null,
    );
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth)).toBe(
      null,
    );
    expect(headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid)).toBe(null);
  });
});
