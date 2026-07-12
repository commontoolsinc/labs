import { assert, assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type {
  MemorySpace,
  MIME,
  Signer,
  URI,
} from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import * as MemoryEngine from "@commonfabric/memory/v2/engine";
import type { ActionSettlement } from "@commonfabric/memory/v2";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import {
  type AcceptedCommitEvent,
  type AcceptedCommitListener,
  Server,
} from "@commonfabric/memory/v2/server";
import { table } from "@commonfabric/memory/sqlite/schema";
import {
  all,
  match,
  principal as rowPrincipal,
} from "@commonfabric/memory/sqlite/row-label";
import type { StorageNotification } from "../src/storage/interface.ts";
import type { NativeStorageCommit } from "../src/storage/interface.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
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

class FailingSchedulerListServer extends WatchCountingServer {
  failNextSchedulerList = false;

  override listSchedulerActionSnapshots(
    message: Parameters<Server["listSchedulerActionSnapshots"]>[0],
  ): ReturnType<Server["listSchedulerActionSnapshots"]> {
    if (this.failNextSchedulerList) {
      this.failNextSchedulerList = false;
      return Promise.resolve({
        type: "response",
        requestId: message.requestId,
        error: {
          name: "QueryError",
          message: "injected scheduler adoption failure",
        },
      });
    }
    return super.listSchedulerActionSnapshots(message);
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

class LifecycleServer extends GatedGraphServer {
  acceptedCommitSubscriptions = 0;

  override subscribeAcceptedCommits(
    space: string,
    listener: AcceptedCommitListener,
  ): () => void {
    this.acceptedCommitSubscriptions++;
    const unsubscribe = super.subscribeAcceptedCommits(space, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.acceptedCommitSubscriptions--;
      unsubscribe();
    };
  }
}

class LoopbackSessionFactory implements SessionFactory {
  constructor(private readonly server: Server) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const client = await MemoryClient.connect({
      transport: MemoryClient.loopback(this.server),
    });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    return { client, session };
  }
}

class LoopbackStorageManager extends StorageManager {
  static connectTo(
    server: Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      new LoopbackSessionFactory(server),
    );
  }
}

const schedulerObservationFor = (space: MemorySpace, actionId: string) => ({
  version: 2,
  ownerSpace: space,
  branch: "",
  pieceId: "space:of:executor-provider:echo-piece",
  processGeneration: 1,
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:executor-provider-echo",
  runtimeFingerprint: "runtime:executor-provider-echo",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [{
    space,
    id: "of:executor-provider:echo-root",
    scope: "space",
    path: [],
  }],
  declaredWrites: [{
    space,
    id: "of:executor-provider:echo-root",
    scope: "space",
    path: [],
  }],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: "impl:executor-provider-echo",
    runtimeFingerprint: "runtime:executor-provider-echo",
    piece: {
      space,
      id: "of:executor-provider:echo-piece",
      scope: "space",
      path: [],
    },
    reads: [],
    writes: [{
      space,
      id: "of:executor-provider:echo-root",
      scope: "space",
      path: [],
    }],
    materializerWriteEnvelopes: [],
    directOutputs: [{
      space,
      id: "of:executor-provider:echo-root",
      scope: "space",
      path: [],
    }],
  },
  status: "success",
});

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

