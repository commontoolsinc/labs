import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { defer } from "@commonfabric/utils/defer";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { Server as MemoryV2Server } from "@commonfabric/memory/v2/server";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  type SessionFactory,
  setConflictAdmissionEnabled,
  setConflictAdmissionMode,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
  IStorageNotification,
  StorageNotification,
  StorageTransactionRejected,
} from "../src/storage/interface.ts";
import type { MIME, URI } from "@commonfabric/memory/interface";
import type { SessionSync } from "@commonfabric/memory/v2";
import { createGraphFixture } from "./memory-v2-graph.fixture.ts";
import { testSessionOpenAuthFactory } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-storage-subscription");
const space = signer.did();

class Subscription implements IStorageNotification {
  notifications: StorageNotification[] = [];
  onNotification?: (notification: StorageNotification) => void;

  next(notification: StorageNotification) {
    this.notifications.push(notification);
    this.onNotification?.(notification);
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

const notificationCarries = (
  notification: StorageNotification,
  uri: URI,
  after: unknown,
): boolean =>
  "changes" in notification &&
  [...notification.changes].some((change) =>
    change.address.id === uri &&
    JSON.stringify(change.after) === JSON.stringify(after)
  );

const visibleIds = (
  provider: { get(uri: URI): { value?: unknown } | undefined },
  ids: readonly URI[],
) => ids.filter((id) => provider.get(id)?.value !== undefined).sort();

const staleReadSource = (uri: URI, seq: number) => ({
  getReadActivities(): Iterable<IReadActivity> {
    return [{
      space,
      id: uri,
      type: "application/json",
      path: [],
      meta: { seq },
    }];
  },
});

type RetryRepairHarness = {
  noteCaughtUpLocalSeq(localSeq: number | undefined): void;
  waitForCaughtUpLocalSeq(localSeq: number): Promise<void>;
  rejectCaughtUpLocalSeqWaiters(error: Error): void;
  closeNow(): void;
  waitForConflictReadRepair(
    rejection: StorageTransactionRejected,
  ): Promise<void>;
};

type WatchRefreshHarness = {
  closeNow(): void;
  refreshWatchSet(
    entries: Iterable<[
      { id: URI; type: MIME; scope?: string },
      { path: string[]; schema: false },
    ]>,
  ): Promise<{ ok?: unknown; error?: { message?: string } }>;
};

const retryRepairHarness = (replica: unknown): RetryRepairHarness =>
  replica as RetryRepairHarness;

const syntheticConflict = (
  uri: URI,
  readyToRetry: () => Promise<void>,
): StorageTransactionRejected => ({
  name: "ConflictError",
  message: "synthetic conflict",
  transaction: {
    iss: space,
    cmd: "/memory/transact",
    sub: space,
    args: { changes: {} },
    prf: [],
  },
  conflict: {
    space,
    the: "application/json",
    of: uri,
    expected: null,
    actual: null,
    existsInHistory: false,
    history: [],
  },
  readyToRetry,
});

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
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
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
    remoteSession = await remoteClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
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
        scope: "space",
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
        scope: "space",
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

    const gotVersion3 = defer<void>();
    subscription.onNotification = (notification) => {
      if (notificationCarries(notification, uri, { value: { version: 3 } })) {
        gotVersion3.resolve();
      }
    };
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 3 } },
      }],
    });
    await gotVersion3.promise;

    const source = staleReadSource(uri, 1);

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
        scope: "space",
        path: ["value", "version"],
      },
      before: { value: { version: 2 } },
      after: { value: { version: 3 } },
    });
  });

  it("reverts a non-conflicting sibling write to current while the conflicting doc lands fresh", async () => {
    // tx writes A and B; only B conflicts. The whole tx is rejected, so A's
    // optimistic write must roll back (it is NOT in the catch-up sync), while B
    // must land on the CURRENT confirmed value (fresh), never on past data.
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const aUri = `of:memory-v2-revert-sibling-a-${Date.now()}` as URI;
    const bUri = `of:memory-v2-revert-sibling-b-${Date.now()}` as URI;
    const aAddress = { id: aUri, type: "application/json" as MIME };
    const bAddress = { id: bUri, type: "application/json" as MIME };

    const provider = storageManager.open(space);
    const replica = provider.replica as typeof provider.replica & {
      commitNative: (
        transaction: unknown,
        source?: unknown,
      ) => Promise<{ ok?: unknown; error?: { name?: string } }>;
    };

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: aUri, value: { value: { a: 1 } } },
        { op: "set", id: bUri, value: { value: { b: 1 } } },
      ],
    });
    await provider.sync(aUri);
    await provider.sync(bUri);

    // Another writer advances ONLY B to b:3; A stays at a:1.
    const gotB3 = defer<void>();
    subscription.onNotification = (notification) => {
      if (notificationCarries(notification, bUri, { value: { b: 3 } })) {
        gotB3.resolve();
      }
    };
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: bUri, value: { value: { b: 3 } } }],
    });
    await gotB3.promise;

    // Local tx writes both A and B optimistically; a stale read of B forces the
    // conflict. Whole tx is rejected.
    const result = await replica.commitNative({
      operations: [
        {
          op: "set",
          id: aUri,
          type: "application/json",
          value: { value: { a: 10 } },
        },
        {
          op: "set",
          id: bUri,
          type: "application/json",
          value: { value: { b: 20 } },
        },
      ],
    }, staleReadSource(bUri, 1));

    expect(result.ok).toBeFalsy();
    expect(result.error?.name).toBe("ConflictError");

    // A rolled back to its confirmed (current) value; B at the fresh current
    // value — not the optimistic 20 and not the past 1.
    expect(replica.get(aAddress)?.is).toEqual({ value: { a: 1 } });
    expect(replica.get(bAddress)?.is).toEqual({ value: { b: 3 } });

    // One revert notification carrying BOTH the sibling rollback and the fresh
    // value, each reverting to current.
    expect(subscription.reverts).toHaveLength(1);
    const changes = [...subscription.reverts[0].changes];
    expect(changes).toContainEqual({
      address: {
        id: aUri,
        type: "application/json",
        scope: "space",
        path: ["value", "a"],
      },
      before: { value: { a: 10 } },
      after: { value: { a: 1 } },
    });
    expect(changes).toContainEqual({
      address: {
        id: bUri,
        type: "application/json",
        scope: "space",
        path: ["value", "b"],
      },
      before: { value: { b: 20 } },
      after: { value: { b: 3 } },
    });
  });

  it("refreshes subscribed state before conflict readyToRetry resolves", async () => {
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

    const gotVersion1 = defer<void>();
    subscription.onNotification = (notification) => {
      if (notificationCarries(notification, uri, { value: { version: 1 } })) {
        gotVersion1.resolve();
      }
    };
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 1 } },
      }],
    });
    await gotVersion1.promise;

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 3 } },
      }],
    });

    const source = staleReadSource(uri, 1);

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
    // The inline read-repair (waitForConflictReadRepair) must have applied the
    // caught-up sync BEFORE the commit resolves — so confirmed state already
    // reflects version 3 here, without any explicit readyToRetry() call. This
    // guards the repair-before-revert ordering: removing the inline wait leaves
    // this at the stale/optimistic value.
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });
    expect(subscription.reverts.at(-1)).toMatchObject({
      type: "revert",
      space,
      source,
    });
    const reason = subscription.reverts.at(-1)?.reason;
    if (reason?.name !== "ConflictError") {
      throw new Error(`Expected ConflictError, got ${reason?.name}`);
    }
    expect(reason.retryAfterSeq).toBe(2);
    expect(typeof reason.readyToRetry).toBe("function");
    await reason.readyToRetry?.();
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });

    await storageManager.close();
    await assertRejects(
      () => reason.readyToRetry?.() ?? Promise.resolve(),
      Error,
    );
  });

  it("returns the original conflict when closing during retry read repair", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const provider = storageManager.open(space);
    const replica = provider.replica as typeof provider.replica & {
      commitNative: (
        transaction: unknown,
        source?: unknown,
      ) => Promise<{ ok?: unknown; error?: unknown }>;
    };
    const repairStarted = defer<void>();
    const retryRepair = retryRepairHarness(replica);
    const waitForConflictReadRepair = retryRepair.waitForConflictReadRepair
      .bind(retryRepair);
    retryRepair.waitForConflictReadRepair = (rejection) => {
      repairStarted.resolve();
      return waitForConflictReadRepair(rejection);
    };
    const firstUri = `of:memory-v2-close-retry-a-${Date.now()}` as URI;
    const secondUri = `of:memory-v2-close-retry-b-${Date.now()}` as URI;
    const factAddress = { id: firstUri, type: "application/json" as MIME };

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: firstUri, value: { value: { version: 1 } } },
        { op: "set", id: secondUri, value: { value: { version: 1 } } },
      ],
    });
    await provider.sync(firstUri);
    await provider.sync(secondUri);

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: firstUri, value: { value: { version: 2 } } },
      ],
    });
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: secondUri, value: { value: { version: 2 } } },
      ],
    });

    const commitPromise = replica.commitNative({
      operations: [{
        op: "set",
        id: firstUri,
        type: "application/json",
        value: { value: { version: 3 } },
      }],
    }, staleReadSource(firstUri, 1));
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });

    await repairStarted.promise;
    await storageManager.close();
    const result = await commitPromise;
    expect(result.ok).toBeFalsy();
    const reason = subscription.reverts.at(-1)?.reason;
    if (reason?.name !== "ConflictError") {
      throw new Error(`Expected ConflictError, got ${reason?.name}`);
    }
    expect(result.error).toBe(reason);
    await assertRejects(
      () => reason?.readyToRetry?.() ?? Promise.resolve(),
      Error,
    );
  });

  it("rejects pending caught-up waiters when storage closes", async () => {
    const provider = storageManager.open(space);
    const harness = retryRepairHarness(provider.replica);

    const readyAtTwo = harness.waitForCaughtUpLocalSeq(2);
    const readyAtThree = harness.waitForCaughtUpLocalSeq(3);
    const rejectsAtThree = assertRejects(() => readyAtThree, Error);

    harness.noteCaughtUpLocalSeq(2);
    await readyAtTwo;
    harness.closeNow();
    await rejectsAtThree;

    await assertRejects(
      () => harness.waitForCaughtUpLocalSeq(1),
      Error,
      "memory replica closed",
    );
  });

  it("swallows a rejecting readyToRetry during read repair", async () => {
    const provider = storageManager.open(space);
    const harness = retryRepairHarness(provider.replica);
    const retryError = new Error("retry unavailable");
    let called = 0;

    // A rejecting readyToRetry must be invoked and then swallowed (logged), not
    // thrown, so the original conflict result is preserved for the caller. If
    // the repair short-circuited, `called` stays 0; if it rethrew, the await
    // would reject and fail the test.
    await harness.waitForConflictReadRepair(
      syntheticConflict(
        `of:memory-v2-retry-reject-${Date.now()}` as URI,
        () => {
          called += 1;
          return Promise.reject(retryError);
        },
      ),
    );

    expect(called).toBe(1);
  });

  it("hold-mode local check flags only provably-stale confirmed reads", async () => {
    const provider = storageManager.open(space);
    const replica = provider.replica as unknown as {
      commitReadsStaleLocally: (commit: unknown) => boolean;
    };
    const uri = `of:hold-check-${Date.now()}` as URI;

    // Establish a confirmed record with seq > 0.
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: uri, value: { value: { v: 1 } } }],
    });
    await provider.sync(uri);

    const read = (seq: number) => ({
      reads: { confirmed: [{ id: uri, path: [], seq }], pending: [] },
      operations: [],
    });
    // seq 0 is below the confirmed base -> provably stale.
    expect(replica.commitReadsStaleLocally(read(0))).toBe(true);
    // a seq at/above the confirmed base -> not provably stale, so it is sent.
    expect(replica.commitReadsStaleLocally(read(Number.MAX_SAFE_INTEGER))).toBe(
      false,
    );
  });

  it("hold mode reverts a held commit only when its read is actually stale", async () => {
    setConflictAdmissionMode("hold");
    try {
      const provider = storageManager.open(space);
      const replica = provider.replica as typeof provider.replica & {
        commitNative: (
          transaction: unknown,
          source?: unknown,
        ) => Promise<{ ok?: unknown; error?: { name?: string } }>;
        recordStaleFloor: (commit: unknown, localSeq: number) => void;
        noteCaughtUpLocalSeq: (localSeq: number | undefined) => void;
      };
      const uri = `of:hold-revert-${Date.now()}` as URI;

      await remoteSession.transact({
        localSeq: remoteLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: uri, value: { value: { v: 1 } } }],
      });
      await provider.sync(uri);

      // Floor uri so a new commit reading it is held until caughtUpLocalSeq>=5.
      replica.recordStaleFloor({
        localSeq: 5,
        reads: { confirmed: [{ id: uri, path: [], seq: 0 }], pending: [] },
        operations: [{ op: "set", id: uri, value: { value: { v: 1 } } }],
      }, 5);

      const commitPromise = replica.commitNative({
        operations: [{
          op: "set",
          id: uri,
          type: "application/json",
          value: { value: { v: 2 } },
        }],
      }, staleReadSource(uri, 0));

      // Held: not sent, not settled, until we observe the catch-up seq.
      let settled = false;
      void commitPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      replica.noteCaughtUpLocalSeq(5);
      const result = await commitPromise;
      // Read seq 0 is below the confirmed base, so the local check reverts it
      // (instead of sending a doomed commit).
      expect(result.ok).toBeFalsy();
      expect(result.error?.name).toBe("ConflictError");
    } finally {
      setConflictAdmissionMode(undefined);
    }
  });

  it("public close settles a commit held by conflict admission", async () => {
    setConflictAdmissionMode("hold");
    try {
      const provider = storageManager.open(space);
      const replica = provider.replica as typeof provider.replica & {
        commitNative: (
          transaction: unknown,
          source?: unknown,
        ) => Promise<{ ok?: unknown; error?: { name?: string } }>;
        recordStaleFloor: (commit: unknown, localSeq: number) => void;
      };
      const uri = `of:hold-close-${Date.now()}` as URI;

      replica.recordStaleFloor({
        localSeq: 5,
        reads: { confirmed: [{ id: uri, path: [], seq: 0 }], pending: [] },
        operations: [{ op: "set", id: uri, value: { value: { v: 1 } } }],
      }, 5);

      const commitPromise = replica.commitNative({
        operations: [{
          op: "set",
          id: uri,
          type: "application/json",
          value: { value: { v: 2 } },
        }],
      }, staleReadSource(uri, 0));

      let settled = false;
      void commitPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      const closeAndCommit = Promise.all([
        storageManager.close(),
        commitPromise,
      ]);
      const [, result] = await Promise.race([
        closeAndCommit,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("close timed out")), 250)
        ),
      ]);

      expect(result.ok).toBeFalsy();
      expect(result.error?.name).toBe("ConflictError");
    } finally {
      setConflictAdmissionMode(undefined);
    }
  });

  it("closes a watch refresh view that resolves after replica close", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const view = MemoryV2Client.WatchView.fromSync(sync);
    const client = {
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const session = {
      watchAddSync: () => Promise.resolve({ view, sync }),
    } as unknown as MemoryV2Client.SpaceSession;
    const sessionFactory: SessionFactory = {
      create: () => Promise.resolve({ client, session }),
    };
    class TestStorageManager extends V2StorageManager {
      constructor() {
        super({ as: signer, memoryHost: new URL("memory://") }, sessionFactory);
      }
    }
    const testStorageManager = new TestStorageManager();
    const provider = testStorageManager.open(space);
    const replica = provider.replica as unknown as WatchRefreshHarness;

    replica.closeNow();
    const result = await replica.refreshWatchSet([[
      { id: "of:late-refresh" as URI, type: "application/json" as MIME },
      { path: [], schema: false },
    ]]);

    expect(result.error?.message).toBe("memory replica closed");
    expect((await view.subscribeSync().next()).done).toBe(true);
    await testStorageManager.closeNow();
  });

  it("admission control records, thresholds, and prunes a stale floor", () => {
    const provider = storageManager.open(space);
    const replica = provider.replica as unknown as {
      recordStaleFloor: (commit: unknown, localSeq: number) => void;
      preemptThreshold: (commit: unknown) => number | undefined;
      noteCaughtUpLocalSeq: (localSeq: number | undefined) => void;
      reset: () => void;
    };
    const uri = `of:admission-floor-${Date.now()}`;
    const reading = {
      localSeq: 9,
      reads: { confirmed: [{ id: uri, path: [], seq: 0 }], pending: [] },
      operations: [{ op: "set", id: uri, value: { value: { v: 2 } } }],
    };

    // Nothing stale yet -> the read is admitted.
    expect(replica.preemptThreshold(reading)).toBeUndefined();

    // A conflict at localSeq 7 marks uri stale until caughtUpLocalSeq >= 7.
    replica.recordStaleFloor(reading, 7);
    expect(replica.preemptThreshold(reading)).toBe(7);

    // Catching up to the floor makes the id fresh again -> admitted.
    replica.noteCaughtUpLocalSeq(7);
    expect(replica.preemptThreshold(reading)).toBeUndefined();

    // A reset starts a new replica epoch; stale floors from the old epoch must
    // not hold or pre-empt post-reset commits that read the same id.
    replica.recordStaleFloor(reading, 8);
    expect(replica.preemptThreshold(reading)).toBe(8);
    replica.reset();
    expect(replica.preemptThreshold(reading)).toBeUndefined();
  });

  it("reset rejects caught-up waiters from the previous replica epoch", async () => {
    const provider = storageManager.open(space);
    const replica = provider.replica as unknown as {
      waitForCaughtUpLocalSeq: (localSeq: number) => Promise<void>;
      reset: () => void;
    };

    const wait = replica.waitForCaughtUpLocalSeq(3);
    replica.reset();

    await expect(wait).rejects.toThrow("memory replica reset");
  });

  it("pre-empts a known-stale commit instead of round-tripping when enabled", async () => {
    setConflictAdmissionEnabled(true);
    try {
      const provider = storageManager.open(space);
      const replica = provider.replica as typeof provider.replica & {
        commitNative: (
          transaction: unknown,
          source?: unknown,
        ) => Promise<
          { ok?: unknown; error?: { name?: string; message?: string } }
        >;
        recordStaleFloor: (commit: unknown, localSeq: number) => void;
        noteCaughtUpLocalSeq: (localSeq: number | undefined) => void;
      };
      const uri = `of:admission-preempt-${Date.now()}` as URI;

      // Simulate a prior conflict that marked uri stale until caughtUpLocalSeq>=5.
      replica.recordStaleFloor({
        localSeq: 5,
        reads: { confirmed: [{ id: uri, path: [], seq: 0 }], pending: [] },
        operations: [{ op: "set", id: uri, value: { value: { version: 1 } } }],
      }, 5);

      const commitPromise = replica.commitNative({
        operations: [{
          op: "set",
          id: uri,
          type: "application/json",
          value: { value: { version: 2 } },
        }],
      }, staleReadSource(uri, 0));

      // The commit is pre-empted (never sent) and held until the catch-up seq
      // is observed, exactly like a real conflict's retry gate.
      let settled = false;
      void commitPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      replica.noteCaughtUpLocalSeq(5);
      const result = await commitPromise;
      expect(result.ok).toBeFalsy();
      expect(result.error?.name).toBe("ConflictError");
      expect(result.error?.message).toContain("preempted");
    } finally {
      setConflictAdmissionEnabled(undefined);
    }
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
