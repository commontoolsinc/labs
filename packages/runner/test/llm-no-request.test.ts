/**
 * LLM builtin no-request tests.
 *
 * A builtin that is handed nothing to send — `llm` with an empty message list,
 * `generateText`/`generateObject` with an empty prompt and no messages — must
 * not call the client. It settles the result cell instead: `pending` false,
 * `result` and `error` cleared. The smoke and outbox suites always supply a
 * prompt, so this branch had no coverage.
 *
 * Each test spies the client method the builtin would call and asserts it never
 * fires, then confirms the cell settled with no result. The wait resolves on the
 * `pending` the early return writes, the same signal a real response would clear.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  clearMockResponses,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
import { LLMClient } from "@commonfabric/llm";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("LLM builtin no-request paths", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let builder: ReturnType<typeof createTrustedBuilder>["commonfabric"];

  beforeEach(() => {
    enableMockMode();
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ commonfabric: builder } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    resetMockMode();
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("`llm` makes no request for an empty message list", async () => {
    const original = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = () => {
      calls++;
      return Promise.reject(new Error("should not be called"));
    };
    try {
      const testPattern = builder.pattern(() => builder.llm({ messages: [] }));
      const resultCell = runtime.getCell(
        space,
        "no-request-llm",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(calls).toBe(0);
      expect(settled.pending).toBe(false);
      expect(result.key("result").get()).toBeUndefined();
      expect(result.key("error").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateText` makes no request for an empty prompt", async () => {
    const original = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = () => {
      calls++;
      return Promise.reject(new Error("should not be called"));
    };
    try {
      const testPattern = builder.pattern(() =>
        builder.generateText({ prompt: "" })
      );
      const resultCell = runtime.getCell(
        space,
        "no-request-generateText",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(calls).toBe(0);
      expect(settled.pending).toBe(false);
      expect(result.key("result").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateObject` makes no request for an empty prompt", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };
    const original = LLMClient.prototype.generateObject;
    let calls = 0;
    LLMClient.prototype.generateObject = () => {
      calls++;
      return Promise.reject(new Error("should not be called"));
    };
    try {
      const testPattern = builder.pattern(() =>
        builder.generateObject({ prompt: "", schema })
      );
      const resultCell = runtime.getCell(
        space,
        "no-request-generateObject",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(calls).toBe(0);
      expect(settled.pending).toBe(false);
      expect(result.key("result").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.generateObject = original;
    }
  });
});
