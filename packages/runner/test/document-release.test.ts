import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { SessionSync } from "@commonfabric/memory/v2";
import { StorageManager as EmulatedStorageManager } from "../src/storage/cache.deno.ts";
import {
  defaultSettings,
  type StorageManager,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { entityKey, parseEntityKey } from "../src/scheduler/keys.ts";
import { Runtime } from "../src/runtime.ts";
import {
  makeSharedServer,
  openSharedServerRuntime,
} from "./shared-server-storage.ts";

const signer = await Identity.fromPassphrase("document-release");
const space = signer.did();

type Retention = { documents: number; watched: number; watches: number };

describe("document release", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof EmulatedStorageManager.emulate>;

  beforeEach(() => {
    storageManager = EmulatedStorageManager.emulate({
      as: signer,
      settings: { ...defaultSettings, experimentalDocumentRelease: true },
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const retention = (): Retention =>
    storageManager.open(space).replica.retentionStats!();

  const holds = (id: URI): boolean =>
    storageManager.open(space).replica.getDocument(id) !== undefined;

  it("keeps a document a live subscription reads", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "retained");
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 1 });
    await tx.commit();
    await runtime.settled();

    const seen: unknown[] = [];
    const cancel = cell.sink((value) => {
      seen.push(value);
    });
    await runtime.settled();
    expect(seen.length).toBeGreaterThan(0);

    expect(holds(cell.getAsNormalizedFullLink().id)).toBe(true);
    cancel();
  });

  it("gives up a document once its last reader goes", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "released");
    const id = cell.getAsNormalizedFullLink().id;
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 1 });
    await tx.commit();
    await runtime.settled();

    const cancel = cell.sink(() => {});
    await runtime.settled();
    const before = retention();
    expect(holds(id)).toBe(true);

    cancel();
    await runtime.settled();

    expect(holds(id)).toBe(false);
    expect(retention().watches).toBeLessThan(before.watches);
  });

  it("re-reads a released document from the server", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "re-read");
    const id = cell.getAsNormalizedFullLink().id;
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 7 });
    await tx.commit();
    await runtime.settled();

    const cancel = cell.sink(() => {});
    await runtime.settled();
    cancel();
    await runtime.settled();
    expect(holds(id)).toBe(false);

    // A fresh cell for the same document: the replica no longer holds it, so
    // this has to reach the server again.
    const again = runtime.getCell<{ value: number }>(space, "re-read");
    await again.sync();
    expect(again.get()).toEqual({ value: 7 });
    expect(holds(id)).toBe(true);
  });

  it("keeps a document whose local write is not yet confirmed", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "unconfirmed");
    const id = cell.getAsNormalizedFullLink().id;
    const setup = runtime.edit();
    cell.withTx(setup).set({ value: 1 });
    await setup.commit();
    await runtime.settled();

    const cancel = cell.sink(() => {});
    await runtime.settled();

    // Issue a write, then release the reader while the commit is still in
    // flight. Dropping the record now would drop the optimistic write with it,
    // and the replay would have nothing to replay onto.
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 2 });
    const commit = tx.commit();
    cancel();
    storageManager.releaseDocuments!([{ space, scope: "space", id }]);

    await commit;
    await runtime.settled();
    // The write reached the server. Read it through a cell that has not been
    // told the document is already loaded, since the release may since have
    // discarded the record — that is the documented cost, and it is not what
    // this test is about.
    const fresh = runtime.getCell<{ value: number }>(space, "unconfirmed");
    await fresh.sync();
    expect(fresh.get()).toEqual({ value: 2 });
  });

  it("settles close() with a release decided but not yet sent", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "closing");
    const id = cell.getAsNormalizedFullLink().id;
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 1 });
    await tx.commit();
    await runtime.settled();

    // Decide the release and close before its shrink reaches the wire. The
    // release round is registered as storage work, and `close()` drains that
    // set, so a round left open here would hang teardown.
    storageManager.releaseDocuments!([{ space, scope: "space", id }]);
    await runtime.dispose();
    await storageManager.close();
    // Re-created in afterEach's place: both are already closed.
    runtime = undefined as unknown as Runtime;
    storageManager = undefined as unknown as typeof storageManager;
  });

  it("keeps a document a provider-level sink subscribes to", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "sunk");
    const id = cell.getAsNormalizedFullLink().id;
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 3 });
    await tx.commit();
    await runtime.settled();

    // A provider-level sink does not go through the scheduler, so the trigger
    // index reports no reader for this document even while the sink is live.
    // `sink` is on the concrete provider rather than the interface.
    const provider = storageManager.open(space) as unknown as {
      sink(uri: URI, callback: (value: unknown) => void): () => void;
    };
    const cancel = provider.sink(id, () => {});
    // Let the sink's own pull settle first, so what holds the document below is
    // the subscription rather than a request still in flight.
    await storageManager.synced();
    storageManager.releaseDocuments!([{ space, scope: "space", id }]);
    await storageManager.synced();

    expect(holds(id)).toBe(true);
    cancel();
  });

  it("keeps serving a document that leaves the union while still read", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "still-read");
    const id = cell.getAsNormalizedFullLink().id;
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 5 });
    await tx.commit();
    await runtime.settled();

    const seen: unknown[] = [];
    const cancel = cell.sink((value) => {
      seen.push(value);
    });
    await runtime.settled();

    // Report the document as released while its subscription is still live —
    // what the server does when a dropped watch was covering a document as
    // well as its own root. The value must stay readable and be pulled again,
    // not be wiped to absent.
    storageManager.releaseDocuments!([{ space, scope: "space", id }]);
    await storageManager.synced();
    await runtime.settled();

    expect(cell.get()).toEqual({ value: 5 });
    expect(holds(id)).toBe(true);
    cancel();
  });
});