Deno.test("executor host provider binds accepted action provenance to its authenticated user", async () => {
  const principal = await Identity.fromPassphrase(
    `executor provenance provider ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const flags = {
    serverPrimaryExecutionV1: true,
    serverPrimaryExecutionClaimRoutingV1: true,
    serverPrimaryExecutionBuiltinPassivityV1: true,
  } as const;
  let sessionAuthorizationCalls = 0;
  const server = new Server({
    authorizeSessionOpen(message) {
      sessionAuthorizationCalls++;
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-provenance-test",
    },
    protocolFlags: flags,
    acl: { mode: "off", serviceDids: [principal.did()] },
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
  const observerClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: flags,
  });
  const observer = await observerClient.mount(
    space,
    {},
    authorizeSessionOpen,
  );
  assertEquals(sessionAuthorizationCalls, 1);
  const actionId = "action:executor-provenance";
  const baseObservation = schedulerObservationFor(space, actionId);
  await observer.setExecutionDemand("", [baseObservation.pieceId]);
  const lease = await server.acquireExecutionLease(space, "");
  assertExists(lease);
  assertEquals(lease.onBehalfOf, principal.did());
  await observer.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${space}:execution-policy`,
      value: { value: { version: 1, serverPrimaryExecution: true } },
    }],
  });
  await observer.watchSet([{
    id: "executor-provenance-output",
    kind: "graph",
    query: {
      roots: [{
        id: "of:executor-provider:provenance-output",
        selector: { path: [], schema: true },
      }],
    },
  }]);

  const claim = server.setExecutionClaim({
    branch: "",
    space,
    contextKey: "space",
    pieceId: baseObservation.pieceId,
    actionId,
    actionKind: "computation",
    implementationFingerprint: baseObservation.implementationFingerprint,
    runtimeFingerprint: baseObservation.runtimeFingerprint,
    leaseGeneration: lease.leaseGeneration,
  });
  const channel = createHostProviderChannel({
    server,
    space,
    executionLease: lease,
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: principal.did(),
    space,
    protocolFlags: flags,
  });
  const settlement = Promise.withResolvers<ActionSettlement>();
  const unsubscribe = observer.subscribeExecutionControl((event) => {
    if (event.type === "session.execution.settlement") {
      settlement.resolve(event.settlement);
    }
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
        id: "of:executor-provider:provenance-output",
        type: "application/json",
        value: { value: { answer: 42 } },
      }],
      schedulerObservation: {
        ...baseObservation,
        executionClaimAssertion: {
          contextKey: claim.contextKey,
          leaseGeneration: claim.leaseGeneration,
          claimGeneration: claim.claimGeneration,
        },
        inputBasisSeq: 999_999,
        executionProvenance: {
          claim,
          onBehalfOf: "did:key:forged",
          leaseGeneration: 999,
          claimGeneration: 999,
          causedBy: [999_999],
          inputBasisSeq: 999_999,
        },
      },
    });
    assertEquals(result.error, undefined);
    assertEquals(sessionAuthorizationCalls, 1);

    const snapshots = await observer.listSchedulerActionSnapshots({
      actionId,
      pieceId: baseObservation.pieceId,
      processGeneration: baseObservation.processGeneration,
    });
    const stored = snapshots.snapshots[0]?.observation as {
      inputBasisSeq?: number;
      executionProvenance?: {
        claim: {
          branch: string;
          space: string;
          contextKey: string;
          pieceId: string;
          actionId: string;
          actionKind: string;
          implementationFingerprint: string;
          runtimeFingerprint: string;
        };
        onBehalfOf: string;
        leaseGeneration: number;
        claimGeneration: number;
        causedBy: number[];
        inputBasisSeq: number;
      };
    };
    assertEquals(stored.inputBasisSeq, 0);
    assertEquals(stored.executionProvenance, {
      claim: {
        branch: "",
        space,
        contextKey: "space",
        pieceId: claim.pieceId,
        actionId,
        actionKind: "computation",
        implementationFingerprint: claim.implementationFingerprint,
        runtimeFingerprint: claim.runtimeFingerprint,
      },
      onBehalfOf: principal.did(),
      leaseGeneration: claim.leaseGeneration,
      claimGeneration: claim.claimGeneration,
      causedBy: [],
      inputBasisSeq: 0,
    });

    await server.flushSessions();
    const accepted = await Promise.race([
      settlement.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("executor settlement was not delivered")),
          1_000,
        )
      ),
    ]);
    assertEquals(accepted.outcome, "committed");
    assertEquals(accepted.inputBasisSeq, 0);
  } finally {
    unsubscribe();
    await storage.close();
    await channel.dispose();
    await observerClient.close();
    await server.close();
  }
});

