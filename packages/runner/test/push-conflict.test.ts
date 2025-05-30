import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ID } from "@commontools/builder";
import { Identity } from "@commontools/identity";
import { type IStorage, Runtime } from "../src/runtime.ts";
import { isCellLink } from "../src/cell.ts";
import { VolatileStorageProvider } from "../src/storage/volatile.ts";

describe("Push conflict", () => {
  let runtime: Runtime;
  let storage: IStorage;

  beforeEach(async () => {
    runtime = new Runtime({
      storageUrl: "volatile://",
    });
    storage = runtime.storage;
    storage.setSigner(await Identity.fromPassphrase("test operator"));
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  it("should resolve push conflicts", async () => {
    const listDoc = runtime.documentMap.getDoc<any[]>(
      [],
      "list",
      "push conflict",
    );
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
  });

  it("should resolve push conflicts among other conflicts", async () => {
    const nameDoc = runtime.documentMap.getDoc<string | undefined>(
      undefined,
      "name",
      "push and set",
    );
    const listDoc = runtime.documentMap.getDoc<any[]>(
      [],
      "list 2",
      "push and set",
    );

    const name = nameDoc.asCell();
    const list = listDoc.asCell();

    await storage.syncCell(name);
    await storage.syncCell(list);

    const memory = new VolatileStorageProvider("push and set");

    // Update memory without notifying main storage
    await memory.sync(nameDoc.entityId, true); // Get current value
    await memory.sync(listDoc.entityId, true); // Get current value
    await memory.send<any>([{
      entityId: nameDoc.entityId,
      value: { value: "foo" },
    }, {
      entityId: listDoc.entityId,
      value: { value: [1, 2, 3] },
    }], true); // true = do not notify main storage

    let retryCalled = 0;
    listDoc.retry = [(value) => {
      retryCalled++;
      return value;
    }];

    name.set("bar");
    list.push(4);

    // This is locally ahead of the db, and retry wasn't called yet.
    expect(name.get()).toEqual("bar");
    expect(list.get()).toEqual([4]);
    expect(retryCalled).toEqual(0);

    await storage.synced();

    // We successfully replayed the change on top of the db:
    expect(name.get()).toEqual("foo");
    expect(list.get()).toEqual([1, 2, 3, 4]);
    expect(retryCalled).toEqual(1);

    // Retry list should be empty now, since the change was applied.
    expect(!!listDoc.retry?.length).toBe(false);
  });

  it("should resolve push conflicts with ID among other conflicts", async () => {
    const nameDoc = runtime.documentMap.getDoc<string | undefined>(
      undefined,
      "name 2",
      "push and set",
    );
    const listDoc = runtime.documentMap.getDoc<any[]>(
      [],
      "list 3",
      "push and set",
    );

    const name = nameDoc.asCell();
    const list = listDoc.asCell();

    await storage.syncCell(name);
    await storage.syncCell(list);

    const memory = new VolatileStorageProvider("push and set");

    // Update memory without notifying main storage
    await memory.sync(nameDoc.entityId, true); // Get current value
    await memory.sync(listDoc.entityId, true); // Get current value
    await memory.send<any>([{
      entityId: nameDoc.entityId,
      value: { value: "foo" },
    }, {
      entityId: listDoc.entityId,
      value: { value: [{ n: 1 }, { n: 2 }, { n: 3 }] },
    }], true); // true = do not notify main storage

    let retryCalled = 0;
    listDoc.retry = [(value) => {
      retryCalled++;
      return value;
    }];

    name.set("bar");
    list.push({ n: 4, [ID]: "4" });

    // This is locally ahead of the db, and retry wasn't called yet.
    expect(name.get()).toEqual("bar");
    expect(list.get()).toEqual([{ n: 4 }]);
    expect(isCellLink(listDoc.get()?.[0])).toBe(true);
    const entry = listDoc.get()[0].cell?.asCell();
    expect(retryCalled).toEqual(0);

    await storage.synced();

    // We successfully replayed the change on top of the db:
    expect(name.get()).toEqual("foo");
    expect(
      list.asSchema({
        type: "array",
        items: { type: "object", properties: { n: { type: "number" } } },
      }).get(),
    ).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    expect(retryCalled).toEqual(1);
    expect(!!listDoc.retry?.length).toBe(false);

    // Check that the ID is still there
    expect(entry.equals(listDoc.get()[3])).toBe(true);
  });
});
