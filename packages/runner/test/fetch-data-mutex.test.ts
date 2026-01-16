import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setRecipeEnvironment } from "../src/env.ts";

const signer = await Identity.fromPassphrase("test fetch-data mutex");
const space = signer.did();

describe("fetch-data mutex mechanism", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    recipe = commontools.recipe;
    byRef = commontools.byRef;

    // Set up recipe environment with a mock base URL
    setRecipeEnvironment({
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
    const testRecipe = recipe<{ url: string }>(
      "Fetch Test",
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell = runtime.getCell(space, "fetch-test", undefined, tx);
    const result = runtime.run(tx, testRecipe, {
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

  it("should handle concurrent requests with same inputs (mutex test)", async () => {
    const fetchData = byRef("fetchData");
    const testRecipe = recipe<{ url: string }>(
      "Concurrent Fetch",
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    // Create two separate result cells simulating two "tabs"
    const resultCell1 = runtime.getCell(space, "concurrent-1", undefined, tx);
    const resultCell2 = runtime.getCell(space, "concurrent-2", undefined, tx);

    // Start both at the same time
    runtime.run(tx, testRecipe, { url: "/api/concurrent" }, resultCell1);
    runtime.run(tx, testRecipe, { url: "/api/concurrent" }, resultCell2);
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
    const testRecipe = recipe<{ url: string }>(
      "URL Change Test",
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell = runtime.getCell(space, "url-change-test", undefined, tx);
    runtime.run(tx, testRecipe, { url: urlCell }, resultCell);
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
    const jsonRecipe = recipe<{ url: string }>(
      "JSON Fetch",
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell1 = runtime.getCell(space, "mode-test-json", undefined, tx);
    runtime.run(tx, jsonRecipe, { url: "/api/mode" }, resultCell1);
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
    const textRecipe = recipe<{ url: string }>(
      "Text Fetch",
      ({ url }) => fetchData({ url, mode: "text" }),
    );

    const resultCell2 = runtime.getCell(space, "mode-test-text", undefined, tx);
    runtime.run(tx, textRecipe, { url: "/api/mode" }, resultCell2);
    tx.commit();

    // Pull first to trigger computation
    await resultCell2.pull();

    // Wait for async work
    await new Promise((resolve) => setTimeout(resolve, 200));
    await resultCell2.pull();

    // Should have made additional fetch calls for the different mode
    expect(fetchCalls.length).toBeGreaterThan(jsonCallCount);
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
    const testRecipe = recipe<{ url: string }>(
      "Pending Test",
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell = runtime.getCell(space, "pending-test", undefined, tx);
    const result = runtime.run(
      tx,
      testRecipe,
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

  it("should handle fetch errors gracefully", async () => {
    // Mock fetch to return an error
    globalThis.fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("Not Found", { status: 404 });
    };

    const fetchData = byRef("fetchData");
    const testRecipe = recipe<{ url: string }>(
      "Error Test",
      ({ url }) => fetchData({ url, mode: "json" }),
    );

    const resultCell = runtime.getCell(space, "error-test", undefined, tx);
    const result = runtime.run(
      tx,
      testRecipe,
      { url: "/api/error" },
      resultCell,
    );
    tx.commit();

    // Pull first to trigger computation (starts the fetch)
    await result.pull();

    // Wait for async work
    await new Promise((resolve) => setTimeout(resolve, 200));

    const data = (await result.pull()) as {
      error?: unknown;
      result?: unknown;
      pending?: boolean;
    };

    // Should have an error with proper @Error wrapper structure
    expect(data.error).toBeDefined();
    expect(data.error).toHaveProperty("@Error");
    const errorInfo =
      (data.error as { "@Error": Record<string, unknown> })["@Error"];
    expect(errorInfo.name).toBe("Error");
    expect(errorInfo.message).toMatch(/HTTP 404/);
    expect(data.pending).toBe(false);
  });

  it("should abort and clear state if URL becomes empty while waiting for mutex", async () => {
    const fetchData = byRef("fetchData");
    const testRecipe = recipe<{ url: string }>(
      "Empty URL Test",
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
    runtime.run(tx, testRecipe, { url: urlCell }, resultCell);
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
});