describe("document retention over a sliding window", () => {
  let server: MemoryV2Server.Server;
  let runtime: Runtime;
  let storageManager: StorageManager;

  const WINDOW = 5;
  const TOTAL = 40;
  const ids = Array.from(
    { length: TOTAL },
    (_, index) => `of:row-${index}` as URI,
  );

  beforeEach(() => {
    server = makeSharedServer();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    await server.close();
  });

  /** Populate the space from a replica that is then thrown away. */
  const publish = async () => {
    const writer = openSharedServerRuntime(signer, server);
    const tx = writer.runtime.edit();
    for (const [index, id] of ids.entries()) {
      writer.runtime
        .getCellFromLink({ space, id, path: [] })
        .withTx(tx)
        .set({ value: index });
    }
    await tx.commit();
    await writer.runtime.settled();
    await writer.manager.synced();
    await writer.runtime.dispose();
    await writer.manager.close();
  };

  /**
   * Slide a `WINDOW`-wide band of live subscriptions across the collection in a
   * replica that starts empty, reporting what it holds after each slide. This is
   * the shape of a view paging through a collection: each slide pulls a page's
   * worth of documents and drops the previous page's readers.
   */
  const slideWindow = async (release: boolean): Promise<number[]> => {
    await publish();
    const opened = openSharedServerRuntime(signer, server, release);
    runtime = opened.runtime;
    storageManager = opened.manager;

    const held: number[] = [];
    for (let start = 0; start + WINDOW <= TOTAL; start += WINDOW) {
      const cancels = ids.slice(start, start + WINDOW).map((id) =>
        runtime
          .getCellFromLink({ space, id, path: [] })
          .sink(() => {})
      );
      await runtime.settled();
      for (const cancel of cancels) cancel();
      await runtime.settled();
      held.push(
        storageManager.open(space).replica.retentionStats!().documents,
      );
    }
    return held;
  };

  it("stops growing once documents are released", async () => {
    const held = await slideWindow(true);
    expect(held.length).toBe(TOTAL / WINDOW);
    // Bounded: no slide holds more than the first one did.
    expect(Math.max(...held)).toBe(held[0]);
  });

  it("grows with every window visited when release is off", async () => {
    const held = await slideWindow(false);
    expect(held.length).toBe(TOTAL / WINDOW);
    // Strictly monotonic: nothing is ever given back.
    for (let index = 1; index < held.length; index++) {
      expect(held[index]).toBeGreaterThan(held[index - 1]);
    }
  });
});

describe("document release, off by default", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof EmulatedStorageManager.emulate>;

  beforeEach(() => {
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("keeps a document whose last reader has gone", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "kept-when-off");
    const id = cell.getAsNormalizedFullLink().id;
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 1 });
    await tx.commit();
    await runtime.settled();

    const cancel = cell.sink(() => {});
    await runtime.settled();
    cancel();
    await runtime.settled();

    expect(
      storageManager.open(space).replica.getDocument(id) !== undefined,
    ).toBe(true);
    // Nor does it carry the bookkeeping release needs: the mirror of the
    // server's watch set is only worth keeping when something prunes it.
    expect(storageManager.open(space).replica.retentionStats!().watches)
      .toBe(0);
  });

  it("does nothing when asked to release", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "asked-when-off");
    const id = cell.getAsNormalizedFullLink().id;
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 1 });
    await tx.commit();
    await runtime.settled();

    expect(storageManager.releasesDocuments!()).toBe(false);
    storageManager.releaseDocuments!([{ space, scope: "space", id }]);
    await storageManager.synced();
    expect(
      storageManager.open(space).replica.getDocument(id) !== undefined,
    ).toBe(true);
  });

  it("keeps the record when the server retires a document", async () => {
    const cell = runtime.getCell<{ value: number }>(space, "retired-when-off");
    const id = cell.getAsNormalizedFullLink().id;
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 1 });
    await tx.commit();
    await runtime.settled();

    const replica = storageManager.open(space).replica;
    const before = replica.retentionStats!().documents;

    // A background refresh whose re-evaluated union came out smaller reports
    // the entities that left it. With release off that must read exactly as it
    // always has: the record stays, holding no value.
    (replica as unknown as {
      applySessionSync(sync: SessionSync, type: "pull" | "integrate"): void;
    }).applySessionSync({
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [{ branch: "", id, scope: "space" }],
    }, "integrate");

    expect(replica.retentionStats!().documents).toBe(before);
    expect(replica.getDocument(id)).toBeUndefined();
  });
});

