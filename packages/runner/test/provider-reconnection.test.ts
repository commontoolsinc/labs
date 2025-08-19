import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { Provider } from "../src/storage/cache.ts";
import * as Memory from "@commontools/memory";
import * as Consumer from "@commontools/memory/consumer";
import type { SchemaContext, URI } from "@commontools/memory/interface";
import * as Subscription from "../src/storage/subscription.ts";
import { BaseMemoryAddress } from "@commontools/runner/traverse";

const signer = await Identity.fromPassphrase("test operator");

describe("Provider Reconnection", () => {
  let provider: Provider;
  let memoryDb: Memory.Memory.Memory;
  let sessionProvider: Memory.Provider.Provider<Memory.Protocol>;
  let consumer: Consumer.MemoryConsumer<Consumer.MemorySpace>;

  beforeEach(() => {
    memoryDb = Memory.Memory.emulate({ serviceDid: signer.did() });
    sessionProvider = Memory.Provider.create(memoryDb);
    consumer = Consumer.open({
      as: signer,
      session: sessionProvider.session(),
    });
    provider = Provider.open({
      space: signer.did(),
      session: consumer,
      subscription: Subscription.create(),
    });
  });

  afterEach(async () => {
    await provider?.destroy();
    await sessionProvider?.close();
    await memoryDb.close();
  });

  describe("reestablishSubscriptions", () => {
    it("should re-issue pull for all tracked subscriptions", async () => {
      const schema1: SchemaContext = {
        schema: { type: "object", properties: { name: { type: "string" } } },
        rootSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      };
      const selector1 = { path: [], schemaContext: schema1 };

      const schema2: SchemaContext = {
        schema: { type: "object", properties: { age: { type: "number" } } },
        rootSchema: { type: "object", properties: { age: { type: "number" } } },
      };
      const selector2 = { path: [], schemaContext: schema2 };

      const uri1: URI = "of:user-1";
      const uri2: URI = "of:user-2";

      // Initial sync to establish subscriptions
      await provider.sync(uri1, selector1);
      await provider.sync(uri2, selector2);

      // Override the workspace's pull function to track calls
      const pullCalls: Array<
        [BaseMemoryAddress, Memory.SchemaPathSelector?][]
      > = [];
      const originalPull = provider.workspace.pull.bind(provider.workspace);
      provider.workspace.pull = function (
        entries: [BaseMemoryAddress, Memory.SchemaPathSelector?][],
      ) {
        pullCalls.push(entries);
        return originalPull(entries);
      };

      // Call reestablishSubscriptions to test the logic
      await provider.reestablishSubscriptions();

      // Should have made one pull call
      expect(pullCalls.length).toBe(1);

      const pullEntries = pullCalls[0];
      // Should include space commit object + 2 subscriptions
      expect(pullEntries.length).toBe(3);

      // First entry should be space commit object
      expect(pullEntries[0][0]).toEqual({
        id: signer.did(),
        type: "application/commit+json",
      });
      expect(pullEntries[0][1]).toBeUndefined();

      // Check user-1 subscription
      const user1Entry = pullEntries.find(
        ([addr]) => addr.id === "of:user-1" && addr.type === "application/json",
      );
      expect(user1Entry).toBeDefined();
      expect(user1Entry![1]).toEqual(selector1);

      // Check user-2 subscription
      const user2Entry = pullEntries.find(
        ([addr]) => addr.id === "of:user-2" && addr.type === "application/json",
      );
      expect(user2Entry).toBeDefined();
      expect(user2Entry![1]).toEqual(selector2);
    });

    it("should handle pull failures gracefully", async () => {
      const schema: SchemaContext = {
        schema: { type: "object" },
        rootSchema: { type: "object" },
      };

      await provider.sync("of:good-entity", {
        path: [],
        schemaContext: schema,
      });
      await provider.sync("of:bad-entity", { path: [], schemaContext: schema });

      // Make pull fail
      const originalPull = provider.workspace.pull.bind(provider.workspace);
      let pullCalled = false;
      provider.workspace.pull = function (
        _entries: [BaseMemoryAddress, Memory.SchemaPathSelector?][],
      ) {
        pullCalled = true;
        throw new Error("Network error");
      };

      // Capture console.error
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: any[]) => errors.push(args.join(" "));

      // Call our function
      await provider.reestablishSubscriptions();
      console.error = originalError;

      expect(pullCalled).toBe(true);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("Failed to re-establish subscriptions");
    });
  });
});
