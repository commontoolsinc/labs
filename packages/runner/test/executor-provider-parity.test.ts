import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MIME, URI } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  type AcceptedCommitEvent,
  Server,
} from "@commonfabric/memory/v2/server";
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

class GatedGraphServer extends WatchCountingServer {
  graphQueryStarted = Promise.withResolvers<void>();
  releaseGraphQuery = Promise.withResolvers<void>();
  #gateNextGraphQuery = false;

  gateNextGraphQuery(): void {
    this.graphQueryStarted = Promise.withResolvers<void>();
    this.releaseGraphQuery = Promise.withResolvers<void>();
    this.#gateNextGraphQuery = true;
  }

  override async graphQuery(
    message: Parameters<Server["graphQuery"]>[0],
  ): ReturnType<Server["graphQuery"]> {
    const response = await super.graphQuery(message);
    if (this.#gateNextGraphQuery) {
      this.#gateNextGraphQuery = false;
      this.graphQueryStarted.resolve();
      await this.releaseGraphQuery.promise;
    }
    return response;
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

Deno.test("executor host provider carries authenticated scheduler observations on its direct feed", async () => {
  const principal = await Identity.fromPassphrase(
    `executor observation provider ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new WatchCountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-observation-test",
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
  const accepted: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(space, (event) => {
    accepted.push(event);
  });

  try {
    const provider = storage.open(space);
    assertEquals(
      (await provider.sync("of:executor-provider:observation-root")).error,
      undefined,
    );
    assertEquals(server.watchAddCount, 0);

    const adopted = Promise.withResolvers<StorageNotification>();
    const notifications: StorageNotification[] = [];
    storage.subscribe({
      next(notification) {
        notifications.push(notification);
        if (notification.type === "scheduler-observations") {
          adopted.resolve(notification);
        }
        return { done: false };
      },
    });

    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: {
        version: 2,
        ownerSpace: space,
        branch: "",
        pieceId: "space:of:executor-provider:piece",
        processGeneration: 1,
        actionId: "action:external",
        actionKind: "computation",
        implementationFingerprint: "impl:executor-provider",
        runtimeFingerprint: "runtime:executor-provider",
        observedAtSeq: 0,
        transactionKind: "action-run",
        reads: [],
        shallowReads: [],
        actualChangedWrites: [],
        currentKnownWrites: [{
          space,
          id: "of:executor-provider:observation-root",
          scope: "space",
          path: [],
        }],
        declaredWrites: [{
          space,
          id: "of:executor-provider:observation-root",
          scope: "space",
          path: [],
        }],
        materializerWriteEnvelopes: [],
        completeActionScopeSummary: {
          version: 1,
          complete: true,
          implementationFingerprint: "impl:executor-provider",
          runtimeFingerprint: "runtime:executor-provider",
          piece: {
            space,
            id: "of:executor-provider:piece",
            scope: "space",
            path: [],
          },
          reads: [],
          writes: [{
            space,
            id: "of:executor-provider:observation-root",
            scope: "space",
            path: [],
          }],
          materializerWriteEnvelopes: [],
          directOutputs: [{
            space,
            id: "of:executor-provider:observation-root",
            scope: "space",
            path: [],
          }],
        },
        status: "success",
      },
    });
    assertEquals(accepted.length, 1);
    assertEquals(accepted[0]?.deliverySeq, 1);
    assertEquals(accepted[0]?.originSessionId === storage.id, false);
    const persisted = await writer.listSchedulerActionSnapshots({
      sinceCommitSeq: 0,
      throughCommitSeq: 1,
    });
    assertEquals(
      (persisted.snapshots[0]?.observation as { actionId?: string })?.actionId,
      "action:external",
    );
    assertEquals(persisted.snapshots[0]?.executionContextKey, "space");

    const timer = setTimeout(
      () =>
        adopted.reject(
          new Error(
            "scheduler observation was not adopted; notifications=" +
              notifications.map((notification) => notification.type).join(","),
          ),
        ),
      1_000,
    );
    let notification: StorageNotification;
    try {
      notification = await adopted.promise;
    } finally {
      clearTimeout(timer);
    }
    assert(notification.type === "scheduler-observations");
    assertEquals(
      (notification.observations[0]?.observation as { actionId?: string })
        ?.actionId,
      "action:external",
    );
  } finally {
    await storage.close();
    await channel.dispose();
    await writerClient.close();
    await server.close();
  }
});

Deno.test("executor host provider source has no engine mutation bypass", async () => {
  const source = await Deno.readTextFile(
    new URL("../src/storage/v2-host-provider.ts", import.meta.url),
  );
  assertEquals(source.includes("applyCommit"), false);
  assertEquals(source.includes("/v2/engine"), false);
  assertEquals(source.includes("this.session.watchAddSync"), false);
});

Deno.test("executor host provider closes the initial read and invalidation race", async () => {
  const principal = await Identity.fromPassphrase(
    "executor initial read race " + crypto.randomUUID(),
  );
  const space = principal.did();
  const server = new GatedGraphServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-initial-race-test",
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
  const uri = "of:executor-provider:initial-race" as URI;
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
    const integrated = Promise.withResolvers<void>();
    storage.subscribe({
      next(notification) {
        if (
          notification.type === "integrate" &&
          JSON.stringify(provider.replica.get(address)?.is) ===
            JSON.stringify({ value: { version: 2 } })
        ) {
          integrated.resolve();
        }
        return { done: false };
      },
    });

    server.gateNextGraphQuery();
    const initialRead = provider.sync(uri);
    await server.graphQueryStarted.promise;
    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 2 } },
      }],
    });
    server.releaseGraphQuery.resolve();
    assertEquals((await initialRead).error, undefined);

    const timer = setTimeout(
      () =>
        integrated.reject(
          new Error("commit racing the initial graph read was missed"),
        ),
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
    assertEquals(server.watchAddCount, 0);
  } finally {
    server.releaseGraphQuery.resolve();
    await storage.close();
    await channel.dispose();
    await writerClient.close();
    await server.close();
  }
});
