import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  loadConversationFixture,
} from "@commontools/llm/client";
import type {
  BuiltInLLMMessage,
  BuiltInLLMTool,
  JSONSchema,
} from "@commontools/api";
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
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
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
    ({ pattern, llmDialog, Cell, patternTool } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should support a multi-turn conversation via addMessage", async () => {
    loadConversationFixture({
      description: "Multi-turn conversation: greeting then follow-up",
      responses: [
        {
          type: "sendRequest",
          expectRequest: { messagesContain: ["Hello"], messageCount: 1 },
          response: { role: "assistant", content: "Hi there!", id: "r1" },
        },
        {
          type: "sendRequest",
          expectRequest: {
            messagesContain: ["Hello", "How are you?"],
            messageCount: 3,
          },
          response: {
            role: "assistant",
            content: "I'm doing well, thanks!",
            id: "r2",
          },
        },
      ],
    });

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

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Turn 1: send greeting
    addMessage.send({ role: "user", content: "Hello" });
    await expect(waitForMessages(result, 2)).resolves.toBeUndefined();

    // Turn 2: send follow-up
    addMessage.send({ role: "user", content: "How are you?" });
    await expect(waitForMessages(result, 4)).resolves.toBeUndefined();

    const msgs = (await result.key("messages").pull())!;
    expect(msgs[0].content).toBe("Hello");
    expect(msgs[1].content).toBe("Hi there!");
    expect(msgs[2].content).toBe("How are you?");
    expect(msgs[3].content).toBe("I'm doing well, thanks!");
  });

  it("should support tool calls in llmDialog", async () => {
    loadConversationFixture({
      description: "Tool call: weather lookup with getWeather tool",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            lastMessageContains: "weather in San Francisco",
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_123",
              toolName: "getWeather",
              input: { location: "San Francisco" },
            }],
            id: "r1",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 3 },
          response: {
            role: "assistant",
            content: "The weather in San Francisco is sunny and 25C.",
            id: "r2",
          },
        },
      ],
    });

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

    let toolCalled = false;

    const getWeatherTool = pattern(
      ({ location: _location }: any) => {
        toolCalled = true;
        return "Sunny, 25C";
      },
      {
        description: "Get the weather for a location",
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      } as const satisfies JSONSchema,
      { type: "string" },
    );

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          tools: {
            getWeather: patternTool(
              getWeatherTool,
            ) as unknown as BuiltInLLMTool,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          error: dialog.error,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-tool-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    addMessage.send({
      role: "user",
      content: "What is the weather in San Francisco?",
    });

    // user msg + assistant tool-call + tool result + assistant final = 4
    await expect(waitForMessages(result, 4)).resolves.toBeUndefined();

    expect(toolCalled).toBe(true);

    const messages = (await result.key("messages").pull())!;
    expect(messages).toHaveLength(4);
    expect(messages[1].role).toBe("assistant");
    const content = messages[1].content as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("tool-call");
    expect(content[0].toolName).toBe("getWeather");
    expect(messages[2].role).toBe("tool");
    expect((messages[2].content as any)[0].toolName).toEqual("getWeather");
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe(
      "The weather in San Francisco is sunny and 25C.",
    );
  });

  it("should support pinning cells via pin tool", async () => {
    loadConversationFixture({
      description: "Pin tool: pin a cell via tool call",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            lastMessageContains: "pin this cell",
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "pin_call_1",
              toolName: "pin",
              input: { path: { "@link": "/of:test123" }, name: "Test Cell" },
            }],
            id: "r1",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 3 },
          response: {
            role: "assistant",
            content: "Cell has been pinned successfully.",
            id: "r2",
          },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asStream: true },
        pending: { type: "boolean" },
        pinnedCells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-pin-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    addMessage.send({ role: "user", content: "Please pin this cell" });
    await expect(waitForMessages(result, 4)).resolves.toBeUndefined();

    const pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells).toBeDefined();
    expect(Array.isArray(pinnedCells)).toBe(true);
    expect(pinnedCells?.length).toBe(1);
    expect(pinnedCells?.[0].path).toBe("/of:test123");
    expect(pinnedCells?.[0].name).toBe("Test Cell");
  });

  it("should support unpinning cells via unpin tool", async () => {
    loadConversationFixture({
      description: "Unpin tool: pin then unpin a cell",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            lastMessageContains: "pin this cell",
            messageCount: 1,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "pin_call_unpin_test",
              toolName: "pin",
              input: { path: { "@link": "/of:test123" }, name: "Test Cell" },
            }],
            id: "r1",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 3 },
          response: {
            role: "assistant",
            content: "Cell has been pinned.",
            id: "r2",
          },
        },
        {
          type: "sendRequest",
          expectRequest: {
            lastMessageContains: "unpin that cell",
            messageCount: 5,
          },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "unpin_call_1",
              toolName: "unpin",
              input: { path: { "@link": "/of:test123" } },
            }],
            id: "r3",
          },
        },
        {
          type: "sendRequest",
          expectRequest: { messageCount: 7 },
          response: {
            role: "assistant",
            content: "Cell has been unpinned.",
            id: "r4",
          },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asStream: true },
        pending: { type: "boolean" },
        pinnedCells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-unpin-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // First pin a cell
    addMessage.send({ role: "user", content: "Please pin this cell" });
    await expect(waitForMessages(result, 4)).resolves.toBeUndefined();

    let pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells?.length).toBe(1);
    expect(pinnedCells?.[0].path).toBe("/of:test123");

    // Now unpin it
    addMessage.send({ role: "user", content: "Please unpin that cell" });
    await expect(waitForMessages(result, 8)).resolves.toBeUndefined();

    pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells).toBeDefined();
    expect(Array.isArray(pinnedCells)).toBe(true);
    expect(pinnedCells?.length).toBe(0);
  });

  it("should include context cells in system prompt", async () => {
    const initialMessage = "What context do you have?";

    let capturedSystemPrompt = "";

    // Mock response that captures the system prompt
    addMockResponse(
      (req) => {
        capturedSystemPrompt = req.system || "";
        return true;
      },
      {
        role: "assistant",
        content: "I have access to the context cells.",
        id: "mock-context-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asStream: true },
        pending: { type: "boolean" },
        pinnedCells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        // Create context cell inside pattern
        const contextCell = Cell.of({ value: "test context data" });
        const dialog = llmDialog({
          messages,
          context: {
            testContext: contextCell,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-context-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Send message
    addMessage.send({
      role: "user",
      content: initialMessage,
    });

    // Wait for response
    await expect(waitForMessages(result, 2)).resolves.toBeUndefined();

    // Verify context cells appear in pinnedCells output
    const pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells).toBeDefined();
    expect(Array.isArray(pinnedCells)).toBe(true);
    expect(pinnedCells?.length).toBe(1);
    expect(pinnedCells?.[0].name).toBe("testContext");
    expect(pinnedCells?.[0].path).toContain("/of:");

    // Verify system prompt includes context cells
    expect(capturedSystemPrompt).toContain("# Available Cells");
    expect(capturedSystemPrompt).toContain("testContext");
    expect(capturedSystemPrompt).toContain("test context data");
  });

  it("should merge context and pinned cells in system prompt", async () => {
    const initialMessage = "Tell me about available cells";
    const cellPath = "/of:pinned123";
    const cellName = "Pinned Cell";

    let capturedSystemPrompt = "";

    // Mock response for initial message
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
            toolCallId: "pin_call_2",
            toolName: "pin",
            input: {
              path: { "@link": cellPath },
              name: cellName,
            },
          },
        ],
        id: "mock-pin-merge-response",
      },
    );

    // Mock response after pin (captures system prompt)
    addMockResponse(
      (req) => {
        capturedSystemPrompt = req.system || "";
        const toolMsg = req.messages.find(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((c) =>
              c.type === "tool-call" && c.toolName === "pin"
            ),
        );
        return !!toolMsg;
      },
      {
        role: "assistant",
        content: "I can see both context and pinned cells now.",
        id: "mock-merge-final-response",
      },
    );

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asStream: true },
        pending: { type: "boolean" },
        pinnedCells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              name: { type: "string" },
            },
          },
        },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        // Create context cell inside pattern
        const contextCell = Cell.of({ value: "context data" });
        const dialog = llmDialog({
          messages,
          context: {
            contextCell: contextCell,
          },
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-merge-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Send message to trigger pin
    addMessage.send({
      role: "user",
      content: initialMessage,
    });

    // Wait for: user message, assistant tool call, tool result, final response
    await expect(waitForMessages(result, 4)).resolves.toBeUndefined();

    // Verify pinnedCells output contains both context cell and tool-pinned cell
    const pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells).toBeDefined();
    expect(Array.isArray(pinnedCells)).toBe(true);
    expect(pinnedCells?.length).toBe(2);
    // Context cell should be first
    expect(pinnedCells?.[0].name).toBe("contextCell");
    expect(pinnedCells?.[0].path).toContain("/of:");
    // Tool-pinned cell should be second
    expect(pinnedCells?.[1].name).toBe(cellName);
    expect(pinnedCells?.[1].path).toBe(cellPath);

    // Verify system prompt includes both context and pinned cells
    expect(capturedSystemPrompt).toContain("# Available Cells");
    expect(capturedSystemPrompt).toContain("contextCell");
    expect(capturedSystemPrompt).toContain("context data");
    // Note: Pinned cell won't appear in system prompt on first request,
    // only after it's been pinned and the next LLM request is made
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