Deno.test("executor host provider refreshes without watches when scheduler adoption fails", async () => {
  const principal = await Identity.fromPassphrase(
    `executor invalidation provider ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new FailingSchedulerListServer({
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
      schedulerObservation: {
        version: 1,
        ownerSpace: space,
        branch: "",
        pieceId: "space:of:executor-provider:fail-open-piece",
        processGeneration: 1,
        actionId: "action:fail-open-reader",
        actionKind: "computation",
        implementationFingerprint: "impl:fail-open-reader",
        runtimeFingerprint: "runtime:fail-open-reader",
        observedAtSeq: 0,
        transactionKind: "action-run",
        reads: [{
          space,
          id: uri,
          scope: "space",
          path: [],
        }],
        shallowReads: [],
        actualChangedWrites: [],
        currentKnownWrites: [],
        declaredWrites: [],
        materializerWriteEnvelopes: [],
        status: "success",
      },
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

    server.failNextSchedulerList = true;
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

Deno.test("executor host provider invalidates inherited linked entities on its branch lane", async () => {
  const principal = await Identity.fromPassphrase(
    `executor branch invalidation ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  await Deno.mkdir(new URL("./engine-v3/", store), { recursive: true });
  const seedEngine = await MemoryEngine.open({
    url: resolveSpaceStoreUrl(store, space),
  });
  const root = "of:executor-provider:branch-root" as URI;
  const target = "of:executor-provider:branch-target" as URI;
  try {
    MemoryEngine.applyCommit(seedEngine, {
      sessionId: "session:branch-seed",
      space,
      principal: principal.did(),
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: root,
          value: {
            value: {
              child: {
                "/": { "link@1": { id: target, path: [], space } },
              },
            },
          },
        }, {
          op: "set",
          id: target,
          value: { value: { version: 1 } },
        }],
      },
    });
    MemoryEngine.createBranch(seedEngine, "feature");
  } finally {
    MemoryEngine.close(seedEngine);
  }

  const server = new WatchCountingServer({
    store,
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-branch-invalidation-test",
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
  const writer = await writerClient.mount(space, {}, authorizeSessionOpen);
  const channel = createHostProviderChannel({
    server,
    space,
    branch: "feature",
    authorizeSessionOpen,
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: principal.did(),
    space,
    branch: "feature",
  });
  const targetAddress = {
    id: target,
    type: "application/json" as MIME,
    path: [],
  };

  try {
    const provider = storage.open(space);
    assertEquals(
      (await provider.sync(root, {
        path: [],
        schema: {
          type: "object",
          properties: {
            child: {
              type: "object",
              properties: { version: { type: "number" } },
              required: ["version"],
            },
          },
          required: ["child"],
        },
      })).error,
      undefined,
    );
    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: 1 },
    });
    assertEquals(server.watchAddCount, 0);

    const integrated = Promise.withResolvers<void>();
    storage.subscribe({
      next(notification) {
        if (
          notification.type === "integrate" &&
          JSON.stringify(provider.replica.get(targetAddress)?.is) ===
            JSON.stringify({ value: { version: 2 } })
        ) {
          integrated.resolve();
        }
        return { done: false };
      },
    });
    await writer.transact({
      branch: "feature",
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: target,
        value: { value: { version: 2 } },
      }],
    });
    const timer = setTimeout(
      () => integrated.reject(new Error("feature target was not integrated")),
      1_000,
    );
    try {
      await integrated.promise;
    } finally {
      clearTimeout(timer);
    }
    assertEquals(provider.replica.get(targetAddress)?.is, {
      value: { version: 2 },
    });
  } finally {
    await storage.close();
    await channel.dispose();
    await writerClient.close();
    await server.close();
    await Deno.remove(storePath, { recursive: true });
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
    const readopted = Promise.withResolvers<StorageNotification>();
    const notifications: StorageNotification[] = [];
    storage.subscribe({
      next(notification) {
        notifications.push(notification);
        if (notification.type === "scheduler-observations") {
          const adoptionCount = notifications.filter((candidate) =>
            candidate.type === "scheduler-observations"
          ).length;
          if (adoptionCount === 1) {
            adopted.resolve(notification);
          }
          if (adoptionCount === 2) {
            readopted.resolve(notification);
          }
        }
        return { done: false };
      },
    });

    const externalObservation = {
      version: 2 as const,
      ownerSpace: space,
      branch: "",
      pieceId: "space:of:executor-provider:piece",
      processGeneration: 1,
      actionId: "action:external",
      actionKind: "computation" as const,
      implementationFingerprint: "impl:executor-provider",
      runtimeFingerprint: "runtime:executor-provider",
      observedAtSeq: 0,
      transactionKind: "action-run" as const,
      reads: [],
      shallowReads: [],
      actualChangedWrites: [],
      currentKnownWrites: [{
        space,
        id: "of:executor-provider:observation-root",
        scope: "space" as const,
        path: [],
      }],
      declaredWrites: [{
        space,
        id: "of:executor-provider:observation-root",
        scope: "space" as const,
        path: [],
      }],
      materializerWriteEnvelopes: [],
      completeActionScopeSummary: {
        version: 1 as const,
        complete: true,
        implementationFingerprint: "impl:executor-provider",
        runtimeFingerprint: "runtime:executor-provider",
        piece: {
          space,
          id: "of:executor-provider:piece",
          scope: "space" as const,
          path: [],
        },
        reads: [],
        writes: [{
          space,
          id: "of:executor-provider:observation-root",
          scope: "space" as const,
          path: [],
        }],
        materializerWriteEnvelopes: [],
        directOutputs: [{
          space,
          id: "of:executor-provider:observation-root",
          scope: "space" as const,
          path: [],
        }],
      },
      status: "success" as const,
    };

    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: externalObservation,
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

    // Rehydration/listing sees the current version and must not permanently
    // suppress a later payload-changing re-observation of the same action row.
    const listed = await provider.listSchedulerActionSnapshots!();
    assertEquals(
      listed.snapshots[0]?.observationId,
      persisted.snapshots[0]?.observationId,
    );

    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: {
        ...externalObservation,
        status: "failed",
        errorFingerprint: "error:second-observation",
      },
    });
    const readoptionTimer = setTimeout(
      () =>
        readopted.reject(
          new Error(
            "updated scheduler observation was not adopted; notifications=" +
              notifications.map((candidate) => candidate.type).join(","),
          ),
        ),
      1_000,
    );
    let updatedNotification: StorageNotification;
    try {
      updatedNotification = await readopted.promise;
    } finally {
      clearTimeout(readoptionTimer);
    }
    assert(updatedNotification.type === "scheduler-observations");
    assertEquals(
      updatedNotification.observations[0]?.observation as {
        status?: string;
        errorFingerprint?: string;
        inputBasisSeq?: number;
      },
      {
        ...externalObservation,
        inputBasisSeq: 0,
        status: "failed",
        errorFingerprint: "error:second-observation",
      },
    );
    assertEquals(accepted.length, 2);
  } finally {
    await storage.close();
    await channel.dispose();
    await writerClient.close();
    await server.close();
  }
});

