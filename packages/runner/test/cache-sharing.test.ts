import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test cache-sharing");
const space = signer.did();

// Track fetch calls
let fetchCallCount = 0;
let originalFetch: typeof globalThis.fetch;

describe("Global Cache Sharing", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    recipe = commontools.recipe;
    byRef = commontools.byRef;

    fetchCallCount = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCallCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ mocked: true, count: fetchCallCount }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should share fetchData cache across different recipe instances", async () => {
    const url = "http://example.com/data";
    const fetchData = byRef("fetchData");

    // Create TWO different recipe instances that fetch the same URL
    const recipe1 = recipe("Recipe1", () => fetchData({ url, mode: "json" }));
    const recipe2 = recipe("Recipe2", () => fetchData({ url, mode: "json" }));

    // Run both recipes with different output cells
    const result1 = runtime.getCell(space, "result-1", undefined, tx);
    const result2 = runtime.getCell(space, "result-2", undefined, tx);

    runtime.run(tx, recipe1, {}, result1);
    runtime.run(tx, recipe2, {}, result2);

    await tx.commit();
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runtime.idle();

    const data1 = result1.get() as { result?: any };
    const data2 = result2.get() as { result?: any };

    // Both should have results
    expect(data1.result).toBeDefined();
    expect(data2.result).toBeDefined();

    // KEY TEST: Only ONE fetch should happen because cache is shared
    expect(fetchCallCount).toBe(1);
  });

  it("should share fetchProgram cache across different recipe instances", async () => {
    const url = "http://example.com/program.ts";

    // Override fetch for program resolution
    globalThis.fetch = async () => {
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

    const fetchProgram = byRef("fetchProgram");

    const recipe1 = recipe("Program1", () => fetchProgram({ url }));
    const recipe2 = recipe("Program2", () => fetchProgram({ url }));

    const result1 = runtime.getCell(space, "prog-result-1", undefined, tx);
    const result2 = runtime.getCell(space, "prog-result-2", undefined, tx);

    runtime.run(tx, recipe1, {}, result1);
    runtime.run(tx, recipe2, {}, result2);

    await tx.commit();
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runtime.idle();

    const data1 = result1.get() as { result?: any };
    const data2 = result2.get() as { result?: any };

    expect(data1.result).toBeDefined();
    expect(data2.result).toBeDefined();

    // Only ONE fetch should happen
    expect(fetchCallCount).toBe(1);
  });

  it("should share generateText cache across different recipe instances", async () => {
    const { LLMClient } = await import("@commontools/llm");
    const originalSendRequest = LLMClient.prototype.sendRequest;
    let llmCallCount = 0;

    LLMClient.prototype.sendRequest = async function (_params: any, onPartial?: (text: string) => void): Promise<any> {
      llmCallCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (onPartial) {
        onPartial("Test response");
      }

      return {
        role: "assistant",
        content: [{ type: "text", text: "Test response" }],
        id: "test-id",
      };
    };

    const messages = [{ role: "user" as const, content: "Hello" }];
    const generateText = byRef("generateText");

    const recipe1 = recipe("LLM1", () => generateText({ messages }));
    const recipe2 = recipe("LLM2", () => generateText({ messages }));

    const result1 = runtime.getCell(space, "llm-result-1", undefined, tx);
    const result2 = runtime.getCell(space, "llm-result-2", undefined, tx);

    runtime.run(tx, recipe1, {}, result1);
    runtime.run(tx, recipe2, {}, result2);

    await tx.commit();
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runtime.idle();

    const data1 = result1.get() as { result?: string };
    const data2 = result2.get() as { result?: string };

    expect(data1.result).toBe("Test response");
    expect(data2.result).toBe("Test response");

    // Only ONE LLM call should happen
    expect(llmCallCount).toBe(1);

    LLMClient.prototype.sendRequest = originalSendRequest;
  });
});
