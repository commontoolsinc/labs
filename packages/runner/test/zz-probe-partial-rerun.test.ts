// TEMPORARY PROBE — not for commit. Measures which commit re-runs the llm
// node when its own batched partial lands, and whether the request then
// settles once the held response is released.

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
import { waitForLlmSettled } from "./support/llm-result.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("llm partial probe");
const space = signer.did();

describe("probe: partial write re-runs the llm node", () => {
  it("traces the re-run and then waits for settled", async () => {
    enableMockMode();
    clearMockResponses();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.setTriggerTraceEnabled(true);
    const original = LLMClient.prototype.sendRequest;
    const response = Promise.withResolvers<LLMResponse>();
    let sends = 0;
    LLMClient.prototype.sendRequest = (_request, partial) => {
      sends++;
      partial?.("hel");
      return response.promise;
    };
    try {
      const tx = runtime.edit();
      const { commonfabric: builder } = createTrustedBuilder(runtime);
      const testPattern = builder.pattern(() =>
        builder.llm({ messages: [{ role: "user", content: "probe" }] })
      );
      const resultCell = runtime.getCell(
        space,
        "llm-partial-probe",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const streamed = Promise.withResolvers<LlmResultState>();
      const stop = result.sink((value: LlmResultState) => {
        if (value?.partial === "hel") streamed.resolve(value);
      });
      try {
        expect((await streamed.promise).pending).toBe(true);
        await clock.settle();
        console.log("[probe] sends after partial landed:", sends);
        for (const entry of runtime.scheduler.getTriggerTrace()) {
          const e = entry as unknown as {
            notificationType: string;
            matchedActionCount: number;
            change: {
              address: { id: string; path: readonly string[] };
              before: unknown;
              after: unknown;
            };
          };
          const keys = (v: unknown) =>
            v && typeof v === "object" ? Object.keys(v as object) : v;
          console.log(
            "[probe trace]",
            e.notificationType,
            "matched",
            e.matchedActionCount,
            "doc",
            e.change.address.id.slice(-12),
            "path",
            JSON.stringify(e.change.address.path),
            "before-keys",
            JSON.stringify(keys(e.change.before)),
            "after-keys",
            JSON.stringify(keys(e.change.after)),
          );
        }
        console.log("[probe] releasing response, awaiting settled ...");
        response.resolve({
          id: "probe",
          role: "assistant",
          content: "hello",
        });
        const settled = await waitForLlmSettled(runtime, result);
        console.log("[probe] settled:", JSON.stringify(settled));
      } finally {
        stop();
      }
    } finally {
      response.resolve({ id: "probe", role: "assistant", content: "hello" });
      LLMClient.prototype.sendRequest = original;
      resetMockMode();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
