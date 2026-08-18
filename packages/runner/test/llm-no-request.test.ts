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
 *
 * A prompt can also become empty after having been set, which a pattern that
 * gates its prompt on an input does every time that input is cleared. Two
 * further tests cover that transition. Entering the no-request state has to
 * abandon a request already in flight, so a response that lands afterwards
 * writes nothing; and it has to forget the request it remembered, so the same
 * prompt coming back is sent again rather than suppressed as a duplicate.
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
  it("`generateText` leaves no trace of a request a cleared prompt abandoned", async () => {
    const original = LLMClient.prototype.sendRequest;
    let release: (() => void) | undefined;
    const arrived = Promise.withResolvers<void>();
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    LLMClient.prototype.sendRequest = async () => {
      arrived.resolve();
      await held;
      return { content: "a summary of cats" } as never;
    };
    try {
      const testPattern = builder.pattern<{ prompt: string }>(({ prompt }) =>
        builder.generateText({ prompt })
      );
      const promptCell = runtime.getCell<string>(
        space,
        "cleared-prompt-input",
        undefined,
        tx,
      );
      promptCell.set("summarize cats");
      const resultCell = runtime.getCell(
        space,
        "cleared-prompt",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { prompt: promptCell },
        resultCell,
      );
      tx.commit();
      tx = runtime.edit();

      // The request is out and parked inside the client; the response has not
      // been produced yet.
      await arrived.promise;

      const clear = runtime.edit();
      promptCell.withTx(clear).set("");
      clear.commit();
      await runtime.idle();

      release!();
      await runtime.settled();

      // `requestHash` is what tells an applied response from an abandoned one.
      // Reading `result` alone cannot: the builtin's action reads the cell it
      // writes, so a response applied after the prompt went empty re-triggers
      // the action, which clears `result` again and hides that anything
      // landed. Only the stamp is left behind, and a hash here means the
      // answer to a prompt that no longer exists was written to the cell.
      expect(result.key("requestHash").get()).toBeUndefined();
      expect(result.key("result").get()).toBeUndefined();
      expect(result.key("partial").get()).toBeUndefined();
      expect(result.key("pending").get()).toBe(false);
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateText` sends again when a cleared prompt comes back", async () => {
    const original = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = () => {
      calls++;
      return Promise.resolve({ content: "a summary of cats" } as never);
    };
    try {
      const testPattern = builder.pattern<{ prompt: string }>(({ prompt }) =>
        builder.generateText({ prompt })
      );
      const promptCell = runtime.getCell<string>(
        space,
        "restored-prompt-input",
        undefined,
        tx,
      );
      promptCell.set("summarize cats");
      const resultCell = runtime.getCell(
        space,
        "restored-prompt",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { prompt: promptCell },
        resultCell,
      );
      tx.commit();
      tx = runtime.edit();

      await waitForLlmSettled(runtime, result);
      expect(calls).toBe(1);
      expect(result.key("result").get()).toBe("a summary of cats");

      const clear = runtime.edit();
      promptCell.withTx(clear).set("");
      clear.commit();
      await runtime.settled();
      expect(result.key("result").get()).toBeUndefined();

      const restore = runtime.edit();
      promptCell.withTx(restore).set("summarize cats");
      restore.commit();
      await runtime.settled();

      // The same prompt is a new request, not a duplicate of one whose result
      // was thrown away.
      expect(calls).toBe(2);
      expect(result.key("result").get()).toBe("a summary of cats");
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateObject` sends again when a cleared prompt comes back", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };
    const original = LLMClient.prototype.generateObject;
    let calls = 0;
    LLMClient.prototype.generateObject = () => {
      calls++;
      return Promise.resolve({ object: { answer: "cats" } } as never);
    };
    try {
      const testPattern = builder.pattern<{ prompt: string }>(({ prompt }) =>
        builder.generateObject({ prompt, schema })
      );
      const promptCell = runtime.getCell<string>(
        space,
        "restored-object-prompt-input",
        undefined,
        tx,
      );
      promptCell.set("name an animal");
      const resultCell = runtime.getCell(
        space,
        "restored-object-prompt",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { prompt: promptCell },
        resultCell,
      );
      tx.commit();
      tx = runtime.edit();

      await waitForLlmSettled(runtime, result);
      expect(calls).toBe(1);
      expect(result.key("result").get()).toEqual({ answer: "cats" });

      const clear = runtime.edit();
      promptCell.withTx(clear).set("");
      clear.commit();
      await runtime.settled();
      expect(result.key("result").get()).toBeUndefined();

      const restore = runtime.edit();
      promptCell.withTx(restore).set("name an animal");
      restore.commit();
      await runtime.settled();

      expect(calls).toBe(2);
      expect(result.key("result").get()).toEqual({ answer: "cats" });
    } finally {
      LLMClient.prototype.generateObject = original;
    }
  });
});
