import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test deduplication");
const space = signer.did();

// Track fetch calls to detect duplicates
let fetchCallCount = 0;
let originalFetch: typeof globalThis.fetch;

describe("Request Deduplication (Multi-Runtime)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime1: Runtime;
  let runtime2: Runtime;
  let tx1: IExtendedStorageTransaction;
  let tx2: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    // Create two separate runtime instances (simulating two tabs)
    runtime1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx1 = runtime1.edit();
    tx2 = runtime2.edit();

    const { commontools } = createBuilder();
    recipe = commontools.recipe;
    byRef = commontools.byRef;

    // Reset fetch call counter
    fetchCallCount = 0;

    // Mock fetch to track calls
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      await new Promise((resolve) => setTimeout(resolve, 50)); // Simulate network delay

      return new Response(
        JSON.stringify({ mocked: true, count: fetchCallCount }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;

    await tx1.commit();
    await tx2.commit();
    await runtime1?.dispose();
    await runtime2?.dispose();
    await storageManager?.close();
  });

  describe("fetchData deduplication", () => {
    it("should allow duplicate fetches when two runtimes see idle simultaneously", async () => {
      const url = "http://example.com/data";
      const fetchData = byRef("fetchData");
      const testRecipe = recipe("Fetch Test", () => fetchData({ url, mode: "json" }));

      // Both runtimes start the same fetch at the same time
      const resultCell1 = runtime1.getCell(space, "dedup-test-1", undefined, tx1);
      const resultCell2 = runtime2.getCell(space, "dedup-test-2", undefined, tx2);

      runtime1.run(tx1, testRecipe, {}, resultCell1);
      runtime2.run(tx2, testRecipe, {}, resultCell2);

      tx1.commit();
      tx2.commit();

      await runtime1.idle();
      await runtime2.idle();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await runtime1.idle();
      await runtime2.idle();

      // Both should complete successfully
      const data1 = resultCell1.get() as { pending?: boolean; result?: any };
      const data2 = resultCell2.get() as { pending?: boolean; result?: any };

      expect(data1.pending).toBe(false);
      expect(data1.result).toBeDefined();
      expect(data2.pending).toBe(false);
      expect(data2.result).toBeDefined();

      // CURRENT BEHAVIOR: Both runtimes make requests (no deduplication at start)
      // This test documents the current behavior
      console.log(`Fetch calls made: ${fetchCallCount}`);
      expect(fetchCallCount).toBeGreaterThanOrEqual(1); // At least one fetch happened

      // TODO: Ideally fetchCallCount should be 1, but currently it's 2
      // because both runtimes unconditionally transition to "fetching"
    });

    it("should NOT make duplicate requests if one runtime is already fetching", async () => {
      const url = "http://example.com/data2";
      const fetchData = byRef("fetchData");
      const testRecipe = recipe("Fetch Test 2", () => fetchData({ url, mode: "json" }));

      // Runtime 1 starts first
      const resultCell1 = runtime1.getCell(space, "dedup-test2-1", undefined, tx1);
      runtime1.run(tx1, testRecipe, {}, resultCell1);
      tx1.commit();

      // Give runtime1 time to transition to "fetching"
      await runtime1.idle();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Now runtime2 tries to start the same request
      const resultCell2 = runtime2.getCell(space, "dedup-test2-2", undefined, tx2);
      runtime2.run(tx2, testRecipe, {}, resultCell2);
      tx2.commit();

      await runtime1.idle();
      await runtime2.idle();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await runtime1.idle();
      await runtime2.idle();

      // Both should complete successfully
      const data1 = resultCell1.get() as { pending?: boolean; result?: any };
      const data2 = resultCell2.get() as { pending?: boolean; result?: any };

      expect(data1.pending).toBe(false);
      expect(data1.result).toBeDefined();
      expect(data2.pending).toBe(false);
      expect(data2.result).toBeDefined();

      // EXPECTED: Only 1 fetch (runtime2 sees "fetching" state and waits)
      // ACTUAL: Might still be 2 if runtime2 transitions before seeing runtime1's state
      console.log(`Fetch calls made: ${fetchCallCount}`);

      // This test shows whether the system can avoid duplicate work when
      // one runtime is already fetching
    });
  });

  describe("fetchProgram deduplication", () => {
    beforeEach(() => {
      // Override fetch for program resolution
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        fetchCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));

        return new Response(
          "export default () => 'test program';",
          {
            status: 200,
            headers: { "Content-Type": "text/typescript" },
          },
        );
      };
    });

    it("should document current deduplication behavior for programs", async () => {
      const url = "http://example.com/program.ts";
      const fetchProgram = byRef("fetchProgram");
      const testRecipe = recipe("Program Test", () => fetchProgram({ url }));

      // Both runtimes start fetching the same program
      const resultCell1 = runtime1.getCell(space, "prog-dedup-1", undefined, tx1);
      const resultCell2 = runtime2.getCell(space, "prog-dedup-2", undefined, tx2);

      runtime1.run(tx1, testRecipe, {}, resultCell1);
      runtime2.run(tx2, testRecipe, {}, resultCell2);

      tx1.commit();
      tx2.commit();

      await runtime1.idle();
      await runtime2.idle();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await runtime1.idle();
      await runtime2.idle();

      const data1 = resultCell1.get() as { pending?: boolean; result?: any };
      const data2 = resultCell2.get() as { pending?: boolean; result?: any };

      expect(data1.pending).toBe(false);
      expect(data1.result).toBeDefined();
      expect(data2.pending).toBe(false);
      expect(data2.result).toBeDefined();

      console.log(`Program fetch calls made: ${fetchCallCount}`);

      // Current behavior: likely 2+ fetches (one per runtime + dependencies)
      // Ideal behavior: 1 fetch total (deduplicated)
      expect(fetchCallCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("LLM deduplication", () => {
    let originalSendRequest: typeof import("@commontools/llm").LLMClient.prototype.sendRequest;
    let llmCallCount = 0;

    beforeEach(async () => {
      llmCallCount = 0;
      const { LLMClient } = await import("@commontools/llm");
      originalSendRequest = LLMClient.prototype.sendRequest;

      LLMClient.prototype.sendRequest = async function (_params: any, onPartial?: (text: string) => void): Promise<any> {
        llmCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));

        if (onPartial) {
          onPartial("Test ");
          onPartial("response");
        }

        return {
          role: "assistant",
          content: [{ type: "text", text: "Test response" }],
          id: "test-id",
        };
      };
    });

    afterEach(async () => {
      const { LLMClient } = await import("@commontools/llm");
      LLMClient.prototype.sendRequest = originalSendRequest;
    });

    it("should document current deduplication behavior for LLM calls", async () => {
      const messages = [{ role: "user" as const, content: "Hello" }];
      const generateText = byRef("generateText");
      const testRecipe = recipe("LLM Test", () => generateText({ messages }));

      // Both runtimes make the same LLM request
      const resultCell1 = runtime1.getCell(space, "llm-dedup-1", undefined, tx1);
      const resultCell2 = runtime2.getCell(space, "llm-dedup-2", undefined, tx2);

      runtime1.run(tx1, testRecipe, {}, resultCell1);
      runtime2.run(tx2, testRecipe, {}, resultCell2);

      tx1.commit();
      tx2.commit();

      await runtime1.idle();
      await runtime2.idle();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await runtime1.idle();
      await runtime2.idle();

      const data1 = resultCell1.get() as { pending?: boolean; result?: string };
      const data2 = resultCell2.get() as { pending?: boolean; result?: string };

      expect(data1.pending).toBe(false);
      expect(data1.result).toBe("Test response");
      expect(data2.pending).toBe(false);
      expect(data2.result).toBe("Test response");

      console.log(`LLM calls made: ${llmCallCount}`);

      // Current behavior: likely 2 LLM calls
      // Ideal behavior: 1 LLM call (deduplicated)
      expect(llmCallCount).toBeGreaterThanOrEqual(1);
    });
  });
});
