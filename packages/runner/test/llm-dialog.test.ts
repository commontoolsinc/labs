import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commontools/llm/client";
import type { BuiltInLLMMessage, JSONSchema } from "@commontools/api";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Enable mock mode once for all tests
enableMockMode();

describe("llmDialog", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commontools"]["Cell"];
  let patternTool: ReturnType<
    typeof createBuilder
  >["commontools"]["patternTool"];
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let llmDialog: ReturnType<typeof createBuilder>["commontools"]["llmDialog"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ recipe, llmDialog, Cell, patternTool } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should support a multi-turn conversation via addMessage", async () => {
    const initialMessage = "Hello";
    const initialResponse = "Hi there!";
    const followUpMessage = "How are you?";
    const followUpResponse = "I'm doing well, thanks!";

    let initialResponseCalled = false;
    let followUpResponseCalled = false;

    // Mock initial response
    addMockResponse(
      (req) => {
        const match = req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(initialMessage)
        );
        if (
          match &&
          !req.messages.some((m) =>
            typeof m.content === "string" && m.content.includes(followUpMessage)
          )
        ) {
          initialResponseCalled = true;
          return true;
        }
        return false;
      },
      {
        role: "assistant",
        content: initialResponse,
        id: "mock-initial-response",
      },
    );

    // Mock follow-up response
    addMockResponse(
      (req) => {
        const hasInitial = req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(initialMessage)
        );
        const hasFollowUp = req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(followUpMessage)
        );
        const match = hasInitial && hasFollowUp;
        if (match) {
          followUpResponseCalled = true;
          return true;
        }
        return false;
      },
      {
        role: "assistant",
        content: followUpResponse,
        id: "mock-followup-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asStream: true },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testRecipe = recipe(
      false,
      resultSchema,
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
    );

    // We need to define the result schema for the recipe to include addMessage as a stream
    // The recipe builder infers this from the return value, but we might need to be explicit if it's a stream?
    // The user said: "setting the result schema to { asStream: true } for that part"
    // This usually implies using `recipe(...).schema(...)` or relying on inference if it works.
    // But `dialog.addMessage` comes from `llmDialog` result which already has `asStream: true` in its schema.
    // So hopefully inference works.

    const resultCell = runtime.getCell(
      space,
      "llmDialog-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    // Wait for initial processing (if any)
    await runtime.idle();

    // Get the addMessage handler
    const addMessage = result.key("addMessage").get();

    // Send initial message
    addMessage.send({
      role: "user",
      content: initialMessage,
    });

    // Wait for initial processing: 1 user message + 1 assistant response = 2 messages
    await expect(waitForMessages(result, 2)).resolves.toBeUndefined();

    // Send follow-up message
    addMessage.send({
      role: "user",
      content: followUpMessage,
    });

    // Wait for follow-up processing: 2 existing + 1 user message + 1 assistant response = 4 messages
    await expect(waitForMessages(result, 4)).resolves.toBeUndefined();

    // Verify mocks were hit
    // Note: The initial message might trigger a generation immediately upon creation if the logic dictates,
    // or only when `addMessage` is called.
    // `llmDialog` usually starts with existing messages. If the last message is User, it replies.
    // So it should reply to "Hello" immediately.

    expect(initialResponseCalled).toBe(true);
    expect(followUpResponseCalled).toBe(true);
  });

  it("should support tool calls in llmDialog", async () => {
    const initialMessage = "What is the weather in San Francisco?";
    const toolCallId = "call_123";
    const toolResult = "Sunny, 25C";
    const finalResponse = "The weather in San Francisco is sunny and 25C.";

    let toolCalled = false;

    // Mock initial response (Tool Call)
    addMockResponse(
      (req) => {
        const lastMsg = req.messages[req.messages.length - 1];
        return (
          typeof lastMsg.content === "string" &&
          lastMsg.content.includes(initialMessage)
        );
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: toolCallId,
            toolName: "getWeather",
            input: { location: "San Francisco" },
          },
        ],
        id: "mock-tool-call-response",
      },
    );

    // Mock final response (After Tool Result)
    addMockResponse(
      (req) => {
        // Check if the request contains the tool result
        const toolMsg = req.messages.find(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((c) =>
              c.type === "tool-call" && c.toolName === "getWeather"
            ),
        );
        return !!toolMsg;
      },
      {
        role: "assistant",
        content: finalResponse,
        id: "mock-final-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asStream: true },
        pending: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const getWeatherTool = recipe(
      {
        description: "Get the weather for a location",
        type: "object",
        properties: {
          location: { type: "string" },
        },
        required: ["location"],
      } as const satisfies JSONSchema,
      { type: "string" },
      ({ location: _location }: any) => {
        toolCalled = true;
        return toolResult;
      },
    );

    const testRecipe = recipe(
      false,
      resultSchema,
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          tools: {
            getWeather: patternTool(getWeatherTool),
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-tool-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    await runtime.idle();

    const addMessage = result.key("addMessage").get();

    // Send initial message
    addMessage.send({
      role: "user",
      content: initialMessage,
    });

    // Wait for processing:
    // 1. User message
    // 2. Assistant tool call
    // 3. Tool result
    // 4. Assistant final response
    // Total = 4 messages
    await expect(waitForMessages(result, 4)).resolves.toBeUndefined();

    expect(toolCalled).toBe(true);

    // Verify the conversation history
    const messages = result.key("messages").get()!;
    expect(messages).toHaveLength(4);
    expect(messages[1].role).toBe("assistant");
    const content = messages[1].content as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("tool-call");
    expect(content[0].toolName).toBe("getWeather");
    expect(messages[2].role).toBe("tool");
    expect((messages[2].content as any)[0].toolName).toEqual("getWeather");
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe(finalResponse);
  });
});

function waitForMessages(result: any, expectedCount: number) {
  let cancel: () => void;
  let timeout: ReturnType<typeof setTimeout>;
  return new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `Timeout waiting for ${expectedCount} messages and pending=false`,
        ),
      );
    }, 5000);
    cancel = result.sink(({ pending, messages }: any = {}) => {
      if (pending === false && messages?.length === expectedCount) {
        resolve();
      }
    });
  }).finally(() => {
    clearTimeout(timeout);
    cancel();
  });
}
