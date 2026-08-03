/// <reference lib="webworker" />

import type { MemorySpace, MIME, URI } from "@commonfabric/memory/interface";
import { HostStorageManager } from "../../src/storage/v2-host-provider.ts";

const worker = globalThis as unknown as DedicatedWorkerGlobalScope;
const uri = "of:executor-provider:worker" as URI;
const type = "application/json" as MIME;
let storage: HostStorageManager | undefined;

worker.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handleMessage(event.data).catch((error) => {
    worker.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
worker.postMessage({ type: "booted" });

async function handleMessage(message: unknown): Promise<void> {
  if (typeof message !== "object" || message === null) {
    throw new Error("invalid executor provider worker message");
  }
  const input = message as Record<string, unknown>;
  if (input.type === "dispose") {
    await storage?.close();
    storage = undefined;
    worker.postMessage({ type: "disposed" });
    return;
  }
  if (
    input.type !== "init" || !(input.port instanceof MessagePort) ||
    typeof input.principal !== "string" || typeof input.space !== "string"
  ) {
    throw new Error("invalid executor provider worker initialization");
  }

  storage = HostStorageManager.connect({
    port: input.port,
    principal: input.principal as MemorySpace,
    space: input.space as MemorySpace,
  });
  const provider = storage.open(input.space as MemorySpace);
  const replica = provider.replica;
  if (!replica.commitNative) {
    throw new Error("executor provider replica has no native commit path");
  }
  const sync = await provider.sync(uri);
  if (sync.error) throw new Error(sync.error.message);
  const committed = await replica.commitNative({
    operations: [{
      op: "set",
      id: uri,
      type,
      value: { value: { version: 1, realm: "worker" } },
    }],
  });
  if (committed.error) throw new Error(committed.error.message);

  let reportedExternal = false;
  storage.subscribe({
    next(notification) {
      const value = replica.get({ id: uri, type })?.is as
        | { value?: { version?: number; realm?: string } }
        | undefined;
      if (
        !reportedExternal && notification.type === "integrate" &&
        value?.value?.version === 2 && value.value.realm === "external"
      ) {
        reportedExternal = true;
        worker.postMessage({ type: "integrated" });
      }
      return { done: false };
    },
  });
  worker.postMessage({ type: "committed" });
}
