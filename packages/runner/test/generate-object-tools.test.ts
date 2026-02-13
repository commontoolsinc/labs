/**
 * Integration tests for generateObject with tool calling support.
 *
 * These tests verify that the generateObject builtin correctly:
 * 1. Adds the finalResult tool to the tool catalog when tools are provided
 * 2. Handles multi-step tool calling (user tools + finalResult)
 * 3. Maintains backward compatibility when no tools are provided
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commontools/llm/client";
import type { BuiltInLLMMessage, BuiltInLLMTool } from "@commontools/api";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Enable mock mode once for all tests
enableMockMode();

describe("generateObject with tools", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];
  let str: ReturnType<typeof createBuilder>["commontools"]["str"];
  let Cell: ReturnType<typeof createBuilder>["commontools"]["Cell"];
  let patternTool: ReturnType<
    typeof createBuilder
  >["commontools"]["patternTool"];
  let generateObject: ReturnType<
    typeof createBuilder
  >["commontools"]["generateObject"];
  let dummyPattern: any;

  beforeEach(() => {
    clearMockResponses(); // Clear mocks from previous tests
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ pattern, generateObject, handler, Cell, patternTool, str } = commontools);
    dummyPattern = pattern("Dummy Tool", () => ({}));
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should add finalResult tool to catalog and extract structured result", async () => {
    // Define a simple schema for the expected result
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    };

    const testPrompt = "test-finalResult-person-with-name-and-age";

    // Mock the LLM response to include a finalResult tool call
    addMockResponse(
      (req) => {
        // Match on unique prompt and verify finalResult tool is present
        return req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.tools?.["finalResult"] !== undefined;
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_finalResult_1",
            toolName: "finalResult",
            input: {
              name: "Alice",
              age: 30,
            },
          },
        ],
        id: "mock-finalResult-response",
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object with finalResult",
      () => {
        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {
            dummy: {
              description: "A dummy tool to force tool-calling path",
              pattern: dummyPattern,
            },
          },
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-finalResult-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toEqual({
      name: "Alice",
      age: 30,
    });
  });

  it("should work without tools parameter (backward compatibility)", async () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["title"],
    };

    const testPrompt = "test-no-tools-document-with-title-and-description";

    // For the no-tools path, we need to mock generateObject directly
    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.schema.type === "object",
      {
        object: {
          title: "Test Title",
          description: "Test Description",
        },
        id: "mock-generateObject-direct",
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object without tools",
      () => {
        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          // No tools parameter - should use direct generateObject path
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-no-tools-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toEqual({
      title: "Test Title",
      description: "Test Description",
    });
  });

  it("should handle errors when finalResult is never called", async () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
      },
      required: ["value"],
    };

    const testPrompt = "test-error-no-finalResult-number";

    // Mock response that never calls finalResult
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.tools?.["finalResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I refuse to call finalResult",
          },
        ],
        id: "mock-no-finalResult",
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object with error",
      () => {
        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {},
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-error-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    // Should handle the error gracefully
    expect(result.key("pending").get()).toBe(false);
    // Result should be undefined after error
    expect(result.key("result").get()).toBeUndefined();
  });

  it("should pass schema to finalResult tool inputSchema", async () => {
    let capturedToolSchema: JSONSchema | undefined;

    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
        },
        total: { type: "number" },
      },
      required: ["items", "total"],
    };

    const testPrompt = "test-schema-validation-items-and-count";

    addMockResponse(
      (req) => {
        // Match on unique prompt
        const matches =
          req.messages.some((m) =>
            typeof m.content === "string" && m.content.includes(testPrompt)
          ) && req.tools?.["finalResult"] !== undefined;

        // Capture the schema from the finalResult tool
        if (matches && req.tools?.["finalResult"]) {
          capturedToolSchema = req.tools["finalResult"].inputSchema;
        }
        return matches;
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_finalResult_schema",
            toolName: "finalResult",
            input: {
              items: ["a", "b", "c"],
              total: 3,
            },
          },
        ],
        id: "mock-schema-test",
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object with schema validation",
      () => {
        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {
            dummy: {
              description: "A dummy tool to force tool-calling path",
              pattern: dummyPattern,
            },
          },
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-schema-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    // Verify the schema was passed correctly to finalResult tool
    expect(capturedToolSchema).toEqual(resultSchema);
  });

  it("should handle complex nested schemas", async () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
          required: ["name"],
        },
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["user"],
    };

    const testPrompt = "test-nested-schema-user-with-tags";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.tools?.["finalResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_nested_schema",
            toolName: "finalResult",
            input: {
              user: {
                name: "Bob",
                email: "bob@example.com",
              },
              tags: ["developer", "tester"],
            },
          },
        ],
        id: "mock-nested-schema",
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object with nested schema",
      () => {
        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {
            dummy: {
              description: "A dummy tool to force tool-calling path",
              pattern: dummyPattern,
            },
          },
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-nested-schema-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toEqual({
      user: {
        name: "Bob",
        email: "bob@example.com",
      },
      tags: ["developer", "tester"],
    });
  });

  it("should use messages parameter instead of prompt when provided", async () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        response: { type: "string" },
      },
      required: ["response"],
    };

    const uniqueMarker = "test-messages-param-unique-marker";
    const messages: BuiltInLLMMessage[] = [
      { role: "user", content: "First message" },
      { role: "assistant", content: "First response" },
      { role: "user", content: `Second message ${uniqueMarker}` },
    ];

    let capturedMessages: readonly BuiltInLLMMessage[] | undefined;

    addMockResponse(
      (req) => {
        // Match on unique marker in messages
        const matches =
          req.messages.some((m) =>
            typeof m.content === "string" && m.content.includes(uniqueMarker)
          ) && req.tools?.["finalResult"] !== undefined;

        if (matches) {
          capturedMessages = req.messages;
        }
        return matches;
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_messages_test",
            toolName: "finalResult",
            input: {
              response: "Final response",
            },
          },
        ],
        id: "mock-messages-test",
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object with messages",
      () => {
        const result = generateObject({
          messages,
          schema: resultSchema,
          tools: {
            dummy: {
              description: "A dummy tool to force tool-calling path",
              pattern: dummyPattern,
            },
          },
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-messages-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    // Verify that messages were used (should have 3 messages from our input)
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages?.[0].content).toBe("First message");
    expect(capturedMessages?.[2].content).toBe(
      `Second message ${uniqueMarker}`,
    );
  });

  it("should handle multiple tool calls with handler-based tools before finalResult", async () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        count: { type: "number" },
      },
      required: ["summary", "count"],
    };

    const testPrompt = "test-multi-tool-handler-based";

    // Track tool calls
    const toolCallLog: string[] = [];

    // Mock the multi-step interaction
    // Step 1: Call getData
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) &&
        req.tools?.["getData"] !== undefined &&
        req.tools?.["countItems"] !== undefined &&
        req.tools?.["finalResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_getData_1",
            toolName: "getData",
            input: {},
          },
        ],
        id: "mock-multi-tool-step1",
      },
    );

    // Step 2: After getData result, call countItems
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_getData_1"
          )
        ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_countItems_1",
            toolName: "countItems",
            input: {},
          },
        ],
        id: "mock-multi-tool-step2",
      },
    );

    // Step 3: After countItems result, call finalResult
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_countItems_1"
          )
        ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_finalResult_1",
            toolName: "finalResult",
            input: {
              summary: "Found 3 items",
              count: 3,
            },
          },
        ],
        id: "mock-multi-tool-step3",
      },
    );

    // Create handler-based tools similar to listRecent in chatbot.tsx
    const getDataHandler = handler(
      {
        type: "object",
        properties: {
          result: { type: "object", asCell: true },
        },
        required: ["result"],
      },
      {
        type: "object",
        properties: {
          dataSource: { type: "object", asCell: true },
        },
        required: ["dataSource"],
      },
      (args: { result: any }, _state: { dataSource: any }) => {
        toolCallLog.push("getData called");
        args.result.set({ items: ["item1", "item2", "item3"] });
      },
    );

    const countHandler = handler(
      {
        type: "object",
        properties: {
          result: { type: "object", asCell: true },
        },
        required: ["result"],
      },
      {
        type: "object",
        properties: {
          counter: { type: "object", asCell: true },
        },
        required: ["counter"],
      },
      (args: { result: any }, _state: { counter: any }) => {
        toolCallLog.push("countItems called");
        args.result.set({ total: 3 });
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object with multiple handler tools",
      () => {
        const dataSource = Cell.of({ ready: true });
        const counter = Cell.of({ value: 0 });

        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {
            getData: {
              description: "Get data from the source",
              handler: getDataHandler({ dataSource }),
            },
            countItems: {
              description: "Count the items",
              handler: countHandler({ counter }),
            },
          },
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-multi-handler-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    // Verify all tools were called in sequence
    expect(toolCallLog).toEqual(["getData called", "countItems called"]);
    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toEqual({
      summary: "Found 3 items",
      count: 3,
    });
  });

  it("should handle multiple tool calls with patternTool-based tools before finalResult", async () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        itemCount: { type: "number" },
      },
      required: ["name", "itemCount"],
    };

    const testPrompt = "test-multi-tool-pattern-based";

    // Mock the multi-step interaction
    // Step 1: Call listItems
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) &&
        req.tools?.["listItems"] !== undefined &&
        req.tools?.["countItems"] !== undefined &&
        req.tools?.["finalResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_listItems_1",
            toolName: "listItems",
            input: {},
          },
        ],
        id: "mock-pattern-tool-step1",
      },
    );

    // Step 2: After listItems result, call countItems
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_listItems_1"
          )
        ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_countItems_1",
            toolName: "countItems",
            input: {},
          },
        ],
        id: "mock-pattern-tool-step2",
      },
    );

    // Step 3: After countItems result, call finalResult
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_countItems_1"
          )
        ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_finalResult_1",
            toolName: "finalResult",
            input: {
              name: "Item Collection",
              itemCount: 3,
            },
          },
        ],
        id: "mock-pattern-tool-step3",
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object with multiple pattern tools",
      () => {
        const itemsData = Cell.of([
          { label: "Item A", value: "a" },
          { label: "Item B", value: "b" },
          { label: "Item C", value: "c" },
        ]);

        // Create a pattern tool similar to listMentionable in chatbot.tsx
        const listItems = pattern<
          { items: Array<{ label: string; value: string }> },
          { result: Array<{ label: string; value: string }> }
        >(
          "List Items",
          ({ items }) => {
            const result = items.map((item) => ({
              label: item.label,
              value: item.value,
            }));
            return { result };
          },
        );

        const countItems = pattern<
          { items: Array<any> },
          { count: number }
        >(
          "Count Items",
          ({ items }) => {
            const count = items.length;
            return { count };
          },
        );

        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {
            listItems: patternTool(listItems, {
              items: itemsData,
            }) as unknown as BuiltInLLMTool,
            countItems: patternTool(countItems, {
              items: itemsData,
            }) as unknown as BuiltInLLMTool,
          },
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-multi-pattern-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("error").get()).toBeUndefined();
    expect(result.key("result").get()).toEqual({
      name: "Item Collection",
      itemCount: 3,
    });
  });

  it("should handle mixed handler and patternTool-based tools", async () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        analysis: { type: "string" },
        total: { type: "number" },
      },
      required: ["analysis", "total"],
    };

    const testPrompt = "test-mixed-tools";

    // Mock the multi-step interaction
    // Step 1: Call fetchData (handler)
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) &&
        req.tools?.["fetchData"] !== undefined &&
        req.tools?.["analyzeData"] !== undefined &&
        req.tools?.["finalResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_fetchData_1",
            toolName: "fetchData",
            input: {},
          },
        ],
        id: "mock-mixed-step1",
      },
    );

    // Step 2: Call analyzeData (pattern)
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_fetchData_1"
          )
        ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_analyzeData_1",
            toolName: "analyzeData",
            input: {},
          },
        ],
        id: "mock-mixed-step2",
      },
    );

    // Step 3: Call finalResult
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_analyzeData_1"
          )
        ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_finalResult_1",
            toolName: "finalResult",
            input: {
              analysis: "Data contains 5 numeric values",
              total: 5,
            },
          },
        ],
        id: "mock-mixed-step3",
      },
    );

    // Handler-based tool
    const fetchData = handler(
      {
        type: "object",
        properties: {
          result: { type: "object", asCell: true },
        },
        required: ["result"],
      },
      {
        type: "object",
        properties: {},
      },
      (args: { result: any }) => {
        args.result.set({ data: [1, 2, 3, 4, 5] });
      },
    );

    // Pattern-based tool
    const analyzeData = pattern({
      type: "object",
      properties: { data: { type: "array", items: { type: "number" } } },
      required: ["data"],
    }, {
      type: "object",
      properties: { analysis: { type: "string" } },
      required: ["analysis"],
    }, ({ data }) => {
      const analysis = str`Analyzed ${data.length} items`;
      return { analysis };
    });

    const testPattern = pattern<Record<string, never>>(
      () => {
        const dataCell = Cell.of([1, 2, 3, 4, 5]);

        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {
            fetchData: {
              description: "Fetch data from source",
              handler: fetchData({}),
            },
            analyzeData: patternTool(analyzeData, {
              data: dataCell,
            }) as unknown as BuiltInLLMTool,
          },
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-mixed-tools-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("error").get()).toBeUndefined();
    expect(result.key("result").get()).toEqual({
      analysis: "Data contains 5 numeric values",
      total: 5,
    });
  });

  it("should handle parallel tool calls before finalResult", async () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        combined: { type: "string" },
      },
      required: ["combined"],
    };

    const testPrompt = "test-parallel-tools";

    const toolCallLog: string[] = [];

    // Mock parallel tool calls followed by finalResult
    // Step 1: Call both toolA and toolB in parallel
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) &&
        req.tools?.["toolA"] !== undefined &&
        req.tools?.["toolB"] !== undefined &&
        req.tools?.["finalResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_toolA_1",
            toolName: "toolA",
            input: {},
          },
          {
            type: "tool-call",
            toolCallId: "call_toolB_1",
            toolName: "toolB",
            input: {},
          },
        ],
        id: "mock-parallel-step1",
      },
    );

    // Step 2: After both results, call finalResult
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_toolA_1"
          )
        ) &&
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_toolB_1"
          )
        ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_finalResult_1",
            toolName: "finalResult",
            input: {
              combined: "A and B",
            },
          },
        ],
        id: "mock-parallel-step2",
      },
    );

    const toolA = handler(
      {
        type: "object",
        properties: {
          result: { type: "object", asCell: true },
        },
        required: ["result"],
      },
      {
        type: "object",
        properties: {},
      },
      (args: { result: any }) => {
        toolCallLog.push("toolA");
        args.result.set({ value: "A" });
      },
    );

    const toolB = handler(
      {
        type: "object",
        properties: {
          result: { type: "object", asCell: true },
        },
        required: ["result"],
      },
      {
        type: "object",
        properties: {},
      },
      (args: { result: any }) => {
        toolCallLog.push("toolB");
        args.result.set({ value: "B" });
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object with parallel tools",
      () => {
        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {
            toolA: {
              description: "Get value A",
              handler: toolA({}),
            },
            toolB: {
              description: "Get value B",
              handler: toolB({}),
            },
          },
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-parallel-tools-test",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink with timeout
    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();

    await runtime.idle();

    // Both tools should have been called
    expect(toolCallLog).toContain("toolA");
    expect(toolCallLog).toContain("toolB");
    expect(result.key("pending").get()).toBe(false);
    expect(result.key("error").get()).toBeUndefined();
    expect(result.key("result").get()).toEqual({
      combined: "A and B",
    });
  });

  it("should return a cell when LLM returns a link object", async () => {
    const finalResultCell = runtime.getCell(
      space,
      "generateObject-link-test-result",
      undefined,
      tx,
    );

    const finalResultValue = { test: "success" };
    finalResultCell.set(finalResultValue);
    const linkedCellId = finalResultCell.getAsNormalizedFullLink().id;

    const resultSchema: JSONSchema = {
      type: "object",
      properties: {
        link: { type: "object", asCell: true },
      },
    };

    const testPrompt = "test-link-response";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(testPrompt)
        ) && req.tools?.["finalResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_finalResult_link",
            toolName: "finalResult",
            input: {
              link: {
                "@link": `/${linkedCellId}`,
              },
            },
          },
        ],
        id: "mock-link-response",
      },
    );

    const testPattern = pattern<Record<string, never>>(
      "Generate Object with link response",
      () => {
        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {
            dummy: {
              description: "A dummy tool",
              pattern: dummyPattern,
            },
          },
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-link-test",
      {
        type: "object",
        properties: {
          pending: { type: "boolean" },
          error: true,
          result: true,
        },
      },
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expect(waitForPendingToBecomeFalse(result)).resolves.toBeUndefined();
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);

    // The result should be a cell with the linked ID
    const value = result.key("result").key("link").get();
    const link = parseLink(value);

    expect(value).toEqual(finalResultValue);
    expect(link?.id).toBe(linkedCellId);
  });
});

function waitForPendingToBecomeFalse(result: Cell<any>) {
  let cancel: () => void;
  let timeout: ReturnType<typeof setTimeout>;
  return new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for pending to become false"));
    }, 1000);
    cancel = result.asSchema({
      type: "object",
      properties: {
        pending: { type: "boolean" },
        error: true,
        result: true,
      },
    }).sink(({ pending, error, result } = {}) => {
      if (pending === false && (error !== undefined || result !== undefined)) {
        resolve();
      }
    });
  }).finally(() => {
    clearTimeout(timeout);
    cancel();
  });
}