Deno.test("executor host provider suppresses only same-session observation echoes", async () => {
  const principal = await Identity.fromPassphrase(
    `executor observation echo ${crypto.randomUUID()}`,
  );
  const space = principal.did();
  const server = new WatchCountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-observation-echo-test",
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
  const writer = await writerClient.mount(space, {}, authorizeSessionOpen);
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
      (await provider.sync("of:executor-provider:echo-root")).error,
      undefined,
    );
    const adopted = Promise.withResolvers<StorageNotification>();
    storage.subscribe({
      next(notification) {
        if (notification.type === "scheduler-observations") {
          adopted.resolve(notification);
        }
        return { done: false };
      },
    });

    const replica = provider.replica;
    assert(replica.commitNative);
    assertEquals(
      (await replica.commitNative({
        operations: [],
        schedulerObservation: schedulerObservationFor(
          space,
          "action:provider-own",
        ),
      })).error,
      undefined,
    );
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: schedulerObservationFor(
        space,
        "action:external",
      ),
    });

    assertEquals(
      accepted.map((event) => ({
        own: event.originSessionId === storage.id,
        schedulerUpdateIds: event.schedulerUpdateIds,
      })),
      [
        { own: true, schedulerUpdateIds: [1] },
        { own: false, schedulerUpdateIds: [2] },
      ],
    );
    const persisted = await writer.listSchedulerActionSnapshots();
    assertEquals(
      persisted.snapshots.map((snapshot) =>
        (snapshot.observation as { actionId?: string }).actionId
      ).sort(),
      ["action:external", "action:provider-own"],
    );

    const timer = setTimeout(
      () => adopted.reject(new Error("external observation was not adopted")),
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
      notification.observations.map((snapshot) =>
        (snapshot.observation as { actionId?: string }).actionId
      ),
      ["action:external"],
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
  assertEquals(
    source.includes(
      "executor providers cannot originate client execution demand",
    ),
    true,
  );
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

type ProviderKind = "loopback" | "host";

const runProviderTrace = async (kind: ProviderKind) => {
  const signer = await Identity.fromPassphrase(
    "executor provider differential " + kind + " " + crypto.randomUUID(),
  );
  const space = signer.did();
  const server = new WatchCountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-differential-test",
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
    authorization: { principal: signer.did() },
  });
  const writerClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const writer = await writerClient.mount(
    space,
    {},
    authorizeSessionOpen,
  );
  const channel = kind === "host"
    ? createHostProviderChannel({
      server,
      space,
      authorizeSessionOpen,
    })
    : undefined;
  const storage: StorageManager = kind === "host"
    ? HostStorageManager.connect({
      port: channel!.port,
      principal: signer.did(),
      space,
    })
    : LoopbackStorageManager.connectTo(server, { as: signer });
  const accepted: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(space, (event) => {
    accepted.push(event);
  });
  const uri = "of:executor-provider:differential" as URI;
  const type = "application/json" as MIME;
  const address = { id: uri, type, path: [] };

  try {
    const provider = storage.open(space);
    const replica = provider.replica;
    assert(replica.commitNative);
    assertEquals((await provider.sync(uri)).error, undefined);

    const commit = (
      transaction: NativeStorageCommit,
      source?: Parameters<NonNullable<typeof replica.commitNative>>[1],
    ) => replica.commitNative!(transaction, source);

    assertEquals(
      (await commit({
        operations: [{
          op: "set",
          id: uri,
          type,
          value: { value: { count: 1 } },
        }],
      })).error,
      undefined,
    );
    assertEquals(
      (await commit({
        operations: [{
          op: "patch",
          id: uri,
          type,
          value: { value: { count: 2, label: "patched" } },
          patches: [
            { op: "replace", path: "/value/count", value: 2 },
            { op: "add", path: "/value/label", value: "patched" },
          ],
        }],
      })).error,
      undefined,
    );

    const integrated = Promise.withResolvers<void>();
    storage.subscribe({
      next(notification) {
        if (
          notification.type === "integrate" &&
          JSON.stringify(replica.get(address)?.is) ===
            JSON.stringify({ value: { count: 3, external: true } })
        ) {
          integrated.resolve();
        }
        return { done: false };
      },
    });
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { count: 3, external: true } },
      }],
    });
    const timer = setTimeout(
      () => integrated.reject(new Error("differential external write missed")),
      1_000,
    );
    try {
      await integrated.promise;
    } finally {
      clearTimeout(timer);
    }
    const afterExternal = replica.get(address)?.is;

    const staleSource = {
      getReadActivities() {
        return [{
          space,
          id: uri,
          type,
          path: [],
          meta: { seq: 1 },
        }];
      },
    } as unknown as Parameters<NonNullable<typeof replica.commitNative>>[1];
    const conflict = await commit({
      operations: [{
        op: "set",
        id: uri,
        type,
        value: { value: { count: 4, stale: true } },
      }],
    }, staleSource);
    const afterConflict = replica.get(address)?.is;

    const observationWrite = {
      space,
      id: uri,
      scope: "space" as const,
      path: [] as string[],
    };
    assertEquals(
      (await commit({
        operations: [],
        schedulerObservation: {
          version: 2,
          ownerSpace: space,
          branch: "",
          pieceId: "space:of:executor-provider:differential-piece",
          processGeneration: 1,
          actionId: "action:differential",
          actionKind: "computation",
          implementationFingerprint: "impl:executor-differential",
          runtimeFingerprint: "runtime:executor-differential",
          observedAtSeq: 0,
          transactionKind: "action-run",
          reads: [],
          shallowReads: [],
          actualChangedWrites: [],
          currentKnownWrites: [observationWrite],
          declaredWrites: [observationWrite],
          materializerWriteEnvelopes: [],
          completeActionScopeSummary: {
            version: 1,
            complete: true,
            implementationFingerprint: "impl:executor-differential",
            runtimeFingerprint: "runtime:executor-differential",
            piece: {
              space,
              id: "of:executor-provider:differential-piece",
              scope: "space",
              path: [],
            },
            reads: [],
            writes: [observationWrite],
            materializerWriteEnvelopes: [],
            directOutputs: [observationWrite],
          },
          status: "success",
        },
      })).error,
      undefined,
    );
    const scheduler = await provider.listSchedulerActionSnapshots!({
      ownerSpace: space,
      actionId: "action:differential",
    });

    const atomicUri = "of:executor-provider:cfc-atomic" as URI;
    const addr = /[^\s<>,;"]+@[^\s<>,;"]+/g;
    const acceptedBeforeCfc = accepted.length;
    const cfc = await commit({
      operations: [{
        op: "set",
        id: atomicUri,
        type,
        value: { value: { mustRollback: true } },
      }],
      sqliteOps: [{
        op: "sqlite",
        db: {
          id: ("of:executor-provider:cfc-" + crypto.randomUUID()) as URI,
          owner: space,
          tables: {
            emails: table(
              { id: "integer primary key", from_addr: "text", body: "text" },
              (fields) => ({
                confidentiality: all(
                  rowPrincipal(
                    "mailto",
                    match(fields.from_addr, addr, { min: 1 }),
                  ),
                ),
              }),
            ),
          },
        },
        sql: "INSERT INTO emails (from_addr, body) VALUES (?, ?)",
        params: ["not an address", "must reject"],
      }],
    });
    const cfcReplicaValue = replica.get({
      id: atomicUri,
      type,
    })?.is;
    const cfcServerValue = await server.readDocument(space, atomicUri);
    const cfcAcceptedDelta = accepted.length - acceptedBeforeCfc;

    assertEquals(
      (await commit({
        operations: [{ op: "delete", id: uri, type }],
      })).error,
      undefined,
    );

    return {
      afterExternal,
      conflict: conflict.error?.name,
      afterConflict,
      scheduler: scheduler.snapshots.map((snapshot) => ({
        actionId: (snapshot.observation as { actionId?: string }).actionId,
        executionContextKey: snapshot.executionContextKey,
        status: (snapshot.observation as { status?: string }).status,
      })),
      cfc: {
        name: cfc.error?.name as string | undefined,
        replicaValue: cfcReplicaValue,
        serverValue: cfcServerValue,
        acceptedDelta: cfcAcceptedDelta,
      },
      final: replica.get(address)?.is,
      accepted: accepted.map((event) => ({
        order: event.order,
        deliverySeq: event.deliverySeq,
        revisionOps: event.revisions.map((revision) => revision.op),
        schedulerUpdateIds: event.schedulerUpdateIds,
      })),
      watchAdds: server.watchAddCount,
    };
  } finally {
    await storage.close();
    await channel?.dispose();
    await writerClient.close();
    await server.close();
  }
};

