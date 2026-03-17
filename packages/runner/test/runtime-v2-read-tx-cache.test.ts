import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { DID } from "@commontools/identity";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { IStorageNotification } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runtime-v2-read-tx-cache");
const space = signer.did();

class MockStorageManager {
  readonly id = "mock-storage-manager";
  readonly as = {
    did: () => space as DID,
  };
  readonly memoryVersion: "v1" | "v2";
  readonly subscriptions: IStorageNotification[] = [];
  readonly unsubscribed: IStorageNotification[] = [];

  constructor(memoryVersion: "v1" | "v2") {
    this.memoryVersion = memoryVersion;
  }

  open(): never {
    throw new Error("MockStorageManager.open should not be called");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  edit(): never {
    throw new Error("MockStorageManager.edit should not be called");
  }

  synced(): Promise<void> {
    return Promise.resolve();
  }

  addCrossSpacePromise(): void {}

  removeCrossSpacePromise(): void {}

  subscribe(subscription: IStorageNotification): void {
    this.subscriptions.push(subscription);
  }

  unsubscribe(subscription: IStorageNotification): void {
    this.unsubscribed.push(subscription);
  }
}

describe("Runtime v2 ambient read transaction", () => {
  it("reuses a single ambient read transaction for repeated reads", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    let editCalls = 0;
    const instrumented = storageManager as typeof storageManager & {
      edit: typeof storageManager.edit;
    };
    const originalEdit = storageManager.edit.bind(storageManager);
    instrumented.edit = () => {
      editCalls += 1;
      return originalEdit();
    };

    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });

    try {
      const seed = runtime.edit();
      const cell = runtime.getCell(
        space,
        "runtime-v2-ambient-read-reuse",
        { type: "number" } as const,
        seed,
      );
      cell.set(42);
      await seed.commit();

      const baseline = editCalls;
      expect(cell.get()).toBe(42);
      expect(cell.get()).toBe(42);
      expect(cell.get()).toBe(42);
      expect(editCalls - baseline).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("invalidates the ambient read transaction after commits", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    let editCalls = 0;
    const instrumented = storageManager as typeof storageManager & {
      edit: typeof storageManager.edit;
    };
    const originalEdit = storageManager.edit.bind(storageManager);
    instrumented.edit = () => {
      editCalls += 1;
      return originalEdit();
    };

    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });

    try {
      const seed = runtime.edit();
      const cell = runtime.getCell(
        space,
        "runtime-v2-ambient-read-invalidate",
        { type: "number" } as const,
        seed,
      );
      cell.set(1);
      await seed.commit();

      expect(cell.get()).toBe(1);
      expect(cell.get()).toBe(1);
      const afterFirstReads = editCalls;

      const update = runtime.edit();
      cell.withTx(update).set(2);
      await update.commit();

      expect(cell.get()).toBe(2);
      expect(editCalls - afterFirstReads).toBe(2);
      expect(cell.get()).toBe(2);
      expect(editCalls - afterFirstReads).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("unsubscribes the ambient v2 notification listener on dispose", async () => {
    const v1Storage = new MockStorageManager("v1");
    const v1Runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: v1Storage as any,
      memoryVersion: "v1",
    });

    await v1Runtime.dispose();
    expect(v1Storage.unsubscribed).toHaveLength(0);

    const v2Storage = new MockStorageManager("v2");
    const v2Runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: v2Storage as any,
      memoryVersion: "v2",
    });

    await v2Runtime.dispose();
    expect(v2Storage.unsubscribed).toHaveLength(1);
    expect(
      v2Storage.subscriptions.includes(v2Storage.unsubscribed[0]!),
    ).toBe(true);
  });
});
