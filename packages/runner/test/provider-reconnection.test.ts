import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { Provider } from "../src/storage/cache.ts";
import * as Memory from "@commontools/memory";
import * as Consumer from "@commontools/memory/consumer";
import type { Entity, SchemaContext } from "@commontools/memory/interface";
import type { EntityId } from "@commontools/runner";

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
    });
  });

  afterEach(async () => {
    await provider?.destroy();
    await sessionProvider?.close();
    await memoryDb.close();
  });

  describe("reestablishSubscriptions", () => {
    it("should re-issue sync for all tracked subscriptions", async () => {
      const schema1: SchemaContext = {
        schema: { type: "object", properties: { name: { type: "string" } } },
        rootSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      };

      const schema2: SchemaContext = {
        schema: { type: "object", properties: { age: { type: "number" } } },
        rootSchema: { type: "object", properties: { age: { type: "number" } } },
      };

      const entityId1: EntityId = { "/": "user-1" };
      const entityId2: EntityId = { "/": "user-2" };

      // Initial sync to establish subscriptions
      await provider.sync(entityId1, true, schema1);
      await provider.sync(entityId2, true, schema2);

      // Override the provider's sync function to our version that also tracks the documents that its sync'ing on
      const syncCalls: Array<
        { entityId: EntityId; schemaContext?: SchemaContext }
      > = [];
      const originalSync = provider.sync.bind(provider);
      (provider as any).sync = function (
        entityId: EntityId,
        expectedInStorage?: boolean,
        schemaContext?: SchemaContext,
      ) {
        syncCalls.push({ entityId, schemaContext });
        return originalSync(entityId, expectedInStorage, schemaContext);
      };

      // Call reestablishSubscriptions to test the logic
      await provider.reestablishSubscriptions();

      // Make sure both subscriptions were re-established
      expect(syncCalls.length).toBe(2);

      // Check first subscription
      const call1 = syncCalls.find((c) => c.entityId["/"] === "user-1");
      expect(call1).toBeDefined();
      expect(call1?.schemaContext).toEqual(schema1);

      // Check second subscription
      const call2 = syncCalls.find((c) => c.entityId["/"] === "user-2");
      expect(call2).toBeDefined();
      expect(call2?.schemaContext).toEqual(schema2);
    });

    it("should handle sync failures gracefully", async () => {
      const schema: SchemaContext = {
        schema: { type: "object" },
        rootSchema: { type: "object" },
      };

      await provider.sync({ "/": "good-entity" }, true, schema);
      await provider.sync({ "/": "bad-entity" }, true, schema);

      // Make sync fail for one entity
      const originalSync = provider.sync.bind(provider);
      let callCount = 0;
      (provider as any).sync = function (
        entityId: EntityId,
        expectedInStorage?: boolean,
        schemaContext?: SchemaContext,
      ) {
        if (entityId["/"] === "bad-entity") {
          throw new Error("Network error");
        }
        callCount++;
        return originalSync(entityId, expectedInStorage, schemaContext);
      };

      // Capture console.error
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (msg: string) => errors.push(msg);

      // Call our function
      await provider.reestablishSubscriptions();
      console.error = originalError;

      expect(callCount).toBe(1); // Only "good-entity" succeeded
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain(
        "Failed to re-establish subscription for bad-entity",
      );
    });
  });
});
