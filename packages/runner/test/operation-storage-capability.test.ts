import { Identity } from "@commonfabric/identity";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "@commonfabric/memory/v2/operation-codec";
import {
  type OperationFieldSnapshot,
  type SessionSync,
  toValuePath,
  type WatchSpec,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { defer } from "@commonfabric/utils/defer";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { hasOperationStorageCapability } from "../src/storage/interface.ts";
import {
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("operation storage capability");

describe("operation storage capability", () => {
  it("fails closed when Memory lacks operation support or a resolution", async () => {
    const unsupportedClient = {
      serverFlags: { applyOp: false },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const unsupportedStorage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          {
            create: () =>
              Promise.resolve({
                client: unsupportedClient,
                session: {} as MemoryV2Client.SpaceSession,
              }),
          },
        );
      }
    })();
    const unsupported = unsupportedStorage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(unsupported)) return;
    expect(await unsupported.operationCodecs()).toEqual([]);
    await expect(unsupported.applyOperation({ op: "apply-op" } as never))
      .rejects.toThrow("does not support apply-op");
    await expect(unsupported.releaseOperationField({
      op: "release-op-field",
    } as never)).rejects.toThrow("does not support release-op-field");
    await unsupportedStorage.closeNow();

    const client = {
      serverFlags: { applyOp: true, operationCodecs: ["test@1"] },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const session = {
      transact: () => Promise.resolve({}),
    } as unknown as MemoryV2Client.SpaceSession;
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          { create: () => Promise.resolve({ client, session }) },
        );
      }
    })();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) return;
    expect(await replica.operationCodecs()).toEqual(["test@1"]);
    await expect(replica.applyOperation({ op: "apply-op" } as never))
      .rejects.toThrow("no operation resolution");
    await replica.releaseOperationField({ op: "release-op-field" } as never);
    await storage.closeNow();
  });

  it("removes a failed subscription and isolates callback failures", async () => {
    const query = { id: "of:failed-watch", path: toValuePath([]) };
    const watchId = `operation:${hashStringOf(query)}`;
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
      operationFields: [{
        watchId,
        field: {
          branch: "",
          id: query.id,
          scopeKey: "space",
          path: query.path,
          active: false,
          codec: null,
          cursor: null,
          baselineHash: "baseline",
          materialized: "value",
          operations: [],
        },
      }],
    };
    const view = MemoryV2Client.WatchView.fromSync(sync);
    let attempts = 0;
    const session = {
      watchAddSync: () => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error("watch failed"));
        return Promise.resolve({ view, sync, precedingSyncs: [] });
      },
      watchRemoveSync: () =>
        Promise.resolve({ view, sync, precedingSyncs: [] }),
    } as unknown as MemoryV2Client.SpaceSession;
    const client = {
      serverFlags: { applyOp: true, operationCodecs: ["test@1"] },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          { create: () => Promise.resolve({ client, session }) },
        );
      }
    })();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) return;
    await expect(replica.subscribeOperationField(query, () => {})).rejects
      .toThrow("watch failed");

    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...values: unknown[]) => errors.push(values);
    try {
      const cancel = await replica.subscribeOperationField(query, () => {
        throw new Error("subscriber failed");
      });
      expect(errors).toHaveLength(1);
      cancel();
    } finally {
      console.error = original;
      await storage.closeNow();
    }
  });

  it("exposes codec-neutral collaboration through a space replica", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const space = signer.did();

    try {
      const seed = storage.edit();
      expect(
        seed.write({
          space,
          id: "of:operation-storage",
          type: "application/json",
          path: [],
        }, { value: { body: "ac" } }).error,
      ).toBeUndefined();
      expect((await seed.commit()).error).toBeUndefined();

      const replica = storage.open(space).replica;
      expect(hasOperationStorageCapability(replica)).toBe(true);
      if (!hasOperationStorageCapability(replica)) return;

      expect(await replica.operationCodecs()).toContain(
        CODEMIRROR_CHANGESET_CODEC,
      );
      const initial = await replica.queryOperationField({
        id: "of:operation-storage",
        path: toValuePath(["body"]),
      });
      expect(initial).toMatchObject({ active: false, materialized: "ac" });

      const resolution = await replica.applyOperation({
        op: "apply-op",
        id: "of:operation-storage",
        path: toValuePath(["body"]),
        codec: CODEMIRROR_CHANGESET_CODEC,
        submissionId: "runner:1",
        base: null,
        baselineHash: operationBaselineHash("ac"),
        payload: {
          updates: [{
            clientId: "runner",
            changes: [1, [0, "b"], 1],
          }],
        },
      });

      expect(resolution).toMatchObject({
        from: { epoch: 1, version: 0 },
        to: { epoch: 1, version: 1 },
      });
      expect(
        await replica.queryOperationField({
          id: "of:operation-storage",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 0 },
        }),
      ).toMatchObject({
        active: true,
        cursor: { epoch: 1, version: 1 },
        materialized: "abc",
        operations: [{ opId: expect.stringMatching(/^op:/) }],
      });
    } finally {
      await storage.close();
    }
  });

  it("removes the Memory watch when the last operation subscriber cancels", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const view = MemoryV2Client.WatchView.fromSync(sync);
    const removed = defer<readonly string[]>();
    let removalCount = 0;
    const session = {
      watchAddSync: (_watches: WatchSpec[]) =>
        Promise.resolve({ view, sync, precedingSyncs: [] }),
      watchRemoveSync: (watchIds: readonly string[]) => {
        removalCount++;
        if (removalCount === 1) removed.resolve(watchIds);
        return Promise.resolve({ view, sync, precedingSyncs: [] });
      },
    } as unknown as MemoryV2Client.SpaceSession;
    const client = {
      serverFlags: {
        applyOp: true,
        operationCodecs: [CODEMIRROR_CHANGESET_CODEC],
      },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const sessionFactory: SessionFactory = {
      create: () => Promise.resolve({ client, session }),
    };
    class TestStorageManager extends V2StorageManager {
      constructor() {
        super({ as: signer, memoryHost: new URL("memory://") }, sessionFactory);
      }
    }
    const storage = new TestStorageManager();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) {
      throw new Error("operation capability unavailable");
    }

    const query = {
      id: "of:operation-watch",
      path: toValuePath(["body"]),
    };
    const cancelFirst = await replica.subscribeOperationField(
      query,
      (_snapshot: OperationFieldSnapshot) => {},
    );
    const cancelSecond = await replica.subscribeOperationField(
      query,
      (_snapshot: OperationFieldSnapshot) => {},
    );
    cancelFirst();
    expect(removalCount).toBe(0);
    cancelSecond();

    expect(await removed.promise).toHaveLength(1);
    const cancelAfterRemoval = await replica.subscribeOperationField(
      query,
      () => {},
    );
    expect(removalCount).toBe(1);
    cancelAfterRemoval();
    const cancelAfterSecondRemoval = await replica.subscribeOperationField(
      query,
      () => {},
    );
    expect(removalCount).toBe(2);
    cancelAfterSecondRemoval();
    await storage.closeNow();
  });

  it("consumes preceding syncs and a replacement watch view", async () => {
    const empty: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const firstView = MemoryV2Client.WatchView.fromSync(empty);
    const secondView = MemoryV2Client.WatchView.fromSync(empty);
    const secondQuery = {
      id: "of:second-watch",
      path: toValuePath(["body"]),
    };
    const secondWatchId = `operation:${hashStringOf(secondQuery)}`;
    const field = (version: number): OperationFieldSnapshot => ({
      branch: "",
      id: "of:second-watch",
      scopeKey: "space",
      path: toValuePath(["body"]),
      active: true,
      codec: CODEMIRROR_CHANGESET_CODEC,
      cursor: { epoch: 1, version },
      baselineHash: "baseline",
      materialized: `v${version}`,
      operations: [],
    });
    const delivery = (version: number): SessionSync => ({
      ...empty,
      toSeq: version,
      operationFields: [{
        watchId: secondWatchId,
        field: field(version),
      }],
    });
    let additions = 0;
    const session = {
      watchAddSync: () => {
        additions++;
        return Promise.resolve(
          additions === 1
            ? { view: firstView, sync: empty, precedingSyncs: [] }
            : {
              view: secondView,
              sync: empty,
              precedingSyncs: [delivery(1)],
            },
        );
      },
      watchRemoveSync: () =>
        Promise.resolve({
          view: secondView,
          sync: empty,
          precedingSyncs: [],
        }),
    } as unknown as MemoryV2Client.SpaceSession;
    const client = {
      serverFlags: {
        applyOp: true,
        operationCodecs: [CODEMIRROR_CHANGESET_CODEC],
      },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const sessionFactory: SessionFactory = {
      create: () => Promise.resolve({ client, session }),
    };
    class TestStorageManager extends V2StorageManager {
      constructor() {
        super({ as: signer, memoryHost: new URL("memory://") }, sessionFactory);
      }
    }
    const storage = new TestStorageManager();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) {
      throw new Error("operation capability unavailable");
    }
    const delivered: number[] = [];
    const secondDelivery = defer<void>();

    const cancelFirst = await replica.subscribeOperationField({
      id: "of:first-watch",
      path: toValuePath(["body"]),
    }, () => {});
    const cancelSecond = await replica.subscribeOperationField({
      ...secondQuery,
    }, (snapshot) => {
      delivered.push(snapshot.cursor?.version ?? 0);
      if (snapshot.cursor?.version === 2) secondDelivery.resolve();
    });
    secondView.emit(delivery(2));
    await secondDelivery.promise;

    expect(delivered).toEqual([1, 2]);
    cancelFirst();
    cancelSecond();
    await storage.closeNow();
  });

  it("closes operation watches that resolve during replica teardown", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const client = {
      serverFlags: { applyOp: true, operationCodecs: ["test@1"] },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const createStorage = (session: MemoryV2Client.SpaceSession) =>
      new (class extends V2StorageManager {
        constructor() {
          super(
            { as: signer, memoryHost: new URL("memory://") },
            { create: () => Promise.resolve({ client, session }) },
          );
        }
      })();

    const addition = defer<{
      view: MemoryV2Client.WatchView;
      sync: SessionSync;
      precedingSyncs: SessionSync[];
    }>();
    const lateAdditionView = MemoryV2Client.WatchView.fromSync(sync);
    const addingStorage = createStorage({
      watchAddSync: () => addition.promise,
    } as unknown as MemoryV2Client.SpaceSession);
    const addingReplica = addingStorage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(addingReplica)) return;
    const subscribing = addingReplica.subscribeOperationField({
      id: "of:late-addition",
      path: toValuePath([]),
    }, () => {});
    await Promise.resolve();
    (addingReplica as unknown as { closeNow(): void }).closeNow();
    addition.resolve({
      view: lateAdditionView,
      sync,
      precedingSyncs: [],
    });
    await expect(subscribing).rejects.toThrow("memory replica closed");
    await addingStorage.closeNow();

    const removal = defer<{
      view: MemoryV2Client.WatchView;
      sync: SessionSync;
      precedingSyncs: SessionSync[];
    }>();
    const activeView = MemoryV2Client.WatchView.fromSync(sync);
    const lateRemovalView = MemoryV2Client.WatchView.fromSync(sync);
    const removingStorage = createStorage({
      watchAddSync: () =>
        Promise.resolve({ view: activeView, sync, precedingSyncs: [] }),
      watchRemoveSync: () => removal.promise,
    } as unknown as MemoryV2Client.SpaceSession);
    const removingReplica = removingStorage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(removingReplica)) return;
    const cancel = await removingReplica.subscribeOperationField({
      id: "of:late-removal",
      path: toValuePath([]),
    }, () => {});
    cancel();
    await Promise.resolve();
    (removingReplica as unknown as { closeNow(): void }).closeNow();
    removal.resolve({
      view: lateRemovalView,
      sync,
      precedingSyncs: [],
    });
    await Promise.resolve();
    await removingStorage.closeNow();
  });

  it("warns when removing an operation watch fails", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const view = MemoryV2Client.WatchView.fromSync(sync);
    const session = {
      watchAddSync: () => Promise.resolve({ view, sync, precedingSyncs: [] }),
      watchRemoveSync: () => Promise.reject(new Error("remove failed")),
    } as unknown as MemoryV2Client.SpaceSession;
    const client = {
      serverFlags: { applyOp: true, operationCodecs: ["test@1"] },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          { create: () => Promise.resolve({ client, session }) },
        );
      }
    })();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) return;
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values);
    try {
      const cancel = await replica.subscribeOperationField({
        id: "of:failed-removal",
        path: toValuePath([]),
      }, () => {});
      cancel();
      await Promise.resolve();
      await Promise.resolve();
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = original;
      await storage.closeNow();
    }
  });
});
