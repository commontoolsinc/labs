import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
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

    // Get the addMessage handler
    const addMessage = await result.key("addMessage").pull();

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
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-tool-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

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
    expect(messages[3].content).toBe(finalResponse);
  });

  it("should support pinning cells via pin tool", async () => {
    const initialMessage = "Please pin this cell";
    const cellPath = "/of:test123";
    const cellName = "Test Cell";

    // Mock response that calls pin tool
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
            toolCallId: "pin_call_1",
            toolName: "pin",
            input: {
              path: { "@link": cellPath },
              name: cellName,
            },
          },
        ],
        id: "mock-pin-response",
      },
    );

    // Mock final response after pin
    addMockResponse(
      (req) => {
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
        content: "Cell has been pinned successfully.",
        id: "mock-pin-final-response",
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
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-pin-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Send message to trigger pin
    addMessage.send({
      role: "user",
      content: initialMessage,
    });

    // Wait for: user message, assistant tool call, tool result, final response
    await expect(waitForMessages(result, 4)).resolves.toBeUndefined();

    // Verify pinned cells
    const pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells).toBeDefined();
    expect(Array.isArray(pinnedCells)).toBe(true);
    expect(pinnedCells?.length).toBe(1);
    expect(pinnedCells?.[0].path).toBe(cellPath);
    expect(pinnedCells?.[0].name).toBe(cellName);
  });

  it("should support unpinning cells via unpin tool", async () => {
    const pinMessage = "Please pin this cell";
    const unpinMessage = "Please unpin that cell";
    const cellPath = "/of:test123";
    const cellName = "Test Cell";

    // Mock response that calls pin tool first
    addMockResponse(
      (req) => {
        const lastMsg = req.messages[req.messages.length - 1];
        return (
          typeof lastMsg.content === "string" &&
          lastMsg.content.includes(pinMessage)
        );
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "pin_call_unpin_test",
            toolName: "pin",
            input: {
              path: { "@link": cellPath },
              name: cellName,
            },
          },
        ],
        id: "mock-pin-for-unpin-response",
      },
    );

    // Mock response after pin
    addMockResponse(
      (req) => {
        const toolMsg = req.messages.find(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((c) =>
              c.type === "tool-call" && c.toolName === "pin" &&
              c.toolCallId === "pin_call_unpin_test"
            ),
        );
        return !!toolMsg;
      },
      {
        role: "assistant",
        content: "Cell has been pinned.",
        id: "mock-pin-for-unpin-final",
      },
    );

    // Mock response that calls unpin tool
    addMockResponse(
      (req) => {
        const lastMsg = req.messages[req.messages.length - 1];
        return (
          typeof lastMsg.content === "string" &&
          lastMsg.content.includes(unpinMessage)
        );
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "unpin_call_1",
            toolName: "unpin",
            input: {
              path: { "@link": cellPath },
            },
          },
        ],
        id: "mock-unpin-response",
      },
    );

    // Mock final response after unpin
    addMockResponse(
      (req) => {
        const toolMsg = req.messages.find(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((c) =>
              c.type === "tool-call" && c.toolName === "unpin"
            ),
        );
        return !!toolMsg;
      },
      {
        role: "assistant",
        content: "Cell has been unpinned.",
        id: "mock-unpin-final-response",
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
          pinnedCells: dialog.pinnedCells,
          messages,
        };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-unpin-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // First pin a cell
    addMessage.send({
      role: "user",
      content: pinMessage,
    });

    // Wait for pin to complete (4 messages: user, assistant tool call, tool result, final)
    await expect(waitForMessages(result, 4)).resolves.toBeUndefined();

    // Verify cell was pinned
    let pinnedCells = await result.key("pinnedCells").pull();
    expect(pinnedCells?.length).toBe(1);
    expect(pinnedCells?.[0].path).toBe(cellPath);

    // Now unpin it
    addMessage.send({
      role: "user",
      content: unpinMessage,
    });

    // Wait for unpin to complete (8 messages total: previous 4 + new 4)
    await expect(waitForMessages(result, 8)).resolves.toBeUndefined();

    // Verify pinned cells is now empty
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

    const testRecipe = recipe(
      false,
      resultSchema,
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        // Create context cell inside recipe
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
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-context-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
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

    const testRecipe = recipe(
      false,
      resultSchema,
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        // Create context cell inside recipe
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
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-merge-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
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

  it("should support async tool calls that resolve after a delay", async () => {
    const initialMessage = "What is the weather in San Francisco?";
    const toolCallId = "call_async_123";
    const toolResultValue = "Sunny, 25C";
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
            toolName: "getWeatherAsync",
            input: { location: "San Francisco" },
          },
        ],
        id: "mock-async-tool-call-response",
      },
    );

    // Mock final response (After Tool Result)
    addMockResponse(
      (req) => {
        const toolMsg = req.messages.find(
          (m) =>
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.some((c) =>
              c.type === "tool-call" && c.toolName === "getWeatherAsync"
            ),
        );
        return !!toolMsg;
      },
      {
        role: "assistant",
        content: finalResponse,
        id: "mock-async-final-response",
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

    // Create a "signal" cell that the tool pattern returns immediately,
    // but which only gets populated after a delay. This simulates async
    // tools like fetchData where the HTTP response arrives later.
    const signalCell = runtime.getCell(
      space,
      "async-tool-signal",
      { type: "string" } as const,
      tx,
    );

    const getWeatherAsyncTool = recipe(
      {
        description: "Get the weather for a location (async)",
        type: "object",
        properties: {
          location: { type: "string" },
        },
        required: ["location"],
      } as const satisfies JSONSchema,
      { type: "string" },
      ({ location: _location }: any) => {
        toolCalled = true;
        // Return the signal cell which starts undefined, simulating
        // an async operation like fetchData
        return signalCell;
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
            getWeatherAsync: patternTool(
              getWeatherAsyncTool,
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
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-async-tool-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Send the user message (triggers LLM request → tool call)
    addMessage.send({
      role: "user",
      content: initialMessage,
    });

    // After a short delay, write the async tool result.
    // This simulates an HTTP response arriving after the tool pattern
    // has already returned its (initially undefined) result cell.
    setTimeout(() => {
      runtime.editWithRetry((writeTx) => {
        signalCell.withTx(writeTx).set(toolResultValue);
      });
    }, 500);

    // Wait with a longer timeout to account for the async delay
    await expect(
      waitForMessages(result, 4, 10000),
    ).resolves.toBeUndefined();

    expect(toolCalled).toBe(true);

    // Verify the conversation completed successfully
    const messages = (await result.key("messages").pull())!;
    expect(messages).toHaveLength(4);
    expect(messages[1].role).toBe("assistant");
    expect(messages[3].role).toBe("assistant");
    expect(messages[3].content).toBe(finalResponse);
  });
});

function waitForMessages(result: any, expectedCount: number, timeoutMs = 5000) {
  let cancel: () => void;
  let timeout: ReturnType<typeof setTimeout>;
  return new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `Timeout waiting for ${expectedCount} messages and pending=false`,
        ),
      );
    }, timeoutMs);
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
