import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  StorageManager,
  StorageManagerEmulator,
} from "@commonfabric/runner/storage/cache.deno";
import { StorageManager as RemoteStorageManager } from "../src/storage/cache.ts";
import * as V2Storage from "../src/storage/v2.ts";
import * as V2Emulate from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  DEFAULT_MEMORY_VERSION,
  getDefaultMemoryVersion,
  INTEGRATION_MEMORY_VERSION_ENV,
  type IStorageNotification,
} from "../src/storage/interface.ts";
import {
  createStorageNotificationRelay,
  StorageNotificationRelay,
} from "../src/storage/subscription.ts";

const signer = await Identity.fromPassphrase("test memory version");

describe("memoryVersion cutover seam", () => {
  afterEach(async () => {
    // Let any pending microtasks settle between emulated storage tests.
    await new Promise((resolve) => setTimeout(resolve, 1));
  });

  it("defaults runtime and storage manager memoryVersion consistently", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    expect(runtime.memoryVersion).toBe(getDefaultMemoryVersion());
    expect(storageManager.memoryVersion).toBe(getDefaultMemoryVersion());

    await runtime.dispose();
    await storageManager.close();
  });

  it("honors the integration memory version override when memoryVersion is omitted", async () => {
    const previous = Deno.env.get(INTEGRATION_MEMORY_VERSION_ENV);
    Deno.env.set(INTEGRATION_MEMORY_VERSION_ENV, "v1");

    try {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });

      expect(runtime.memoryVersion).toBe("v1");
      expect(storageManager.memoryVersion).toBe("v1");

      await runtime.dispose();
      await storageManager.close();
    } finally {
      if (previous === undefined) {
        Deno.env.delete(INTEGRATION_MEMORY_VERSION_ENV);
      } else {
        Deno.env.set(INTEGRATION_MEMORY_VERSION_ENV, previous);
      }
    }
  });

  it("prefers an explicit memoryVersion over the integration override", async () => {
    const previous = Deno.env.get(INTEGRATION_MEMORY_VERSION_ENV);
    Deno.env.set(INTEGRATION_MEMORY_VERSION_ENV, "v1");

    try {
      const storageManager = StorageManager.emulate({
        as: signer,
        memoryVersion: "v2",
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        memoryVersion: "v2",
      });

      expect(runtime.memoryVersion).toBe("v2");
      expect(storageManager.memoryVersion).toBe("v2");

      await runtime.dispose();
      await storageManager.close();
    } finally {
      if (previous === undefined) {
        Deno.env.delete(INTEGRATION_MEMORY_VERSION_ENV);
      } else {
        Deno.env.set(INTEGRATION_MEMORY_VERSION_ENV, previous);
      }
    }
  });

  it("uses storage manager implementations that match the current default", async () => {
    const previous = Deno.env.get(INTEGRATION_MEMORY_VERSION_ENV);
    Deno.env.delete(INTEGRATION_MEMORY_VERSION_ENV);

    try {
      const emulated = StorageManager.emulate({ as: signer });
      const remote = RemoteStorageManager.open({
        as: signer,
        address: new URL("http://example.com/api/storage/memory"),
      });

      if (DEFAULT_MEMORY_VERSION === "v2") {
        expect(Object.getPrototypeOf(emulated).constructor).toBe(
          V2Emulate.EmulatedStorageManager,
        );
        expect(Object.getPrototypeOf(remote).constructor).toBe(
          V2Storage.StorageManager,
        );
      } else {
        expect(DEFAULT_MEMORY_VERSION).toBe("v1");
        expect(Object.getPrototypeOf(emulated).constructor).toBe(
          StorageManagerEmulator,
        );
        expect(Object.getPrototypeOf(remote).constructor).toBe(
          RemoteStorageManager,
        );
      }

      await emulated.close();
      await remote.close();
    } finally {
      if (previous !== undefined) {
        Deno.env.set(INTEGRATION_MEMORY_VERSION_ENV, previous);
      }
    }
  });

  it("propagates an explicit v2 memoryVersion through runtime setup", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      memoryVersion: "v2",
    });

    expect(runtime.memoryVersion).toBe("v2");
    expect(storageManager.memoryVersion).toBe("v2");

    await runtime.dispose();
    await storageManager.close();
  });

  it("routes explicit remote v2 opens to the dedicated v2 storage manager", async () => {
    const remoteV1 = RemoteStorageManager.open({
      as: signer,
      address: new URL("http://example.com/api/storage/memory"),
      memoryVersion: "v1",
    });
    const remoteV2 = RemoteStorageManager.open({
      as: signer,
      address: new URL("http://example.com/api/storage/memory"),
      memoryVersion: "v2",
    });

    expect(Object.getPrototypeOf(remoteV1).constructor).toBe(
      RemoteStorageManager,
    );
    expect(Object.getPrototypeOf(remoteV2).constructor).toBe(
      V2Storage.StorageManager,
    );

    await remoteV1.close();
    await remoteV2.close();
  });

  it("rejects a runtime/storage manager memoryVersion mismatch", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v1",
    });

    expect(() =>
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        memoryVersion: "v2",
      })
    ).toThrow(/memoryVersion/i);

    await storageManager.close();
  });

  it("allows an explicit runtime memoryVersion when a custom storage manager does not declare one", async () => {
    let closed = false;
    const storageManager = {
      id: "legacy-storage-manager",
      as: {
        did: () => signer.did(),
      },
      open() {
        throw new Error("legacy storage manager open should not be called");
      },
      close() {
        closed = true;
        return Promise.resolve();
      },
      edit() {
        throw new Error("legacy storage manager edit should not be called");
      },
      synced() {
        return Promise.resolve();
      },
      addCrossSpacePromise() {},
      removeCrossSpacePromise() {},
      subscribe() {},
      unsubscribe() {},
    };

    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageManager as any,
      memoryVersion: "v1",
    });

    expect(runtime.memoryVersion).toBe("v1");

    await runtime.dispose();
    expect(closed).toBe(true);
  });
});

describe("storage notification aliases", () => {
  it("exports the relay under the v2-oriented naming", () => {
    const relay = createStorageNotificationRelay();
    expect(relay).toBeInstanceOf(StorageNotificationRelay);

    const notifications: string[] = [];
    const subscriber: IStorageNotification = {
      next(notification) {
        notifications.push(notification.type);
        return { done: false };
      },
    };

    relay.subscribe(subscriber);
    relay.next({
      type: "reset",
      space: signer.did(),
    });

    expect(notifications).toEqual(["reset"]);
  });
});
