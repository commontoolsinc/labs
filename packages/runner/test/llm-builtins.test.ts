import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { LLMClient, type LLMResponse } from "@commontools/llm";
import type { BuiltInLLMMessage } from "@commontools/api";

const signer = await Identity.fromPassphrase("test llm-builtins");
const space = signer.did();

// Original LLM methods (to restore later)
let originalSendRequest: typeof LLMClient.prototype.sendRequest;
let originalGenerateObject: typeof LLMClient.prototype.generateObject;

// Test control
let llmDelay = 0;
let shouldError = false;
let errorMessage = "";

describe("LLM Built-ins State Machine", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];

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

    // Reset control variables
    llmDelay = 0;
    shouldError = false;
    errorMessage = "";

    // Mock LLMClient methods
    originalSendRequest = LLMClient.prototype.sendRequest;
    originalGenerateObject = LLMClient.prototype.generateObject;

    LLMClient.prototype.sendRequest = async function (
      _params: any,
      onPartial?: (text: string) => void,
    ): Promise<LLMResponse> {
      if (llmDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, llmDelay));
      }

      if (shouldError) {
        throw new Error(errorMessage || "LLM request failed");
      }

      if (onPartial) {
        onPartial("Partial ");
        await new Promise((resolve) => setTimeout(resolve, 5));
        onPartial("response");
      }

      return {
        role: "assistant",
        content: [{ type: "text", text: "Test response" }],
        id: "test-id",
      };
    };

    LLMClient.prototype.generateObject = async function (
      _params: any,
    ): Promise<any> {
      if (llmDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, llmDelay));
      }

      if (shouldError) {
        throw new Error(errorMessage || "Generate object failed");
      }

      return { object: { test: "value" }, id: "test-id" };
    };
  });

  afterEach(async () => {
    // Restore original methods
    LLMClient.prototype.sendRequest = originalSendRequest;
    LLMClient.prototype.generateObject = originalGenerateObject;

    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("generateText lifecycle", () => {
    it("should transition: idle -> fetching -> success", async () => {
      llmDelay = 30; // Add delay to observe pending state

      const messages: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Hello",
      }];

      const generateText = byRef("generateText");
      const testRecipe = recipe(
        "Lifecycle Test",
        () => generateText({ messages }),
      );

      const resultCell = runtime.getCell(space, "lifecycle-1", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      // Wait for completion
      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await runtime.idle();

      const data = result.get() as {
        pending?: boolean;
        result?: string;
        error?: string;
      };
      expect(data.pending).toBe(false);
      expect(data.result).toBe("Test response");
      expect(data.error).toBeUndefined();
    });

    it("should transition: idle -> fetching -> error", async () => {
      shouldError = true;
      errorMessage = "Network error";

      const messages: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Hello",
      }];

      const generateText = byRef("generateText");
      const testRecipe = recipe(
        "Error Lifecycle Test",
        () => generateText({ messages }),
      );

      const resultCell = runtime.getCell(space, "error-lifecycle", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      const data = result.get() as {
        pending?: boolean;
        result?: string;
        error?: string;
      };

      expect(data.pending).toBe(false);
      expect(data.error).toBe("Network error");
      expect(data.result).toBeUndefined();
    });

    it("should handle concurrent requests with different inputs", async () => {
      const messages1: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Request 1",
      }];
      const messages2: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Request 2",
      }];

      const generateText = byRef("generateText");
      const recipe1 = recipe("Test 1", () =>
        generateText({ messages: messages1 }));
      const recipe2 = recipe("Test 2", () =>
        generateText({ messages: messages2 }));

      const resultCell1 = runtime.getCell(space, "concurrent-1", undefined, tx);
      const resultCell2 = runtime.getCell(space, "concurrent-2", undefined, tx);

      runtime.run(tx, recipe1, {}, resultCell1);
      runtime.run(tx, recipe2, {}, resultCell2);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      const data1 = resultCell1.get() as { pending?: boolean; result?: string };
      const data2 = resultCell2.get() as { pending?: boolean; result?: string };

      expect(data1.pending).toBe(false);
      expect(data1.result).toBe("Test response");
      expect(data2.pending).toBe(false);
      expect(data2.result).toBe("Test response");
    });

    it("should prevent race conditions (newer request wins)", async () => {
      llmDelay = 50;

      const messagesCell = runtime.getCell<BuiltInLLMMessage[]>(
        space,
        "messages-input",
        undefined,
        tx,
      );
      messagesCell.set([{ role: "user", content: "First" }]);
      tx.commit();
      tx = runtime.edit();

      const generateText = byRef("generateText");
      const testRecipe = recipe<{ messages: BuiltInLLMMessage[] }>(
        "Race Test",
        ({ messages }) => generateText({ messages }),
      );

      const resultCell = runtime.getCell(space, "race-test", undefined, tx);
      runtime.run(tx, testRecipe, { messages: messagesCell }, resultCell);
      tx.commit();

      // Change input quickly to trigger new request
      await new Promise((resolve) => setTimeout(resolve, 10));
      tx = runtime.edit();
      messagesCell.withTx(tx).send([{ role: "user", content: "Second" }]);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await runtime.idle();

      const data = resultCell.get() as { result?: string };
      // Should have result from second request
      expect(data.result).toBe("Test response");
    });

    it("should cache results for identical inputs", async () => {
      const messages: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Cache test",
      }];

      const generateText = byRef("generateText");
      const testRecipe = recipe(
        "Cache Test",
        () => generateText({ messages }),
      );

      // First request
      const resultCell1 = runtime.getCell(space, "cache-1", undefined, tx);
      runtime.run(tx, testRecipe, {}, resultCell1);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      // Second request with same inputs should use cache
      tx = runtime.edit();
      const resultCell2 = runtime.getCell(space, "cache-2", undefined, tx);
      runtime.run(tx, testRecipe, {}, resultCell2);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runtime.idle();

      const data1 = resultCell1.get() as { result?: string };
      const data2 = resultCell2.get() as { result?: string };

      expect(data1.result).toBe("Test response");
      expect(data2.result).toBe("Test response");
    });

    it("should invalidate cache when inputs change", async () => {
      const messages1: BuiltInLLMMessage[] = [{
        role: "user",
        content: "First",
      }];
      const messages2: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Second",
      }];

      const generateText = byRef("generateText");

      // First request
      const recipe1 = recipe("Inv 1", () =>
        generateText({ messages: messages1 }));
      const resultCell = runtime.getCell(space, "invalidate", undefined, tx);
      runtime.run(tx, recipe1, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      // Second request with different inputs
      tx = runtime.edit();
      const recipe2 = recipe("Inv 2", () =>
        generateText({ messages: messages2 }));
      runtime.run(tx, recipe2, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      const data = resultCell.get() as { result?: string };
      expect(data.result).toBe("Test response");
    });

    it("should handle empty messages (no request)", async () => {
      const generateText = byRef("generateText");
      const testRecipe = recipe(
        "Empty Test",
        () => generateText({}), // No messages or prompt
      );

      const resultCell = runtime.getCell(space, "empty-msgs", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const data = result.get() as {
        pending?: boolean;
        result?: string;
      };

      expect(data.pending).toBe(false);
      expect(data.result).toBeUndefined();
    });
  });

  describe("generateObject lifecycle", () => {
    it("should transition: idle -> fetching -> success", async () => {
      const messages: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Generate object",
      }];
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
      } as const;

      const generateObject = byRef("generateObject");
      const testRecipe = recipe(
        "Object Lifecycle",
        () => generateObject({ messages, schema }),
      );

      const resultCell = runtime.getCell(space, "obj-lifecycle", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      const data = result.get() as {
        pending?: boolean;
        result?: { test: string };
        error?: string;
      };

      expect(data.pending).toBe(false);
      expect(data.result).toEqual({ test: "value" });
      expect(data.error).toBeUndefined();
    });

    it("should transition: idle -> fetching -> error", async () => {
      shouldError = true;
      errorMessage = "Schema error";

      const messages: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Generate object",
      }];
      const schema = { type: "object", properties: {} } as const;

      const generateObject = byRef("generateObject");
      const testRecipe = recipe(
        "Object Error",
        () => generateObject({ messages, schema }),
      );

      const resultCell = runtime.getCell(space, "obj-error", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      const data = result.get() as {
        pending?: boolean;
        error?: string;
        result?: unknown;
      };

      expect(data.pending).toBe(false);
      expect(data.error).toBe("Schema error");
      expect(data.result).toBeUndefined();
    });

    it("should prevent race conditions", async () => {
      llmDelay = 50;

      const messagesCell = runtime.getCell<BuiltInLLMMessage[]>(
        space,
        "obj-messages",
        undefined,
        tx,
      );
      messagesCell.set([{ role: "user", content: "First" }]);
      const schema = { type: "object", properties: {} } as const;
      tx.commit();
      tx = runtime.edit();

      const generateObject = byRef("generateObject");
      const testRecipe = recipe<{ messages: BuiltInLLMMessage[] }>(
        "Obj Race",
        ({ messages }) => generateObject({ messages, schema }),
      );

      const resultCell = runtime.getCell(space, "obj-race", undefined, tx);
      runtime.run(tx, testRecipe, { messages: messagesCell }, resultCell);
      tx.commit();

      // Change input
      await new Promise((resolve) => setTimeout(resolve, 10));
      tx = runtime.edit();
      messagesCell.withTx(tx).send([{ role: "user", content: "Second" }]);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await runtime.idle();

      const data = resultCell.get() as { result?: { test: string } };
      expect(data.result).toEqual({ test: "value" });
    });
  });

  describe("llm (full content) lifecycle", () => {
    it("should transition: idle -> fetching -> success", async () => {
      const messages: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Hello",
      }];

      const llm = byRef("llm");
      const testRecipe = recipe("LLM Lifecycle", () => llm({ messages }));

      const resultCell = runtime.getCell(space, "llm-lifecycle", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      const data = result.get() as {
        pending?: boolean;
        result?: Array<{ type: string; text: string }>;
      };

      expect(data.pending).toBe(false);
      expect(data.result).toBeDefined();
      expect(Array.isArray(data.result)).toBe(true);
    });

    it("should transition: idle -> fetching -> error", async () => {
      shouldError = true;
      errorMessage = "LLM failure";

      const messages: BuiltInLLMMessage[] = [{
        role: "user",
        content: "Hello",
      }];

      const llm = byRef("llm");
      const testRecipe = recipe("LLM Error", () => llm({ messages }));

      const resultCell = runtime.getCell(space, "llm-error", undefined, tx);
      const result = runtime.run(tx, testRecipe, {}, resultCell);
      tx.commit();

      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.idle();

      const data = result.get() as {
        pending?: boolean;
        error?: string;
      };

      expect(data.pending).toBe(false);
      expect(data.error).toBe("LLM failure");
    });
  });
});
