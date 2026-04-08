import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
} from "@commonfabric/llm/client";
import { LLMClient } from "@commonfabric/llm";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("test generate-text outbox");
const space = signer.did();

enableMockMode();

describe("generateText outbox mechanism", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let generateText: ReturnType<
    typeof createBuilder
  >["commonfabric"]["generateText"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, generateText } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("enqueues generateText work behind the post-commit outbox", async () => {
    const prompt = "generate text outbox";
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes(prompt)
        ),
      {
        role: "assistant",
        content: "gated response",
        id: "mock-generate-text-outbox",
      },
    );

    const testPattern = pattern(() => {
      return generateText({ prompt });
    });

    const resultCell = runtime.getCell(
      space,
      "generateText-outbox-test",
      testPattern.resultSchema,
      tx,
    );

    const txPrototype = ExtendedStorageTransaction.prototype;
    const wrapperPrototype = TransactionWrapper.prototype;
    const originalTxEnqueue = txPrototype.enqueuePostCommitEffect;
    const originalWrapperEnqueue = wrapperPrototype.enqueuePostCommitEffect;
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const outboxEffects: Array<{ id: string; kind: string }> = [];
    const sendRequestCalls: number[] = [];

    txPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalTxEnqueue.apply(this, args as never);
    };
    wrapperPrototype.enqueuePostCommitEffect = function (...args) {
      outboxEffects.push(args[0] as { id: string; kind: string });
      return originalWrapperEnqueue.apply(this, args as never);
    };
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      sendRequestCalls.push(Date.now());
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      expect(sendRequestCalls).toEqual([]);

      await waitForPendingToBecomeFalse(result);
      await runtime.idle();

      expect(outboxEffects.length).toBeGreaterThan(0);
      expect(outboxEffects[0].kind).toBe("generateText-start");
      expect(sendRequestCalls.length).toBeGreaterThan(0);
      expect(result.key("result").get()).toBe("gated response");
    } finally {
      txPrototype.enqueuePostCommitEffect = originalTxEnqueue;
      wrapperPrototype.enqueuePostCommitEffect = originalWrapperEnqueue;
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });
});

function waitForPendingToBecomeFalse(result: any) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for pending to become false"));
    }, 5000);
    const cancel = result.sink((value: any) => {
      if (value?.pending === false) {
        clearTimeout(timeout);
        cancel();
        resolve();
      }
    });
  });
}
