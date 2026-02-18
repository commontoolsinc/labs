import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commontools/llm/client";
import type { BuiltInLLMMessage } from "@commontools/api";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Enable mock mode once for all tests
enableMockMode();

describe("generateText", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let generateText: ReturnType<
    typeof createBuilder
  >["commontools"]["generateText"];

  let dummyPattern: any;

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ pattern, generateText } = commontools);
    dummyPattern = pattern(() => ({}), { type: "object" });
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should generate text from a simple prompt", async () => {
    const testPrompt = "Say hello";
    const expectedResponse = "Hello world!";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      {
        role: "assistant",
        content: expectedResponse,
        id: "mock-simple-prompt",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt: testPrompt,
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-simple-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe(expectedResponse);
  });

  it("should generate text from messages", async () => {
    const messages: BuiltInLLMMessage[] = [
      { role: "user", content: "Knock knock" },
      { role: "assistant", content: "Who's there?" },
      { role: "user", content: "Orange" },
    ];
    const expectedResponse = "Orange who?";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes("Orange")
        ),
      {
        role: "assistant",
        content: expectedResponse,
        id: "mock-messages",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        messages,
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-messages-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe(expectedResponse);
  });

  it("should support system parameter", async () => {
    const testPrompt = "Who are you?";
    const systemPrompt = "You are a pirate.";
    const expectedResponse = "I be a pirate!";

    addMockResponse(
      (req) =>
        req.system === systemPrompt &&
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ),
      {
        role: "assistant",
        content: expectedResponse,
        id: "mock-system-prompt",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt: testPrompt,
        system: systemPrompt,
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-system-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe(expectedResponse);
  });

  it("should support tools", async () => {
    const testPrompt = "What is the weather?";
    const expectedResponse = "The weather is Sunny.";

    // Mock tool call
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.tools?.["getWeather"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_weather",
            toolName: "getWeather",
            input: {},
          },
        ],
        id: "mock-tool-call",
      },
    );

    // Mock tool result processing and final response
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_weather"
          )
        ),
      {
        role: "assistant",
        content: expectedResponse,
        id: "mock-tool-result",
      },
    );

    const testPattern = pattern(() => {
      return generateText({
        prompt: testPrompt,
        tools: {
          getWeather: {
            description: "Get the weather",
            pattern: dummyPattern,
          },
        },
      });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-tools-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe(expectedResponse);
  });
});

// Helper to wait for pending to become false
function waitForPendingToBecomeFalse(
  cell: Cell<unknown>,
  timeoutMs = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cancel?.();
      reject(new Error("Timeout waiting for pending to become false"));
    }, timeoutMs);

    // Use sink to subscribe as an effect - this triggers the computation chain
    const cancel = cell.asSchema({
      type: "object",
      properties: { pending: { type: "boolean" } },
      default: {},
    }).sink((value) => {
      if (value.pending === false) {
        clearTimeout(timeout);
        cancel?.();
        resolve();
      }
    });
  });
}