describe("entity keys", () => {
  const roundTrip = (
    address: { space: MemorySpace; id: URI; scope?: "space" | "user" },
  ) => parseEntityKey(entityKey(address));

  it("round-trips an ordinary identifier", () => {
    expect(roundTrip({ space: space as MemorySpace, id: "of:abc" as URI }))
      .toEqual({ space, scope: "space", id: "of:abc" });
  });

  it("round-trips a scoped identifier", () => {
    expect(
      roundTrip({
        space: space as MemorySpace,
        id: "of:abc" as URI,
        scope: "user",
      }),
    ).toEqual({ space, scope: "user", id: "of:abc" });
  });

  it("round-trips an identifier containing slashes", () => {
    const id = 'data:application/json,{"a":"b/c"}' as URI;
    expect(roundTrip({ space: space as MemorySpace, id }))
      .toEqual({ space, scope: "space", id });
  });
});

describe("shrinking against a stubbed session", () => {
  const uri = "of:shrink-probe" as URI;

  type Calls = {
    added: string[][];
    replaced: string[][];
    removed: string[][];
  };

  /**
   * A storage manager over a session that records which watch mutation the
   * shrink reached for, so the two forms can be told apart without a server.
   */
  const openStubbed = (options: {
    supportsWatchRemove: boolean;
    failShrink?: boolean;
    /** Identifiers the shrink's answer reports as having left the union. */
    removesOnShrink?: URI[];
    /** Report a live reader for everything, forcing the collateral re-pull. */
    stillRead?: boolean;
    /** Fail the pull that would get the watch back. */
    failRepull?: boolean;
    /** Identifiers the first watch install delivers. */
    deliverOnAdd?: URI[];
  }) => {
    const calls: Calls = { added: [], replaced: [], removed: [] };
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const view = MemoryV2Client.WatchView.fromSync(sync);
    const session = {
      get supportsWatchRemove() {
        return options.supportsWatchRemove;
      },
      setConcurrentWatchRefresh: () => {},
      watchAddSync: (watches: { id: string }[]) => {
        calls.added.push(watches.map((watch) => watch.id));
        if (options.failRepull && calls.added.length > 1) {
          return Promise.reject(new Error("pull refused"));
        }
        // Answer the first install with the document, so the replica has
        // something to hold and, later, something to give up.
        return Promise.resolve({
          view,
          sync: options.deliverOnAdd
            ? {
              ...sync,
              upserts: options.deliverOnAdd.map((id) => ({
                branch: "",
                id,
                scope: "space" as const,
                seq: 1,
                doc: { value: { held: true } },
              })),
            }
            : sync,
        });
      },
      watchSetSync: (watches: { id: string }[]) => {
        calls.replaced.push(watches.map((watch) => watch.id));
        if (options.failShrink) {
          return Promise.reject(new Error("shrink refused"));
        }
        return Promise.resolve({ view, sync });
      },
      watchRemoveSync: (ids: string[]) => {
        calls.removed.push(ids);
        if (options.failShrink) {
          return Promise.reject(new Error("shrink refused"));
        }
        return Promise.resolve({
          view,
          sync: {
            ...sync,
            removes: (options.removesOnShrink ?? []).map((id) => ({
              branch: "",
              id,
              scope: "space" as const,
            })),
          },
        });
      },
    } as unknown as MemoryV2Client.SpaceSession;
    const client = {
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;

    class StubbedStorageManager extends V2StorageManager {
      constructor() {
        super(
          {
            as: signer,
            memoryHost: new URL("memory://"),
            settings: {
              ...defaultSettings,
              experimentalDocumentRelease: true,
            },
          },
          { create: () => Promise.resolve({ client, session }) },
        );
      }
      override registerSpaceHost(): boolean {
        return false;
      }
    }
    const manager = new StubbedStorageManager();
    if (options.stillRead) {
      manager.setDocumentReleaseHooks!({
        hasReaders: () => true,
        documentDropped: () => {},
      });
    }
    return { manager, calls };
  };

  /** Install one watch, then give it up. */
  const installThenRelease = async (manager: StorageManager) => {
    const provider = manager.open(space);
    await provider.sync(uri, { path: [], schema: false });
    manager.releaseDocuments!([{ space, scope: "space", id: uri }]);
    await manager.synced();
    return provider;
  };

  it("names the watches that go when the server takes a removal", async () => {
    const { manager, calls } = openStubbed({ supportsWatchRemove: true });
    try {
      await installThenRelease(manager);
      expect(calls.added.length).toBe(1);
      expect(calls.removed).toEqual(calls.added);
      expect(calls.replaced).toEqual([]);
    } finally {
      await manager.close();
    }
  });

  it("replaces the whole set for a server without the verb", async () => {
    const { manager, calls } = openStubbed({ supportsWatchRemove: false });
    try {
      await installThenRelease(manager);
      expect(calls.removed).toEqual([]);
      // The only installed watch was the one released, so nothing survives.
      expect(calls.replaced).toEqual([[]]);
    } finally {
      await manager.close();
    }
  });

  it("keeps the documents when the shrink is refused", async () => {
    const { manager, calls } = openStubbed({
      supportsWatchRemove: true,
      failShrink: true,
    });
    try {
      const provider = await installThenRelease(manager);
      expect(calls.removed.length).toBe(1);
      // The server's watch set is unchanged, so the replica still holds its
      // watch rather than acting on a shrink that never landed.
      expect(provider.replica.retentionStats!().watches).toBe(1);

      // The decision is still queued, so the next release retries it.
      manager.releaseDocuments!([{ space, scope: "space", id: uri }]);
      await manager.synced();
      expect(calls.removed.length).toBe(2);
    } finally {
      await manager.close();
    }
  });

  it("abandons a shrink whose replica closed while it was in flight", async () => {
    const { manager, calls } = openStubbed({ supportsWatchRemove: true });
    const provider = manager.open(space);
    await provider.sync(uri, { path: [], schema: false });
    manager.releaseDocuments!([{ space, scope: "space", id: uri }]);
    // Close before the shrink's answer is applied. The answer is dropped
    // rather than applied to a replica that is gone, and the close still
    // settles.
    await manager.close();
    expect(calls.removed.length).toBe(1);
  });

  it("drops a document whose watch cannot be got back", async () => {
    const { manager, calls } = openStubbed({
      supportsWatchRemove: true,
      failRepull: true,
      deliverOnAdd: [uri],
      removesOnShrink: [uri],
      stillRead: true,
    });
    try {
      const provider = manager.open(space);
      await provider.sync(uri, { path: [], schema: false });
      expect(provider.replica.getDocument(uri)).toBeDefined();

      manager.releaseDocuments!([{ space, scope: "space", id: uri }]);
      await manager.synced();
      await manager.synced();

      // The server retired it while a reader still wanted it, and the pull that
      // would have got a watch back failed. Holding the value would mean
      // serving something the server has stopped updating, with nothing saying
      // so, so it goes instead.
      expect(calls.removed.length).toBeGreaterThan(0);
      expect(provider.replica.getDocument(uri)).toBeUndefined();
    } finally {
      await manager.close();
    }
  });

  it("retries a failed shrink at the next quiescence", async () => {
    const { manager, calls } = openStubbed({
      supportsWatchRemove: true,
      failShrink: true,
    });
    try {
      await installThenRelease(manager);
      expect(calls.removed.length).toBe(1);

      // Quiescence with nothing new to give up. The failed decision is still
      // queued, and this is the event that arms another attempt — without it a
      // reader who stops paging keeps those documents for the session.
      manager.releaseDocuments!([]);
      await manager.synced();
      expect(calls.removed.length).toBe(2);
    } finally {
      await manager.close();
    }
  });

  it("gives up the whole watch set when the replica is reset", async () => {
    const { manager, calls } = openStubbed({ supportsWatchRemove: true });
    try {
      const provider = manager.open(space);
      await provider.sync(uri, { path: [], schema: false });
      expect(provider.replica.retentionStats!().watches).toBe(1);

      // A reset throws the documents away, so the watches behind them have to
      // go too: the server would otherwise believe this session still holds
      // what it just discarded, and never resend it.
      (provider.replica as unknown as { reset(): void }).reset();
      await manager.synced();
      expect(calls.replaced).toEqual([[]]);
      expect(provider.replica.retentionStats!().watches).toBe(0);
    } finally {
      await manager.close();
    }
  });
});