Deno.test("executor host provider is behaviorally equivalent to authenticated loopback", async () => {
  const loopback = await runProviderTrace("loopback");
  const host = await runProviderTrace("host");
  assertEquals(
    { ...host, watchAdds: undefined },
    { ...loopback, watchAdds: undefined },
  );
  assertEquals(host.afterExternal, {
    value: { count: 3, external: true },
  });
  assertEquals(host.conflict, "ConflictError");
  assertEquals(host.afterConflict, host.afterExternal);
  assertEquals(host.scheduler, [{
    actionId: "action:differential",
    executionContextKey: "space",
    status: "success",
  }]);
  assertEquals(host.cfc, {
    name: "RowLabelCommitError",
    replicaValue: undefined,
    serverValue: null,
    acceptedDelta: 0,
  });
  assertEquals(host.final, undefined);
  assertEquals(host.watchAdds, 0);
  assert(loopback.watchAdds > 0);
});

const runAclTrace = async (kind: ProviderKind) => {
  const owner = await Identity.fromPassphrase(
    "executor ACL owner " + kind + " " + crypto.randomUUID(),
  );
  const reader = await Identity.fromPassphrase(
    "executor ACL reader " + kind + " " + crypto.randomUUID(),
  );
  const space = owner.did();
  const server = new WatchCountingServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-acl-test",
    },
    acl: { mode: "enforce" },
  });
  const authFor = (
    principal: string,
  ): MemoryClient.SessionOpenAuthFactory =>
  (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  });
  const ownerClient = await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
  });
  const ownerSession = await ownerClient.mount(
    space,
    {},
    authFor(owner.did()),
  );
  const uri = "of:executor-provider:acl-data" as URI;
  await ownerSession.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: ("of:" + space) as URI,
      value: {
        value: {
          [owner.did()]: "OWNER",
          [reader.did()]: "READ",
        },
      },
    }],
  });
  await ownerSession.transact({
    localSeq: 2,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: uri,
      value: { value: { protected: true } },
    }],
  });

  const channel = kind === "host"
    ? createHostProviderChannel({
      server,
      space,
      authorizeSessionOpen: authFor(reader.did()),
    })
    : undefined;
  const storage: StorageManager = kind === "host"
    ? HostStorageManager.connect({
      port: channel!.port,
      principal: reader.did(),
      space,
    })
    : LoopbackStorageManager.connectTo(server, { as: reader });
  const accepted: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(space, (event) => {
    accepted.push(event);
  });

  try {
    const provider = storage.open(space);
    assertEquals((await provider.sync(uri)).error, undefined);
    const replica = provider.replica;
    assert(replica.commitNative);
    const denied = await replica.commitNative({
      operations: [{
        op: "set",
        id: uri,
        type: "application/json",
        value: { value: { protected: false } },
      }],
    });
    return {
      denial: {
        name: denied.error?.name,
        message: denied.error?.message.replace(/did:key:\S+/g, "<did>"),
      },
      replicaValue: replica.get({
        id: uri,
        type: "application/json",
      })?.is,
      serverValue: await server.readDocument(space, uri),
      accepted: accepted.length,
      watchAdds: server.watchAddCount,
    };
  } finally {
    await storage.close();
    await channel?.dispose();
    await ownerClient.close();
    await server.close();
  }
};

