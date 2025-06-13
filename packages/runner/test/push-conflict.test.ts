import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ID } from "../src/builder/types.ts";
import { Identity } from "@commontools/identity";
import { type IStorage, Runtime } from "../src/runtime.ts";
import { isCellLink } from "../src/cell.ts";
import * as Memory from "@commontools/memory";
import * as Consumer from "@commontools/memory/consumer";
import { Provider } from "../src/storage/cache.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("Push conflict", () => {
  let runtime: Runtime;
  let session: Memory.Memory.Memory;
  let memory: Provider;
  let storage: IStorage;
  let provider: Memory.Provider.Provider<Memory.Protocol>;
  let consumer: Consumer.MemoryConsumer<Consumer.MemorySpace>;
  const storageManager = {
    id: "some id",
    open: (space: Consumer.MemorySpace) =>
      Provider.open({
        space,
        session: consumer,
      }),
  };

  beforeEach(() => {
    session = Memory.Memory.emulate({ serviceDid: signer.did() });

    // Create memory service for testing
    provider = Memory.Provider.create(session);

    consumer = Consumer.open({
      as: signer,
      session: provider.session(),
    });

    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    storage = runtime.storage;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await provider?.close();
    await session.close();
  });

  it("should resolve push conflicts", async () => {
    const listDoc = runtime.documentMap.getDoc<any[]>(
      [],
      "list",
      signer.did(),
    );
    const list = listDoc.asCell();
    await storage.syncCell(list);

    const source = session.clone();
    source.subscribers.clear();
    const provider = Memory.Provider.create(source);
    const consumer = Consumer.open({
      as: signer,
      session: provider.session(),
    });
    memory = Provider.open({
      space: signer.did(),
      session: consumer,
    });

    // Update memory without notifying main storage
    await memory.sync(listDoc.entityId, true); // Get current value
    expect(memory.get(listDoc.entityId)).toEqual({ value: [] });

    await memory.send([{
      entityId: listDoc.entityId,
      value: { value: [1, 2, 3] },
    }]);

    expect(memory.get(listDoc.entityId)).toEqual({ value: [1, 2, 3] });

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
    expect(retryCalled).toEqual(true);
    expect(list.get()).toEqual([1, 2, 3, 4]);

    // Retry list should be empty now, since the change was applied.
    expect(!!listDoc.retry?.length).toBe(false);
  });

  it("should resolve push conflicts among other conflicts", async () => {
    const nameDoc = runtime.documentMap.getDoc<string | undefined>(
      undefined,
      "name",
      signer.did(),
    );
    const listDoc = runtime.documentMap.getDoc<any[]>(
      [],
      "list 2",
      signer.did(),
    );

    const name = nameDoc.asCell();
    const list = listDoc.asCell();

    await storage.syncCell(name);
    await storage.syncCell(list);

    const source = session.clone();
    source.subscribers.clear();
    const provider = Memory.Provider.create(source);
    const consumer = Consumer.open({
      as: signer,
      session: provider.session(),
    });
    memory = Provider.open({
      space: signer.did(),
      session: consumer,
    });

    // Update memory without notifying main storage
    await memory.sync(nameDoc.entityId, true); // Get current value
    await memory.sync(listDoc.entityId, true); // Get current value
    await memory.send<any>([{
      entityId: nameDoc.entityId,
      value: { value: "foo" },
    }, {
      entityId: listDoc.entityId,
      value: { value: [1, 2, 3] },
    }]);

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
      signer.did(),
    );
    const listDoc = runtime.documentMap.getDoc<any[]>(
      [],
      "list 3",
      signer.did(),
    );

    const name = nameDoc.asCell();
    const list = listDoc.asCell();

    await storage.syncCell(name);
    await storage.syncCell(list);

    const source = session.clone();
    source.subscribers.clear();
    const provider = Memory.Provider.create(source);
    const consumer = Consumer.open({
      as: signer,
      session: provider.session(),
    });
    memory = Provider.open({
      space: signer.did(),
      session: consumer,
    });

    // Update memory without notifying main storage
    await memory.sync(nameDoc.entityId, true); // Get current value
    await memory.sync(listDoc.entityId, true); // Get current value
    await memory.send<any>([{
      entityId: nameDoc.entityId,
      value: { value: "foo" },
    }, {
      entityId: listDoc.entityId,
      value: { value: [{ n: 1 }, { n: 2 }, { n: 3 }] },
    }]);

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
