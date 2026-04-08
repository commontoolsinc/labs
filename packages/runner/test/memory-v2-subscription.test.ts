import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { Server as MemoryV2Server } from "@commonfabric/memory/v2/server";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
  StorageNotification,
} from "../src/storage/interface.ts";
import type { MIME, URI } from "@commonfabric/memory/interface";
import { createGraphFixture } from "./memory-v2-graph.fixture.ts";

const signer = await Identity.fromPassphrase("memory-v2-storage-subscription");
const space = signer.did();

class Subscription implements IStorageNotification {
  notifications: StorageNotification[] = [];

  next(notification: StorageNotification) {
    this.notifications.push(notification);
    return { done: false };
  }

  get commits() {
    return this.notifications.filter((notification) =>
      notification.type === "commit"
    );
  }

  get reverts() {
    return this.notifications.filter((notification) =>
      notification.type === "revert"
    );
  }

  get pulls() {
    return this.notifications.filter((notification) =>
      notification.type === "pull"
    );
  }

  clear() {
    this.notifications = [];
  }
}

const waitFor = async (
  predicate: () => boolean,
  timeout = 250,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const visibleIds = (
  provider: { get(uri: URI): { value?: unknown } | undefined },
  ids: readonly URI[],
) => ids.filter((id) => provider.get(id)?.value !== undefined).sort();

describe("Memory v2 storage notifications", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let remoteClient: MemoryV2Client.Client;
  let remoteSession: MemoryV2Client.SpaceSession;
  let remoteLocalSeq: number;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });
    tx = runtime.edit();

    const candidate = storageManager as unknown as {
      server?: () => MemoryV2Server;
    };
    if (typeof candidate.server !== "function") {
      throw new Error("Expected a memory/v2 emulated storage manager");
    }
    remoteClient = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(candidate.server()),
    });
    remoteSession = await remoteClient.mount(space);
    remoteLocalSeq = 1;
  });

  afterEach(async () => {
    const status = tx?.status();
    if (status?.status === "ready") {
      await tx.commit();
    }
    await runtime.dispose();
    await remoteClient.close();
    await storageManager.close();
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it("emits a commit notification with optimistic changes", async () => {
    const subscription = new Subscription();
    runtime.storageManager.subscribe(subscription);

    const uri = `of:memory-v2-commit-${Date.now()}` as URI;
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: [],
    }, { value: "hello" });

    await tx.commit();

    expect(subscription.commits.length).toBeGreaterThanOrEqual(1);
    expect(subscription.commits.at(-1)).toMatchObject({
      type: "commit",
      space,
      source: tx.tx,
    });
    expect(
      [...subscription.commits.at(-1)!.changes].map((change) => change.after),
    )
      .toContainEqual({ value: "hello" });
  });

  it("emits precise commit notification paths for nested v2 writes", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-precise-commit-${Date.now()}` as URI;
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: [],
    }, { value: { profile: { name: "Ada", title: "Dr" } } });
    await tx.commit();

    subscription.clear();

    tx = runtime.edit();
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: ["value", "profile", "name"],
    }, "Grace");
    await tx.commit();

    const commit = subscription.commits.at(-1);
    expect(commit).toMatchObject({
      type: "commit",
      space,
      source: tx.tx,
    });

    const changes = [...commit!.changes];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      address: {
        id: uri,
        type: "application/json",
        path: ["value", "profile", "name"],
      },
      before: { value: { profile: { name: "Ada", title: "Dr" } } },
      after: { value: { profile: { name: "Grace", title: "Dr" } } },
    });
  });

  it("emits array-path commit notification paths for v2 shape changes", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-precise-array-${Date.now()}` as URI;
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: [],
    }, { value: { tags: ["alpha", "beta", "gamma"] } });
    await tx.commit();

    subscription.clear();

    tx = runtime.edit();
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: ["value", "tags", "length"],
    }, 2);
    await tx.commit();

    const commit = subscription.commits.at(-1);
    expect(commit).toMatchObject({
      type: "commit",
      space,
      source: tx.tx,
    });

    const changes = [...commit!.changes];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      address: {
        id: uri,
        type: "application/json",
        path: ["value", "tags"],
      },
      before: { value: { tags: ["alpha", "beta", "gamma"] } },
      after: { value: { tags: ["alpha", "beta"] } },
    });
  });

  it("emits a revert notification when a v2 commit conflicts", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-conflict-${Date.now()}` as URI;
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 1 } },
      }],
    });

    const { replica: openedReplica } = storageManager.open(space);
    const replica = openedReplica as typeof openedReplica & {
      commitNative: (
        transaction: unknown,
        source?: unknown,
      ) => Promise<{ ok?: unknown; error?: unknown }>;
    };
    await storageManager.open(space).sync(uri);

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 3 } },
      }],
    });
    await waitFor(() =>
      JSON.stringify(
        replica.get({ id: uri, type: "application/json" as MIME })?.is,
      ) ===
        JSON.stringify({ value: { version: 3 } })
    );

    const source = {
      getReadActivities() {
        return [{
          space,
          id: uri,
          type: "application/json",
          path: [],
          meta: { seq: 1 },
        }];
      },
    } as any;

    const factAddress = { id: uri, type: "application/json" as MIME };
    if (!replica.commitNative) {
      throw new Error("Expected memory v2 replica to support commitNative()");
    }
    const commitPromise = replica.commitNative({
      operations: [{
        op: "set",
        id: uri,
        type: "application/json",
        value: { value: { version: 2 } },
      }],
    }, source);
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 2 } });

    const result = await commitPromise;
    expect(result.ok).toBeFalsy();
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });

    expect(subscription.reverts).toHaveLength(1);
    expect(subscription.reverts[0]).toMatchObject({
      type: "revert",
      space,
      source,
    });
    expect(subscription.reverts[0].reason.name).toBe("ConflictError");
    expect([...subscription.reverts[0].changes]).toContainEqual({
      address: {
        id: uri,
        type: "application/json",
        path: ["value", "version"],
      },
      before: { value: { version: 2 } },
      after: { value: { version: 3 } },
    });
  });

  it("refreshes subscribed state before a conflict revert resolves", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-retry-${Date.now()}` as URI;
    const provider = storageManager.open(space);
    const replica = provider.replica as typeof provider.replica & {
      commitNative: (
        transaction: unknown,
        source?: unknown,
      ) => Promise<{ ok?: unknown; error?: unknown }>;
    };
    await provider.sync(uri);

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 1 } },
      }],
    });
    await waitFor(() =>
      JSON.stringify(
        replica.get({ id: uri, type: "application/json" as MIME })?.is,
      ) ===
        JSON.stringify({ value: { version: 1 } })
    );

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 3 } },
      }],
    });

    const source = {
      getReadActivities() {
        return [{
          space,
          id: uri,
          type: "application/json",
          path: [],
          meta: { seq: 1 },
        }];
      },
    } as any;

    const factAddress = { id: uri, type: "application/json" as MIME };
    if (!replica.commitNative) {
      throw new Error("Expected memory v2 replica to support commitNative()");
    }
    const commitPromise = replica.commitNative({
      operations: [{
        op: "set",
        id: uri,
        type: "application/json",
        value: { value: { version: 2 } },
      }],
    }, source);
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 2 } });

    const result = await commitPromise;
    expect(result.ok).toBeFalsy();
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });
    expect(subscription.reverts.at(-1)).toMatchObject({
      type: "revert",
      space,
      source,
    });
    expect(subscription.reverts.at(-1)?.reason.name).toBe("ConflictError");
  });

  it("does not emit duplicate pull notifications for unchanged v2 sync results", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-pull-dedupe-${Date.now()}` as URI;
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: {
          value: {
            items: [
              { count: 1, label: "one" },
              { count: 2, label: "two" },
            ],
          },
        },
      }],
    });

    const provider = storageManager.open(space);
    await provider.sync(uri, {
      path: ["items", "0", "count"],
      schema: false,
    });
    expect(subscription.pulls).toHaveLength(1);

    await provider.sync(uri, {
      path: ["items", "1", "count"],
      schema: false,
    });
    expect(subscription.pulls).toHaveLength(1);
  });

  it("expands subscribed graph state to previously existing hidden docs after a root retarget", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);
    const fixture = createGraphFixture(space);
    const observer = storageManager.open(space) as unknown as {
      get(uri: URI): { value: unknown } | undefined;
      sync(
        uri: URI,
        selector: { path: string[]; schema: unknown },
      ): Promise<{ ok?: Record<PropertyKey, never> }>;
    };

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: fixture.docs.map(({ id, value }) => ({
        op: "set" as const,
        id,
        value: { value },
      })),
    });

    expect(
      await observer.sync(fixture.rootId, {
        path: [],
        schema: fixture.schema,
      }),
    ).toEqual({ ok: {} });
    await storageManager.synced();
    await waitFor(
      () =>
        visibleIds(observer, fixture.expandedReachableIds).length ===
          fixture.initialReachableIds.length,
      1_000,
    );
    expect(visibleIds(observer, fixture.expandedReachableIds)).toEqual(
      fixture.initialReachableIds,
    );

    subscription.clear();
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: fixture.rootId,
        value: { value: fixture.expandedRootValue },
      }],
    });
    await storageManager.synced();
    await waitFor(
      () =>
        visibleIds(observer, fixture.expandedReachableIds).length ===
          fixture.expandedReachableIds.length,
      1_000,
    );

    expect(visibleIds(observer, fixture.expandedReachableIds)).toEqual(
      fixture.expandedReachableIds,
    );
    const integrateIds = subscription.notifications
      .filter((notification) => notification.type === "integrate")
      .flatMap((notification) =>
        "changes" in notification
          ? [...notification.changes].map((change) => change.address.id as URI)
          : []
      );
    expect(integrateIds).toContain(fixture.hiddenRootId);
    expect(integrateIds).toContain("of:test-node-63");
  });
});
