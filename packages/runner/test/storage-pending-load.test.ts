import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { NormalizedLink } from "../src/link-types.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

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

    const storage = runtime.storageManager as any;
    const schemaStarted = Promise.withResolvers<void>();
    const releaseSchema = Promise.withResolvers<void>();
    storage.syncCfcSchemaDocument = async () => {
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
    const storage = runtime.storageManager as any;
    const targetId = "of:pending-linked-target";
    const syncStarted = Promise.withResolvers<void>();
    const releaseSync = Promise.withResolvers<void>();
    const originalOpen = storage.open.bind(storage);
    storage.open = (openSpace: string) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return async (id: string, ...args: unknown[]) => {
              if (id === targetId) {
                syncStarted.resolve();
                await releaseSync.promise;
                return { ok: {} };
              }
              return (target.sync as (
                ...values: unknown[]
              ) => Promise<unknown>)(
                id,
                ...args,
              );
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    const base: NormalizedLink = {
      space,
      id: "of:data-root" as any,
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

  it("rejects failed generations and gives a later load a new identity", async () => {
    const storage = env.runtime.storageManager as any;
    const address = { space, scope: "space", id: "of:generation" };
    const key = `${address.space}/${address.scope}/${address.id}`;

    const releaseFirst = storage.registerPendingLoad(address);
    const firstGeneration = storage.pendingLoadGeneration(key);
    const firstSettled = storage.loadsSettled([key]);
    releaseFirst(new Error("transport failed"));
    await expect(firstSettled).rejects.toThrow("transport failed");

    const releaseSecond = storage.registerPendingLoad(address);
    const secondGeneration = storage.pendingLoadGeneration(key);
    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    releaseSecond();
    await storage.loadsSettled([key]);
  });
});
