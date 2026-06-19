import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { SchemaPathSelector } from "@commonfabric/api";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import type { CellScope } from "@commonfabric/memory/v2";
import type { Result, Unit } from "../src/storage/interface.ts";
import type * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { SessionFactory } from "../src/storage/v2.ts";
import { TestStorageManager } from "./memory-v2-test-utils.ts";

class PendingSessionFactory implements SessionFactory {
  create(_space: MemorySpace, _signer?: Signer): Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }> {
    return new Promise(() => {});
  }
}

type DestroyNowProvider = {
  destroy(): Promise<void>;
  destroyNow(): Promise<void>;
  replica: {
    synced(): Promise<void>;
    close(): Promise<void>;
    closeNow(): void;
  };
  sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
  ): Promise<Result<Unit, Error>>;
};

function hasDestroyNowProvider(
  provider: unknown,
): provider is DestroyNowProvider {
  return typeof provider === "object" && provider !== null &&
    "destroy" in provider && typeof provider.destroy === "function" &&
    "destroyNow" in provider && typeof provider.destroyNow === "function" &&
    "replica" in provider && typeof provider.replica === "object" &&
    provider.replica !== null &&
    "sync" in provider && typeof provider.sync === "function";
}

Deno.test("StorageManager.closeNow does not wait for a pending session sync", async () => {
  const signer = await Identity.fromPassphrase("storage-close-pending-sync");
  const storage = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("http://localhost:65535"),
  }, new PendingSessionFactory());

  const provider = storage.open(signer.did());
  provider.sync("of:pending-session-sync" as URI);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    storage.closeNow().then(() => "closed" as const),
    new Promise<"timed-out">((resolve) => {
      timeout = setTimeout(() => resolve("timed-out"), 50);
      Deno.unrefTimer(timeout);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });

  assertEquals(result, "closed");
});

Deno.test("Provider.destroyNow force-closes after destroy is already pending", async () => {
  const signer = await Identity.fromPassphrase("storage-provider-destroy-now");
  const storage = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("http://localhost:65535"),
  }, new PendingSessionFactory());

  const provider = storage.open(signer.did());
  if (!hasDestroyNowProvider(provider)) {
    throw new Error("test provider does not expose destroyNow");
  }

  let closeNowCalls = 0;
  provider.replica.synced = () => Promise.resolve();
  provider.replica.close = () => new Promise(() => {});
  provider.replica.closeNow = () => {
    closeNowCalls++;
  };

  void provider.destroy();
  await Promise.resolve();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    provider.destroyNow().then(() => "closed" as const),
    new Promise<"timed-out">((resolve) => {
      timeout = setTimeout(() => resolve("timed-out"), 50);
      Deno.unrefTimer(timeout);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });

  assertEquals(result, "closed");
  assertEquals(closeNowCalls, 1);
});
