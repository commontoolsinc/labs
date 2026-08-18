// The transaction's side of a materialized read's instant.
//
// A read resolving against an earlier epoch describes a different moment than
// the transaction's caches do, so those caches stand aside for it. And a
// wrapper answers for the instant exactly as the transaction it wraps does,
// which is what keeps a read taken through `Cell.sample()` describing the same
// moment as one taken directly.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createNonReactiveTransaction } from "../src/storage/extended-storage-transaction.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("extended-storage-transaction");
const space = signer.did();

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
} as const satisfies JSONSchema;

describe("extended-storage-transaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const seeded = async (cause: string) => {
    const write = runtime.edit();
    runtime.getCell(space, cause, undefined, write).set({ title: "before" });
    await write.commit();
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    return { tx, cell: runtime.getCell(space, cause, SCHEMA, tx) };
  };

  describe("the read-result cache under an epoch", () => {
    it("serves nothing while a read resolves against an earlier epoch", () => {
      const tx = runtime.edit();
      // Optional on the interface, and the behavior under test is what it
      // does, so a transaction without it has nothing to say.
      expect(typeof tx.getCachedReadResult).toBe("function");
      tx.setCachedReadResult!("key", "variant", 1);
      expect(tx.getCachedReadResult!("key", "variant")).toEqual({ value: 1 });

      const previous = tx.enterReadEpoch(0);
      expect(tx.getCachedReadResult!("key", "variant")).toBeUndefined();
      tx.exitReadEpoch(previous);

      expect(tx.getCachedReadResult!("key", "variant")).toEqual({ value: 1 });
      tx.abort("done");
    });

    it("keeps nothing taken while a read resolves against an earlier epoch", () => {
      const tx = runtime.edit();

      const previous = tx.enterReadEpoch(0);
      tx.setCachedReadResult!("key", "variant", 2);
      tx.exitReadEpoch(previous);

      // Had it been kept, this would answer with the value taken under the
      // epoch — a materialized read's value served to a current one.
      expect(tx.getCachedReadResult!("key", "variant")).toBeUndefined();
      tx.abort("done");
    });
  });

  describe("a wrapped transaction", () => {
    it("answers for the instant as the transaction it wraps does", async () => {
      const { tx, cell } = await seeded("wrapped-instant");
      const wrapper = createNonReactiveTransaction(tx);
      try {
        expect(wrapper.hasWrites()).toBe(false);

        const view = cell.withTx(wrapper).get() as { title: string };
        cell.withTx(tx).key("title").set("after");

        expect(wrapper.hasWrites()).toBe(true);
        // The wrapper carried the epoch down, so the view it handed back keeps
        // describing the moment it was taken.
        expect(view.title).toBe("before");
        expect((cell.withTx(wrapper).get() as { title: string }).title).toBe(
          "after",
        );
      } finally {
        await tx.commit();
      }
    });
  });
});
