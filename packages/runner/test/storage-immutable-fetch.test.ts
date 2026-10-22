import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  resetServerExecutionConfig,
  setServerExecutionConfig,
  type ViewPlan,
} from "@commonfabric/memory/v2";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
} from "@commonfabric/memory/v2/client";
import { SessionRegistry } from "@commonfabric/memory/v2/server";

import { SpaceReplica } from "../src/storage/v2.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("immutable schema fetch");
const space = signer.did();
const rootOnly = { path: [], schema: false } as const;
const cid = (value: EntityDocument["value"]): URI =>
  `cid:${taggedHashStringOf(value)}`;

describe("immutable document fetching", () => {
  let server: ReturnType<typeof newSharedServer>;
  let sessions: SessionRegistry;
  let manager: TestStorageManager;
  let writer: Client;
  let writerSession: SpaceSession;
  let readerSession: SpaceSession;
  let replica: SpaceReplica;
  let localSeq: number;
  const cleanup: (() => void)[] = [];

  beforeEach(async () => {
    sessions = new SessionRegistry();
    server = newSharedServer({
      subscriptionRefreshDelayMs: "manual",
      sessions,
    });
    writer = await connect({ transport: loopback(server) });
    writerSession = await writer.mount(
      space,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    manager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, {
      async create(target, identity, options) {
        const client = await connect({ transport: loopback(server) });
        readerSession = await client.mount(
          target,
          options,
          testPrincipalSessionOpenAuthFactory(identity),
        );
        return { client, session: readerSession };
      },
    });
    const opened = manager.open(space).replica;
    if (!(opened instanceof SpaceReplica)) {
      throw new Error("Expected a remote space replica");
    }
    replica = opened;
    localSeq = 0;
  });

  afterEach(async () => {
    for (const cancel of cleanup.splice(0).reverse()) cancel();
    await manager.close();
    await writer.close();
    await server.close();
  });

  async function write(documents: [URI, EntityDocument][]) {
    await writerSession.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: documents.map(([id, value]) => ({ op: "set", id, value })),
    });
  }

  function readerState() {
    return server.accessForTestingOnly.sessionsForSpace(space).find((session) =>
      session.id === readerSession.sessionId
    )!;
  }

  it("fetches concurrent immutable roots and their schema closure without retaining server interests", async () => {
    const child = { type: "string", description: "fetch closure child" };
    const childId = cid(child);
    const parent = { type: "object", properties: { name: { $ref: childId } } };
    const parentId = cid(parent);
    const label = { type: "number", description: "fetch closure label" };
    const labelId = cid(label);
    await write([
      [childId, { value: child }],
      [parentId, { value: parent }],
      [labelId, { value: label }],
    ]);
    const query = stub(server, "graphQuery", server.graphQuery.bind(server));
    cleanup.push(query.restore);
    const provider = manager.open(space);
    const results = await Promise.all([
      provider.sync(parentId, rootOnly),
      provider.sync(labelId, rootOnly),
      provider.sync(parentId, rootOnly),
    ]);
    expect(results.every((result) => result.error === undefined)).toBe(true);
    expect(query.calls).toHaveLength(1);
    for (
      const [id, value] of [
        [parentId, parent],
        [childId, child],
        [labelId, label],
      ] as const
    ) {
      expect(replica.getDocument(id)?.value).toEqual(value);
      expect(replica.isConfirmedDocument(id)).toBe(true);
    }
    expect(readerState().watches).toEqual([]);
    expect(readerState().graphs.size).toBe(0);
    expect(readerState().entities.size).toBe(0);
    expect(replica.holdings()).toEqual([]);
    expect(replica.completeThroughSeq()).toBeUndefined();
    await provider.sync(childId, rootOnly);
    await provider.sync(parentId, rootOnly);
    expect(query.calls).toHaveLength(1);
  });

  it("keeps an absent immutable root watched so a later creation arrives", async () => {
    const value = { type: "string", description: "late schema" };
    const id = cid(value);
    expect((await manager.open(space).sync(id, rootOnly)).error)
      .toBeUndefined();
    expect(replica.getDocument(id)).toBeUndefined();
    expect(readerState().watches).toHaveLength(1);
    await write([[id, { value }]]);
    await server.idle();
    await manager.pullOpenSpacesToHead();
    expect(replica.getDocument(id)?.value).toEqual(value);
    expect(replica.isConfirmedDocument(id)).toBe(true);
  });

  it("reuses an acknowledged immutable write without querying or watching it", async () => {
    const value = { type: "string", description: "acknowledged schema" };
    const id = cid(value);
    const provider = manager.open(space);
    expect((await replica.send([{ uri: id, document: { value } }])).error)
      .toBeUndefined();
    const query = stub(server, "graphQuery", server.graphQuery.bind(server));
    cleanup.push(query.restore);
    expect((await provider.sync(id, rootOnly)).error).toBeUndefined();
    expect(query.calls).toHaveLength(0);
    expect(replica.getDocument(id)?.value).toEqual(value);
    expect(readerState().watches).toEqual([]);
    expect(replica.holdings()).toEqual([]);
  });

  it("does not treat an optimistic immutable write as server persistence", async () => {
    const value = { type: "string", description: "pending schema" };
    const id = cid(value);
    const provider = manager.open(space);
    await replica.ensureSession();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const original = readerSession.transact.bind(readerSession);
    const held = stub(
      readerSession,
      "transact",
      async (commit, beforeIssue) => {
        entered.resolve();
        await release.promise;
        const result = await original(commit, beforeIssue);
        accepted.resolve();
        return result;
      },
    );
    cleanup.push(held.restore, release.resolve);
    const writing = replica.send([{ uri: id, document: { value } }]);
    await entered.promise;
    expect(replica.getDocument(id)?.value).toEqual(value);
    const query = stub(server, "graphQuery", server.graphQuery.bind(server));
    cleanup.push(query.restore);
    expect((await provider.sync(id, rootOnly)).error).toBeUndefined();
    expect(query.calls).toHaveLength(1);
    expect(readerState().watches).toHaveLength(1);
    release.resolve();
    await accepted.promise;
    await server.idle();
    expect((await writing).error).toBeUndefined();
    await manager.pullOpenSpacesToHead();
    expect(replica.getDocument(id)?.value).toEqual(value);
    expect(replica.isConfirmedDocument(id)).toBe(true);
  });

  it("fetches an acknowledged root whose schema dependencies are not local", async () => {
    const child = { type: "string", description: "remote dependency" };
    const childId = cid(child);
    const value = { type: "object", properties: { name: { $ref: childId } } };
    const id = cid(value);
    await write([[childId, { value: child }]]);
    expect((await replica.send([{ uri: id, document: { value } }])).error)
      .toBeUndefined();
    expect(replica.getDocument(childId)).toBeUndefined();
    const query = stub(server, "graphQuery", server.graphQuery.bind(server));
    cleanup.push(query.restore);
    expect((await manager.open(space).sync(id, rootOnly)).error)
      .toBeUndefined();
    expect(query.calls).toHaveLength(1);
    expect(replica.getDocument(childId)?.value).toEqual(child);
    expect(readerState().watches).toEqual([]);
  });

  it("keeps traversals of mutable targets reactive after fetching their immutable root", async () => {
    const target = "of:immutable-fetch-target";
    const value = {
      target: { "/": { [LINK_V1_TAG]: { id: target, path: [] } } },
    };
    const id = cid(value);
    await write([[id, { value }], [target, { value: "before" }]]);
    const provider = manager.open(space);
    expect((await provider.sync(id, rootOnly)).error).toBeUndefined();
    expect(replica.getDocument(target)).toBeUndefined();
    expect((await provider.sync(id, { path: [], schema: true })).error)
      .toBeUndefined();
    expect(readerState().watches).toHaveLength(1);
    expect(replica.getDocument(target)?.value).toBe("before");
    await write([[target, { value: "after" }]]);
    await server.idle();
    await manager.pullOpenSpacesToHead();
    expect(replica.getDocument(target)?.value).toBe("after");
  });

  it("retains fetched content when a separate watch removes it", async () => {
    const value = { type: "string", description: "retained schema" };
    const id = cid(value);
    await write([[id, { value }]]);
    const provider = manager.open(space);
    await provider.sync(id, rootOnly);
    await provider.sync(id, { path: [], schema: true });
    expect(replica.holdings().some((holding) => holding.id === id)).toBe(true);
    const removed = await readerSession.watchRemoveSync(
      readerState().watches.map((watch) => watch.id),
    );
    for (const frame of [...removed.precedingSyncs, removed.sync]) {
      replica.accessForTestingOnly.applySessionSync(frame, "pull");
    }
    expect(removed.sync.removes.some((entry) => entry.id === id)).toBe(true);
    expect(replica.getDocument(id)?.value).toEqual(value);
    expect(replica.isConfirmedDocument(id)).toBe(true);
    expect(replica.holdings()).toEqual([]);
  });

  it("does not remove a server watch for a fetched-only root during release", async () => {
    const value = { type: "string", description: "fetched-only release" };
    const id = cid(value);
    await write([[id, { value }]]);
    const provider = manager.open(space);
    expect((await provider.sync(id, rootOnly)).error).toBeUndefined();
    const removal = stub(
      server,
      "watchRemove",
      server.watchRemove.bind(server),
    );
    cleanup.push(removal.restore);

    await replica.releaseUnread();
    await replica.releaseUnread();

    expect(removal.calls).toHaveLength(0);
    expect(readerState().watches).toEqual([]);
    expect(replica.getDocument(id)?.value).toEqual(value);
    expect(replica.holdings()).toEqual([]);
  });

  it("keeps fetched content when release drops its overlapping traversal and mutable target", async () => {
    const target = "of:released-immutable-target";
    const value = {
      target: { "/": { [LINK_V1_TAG]: { id: target, path: [] } } },
    };
    const id = cid(value);
    await write([[id, { value }], [target, { value: "before release" }]]);
    const provider = manager.open(space);
    expect((await provider.sync(id, rootOnly)).error).toBeUndefined();
    expect((await provider.sync(id, { path: [], schema: true })).error)
      .toBeUndefined();
    expect(replica.getDocument(target)?.value).toBe("before release");
    expect(readerState().watches).toHaveLength(1);

    await replica.releaseUnread();
    await replica.releaseUnread();

    expect(readerState().watches).toEqual([]);
    expect(replica.getDocument(target)).toBeUndefined();
    expect(replica.getDocument(id)?.value).toEqual(value);
    expect(replica.isConfirmedDocument(id)).toBe(true);
    expect(replica.holdings()).toEqual([]);
    const query = stub(server, "graphQuery", server.graphQuery.bind(server));
    cleanup.push(query.restore);
    expect((await provider.sync(id, rootOnly)).error).toBeUndefined();
    expect(query.calls).toHaveLength(0);
    expect(replica.getDocument(id)?.value).toEqual(value);

    await write([[target, { value: "after release" }]]);
    expect((await provider.sync(id, { path: [], schema: true })).error)
      .toBeUndefined();
    expect(readerState().watches).toHaveLength(1);
    expect(replica.getDocument(target)?.value).toBe("after release");
  });

  it("falls back from a forged snapshot without failing healthy reads in the batch", async () => {
    const value = { type: "string", description: "verified schema" };
    const id = cid(value);
    const healthy = { type: "boolean", description: "healthy batched schema" };
    const healthyId = cid(healthy);
    const mutableId = "of:healthy-forged-batch";
    await write([
      [id, { value }],
      [healthyId, { value: healthy }],
      [mutableId, { value: "mutable" }],
    ]);
    const original = server.graphQuery.bind(server);
    const corrupt = stub(server, "graphQuery", async (message) => {
      const response = await original(message);
      if (response.ok) {
        response.ok.entities = response.ok.entities.map((entity) =>
          entity.id === id
            ? { ...entity, document: { value: { type: "number" } } }
            : entity
        );
      }
      return response;
    });
    cleanup.push(() => {
      if (!corrupt.restored) corrupt.restore();
    });
    const provider = manager.open(space);
    const results = await Promise.all([
      provider.sync(id, rootOnly),
      provider.sync(healthyId, rootOnly),
      provider.sync(mutableId, rootOnly),
    ]);
    expect(results.map((result) => result.error)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(replica.getDocument(id)?.value).toEqual(value);
    expect(replica.getDocument(healthyId)?.value).toEqual(healthy);
    expect(replica.getDocument(mutableId)?.value).toBe("mutable");
    expect(replica.holdings().map((holding) => holding.id).sort()).toEqual(
      [id, mutableId].sort(),
    );
  });

  it("falls back from an incomplete closure without failing healthy reads in the batch", async () => {
    setServerExecutionConfig(false);
    cleanup.push(resetServerExecutionConfig);
    const child = { type: "number", description: "missing fetch closure" };
    const childId = cid(child);
    const value = { type: "object", properties: { count: { $ref: childId } } };
    const id = cid(value);
    const healthy = { type: "boolean", description: "healthy closure batch" };
    const healthyId = cid(healthy);
    const mutableId = "of:healthy-closure-batch";
    const watchedId = "of:fetch-coverage";
    await write([
      [childId, { value: child }],
      [id, { value }],
      [healthyId, { value: healthy }],
      [mutableId, { value: "mutable" }],
      [watchedId, { value: "before" }],
    ]);
    const provider = manager.open(space);
    expect((await provider.sync(watchedId, rootOnly)).error).toBeUndefined();
    await write([[watchedId, { value: "after" }]]);
    await server.idle();
    await manager.pullOpenSpacesToHead();
    const completeThrough = replica.completeThroughSeq();
    expect(completeThrough).toBeGreaterThan(0);
    const plan: ViewPlan = {
      id: "healthy-view",
      revision: 0,
      generation: 1,
      eligibleActions: ["preview"],
      pieces: [],
    };
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
      viewPlans: [plan],
    }, "integrate");
    const plans: (readonly ViewPlan[])[] = [];
    cleanup.push(replica.subscribeViewPlans((value) => plans.push(value)));
    const original = server.graphQuery.bind(server);
    const incomplete = stub(server, "graphQuery", async (message) => {
      const response = await original(message);
      if (response.ok) {
        response.ok.entities = response.ok.entities.filter((entity) =>
          entity.id !== childId
        );
      }
      return response;
    });
    cleanup.push(() => {
      if (!incomplete.restored) incomplete.restore();
    });
    const results = await Promise.all([
      provider.sync(id, rootOnly),
      provider.sync(healthyId, rootOnly),
      provider.sync(mutableId, rootOnly),
    ]);
    expect(results.map((result) => result.error)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(replica.getDocument(id)?.value).toEqual(value);
    expect(replica.getDocument(childId)?.value).toEqual(child);
    expect(replica.getDocument(healthyId)?.value).toEqual(healthy);
    expect(replica.getDocument(mutableId)?.value).toBe("mutable");
    const holdings = replica.holdings().map((holding) => holding.id);
    expect(holdings).toContain(id);
    expect(holdings).toContain(mutableId);
    expect(holdings).not.toContain(healthyId);
    expect(replica.completeThroughSeq()).toBe(completeThrough);
    expect(plans).toEqual([[plan]]);
  });

  it("discards an in-flight fetch after reset and refetches into the new replica state", async () => {
    const value = { type: "string", description: "reset schema" };
    const id = cid(value);
    await write([[id, { value }]]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = server.graphQuery.bind(server);
    const held = stub(server, "graphQuery", async (message) => {
      const response = await original(message);
      entered.resolve();
      await release.promise;
      return response;
    });
    cleanup.push(() => {
      if (!held.restored) held.restore();
    }, release.resolve);
    const provider = manager.open(space);
    const pending = provider.sync(id, rootOnly);
    await entered.promise;
    replica.reset();
    release.resolve();
    expect((await pending).error).toBeDefined();
    expect(replica.getDocument(id)).toBeUndefined();
    held.restore();
    expect((await provider.sync(id, rootOnly)).error).toBeUndefined();
    expect(replica.getDocument(id)?.value).toEqual(value);
  });

  it("honors terminal authorization loss before reusing fetched content", async () => {
    const value = { type: "string", description: "revoked schema" };
    const id = cid(value);
    await write([[id, { value }]]);
    const provider = manager.open(space);
    await provider.sync(id, rootOnly);
    sessions.remove(space, readerSession.sessionId);
    readerSession.handleRevoked("unauthorized");
    expect((await provider.sync(id, rootOnly)).error?.name).toBe(
      "AuthorizationError",
    );
    expect(manager.spaceAccessError(space)?.name).toBe("AuthorizationError");
    const revoked = readerSession;
    manager.noteSpaceAclChanged(space);
    expect((await provider.sync(id, rootOnly)).error).toBeUndefined();
    expect(readerSession).not.toBe(revoked);
    expect(manager.spaceAccessError(space)).toBeUndefined();
    expect(readerState().watches).toEqual([]);
  });

  it("discards a fetch reset while waiting for session restoration", async () => {
    const value = { type: "string", description: "reset before query" };
    const id = cid(value);
    await write([[id, { value }]]);
    await replica.ensureSession();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = readerSession.whenRestored.bind(readerSession);
    const held = stub(readerSession, "whenRestored", async () => {
      entered.resolve();
      await release.promise;
      await original();
    });
    cleanup.push(held.restore, release.resolve);
    const pending = manager.open(space).sync(id, rootOnly);
    await entered.promise;
    replica.reset();
    release.resolve();
    expect((await pending).error?.message).toContain("outlived its replica");
    expect(replica.getDocument(id)).toBeUndefined();
    expect(readerState().watches).toEqual([]);
  });

  it("refuses a response received after its session loses access", async () => {
    const value = { type: "string", description: "revoked in-flight schema" };
    const id = cid(value);
    await write([[id, { value }]]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = server.graphQuery.bind(server);
    const held = stub(server, "graphQuery", async (message) => {
      const response = await original(message);
      entered.resolve();
      await release.promise;
      return response;
    });
    cleanup.push(held.restore, release.resolve);
    const pending = manager.open(space).sync(id, rootOnly);
    await entered.promise;
    sessions.remove(space, readerSession.sessionId);
    readerSession.handleRevoked("unauthorized");
    release.resolve();
    expect((await pending).error?.name).toBe("AuthorizationError");
    expect(replica.getDocument(id)).toBeUndefined();
    expect(replica.holdings()).toEqual([]);
  });
});
