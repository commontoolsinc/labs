import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
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

Deno.test("StorageManager.closeNow does not wait for a pending session sync", async () => {
  const signer = await Identity.fromPassphrase("storage-close-pending-sync");
  const storage = TestStorageManager.create({
    as: signer,
    address: new URL("http://localhost:65535"),
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
