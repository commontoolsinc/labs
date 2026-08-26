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
    const session = {
      watchAddSync: (_watches: WatchSpec[]) =>
        Promise.resolve({ view, sync, precedingSyncs: [] }),
      watchRemoveSync: (watchIds: readonly string[]) => {
        removed.resolve(watchIds);
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

    const cancel = await replica.subscribeOperationField({
      id: "of:operation-watch",
      path: toValuePath(["body"]),
    }, (_snapshot: OperationFieldSnapshot) => {});
    cancel();

    expect(await removed.promise).toHaveLength(1);
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
});
