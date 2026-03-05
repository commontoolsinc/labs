/**
 * LLM pattern smoke tests.
 *
 * These exercise representative LLM usage patterns through the runtime,
 * verifying the full path from pattern → LLM client → mock response.
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
import type { BuiltInLLMMessage } from "@commontools/api";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

enableMockMode();

describe("LLM pattern smoke tests", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let generateText: ReturnType<
    typeof createBuilder
  >["commontools"]["generateText"];
  let generateObject: ReturnType<
    typeof createBuilder
  >["commontools"]["generateObject"];
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
    ({ pattern, generateText, generateObject } = commontools);
    dummyPattern = pattern(() => ({}), { type: "object" });
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("simple generateText with prompt and system", async () => {
    const prompt = "smoke-test-simple-generateText";
    const system = "You are a helpful assistant.";

    addMockResponse(
      (req) =>
        req.system === system &&
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        role: "assistant",
        content: "Hello from mock!",
        id: "smoke-1",
      },
    );

    const testPattern = pattern(() => {
      return generateText({ prompt, system });
    });

    const resultCell = runtime.getCell(
      space,
      "smoke-simple-generateText",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForPendingToBecomeFalse(result);
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe("Hello from mock!");
  });

  it("generateObject with typed schema returns structured object", async () => {
    const prompt = "smoke-test-generateObject-typed";
    const schema: JSONSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        score: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "score"],
    };

    addMockObjectResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        object: { title: "Test Item", score: 95, tags: ["fast", "reliable"] },
        id: "smoke-2",
      },
    );

    const testPattern = pattern(() => {
      return generateObject({ prompt, schema });
    });

    const resultCell = runtime.getCell(
      space,
      "smoke-generateObject-typed",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForPendingToBecomeFalse(result);
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    const obj = result.key("result").get();
    expect(obj).toEqual({
      title: "Test Item",
      score: 95,
      tags: ["fast", "reliable"],
    });
  });

  it("generateObject with tools and presentResult", async () => {
    const prompt = "smoke-test-generateObject-tools";
    const schema: JSONSchema = {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
    };

    // Step 1: LLM calls a user tool
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ) &&
        req.tools?.["lookup"] !== undefined &&
        req.tools?.["presentResult"] !== undefined,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_lookup_1",
            toolName: "lookup",
            input: {},
          },
        ],
        id: "smoke-tools-step1",
      },
    );

    // Step 2: After tool result, call presentResult
    addMockResponse(
      (req) =>
        req.messages.some((m: any) =>
          m.role === "tool" &&
          Array.isArray(m.content) &&
          m.content.some((c: any) =>
            c.type === "tool-result" && c.toolCallId === "call_lookup_1"
          )
        ),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_presentResult_1",
            toolName: "presentResult",
            input: { answer: "Found the answer via tool" },
          },
        ],
        id: "smoke-tools-step2",
      },
    );

    const testPattern = pattern(() => {
      return generateObject({
        prompt,
        schema,
        tools: {
          lookup: {
            description: "Look up information",
            pattern: dummyPattern,
          },
        },
      });
    });

    const resultCell = runtime.getCell(
      space,
      "smoke-generateObject-tools",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForPendingToBecomeFalse(result);
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toEqual({
      answer: "Found the answer via tool",
    });
  });

  it("generateText with context data appears in request", async () => {
    const prompt = "smoke-test-with-context";
    const contextData = "The user's name is Alice and they like cats.";

    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ) &&
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(contextData)
        ),
      {
        role: "assistant",
        content: "I see Alice likes cats!",
        id: "smoke-context",
      },
    );

    const testPattern = pattern(() => {
      const messages: BuiltInLLMMessage[] = [
        { role: "user", content: `Context: ${contextData}` },
        { role: "user", content: prompt },
      ];
      return generateText({ messages });
    });

    const resultCell = runtime.getCell(
      space,
      "smoke-generateText-context",
      testPattern.resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await waitForPendingToBecomeFalse(result);
    await runtime.idle();

    expect(result.key("pending").get()).toBe(false);
    expect(result.key("result").get()).toBe("I see Alice likes cats!");
  });
});

function waitForPendingToBecomeFalse(
  cell: Cell<unknown>,
  timeoutMs = 1000,
): Promise<void> {
  let cancel: () => void;
  let timeout: ReturnType<typeof setTimeout>;
  return new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for pending to become false"));
    }, timeoutMs);
    cancel = cell.asSchema({
      type: "object",
      properties: {
        pending: { type: "boolean" },
        error: true,
        result: true,
      },
      default: {},
    }).sink(({ pending, error, result } = {}) => {
      if (pending === false && (error !== undefined || result !== undefined)) {
        resolve();
      }
    });
  }).finally(() => {
    clearTimeout(timeout);
    cancel?.();
  });
}
