import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { CellScope, SchemaPathSelector } from "@commonfabric/api";
import type { EntityDocument } from "@commonfabric/memory/v2";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedLink } from "../src/link-types.ts";
import type { URI } from "../src/sigil-types.ts";
import type {
  IStorageProvider,
  MemorySpace,
  Result,
  Unit,
} from "../src/storage/interface.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

type PendingLoadStorageManager = {
  syncCfcSchemaDocument: (
    space: MemorySpace,
    document: EntityDocument | undefined,
  ) => Promise<unknown>;
  syncCell: <T>(cell: Cell<T>) => Promise<Cell<T>>;
  pendingLoadGeneration: (key: string) => number | undefined;
  loadsSettled: (keys: readonly string[]) => Promise<void>;
  open: (space: MemorySpace) => IStorageProvider;
  collectLinkedCellSyncs: (
    value: unknown,
    base: NormalizedLink,
    schema: JSONSchema | undefined,
    cfc: ContextualFlowControl,
    promises: Promise<unknown>[],
    seen: Set<unknown>,
  ) => void;
  registerPendingLoad: (
    address: { space: MemorySpace; scope: CellScope; id: URI },
  ) => (failure?: unknown) => void;
  trackPendingProviderSync: (
    address: { space: MemorySpace; scope: CellScope; id: URI },
    start: () => Promise<Result<Unit, Error>>,
  ) => Promise<Result<Unit, Error>>;
};

function pendingLoadStorage(
  storageManager: SchedulerTestRuntime["runtime"]["storageManager"],
): PendingLoadStorageManager {
  return storageManager as unknown as PendingLoadStorageManager;
}

