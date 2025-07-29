import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "@commontools/runner";
import { Runtime } from "../src/runtime.ts";
import { type Provider, StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Provider Subscriptions", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let provider: Provider;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });

    provider = storageManager.open(space) as Provider;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("pending nursery changes don't trigger subscription", () => {
    it("should not make subscription callbacks for pending nursery changes", async () => {
      const schema = { "type": "number" } as const satisfies JSONSchema;

      // Initial sync to establish subscriptions for both users
      const cell1 = runtime.getCell(space, "test-cell", schema);
      await runtime.storage.syncCell(cell1);
      await runtime.storage.synced();

      const uri = cell1.getAsNormalizedFullLink().id;

      const tx = runtime.edit();
      cell1.withTx(tx).set(1);
      await tx.commit();
      await runtime.storage.synced();

      expect(provider.get(uri)).toEqual({ value: 1 });

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