Deno.test("executor host provider preserves ACL denial and atomic rollback parity", async () => {
  const loopback = await runAclTrace("loopback");
  const host = await runAclTrace("host");
  assertEquals(
    { ...host, watchAdds: undefined },
    { ...loopback, watchAdds: undefined },
  );
  assertEquals(host.denial.name, "TransactionError");
  assert(host.denial.message?.includes("lacks WRITE"));
  assertEquals(host.replicaValue, { value: { protected: true } });
  assertEquals(host.serverValue, { value: { protected: true } });
  assertEquals(host.accepted, 0);
  assertEquals(host.watchAdds, 0);
  assert(loopback.watchAdds > 0);
});

Deno.test("executor host provider disposal releases callbacks and pending reads", async () => {
  const principal = await Identity.fromPassphrase(
    "executor provider disposal " + crypto.randomUUID(),
  );
  const space = principal.did();
  const server = new LifecycleServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-disposal-test",
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
  let disposing: Promise<void> | undefined;

  try {
    assertEquals(server.acceptedCommitSubscriptions, 1);
    server.gateNextGraphQuery();
    const pendingRead = storage.open(space).sync(
      "of:executor-provider:pending-disposal",
    );
    await server.graphQueryStarted.promise;

    disposing = channel.dispose();
    const disposedPromptly = await Promise.race([
      disposing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assertEquals(disposedPromptly, true);
    assertEquals(server.acceptedCommitSubscriptions, 0);

    const pendingResult = await Promise.race([
      pendingRead.then((result) => ({ settled: true as const, result })),
      new Promise<{ settled: false }>((resolve) =>
        setTimeout(() => resolve({ settled: false }), 100)
      ),
    ]);
    assert(pendingResult.settled, "host-first disposal stranded a Worker read");
    assert(pendingResult.result.error);
    await storage.close();
  } finally {
    server.releaseGraphQuery.resolve();
    await disposing;
    await channel.dispose();
    await storage.close();
    await server.close();
  }
});

Deno.test("executor host provider transfers as an opaque channel to a real Worker", async () => {
  const principal = await Identity.fromPassphrase(
    "executor provider real worker " + crypto.randomUUID(),
  );
  const space = principal.did();
  const server = new LifecycleServer({
    authorizeSessionOpen(message) {
      const value = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof value === "string" ? value : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-real-worker-test",
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
  const worker = new Worker(
    new URL(
      "./fixtures/executor-provider-worker.ts",
      import.meta.url,
    ).href,
    { type: "module" },
  );
  const queued: Record<string, unknown>[] = [];
  const waiters: {
    type: string;
    pending: PromiseWithResolvers<Record<string, unknown>>;
  }[] = [];
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data as Record<string, unknown>;
    if (message.type === "error") {
      const error = new Error(String(message.message ?? "Worker failed"));
      for (const waiter of waiters.splice(0)) {
        waiter.pending.reject(error);
      }
      queued.push(message);
      return;
    }
    const waiterIndex = waiters.findIndex((waiter) =>
      waiter.type === message.type
    );
    if (waiterIndex === -1) {
      queued.push(message);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    waiter.pending.resolve(message);
  });
  worker.addEventListener("error", (event) => {
    for (const waiter of waiters.splice(0)) {
      waiter.pending.reject(event.error ?? new Error(event.message));
    }
  });
  const nextMessage = (type: string): Promise<Record<string, unknown>> => {
    const queuedIndex = queued.findIndex((message) => message.type === type);
    if (queuedIndex !== -1) {
      return Promise.resolve(queued.splice(queuedIndex, 1)[0]!);
    }
    const pending = Promise.withResolvers<Record<string, unknown>>();
    waiters.push({ type, pending });
    const timer = setTimeout(
      () =>
        pending.reject(
          new Error(
            "timed out waiting for Worker " + type + "; queued=" +
              JSON.stringify(queued),
          ),
        ),
      10_000,
    );
    return pending.promise.finally(() => clearTimeout(timer));
  };

  try {
    await nextMessage("booted");
    worker.postMessage({
      type: "init",
      port: channel.port,
      principal: principal.did(),
      space,
    }, [channel.port]);
    await nextMessage("committed");
    assertEquals(
      await server.readDocument(space, "of:executor-provider:worker"),
      { value: { version: 1, realm: "worker" } },
    );

    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:executor-provider:worker",
        value: { value: { version: 2, realm: "external" } },
      }],
    });
    await nextMessage("integrated");

    // The worker controller owns this pairing: an abrupt realm termination is
    // immediately followed by host-channel disposal, which releases the
    // authenticated connection and accepted-commit callback.
    worker.terminate();
    await channel.dispose();
    assertEquals(server.acceptedCommitSubscriptions, 0);
    assertEquals(queued.find((message) => message.type === "error"), undefined);
  } finally {
    worker.terminate();
    await channel.dispose();
    await writerClient.close();
    await server.close();
  }
});