describe("storage pending-load generations", () => {
  let env: SchedulerTestRuntime;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  it("keeps the document pending until its CFC schema load settles", async () => {
    const { runtime, tx } = env;
    const cell = runtime.getCell(space, "pending-through-cfc", undefined);
    await tx.commit();
    env.tx = runtime.edit();

    const storage = pendingLoadStorage(runtime.storageManager);
    const schemaStarted = Promise.withResolvers<void>();
    const releaseSchema = Promise.withResolvers<void>();
    storage.syncCfcSchemaDocument = async (_space, _document) => {
      schemaStarted.resolve();
      await releaseSchema.promise;
      return undefined;
    };

    const sync = storage.syncCell(cell);
    await schemaStarted.promise;

    const address = cell.getAsNormalizedFullLink();
    const key = `${address.space}/${address.scope}/${address.id}`;
    expect(storage.pendingLoadGeneration(key)).toBeDefined();

    let settled = false;
    const pending = storage.loadsSettled([key]).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSchema.resolve();
    await sync;
    await pending;
    expect(storage.pendingLoadGeneration(key)).toBeUndefined();
  });

  it("tracks linked-document pulls kicked from data values", async () => {
    const { runtime } = env;
    const storage = pendingLoadStorage(runtime.storageManager);
    const targetId = "of:pending-linked-target";
    const syncStarted = Promise.withResolvers<void>();
    const releaseSync = Promise.withResolvers<void>();
    const originalOpen = storage.open.bind(storage);
    storage.open = (openSpace: MemorySpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return async (
              id: URI,
              selector?: SchemaPathSelector,
              scope?: CellScope,
            ) => {
              if (id === targetId) {
                syncStarted.resolve();
                await releaseSync.promise;
                return { ok: {} };
              }
              return target.sync(id, selector, scope);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    const base: NormalizedLink = {
      space,
      id: "of:data-root" as URI,
      scope: "space",
      path: [],
    };
    const value = {
      "/": {
        "link@1": { id: targetId, path: [], space },
      },
    };
    const promises: Promise<unknown>[] = [];
    storage.collectLinkedCellSyncs(
      value,
      base,
      undefined,
      new ContextualFlowControl(),
      promises,
      new Set(),
    );
    await syncStarted.promise;

    const key = `${space}/space/${targetId}`;
    expect(storage.pendingLoadGeneration(key)).toBeDefined();
    releaseSync.resolve();
    await Promise.all(promises);
    expect(storage.pendingLoadGeneration(key)).toBeUndefined();
  });

  it("releases the pending generation when syncCell rejects", async () => {
    const { runtime } = env;
    const storage = pendingLoadStorage(runtime.storageManager);
    const id = "of:pending-sync-rejection";
    const cell = runtime.getCell(space, id);
    const originalOpen = storage.open.bind(storage);
    storage.open = (openSpace: MemorySpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return () => Promise.reject(new Error("provider sync rejected"));
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    try {
      const address = cell.getAsNormalizedFullLink();
      const key = `${address.space}/${address.scope}/${address.id}`;
      const sync = storage.syncCell(cell);
      const settled = storage.loadsSettled([key]);
      await expect(sync).rejects.toThrow("provider sync rejected");
      await expect(settled).rejects.toThrow("provider sync rejected");
      expect(storage.pendingLoadGeneration(key)).toBeUndefined();
    } finally {
      storage.open = originalOpen;
    }
  });

  it("releases linked-document loads when provider sync throws synchronously", () => {
    const storage = pendingLoadStorage(env.runtime.storageManager);
    const targetId = "of:pending-linked-sync-throw";
    const originalOpen = storage.open.bind(storage);
    storage.open = (openSpace: MemorySpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return () => {
              throw new Error("linked provider sync threw");
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    try {
      const base: NormalizedLink = {
        space,
        id: "of:throwing-data-root" as URI,
        scope: "space",
        path: [],
      };
      const value = {
        "/": { "link@1": { id: targetId, path: [], space } },
      };
      expect(() =>
        storage.collectLinkedCellSyncs(
          value,
          base,
          undefined,
          new ContextualFlowControl(),
          [],
          new Set(),
        )
      ).toThrow("linked provider sync threw");
      expect(storage.pendingLoadGeneration(`${space}/space/${targetId}`))
        .toBeUndefined();
    } finally {
      storage.open = originalOpen;
    }
  });

  it("rejects linked-document loads when provider sync rejects", async () => {
    const storage = pendingLoadStorage(env.runtime.storageManager);
    const targetId = "of:pending-linked-sync-rejection";
    const originalOpen = storage.open.bind(storage);
    storage.open = (openSpace: MemorySpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return () => Promise.reject(new Error("linked provider rejected"));
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    try {
      const base: NormalizedLink = {
        space,
        id: "of:rejecting-data-root" as URI,
        scope: "space",
        path: [],
      };
      const value = {
        "/": { "link@1": { id: targetId, path: [], space } },
      };
      const promises: Promise<unknown>[] = [];
      storage.collectLinkedCellSyncs(
        value,
        base,
        undefined,
        new ContextualFlowControl(),
        promises,
        new Set(),
      );
      const key = `${space}/space/${targetId}`;
      const settled = storage.loadsSettled([key]);
      await expect(Promise.all(promises)).rejects.toThrow(
        "linked provider rejected",
      );
      await expect(settled).rejects.toThrow("linked provider rejected");
      expect(storage.pendingLoadGeneration(key)).toBeUndefined();
    } finally {
      storage.open = originalOpen;
    }
  });

  it("rejects failed generations and gives a later load a new identity", async () => {
    const storage = pendingLoadStorage(env.runtime.storageManager);
    const address = {
      space,
      scope: "space" as const,
      id: "of:generation" as URI,
    };
    const key = `${address.space}/${address.scope}/${address.id}`;

    const releaseFirst = storage.registerPendingLoad(address);
    const firstGeneration = storage.pendingLoadGeneration(key);
    const firstSettled = storage.loadsSettled([key]);
    releaseFirst(new Error("transport failed"));
    await expect(firstSettled).rejects.toThrow("transport failed");

    const releaseSecond = storage.registerPendingLoad(address);
    const secondGeneration = storage.pendingLoadGeneration(key);
    if (firstGeneration === undefined || secondGeneration === undefined) {
      throw new Error("pending load generation missing");
    }
    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    releaseSecond();
    await storage.loadsSettled([key]);
  });
});
