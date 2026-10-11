import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("doomed pending reads");
const space = signer.did();
const listSchema = { type: "array", items: { type: "string" } } as const;
const recordSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: { type: "string" } },
    other: { type: "number" },
  },
} as const;

type Session = { storage: EmulatedStorageManager; runtime: Runtime };

const snapshot = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null));

describe("memory-v2 doomed pending reads", () => {
  let server: MemoryV2Server.Server;
  let verdicts: string[];
  // Commits on these document ids wait at the server's door until the test
  // releases them: the window a slow verdict leaves open.
  let heldIds: Set<string>;
  let held: PromiseWithResolvers<void>;
  let release: PromiseWithResolvers<void>;
  const sessions: Session[] = [];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    verdicts = [];
    heldIds = new Set();
    held = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    const transact = server.transact.bind(server);
    server.transact = async (...args: Parameters<typeof transact>) => {
      const [message] = args;
      if (
        message.commit.operations.some((op) => "id" in op && heldIds.has(op.id))
      ) {
        held.resolve();
        await release.promise;
      }
      const response = await transact(...args);
      verdicts.push(response.error ? response.error.name : "ok");
      return response;
    };
  });

  afterEach(async () => {
    release.resolve();
    await server.flushSessions([space]);
    await clock.settle();
    for (const session of sessions.splice(0)) {
      await session.runtime.dispose();
      await session.storage.close();
    }
    await server.close();
  });

  const connect = (): Session => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const session = { storage, runtime };
    sessions.push(session);
    return session;
  };

  const flush = async () => {
    await server.flushSessions([space]);
    await clock.settle();
  };

  const seed = async (session: Session, doc: string, value: unknown) => {
    await session.runtime.getCell(space, doc, listSchema).sync();
    const tx = session.runtime.edit();
    session.runtime.getCell(space, doc, listSchema, tx).set(value as never);
    expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
      .toBeUndefined();
  };

  const append = (session: Session, doc: string, item: string) => {
    const tx = session.runtime.edit();
    const cell = session.runtime.getCell(space, doc, listSchema, tx);
    cell.set([...(cell.get() as string[]), item]);
    return tx.commit({ holdSyncedUntilCovered: false }).verdict;
  };

  const errorNameOf = (verdict: { error?: { name?: string } }) =>
    verdict.error?.name;

  it("takes a tail splice out of the view when a frame overtakes the array it read", async () => {
    // Two runtimes grow one list the same way. The other's write lands
    // first; its frame moves the list under this one's pending splice,
    // whose whole-document read is now stale. The reader sees the list as
    // the store holds it throughout, never the tail twice, and the store's
    // refusal then drops the layer it no longer shows.
    const doc = "doomed-tail-splice";
    const a = connect();
    const b = connect();
    await seed(a, doc, ["e1", "e2"]);
    const listB = b.runtime.getCell(space, doc, listSchema);
    await listB.sync();
    await flush();
    await b.storage.synced();
    expect(listB.get()).toEqual(["e1", "e2"]);

    const seen: unknown[] = [];
    const cancel = listB.sink((value) => {
      seen.push(snapshot(value));
    });

    heldIds.add(listB.getAsNormalizedFullLink().id);
    const bVerdict = append(b, doc, "e3");
    await held.promise;
    expect(listB.get()).toEqual(["e1", "e2", "e3"]);

    heldIds.clear();
    expect((await append(a, doc, "e3")).error).toBeUndefined();
    await flush();
    // The frame took B's splice out of the view; its verdict is still held.
    expect(listB.get()).toEqual(["e1", "e2", "e3"]);
    expect(verdicts).toEqual(["ok", "ok"]);

    release.resolve();
    expect(errorNameOf(await bVerdict)).toBe("ConflictError");
    await flush();
    await b.runtime.idle();
    cancel();

    expect(listB.get()).toEqual(["e1", "e2", "e3"]);
    expect(seen.filter((value) => Array.isArray(value) && value.length > 3))
      .toEqual([]);
    expect(verdicts).toEqual(["ok", "ok", "ConflictError"]);
  });

  it("dooms the commits stacked on a doomed one with it", async () => {
    // B's second append reads through its first, so its read is pending on
    // that layer. The frame that dooms the first dooms the second, the view
    // leaves both out at once, and the store refuses both.
    const doc = "doomed-stack";
    const a = connect();
    const b = connect();
    await seed(a, doc, ["e1", "e2"]);
    const listB = b.runtime.getCell(space, doc, listSchema);
    await listB.sync();
    await flush();
    await b.storage.synced();

    const seen: unknown[] = [];
    const cancel = listB.sink((value) => {
      seen.push(snapshot(value));
    });

    heldIds.add(listB.getAsNormalizedFullLink().id);
    const first = append(b, doc, "e3");
    const second = append(b, doc, "e4");
    await held.promise;
    expect(listB.get()).toEqual(["e1", "e2", "e3", "e4"]);

    heldIds.clear();
    expect((await append(a, doc, "x")).error).toBeUndefined();
    await flush();
    expect(listB.get()).toEqual(["e1", "e2", "x"]);

    release.resolve();
    expect(errorNameOf(await first)).toBe("ConflictError");
    expect(errorNameOf(await second)).toBe("ConflictError");
    await flush();
    await b.runtime.idle();
    cancel();

    expect(listB.get()).toEqual(["e1", "e2", "x"]);
    expect(
      seen.filter((value) =>
        Array.isArray(value) && value.includes("x") && value.includes("e3")
      ),
    ).toEqual([]);
  });

  it("keeps a pending write whose document the frame left alone", async () => {
    // A frame carrying another document says nothing about this one's read.
    const a = connect();
    const b = connect();
    await seed(a, "doomed-mine", ["e1"]);
    await seed(a, "doomed-theirs", ["t1"]);
    const mine = b.runtime.getCell(space, "doomed-mine", listSchema);
    const theirs = b.runtime.getCell(space, "doomed-theirs", listSchema);
    await mine.sync();
    await theirs.sync();
    await flush();
    await b.storage.synced();

    heldIds.add(mine.getAsNormalizedFullLink().id);
    const bVerdict = append(b, "doomed-mine", "e2");
    await held.promise;

    heldIds.clear();
    expect((await append(a, "doomed-theirs", "t2")).error).toBeUndefined();
    await flush();
    expect(mine.get()).toEqual(["e1", "e2"]);
    expect(theirs.get()).toEqual(["t1", "t2"]);

    release.resolve();
    expect((await bVerdict).error).toBeUndefined();
    await flush();
    expect(mine.get()).toEqual(["e1", "e2"]);
    expect(verdicts).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("leaves a narrower read for the store to judge", async () => {
    // B reads and writes only `items`; A writes `other`. The frame moves the
    // document, but B's read does not cover every write, so the replica
    // keeps the layer and the store, which knows the paths, accepts it.
    const doc = "doomed-narrow";
    const a = connect();
    const b = connect();
    await a.runtime.getCell(space, doc, recordSchema).sync();
    const seedTx = a.runtime.edit();
    a.runtime.getCell(space, doc, recordSchema, seedTx).set({
      items: ["e1"],
      other: 0,
    });
    expect(
      (await seedTx.commit({ holdSyncedUntilCovered: false }).verdict).error,
    )
      .toBeUndefined();
    const recordB = b.runtime.getCell(space, doc, recordSchema);
    await recordB.sync();
    await flush();
    await b.storage.synced();

    heldIds.add(recordB.getAsNormalizedFullLink().id);
    const txB = b.runtime.edit();
    const itemsB = recordB.withTx(txB).key("items");
    itemsB.set([...(itemsB.get() as string[]), "e2"]);
    const bVerdict = txB.commit({ holdSyncedUntilCovered: false }).verdict;
    await held.promise;

    heldIds.clear();
    const txA = a.runtime.edit();
    a.runtime.getCell(space, doc, recordSchema, txA).key("other").set(1);
    expect((await txA.commit({ holdSyncedUntilCovered: false }).verdict).error)
      .toBeUndefined();
    await flush();
    expect(recordB.get()).toEqual({ items: ["e1", "e2"], other: 1 });

    release.resolve();
    expect((await bVerdict).error).toBeUndefined();
    await flush();
    await b.storage.synced();
    expect(recordB.get()).toEqual({ items: ["e1", "e2"], other: 1 });
  });
});
