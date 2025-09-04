import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import * as Memory from "@commontools/memory";
import * as Consumer from "@commontools/memory/consumer";
import { Cell, ID } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { isAnyCellLink } from "../src/link-utils.ts";
import { Provider } from "../src/storage/cache.ts";
import * as Subscription from "../src/storage/subscription.ts";
import {
  IStorageManager,
  IStorageSubscription,
} from "../src/storage/interface.ts";
const signer = await Identity.fromPassphrase("test operator");

// In the transition to TX we had to remove the current push retry logic
describe.skip("Push conflict", () => {
  let runtime: Runtime;
  let session: Memory.Memory.Memory;
  let memory: Provider;
  let provider: Memory.Provider.Provider<Memory.Protocol>;
  let consumer: Consumer.MemoryConsumer<Consumer.MemorySpace>;
  const storageManager: IStorageManager = {
    id: "some id",
    open: (space: Consumer.MemorySpace) =>
      Provider.open({
        space,
        subscription: Subscription.create(),
        session: consumer,
      }),
    edit() {
      throw new Error("Not implemented");
    },
    subscribe(_subscription: IStorageSubscription) {
      throw new Error("Not implemented");
    },
    synced() {
      return Promise.resolve();
    },
    syncCell<T>(cell: Cell<T>, _schemaContext?: Consumer.SchemaContext) {
      return Promise.resolve(cell);
    },
    close() {
      return Promise.resolve();
    },
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
  });

  afterEach(async () => {
    await runtime?.dispose();
    await provider?.close();
    await session.close();
  });

  it("should resolve push conflicts", async () => {
    const list = runtime.getCell<any[]>(
      signer.did(),
      "list",
    );
    list.set([]);
    const listURI = list.getAsNormalizedFullLink().id;
    await list.sync();

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
      subscription: Subscription.create(),
    });

    // Update memory without notifying main storage
    await memory.sync(listURI); // Get current value
    expect(memory.get(listURI)).toEqual({ value: [] });

    await memory.send([{ uri: listURI, value: { value: [1, 2, 3] } }]);

    expect(memory.get(listURI)).toEqual({ value: [1, 2, 3] });

    list.push(4);

    // This is locally ahead of the db, and retry wasn't called yet.
    expect(list.get()).toEqual([4]);

    await runtime.storageManager.synced();

    // We successfully replayed the change on top of the db:
    // FIXME(@ubik2) retry currently disabled
    //expect(retryCalled).toEqual(true);
    //expect(list.get()).toEqual([1, 2, 3, 4]);
    expect(list.get()).toEqual([1, 2, 3]);

    // Retry list should be empty now, since the change was applied.
    //expect(!!listDoc.retry?.length).toBe(false);
  });

  it("should resolve push conflicts among other conflicts", async () => {
    const name = runtime.getCell<string | undefined>(
      signer.did(),
      "name",
    );
    name.set(undefined);

    const list = runtime.getCell<any[]>(
      signer.did(),
      "list 2",
    );
    list.set([]);

    await name.sync();
    await list.sync();

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
      subscription: Subscription.create(),
    });

    const nameURI = name.getAsNormalizedFullLink().id;
    const listURI = list.getAsNormalizedFullLink().id;
    // Update memory without notifying main storage
    await memory.sync(nameURI); // Get current value
    await memory.sync(listURI); // Get current value
    await memory.send<any>([
      { uri: nameURI, value: { value: "foo" } },
      { uri: listURI, value: { value: [1, 2, 3] } },
    ]);

    name.set("bar");
    list.push(4);

    // This is locally ahead of the db, and retry wasn't called yet.
    expect(name.get()).toEqual("bar");
    expect(list.get()).toEqual([4]);

    await runtime.storageManager.synced();

    // We successfully replayed the change on top of the db:
    expect(name.get()).toEqual("foo");
    // TODO(@ubik2): our set of [4] will be invalid, and we use server's
    // value here. Previous code looks like it would have appended.
    //expect(list.get()).toEqual([1, 2, 3, 4]);
    expect(list.get()).toEqual([1, 2, 3]);
    //expect(retryCalled).toEqual(1);

    // Retry list should be empty now, since the change was applied.
    //expect(!!listDoc.retry?.length).toBe(false);
  });

  it("should resolve push conflicts with ID among other conflicts", async () => {
    const name = runtime.getCell<string | undefined>(
      signer.did(),
      "name 2",
    );
    name.set(undefined);

    const list = runtime.getCell<any[]>(
      signer.did(),
      "list 3",
    );
    list.set([]);

    await name.sync();
    await list.sync();

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
      subscription: Subscription.create(),
    });

    const nameURI = name.getAsNormalizedFullLink().id;
    const listURI = list.getAsNormalizedFullLink().id;
    // Update memory without notifying main storage
    await memory.sync(nameURI); // Get current value
    await memory.sync(listURI); // Get current value
    await memory.send<any>([
      { uri: nameURI, value: { value: "foo" } },
      { uri: listURI, value: { value: [{ n: 1 }, { n: 2 }, { n: 3 }] } },
    ]);

    name.set("bar");
    list.push({ n: 4, [ID]: "4" });

    // This is locally ahead of the db, and retry wasn't called yet.
    expect(name.get()).toEqual("bar");
    expect(list.get()).toEqual([{ n: 4 }]);
    expect(isAnyCellLink(list.getRaw()?.[0])).toBe(true);

    await runtime.storageManager.synced();

    // We successfully replayed the change on top of the db:
    expect(name.get()).toEqual("foo");
    // TODO(@ubik2): our set of [{ n: 4 }] will be invalid, and we use
    // server's value here. Previous code looks like it would have appended
    //     ).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    expect(
      list.asSchema({
        type: "array",
        items: { type: "object", properties: { n: { type: "number" } } },
      }).get(),
    ).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    //expect(retryCalled).toEqual(1);
    //expect(!!listDoc.retry?.length).toBe(false);

    // Check that the ID is still there
    // TODO(@ubik2): this is an important test to have, so re-add soon
    //expect(JSON.stringify(entry)).toEqual(JSON.stringify(list.getRaw()[3]));
  });
});
