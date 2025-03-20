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
    const charmsDoc = getDoc<any[]>([], "charms", "push conflict");
    const charms = charmsDoc.asCell();
    await storage.syncCell(charms);

    const memory = new VolatileStorageProvider("push conflict");

    console.log("sending");
    await memory.sync(charmsDoc.entityId, true);
    await memory.send([{
      entityId: charmsDoc.entityId,
      value: { value: [1, 2, 3] },
    }], true); // Update memory without notifying

    let retryCalled = false;
    charmsDoc.retry = [(value) => {
      retryCalled = true;
      return value;
    }];

    console.log("pushing");
    charms.push(4);
    expect(charms.get()).toEqual([4]);

    await storage.synced();

    expect(retryCalled).toEqual(true);
    expect(charms.get()).toEqual([1, 2, 3, 4]);

    // Clears timers
    await storage.synced();
  });
});
