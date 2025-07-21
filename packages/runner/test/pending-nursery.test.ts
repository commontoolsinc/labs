import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import * as Memory from "@commontools/memory";
import * as Consumer from "@commontools/memory/consumer";
import type { JSONSchema } from "@commontools/runner";
import { Provider } from "../src/storage/cache.ts";
import * as Subscription from "../src/storage/subscription.ts";
import { IRuntime, Runtime } from "../src/runtime.ts";
import { toURI } from "../src/uri-utils.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("Provider Subscriptions", () => {
  let memoryDb: Memory.Memory.Memory;
  let sessionProvider: Memory.Provider.Provider<Memory.Protocol>;
  let provider: Provider;
  let runtime: IRuntime;

  beforeEach(() => {
    memoryDb = Memory.Memory.emulate({ serviceDid: signer.did() });
    sessionProvider = Memory.Provider.create(memoryDb);
    //Memory.Provider.create(memoryDb);
    const consumer = Consumer.open({
      as: signer,
      session: sessionProvider.session(),
    });

    provider = Provider.open({
      space: signer.did(),
      session: consumer,
      subscription: Subscription.create(),
    });

    const storageManager = {
      id: "some id",
      open: (_space: Consumer.MemorySpace) => {
        return provider;
      },
      edit() {
        throw new Error("Not implemented");
      },
    };

    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager: storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await provider?.destroy();
    await sessionProvider?.close();
    await memoryDb.close();
  });

  describe("pending nursery changes don't trigger subscription", () => {
    it("should not make subscription callbacks for pending nursery changes", async () => {
      const space = signer.did();
      const schema = { "type": "number" } as const satisfies JSONSchema;

      // Initial sync to establish subscriptions for both users
      const cell1 = runtime.getCell(space, "test-cell", schema);
      await runtime.storage.syncCell(cell1);
      await runtime.storage.synced();

      const uri = toURI(cell1.entityId);

      const tx = runtime.edit();
      cell1.withTx(tx).set(1);
      await tx.commit();
      await runtime.storage.synced();

      expect(provider.get(cell1.entityId)).toEqual({ value: 1 });

      let s1Count = 0;

      provider.replica.heap.subscribe(
        { of: uri, the: "application/json" },
        (_v) => {
          s1Count++;
        },
      );

      const tx1a = runtime.edit();
      cell1.withTx(tx1a).set(43);
      tx1a.commit();

      const tx1b = runtime.edit();
      cell1.withTx(tx1b).set(44);
      tx1b.commit();

      const tx1c = runtime.edit();
      cell1.withTx(tx1c).set(45);
      tx1c.commit();

      await runtime.storage.synced();

      // We should have gotten no updates, since these were all
      // our own pending messages
      expect(s1Count).toEqual(0);
    });
  });
});
