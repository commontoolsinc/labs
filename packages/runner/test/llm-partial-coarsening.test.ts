/**
 * Channel 6 (builtin progress) coarsening: the LLM partial-streaming batch
 * window is one second (>=1s), so an untrusted pattern cannot watch the partial
 * cell for a sub-second token-arrival cadence. See
 * docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { LLMClient, type LLMResponse } from "@commonfabric/llm";
import {
  clearMockResponses,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PARTIAL_BATCH_MS } from "../src/builtins/llm.ts";
import { Runtime } from "../src/runtime.ts";
import type { LlmResultState } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("llm partial batch");
const space = signer.did();

describe("LLM partial batch coarsening (channel 6)", () => {
  it("batches partial writes at >=1s so the cadence is <=1 Hz", () => {
    expect(PARTIAL_BATCH_MS).toBeGreaterThanOrEqual(1000);
  });

  it("writes a streamed partial to the cell once one batch window has elapsed", async () => {
    // The request streams one partial and stays open for the rest of the
    // test, so the only way the text reaches the cell is the batch window.
    // The claim is the window: the clock advances through it once the loop
    // is idle, and the wait is on the cell.
    enableMockMode();
    clearMockResponses();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const original = LLMClient.prototype.sendRequest;
    const response = Promise.withResolvers<LLMResponse>();
    LLMClient.prototype.sendRequest = (_request, partial) => {
      partial?.("hel");
      return response.promise;
    };
    try {
      const tx = runtime.edit();
      const { commonfabric: builder } = createTrustedBuilder(runtime);
      const testPattern = builder.pattern(() =>
        builder.llm({ messages: [{ role: "user", content: "stream" }] })
      );
      const resultCell = runtime.getCell(
        space,
        "llm-partial-batch",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      // A plain sink, not a quiescent read: the request is open, and the
      // scheduler is not idle while it is.
      const started = Date.now();
      const streamed = Promise.withResolvers<LlmResultState>();
      const stop = result.sink((value: LlmResultState) => {
        if (value?.partial === "hel") streamed.resolve(value);
      });
      try {
        expect((await streamed.promise).pending).toBe(true);
      } finally {
        stop();
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(PARTIAL_BATCH_MS);
    } finally {
      response.resolve({
        id: "partial-batch",
        role: "assistant",
        content: "hello",
      });
      LLMClient.prototype.sendRequest = original;
      resetMockMode();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("writes no partial under the serving posture with server execution on", async () => {
    // A served run's partials never become commits: the batch window
    // elapses, and the window's write is skipped before a transaction is
    // minted. The request stays open for the rest of the test.
    enableMockMode();
    clearMockResponses();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    const original = LLMClient.prototype.sendRequest;
    const response = Promise.withResolvers<LLMResponse>();
    let streamed = 0;
    LLMClient.prototype.sendRequest = (_request, partial) => {
      streamed++;
      partial?.("hel");
      return response.promise;
    };
    try {
      const tx = runtime.edit();
      const { commonfabric: builder } = createTrustedBuilder(runtime);
      const testPattern = builder.pattern(() =>
        builder.llm({ messages: [{ role: "user", content: "served" }] })
      );
      const resultCell = runtime.getCell(
        space,
        "llm-partial-served",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();
      await clock.settle();
      expect(streamed).toBe(1);

      await clock.tick(PARTIAL_BATCH_MS);
      await clock.settle();
      expect((result.get() as LlmResultState)?.partial).toBeUndefined();
    } finally {
      response.resolve({
        id: "partial-served",
        role: "assistant",
        content: "served",
      });
      LLMClient.prototype.sendRequest = original;
      resetMockMode();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
