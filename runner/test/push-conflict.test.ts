import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { storage } from "../src/storage.ts";
import { getDoc } from "@commontools/runner";
import { VolatileStorageProvider } from "../src/storage/volatile.ts";
import { Identity } from "@commontools/identity";

storage.setRemoteStorage(new URL(`volatile:`));
storage.setSigner(await Identity.fromPassphrase("test operator"));

describe("Push conflict", () => {
  it("should resolve push conflicts", async () => {
    const listDoc = getDoc<any[]>([], "list", "push conflict");
    const list = listDoc.asCell();
    await storage.syncCell(list);

    const memory = new VolatileStorageProvider("push conflict");

    // Update memory without notifying main storage
    await memory.sync(listDoc.entityId, true); // Get current value
    await memory.send([{
      entityId: listDoc.entityId,
      value: { value: [1, 2, 3] },
    }], true); // true = do not notify main storage

    let retryCalled = false;
    listDoc.retry = [(value) => {
      retryCalled = true;
      return value;
    }];

    list.push(4);

    // This is locally ahead of the db, and retry wasn't called yet.
    expect(list.get()).toEqual([4]);
    expect(retryCalled).toEqual(false);

    await storage.synced();

    // We successfully replayed the change on top of the db:
    expect(list.get()).toEqual([1, 2, 3, 4]);
    expect(retryCalled).toEqual(true);

    // Retry list should be empty now, since the change was applied.
    expect(!!listDoc.retry?.length).toBe(false);

    // Wait for database to settle any follow-up batches, which the system will
    // realize are all redundant. But otherwise the test suite complains.
    await storage.synced();
  });
});
