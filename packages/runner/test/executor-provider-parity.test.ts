import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MIME, URI } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import type { StorageNotification } from "../src/storage/interface.ts";
import {
  createHostProviderChannel,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";

class WatchCountingServer extends Server {
  watchAddCount = 0;

  override async watchAdd(
    message: Parameters<Server["watchAdd"]>[0],
  ): ReturnType<Server["watchAdd"]> {
    this.watchAddCount++;
    return await super.watchAdd(message);
  }
}

Deno.test("executor host provider commits through authenticated memory without a Worker key", async () => {
  const hostSigner = await Identity.fromPassphrase(
    `executor host provider ${crypto.randomUUID()}`,
  );
  const space = hostSigner.did();
  const server = new Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-provider-test",
    },
  });
  const channel = createHostProviderChannel({
    server,
    space,
    authorizeSessionOpen: (_space, _session, context) => ({
      invocation: {
        aud: context.audience,
        challenge: context.challenge.value,
      },
      authorization: { principal: hostSigner.did() },
    }),
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: hostSigner.did(),
    space,
  });

  try {
    const signing = await storage.as.sign(new Uint8Array() as never);
    assert(signing.error instanceof Error);
    assertEquals(
      signing.error.message,
      "executor provider principal has no Worker signing key",
    );

    const replica = storage.open(space).replica;
    assert(replica.commitNative);
    const result = await replica.commitNative({
      operations: [{
        op: "set",
        id: "of:executor-provider:test",
        type: "application/json",
        value: { value: { authenticated: true } },
      }],
    });
    assertEquals(result.error, undefined);
    assertEquals(
      await server.readDocument(space, "of:executor-provider:test"),
      { value: { authenticated: true } },
    );
  } finally {
    await storage.close();
    await channel.dispose();
    await server.close();
  }
});

Deno.test("executor host provider refreshes from accepted commits without memory watches", async () => {
  const principal = await Identity.fromPassphrase(
    `executor invalidation provider ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new WatchCountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-invalidation-test",
    },
  });
  const authorizeSessionOpen: MemoryClient.SessionOpenAuthFactory = (
    _space,
    _session,
    context,
  ) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal: principal.did() },
  });
  const writerClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const writer = await writerClient.mount(
    space,
    {},
    authorizeSessionOpen,
  );
  const channel = createHostProviderChannel({
    server,
    space,
    authorizeSessionOpen,
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: principal.did(),
    space,
  });
  const uri = "of:executor-provider:external" as URI;
  const address = {
    id: uri,
    type: "application/json" as MIME,
    path: [],
  };

  try {
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 1 } },
      }],
    });
    const provider = storage.open(space);
    assertEquals((await provider.sync(uri)).error, undefined);
    assertEquals(server.watchAddCount, 0);
    assertEquals(provider.replica.get(address)?.is, {
      value: { version: 1 },
    });

    const integrated = Promise.withResolvers<void>();
    storage.subscribe({
      next(notification: StorageNotification) {
        if (
          notification.type === "integrate" &&
          provider.replica.get(address)?.is !== undefined &&
          JSON.stringify(provider.replica.get(address)?.is) ===
            JSON.stringify({ value: { version: 2 } })
        ) {
          integrated.resolve();
        }
        return { done: false };
      },
    });

    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 2 } },
      }],
    });
    const timer = setTimeout(
      () => integrated.reject(new Error("accepted commit was not integrated")),
      1_000,
    );
    try {
      await integrated.promise;
    } finally {
      clearTimeout(timer);
    }
    assertEquals(provider.replica.get(address)?.is, {
      value: { version: 2 },
    });
  } finally {
    await storage.close();
    await channel.dispose();
    await writerClient.close();
    await server.close();
  }
});
