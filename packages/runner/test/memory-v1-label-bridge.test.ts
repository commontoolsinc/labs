import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("memory-v1-label-bridge");
const space = signer.did();

describe("Memory v1 label bridge cleanup", () => {
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it("does not emit application/label+json facts when labels are supplied", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v1",
    });
    try {
      const provider = storageManager.open(space) as unknown as {
        send(
          batch: {
            uri: string;
            value: {
              value?: unknown;
              labels?: unknown;
            };
          }[],
        ): Promise<{ ok?: Record<PropertyKey, never> }>;
        workspace: {
          commit: (transaction: {
            facts: Array<{ the: string }>;
            claims: unknown[];
          }) => Promise<{ ok?: Record<PropertyKey, never> }>;
        };
      };

      const commitCalls: Array<{
        facts: Array<{ the: string }>;
        claims: unknown[];
      }> = [];
      const originalCommit = provider.workspace.commit;
      provider.workspace.commit = async (transaction) => {
        commitCalls.push(transaction);
        return { ok: {} };
      };

      const result = await provider.send([{
        uri: `of:memory-v1-label-bridge-${Date.now()}`,
        value: {
          value: { hello: "labels" },
          labels: { classification: ["confidential"] },
        },
      }]);

      provider.workspace.commit = originalCommit;

      expect(result).toEqual({ ok: {} });
      expect(commitCalls).toHaveLength(1);
      expect(commitCalls[0].facts.map((fact) => fact.the)).toEqual([
        "application/json",
      ]);
    } finally {
      await storageManager.close();
    }
  });
});
