import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { StorageManager as RemoteStorageManager } from "../src/storage/cache.ts";
import * as V2Storage from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import {
  DEFAULT_MEMORY_VERSION,
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

    expect(runtime.memoryVersion).toBe(DEFAULT_MEMORY_VERSION);
    expect(storageManager.memoryVersion).toBe(DEFAULT_MEMORY_VERSION);

    await runtime.dispose();
    await storageManager.close();
  });

  it("uses the v2 storage manager implementations when the default is v2", async () => {
    const emulated = StorageManager.emulate({ as: signer });
    const remote = RemoteStorageManager.open({
      as: signer,
      address: new URL("http://example.com/api/storage/memory"),
    });

    expect(DEFAULT_MEMORY_VERSION).toBe("v2");
    expect(Object.getPrototypeOf(emulated).constructor).toBe(
      V2Storage.EmulatedStorageManager,
    );
    expect(Object.getPrototypeOf(remote).constructor).toBe(
      V2Storage.StorageManager,
    );

    await emulated.close();
    await remote.close();
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
