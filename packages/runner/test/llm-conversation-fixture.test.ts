/**
 * Tests demonstrating conversation fixtures for LLM testing.
 *
 * These tests use declarative JSON fixture files instead of inline
 * addMockResponse() calls, making multi-turn conversations easier
 * to read, write, and maintain.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  clearMockResponses,
  type ConversationFixture,
  loadConversationFixture,
  loadConversationFixtureFile,
} from "@commonfabric/llm/client";
import type {
  BuiltInLLMContentPart,
  BuiltInLLMMessage,
  BuiltInLLMTool,
  BuiltInLLMToolCallPart,
  Cell,
  JSONSchema,
  Stream,
} from "@commonfabric/api";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { join } from "@std/path";

const signer = await Identity.fromPassphrase("test operator fixtures");
const space = signer.did();

const FIXTURES_DIR = join(import.meta.dirname!, "fixtures");

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
    pending: { type: "boolean" },
    error: { type: "object", additionalProperties: true },
    messages: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  required: ["addMessage"],
} as const satisfies JSONSchema;

type DialogResult = {
  addMessage: Stream<BuiltInLLMMessage>;
  pending?: boolean;
  error?: unknown;
  messages?: BuiltInLLMMessage[];
};

type GenerateObjectResult = {
  pending?: boolean;
  error?: unknown;
  result?: {
    title: string;
    score: number;
  };
};

type WeatherToolInput = {
  location: string;
};

function isToolCallPart(
  part: BuiltInLLMContentPart | undefined,
): part is BuiltInLLMToolCallPart {
  return part?.type === "tool-call";
}

describe("conversation fixtures", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];
  let patternTool: ReturnType<
    typeof createBuilder
  >["commonfabric"]["patternTool"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let generateObject: ReturnType<
    typeof createBuilder
  >["commonfabric"]["generateObject"];
  let llmDialog: ReturnType<typeof createBuilder>["commonfabric"]["llmDialog"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, generateObject, llmDialog, Cell, patternTool } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("simple multi-turn conversation loaded from file", async () => {
    await loadConversationFixtureFile(
      join(FIXTURES_DIR, "simple-multi-turn.json"),
    );

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
      RESULT_SCHEMA,
    );

    const resultCell = runtime.getCell<DialogResult>(
      space,
      "fixture-simple-multi-turn",
      RESULT_SCHEMA,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Turn 1: send greeting
    addMessage.send({ role: "user", content: "Hello" });
    await waitForMessages(result, 2);

    // Verify turn 1
    const msgs1 = (await result.key("messages").pull())!;
    expect(msgs1[0].content).toBe("Hello");
    expect(msgs1[1].content).toBe("Hi there!");

    // Turn 2: send follow-up
    addMessage.send({ role: "user", content: "How are you?" });
    await waitForMessages(result, 4);

    // Verify turn 2
    const msgs2 = (await result.key("messages").pull())!;
    expect(msgs2[2].content).toBe("How are you?");
    expect(msgs2[3].content).toBe("I'm doing well, thanks!");
  });

  it("multi-turn conversation with tool calls loaded from file", async () => {
    await loadConversationFixtureFile(
      join(FIXTURES_DIR, "multi-turn-dialog.json"),
    );

    const getWeatherTool = pattern(
      ({ location: _location }: WeatherToolInput) => {
        return "Sunny, 72°F";
      },
      {
        description: "Get current weather for a location",
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
      RESULT_SCHEMA,
    );

    const resultCell = runtime.getCell<DialogResult>(
      space,
      "fixture-multi-turn-tools",
      RESULT_SCHEMA,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    // Turn 1: greeting
    addMessage.send({ role: "user", content: "Hello" });
    await waitForMessages(result, 2);

    expect((await result.key("messages").pull())![1].content).toBe(
      "Hi there! How can I help you today?",
    );

    // Turn 2: ask about weather (triggers tool call chain)
    addMessage.send({
      role: "user",
      content: "What's the weather in San Francisco?",
    });
    // user msg + assistant tool-call + tool result + assistant final = 4 new msgs
    await waitForMessages(result, 6);

    const msgs = (await result.key("messages").pull())!;
    // Verify tool call was made
    const toolCallMsg = msgs[3];
    expect(toolCallMsg.role).toBe("assistant");
    const toolCallContent = toolCallMsg.content;
    expect(Array.isArray(toolCallContent)).toBe(true);
    if (!Array.isArray(toolCallContent)) {
      throw new Error("Expected assistant message content parts");
    }
    const toolCallPart = toolCallContent[0];
    expect(isToolCallPart(toolCallPart)).toBe(true);
    if (!isToolCallPart(toolCallPart)) {
      throw new Error(
        "Expected first assistant content part to be a tool call",
      );
    }
    expect(toolCallPart.toolName).toBe("getWeather");

    // Verify final response
    const finalMsg = msgs[5];
    expect(finalMsg.role).toBe("assistant");
    expect(finalMsg.content).toBe(
      "The weather in San Francisco is sunny and 72°F. Anything else?",
    );
  });

  it("inline fixture without file", async () => {
    const fixture: ConversationFixture = {
      description: "Inline fixture for quick one-off tests",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            messagesContain: ["meaning of life"],
          },
          response: {
            role: "assistant",
            content: "The answer is 42.",
            id: "inline-1",
          },
        },
      ],
    };

    loadConversationFixture(fixture);

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
      RESULT_SCHEMA,
    );

    const resultCell = runtime.getCell<DialogResult>(
      space,
      "fixture-inline",
      RESULT_SCHEMA,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await result.key("addMessage").pull();

    addMessage.send({
      role: "user",
      content: "What is the meaning of life?",
    });
    await waitForMessages(result, 2);

    const msgs = (await result.key("messages").pull())!;
    expect(msgs[1].content).toBe("The answer is 42.");
  });

  it("fixture with generateObject responses", async () => {
    loadConversationFixture({
      responses: [
        {
          type: "generateObject",
          response: {
            object: { title: "Test Title", score: 95 },
            id: "gen-obj-1",
          },
        },
      ],
    });

    const testPattern = pattern(
      () => {
        return generateObject({
          prompt: "Generate a title",
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              score: { type: "number" },
            },
          },
        });
      },
    );

    const resultCell = runtime.getCell<GenerateObjectResult>(
      space,
      "fixture-generate-object",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForPending(result);
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toEqual({
      title: "Test Title",
      score: 95,
    });
  });
});

function waitForMessages(result: Cell<DialogResult>, expectedCount: number) {
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
    cancel = result.sink(({ pending, messages }) => {
      if (pending === false && messages?.length === expectedCount) {
        resolve();
      }
    });
  }).finally(() => {
    clearTimeout(timeout);
    cancel();
  });
}

function waitForPending(result: Cell<GenerateObjectResult>) {
  let cancel: () => void;
  let timeout: ReturnType<typeof setTimeout>;
  return new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for pending to become false"));
    }, 5000);
    cancel = result.asSchema({
      type: "object",
      properties: {
        pending: { type: "boolean" },
        error: true,
        result: true,
      },
      default: {},
    }).sink(({ pending, error, result: r } = {}) => {
      if (pending === false && (error !== undefined || r !== undefined)) {
        resolve();
      }
    });
  }).finally(() => {
    clearTimeout(timeout);
    cancel?.();
  });
}
