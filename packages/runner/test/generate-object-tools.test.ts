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
  enableMockMode,
} from "@commontools/llm/client";
import type { BuiltInLLMMessage } from "@commontools/api";
import type { JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Enable mock mode once for all tests
enableMockMode();

describe("generateObject with tools", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let generateObject: ReturnType<
    typeof createBuilder
  >["commontools"]["generateObject"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ recipe, generateObject } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
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

    const testRecipe = recipe<Record<string, never>>(
      "Generate Object with finalResult",
      () => {
        const result = generateObject({
          prompt: testPrompt,
          schema: resultSchema,
          tools: {}, // Empty tools object triggers the finalResult path
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-finalResult-test",
      testRecipe.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink
    await new Promise<void>((resolve) => {
      const cancel = result.key("pending").sink((pending: any) => {
        if (pending === false) {
          cancel();
          resolve();
        }
      });
    });

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

    const testRecipe = recipe<Record<string, never>>(
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
      testRecipe.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink
    await new Promise<void>((resolve) => {
      const cancel = result.key("pending").sink((pending: any) => {
        if (pending === false) {
          cancel();
          resolve();
        }
      });
    });

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

    const testRecipe = recipe<Record<string, never>>(
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
      testRecipe.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink
    await new Promise<void>((resolve) => {
      const cancel = result.key("pending").sink((pending: any) => {
        if (pending === false) {
          cancel();
          resolve();
        }
      });
    });

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

    const testRecipe = recipe<Record<string, never>>(
      "Generate Object with schema validation",
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
      "generateObject-schema-test",
      testRecipe.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink
    await new Promise<void>((resolve) => {
      const cancel = result.key("pending").sink((pending: any) => {
        if (pending === false) {
          cancel();
          resolve();
        }
      });
    });

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

    const testRecipe = recipe<Record<string, never>>(
      "Generate Object with nested schema",
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
      "generateObject-nested-schema-test",
      testRecipe.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink
    await new Promise<void>((resolve) => {
      const cancel = result.key("pending").sink((pending: any) => {
        if (pending === false) {
          cancel();
          resolve();
        }
      });
    });

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

    let capturedMessages: BuiltInLLMMessage[] | undefined;

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

    const testRecipe = recipe<Record<string, never>>(
      "Generate Object with messages",
      () => {
        const result = generateObject({
          messages,
          schema: resultSchema,
          tools: {},
        });
        return result;
      },
    );

    const resultCell = runtime.getCell(
      space,
      "generateObject-messages-test",
      testRecipe.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testRecipe, {}, resultCell);
    tx.commit();

    // Wait for pending to become false using sink
    await new Promise<void>((resolve) => {
      const cancel = result.key("pending").sink((pending: any) => {
        if (pending === false) {
          cancel();
          resolve();
        }
      });
    });

    await runtime.idle();

    // Verify that messages were used (should have 3 messages from our input)
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages?.[0].content).toBe("First message");
    expect(capturedMessages?.[2].content).toBe(
      `Second message ${uniqueMarker}`,
    );
  });
});
