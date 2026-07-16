import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import {
  type AcceptedCommitSeq,
  type ActionSettlement,
  canonicalActionClaimKey,
  type ClientCommit,
  type ExecutionClaim,
  resetServerPrimaryExecutionConfig,
  sessionExecutionContextKey,
  type SessionSync,
  setServerPrimaryExecutionConfig,
  toInputBasisSeq,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import type {
  ReplicaSession,
  ReplicaSessionHandle,
  ReplicaWatchView,
} from "../src/storage/v2-replica-session.ts";
import { type SessionFactory, StorageManager } from "../src/storage/v2.ts";
import type { StorageNotification } from "../src/storage/interface.ts";
import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
} from "@commonfabric/utils/logger";

const signer = await Identity.fromPassphrase(
  "client execution overlay test principal",
);
const SPACE = signer.did() as MemorySpace;
const INPUT = "of:client-overlay-input" as URI;
const OUTPUT = "of:client-overlay-output" as URI;
const CHAIN_SOURCE = "of:client-overlay-chain-source" as URI;
const CHAIN_UNRELATED = "of:client-overlay-chain-unrelated" as URI;
const CHAIN_INTERMEDIATE = "of:client-overlay-chain-intermediate" as URI;
const CHAIN_DOWNSTREAM = "of:client-overlay-chain-downstream" as URI;
const sourceAction = {};

const claim: ExecutionClaim = {
  branch: "",
  space: SPACE,
  contextKey: "space",
  pieceId: "space:of:client-overlay-piece",
  actionId: "action:client-overlay",
  actionKind: "computation",
  implementationFingerprint: "impl:client-overlay",
  runtimeFingerprint: "runtime:client-overlay",
  leaseGeneration: 2,
  claimGeneration: 4,
  expiresAt: 100_000,
};

const observation = () => ({
  version: 2 as const,
  ownerSpace: SPACE,
  branch: "",
  pieceId: claim.pieceId,
  processGeneration: 1,
  actionId: claim.actionId,
  actionKind: "computation" as const,
  implementationFingerprint: claim.implementationFingerprint,
  runtimeFingerprint: claim.runtimeFingerprint,
  observedAtSeq: 0,
  transactionKind: "action-run" as const,
  reads: [{
    space: SPACE,
    scope: "space" as const,
    id: INPUT,
    path: ["value"],
  }],
  shallowReads: [],
  actualChangedWrites: [{
    space: SPACE,
    scope: "space" as const,
    id: OUTPUT,
    path: ["value"],
  }],
  currentKnownWrites: [{
    space: SPACE,
    scope: "space" as const,
    id: OUTPUT,
    path: ["value"],
  }],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1 as const,
    complete: true as const,
    implementationFingerprint: claim.implementationFingerprint,
    runtimeFingerprint: claim.runtimeFingerprint,
    piece: {
      space: SPACE,
      scope: "space" as const,
      id: "of:client-overlay-piece",
      path: ["value"],
    },
    reads: [{
      space: SPACE,
      scope: "space" as const,
      id: INPUT,
      path: ["value"],
    }],
    writes: [{
      space: SPACE,
      scope: "space" as const,
      id: OUTPUT,
      path: ["value"],
    }],
    materializerWriteEnvelopes: [],
    directOutputs: [{
      space: SPACE,
      scope: "space" as const,
      id: OUTPUT,
      path: ["value"],
    }],
  },
  status: "success" as const,
});

const observationFor = (
  actionClaim: ExecutionClaim,
  reads: readonly URI[],
  writes: readonly URI[],
) => {
  const address = (id: URI) => ({
    space: SPACE,
    scope: "space" as const,
    id,
    path: ["value"],
  });
  return {
    ...observation(),
    pieceId: actionClaim.pieceId,
    actionId: actionClaim.actionId,
    actionKind: actionClaim.actionKind,
    implementationFingerprint: actionClaim.implementationFingerprint,
    runtimeFingerprint: actionClaim.runtimeFingerprint,
    reads: reads.map(address),
    actualChangedWrites: writes.map(address),
    currentKnownWrites: writes.map(address),
    completeActionScopeSummary: {
      version: 1 as const,
      complete: true as const,
      implementationFingerprint: actionClaim.implementationFingerprint,
      runtimeFingerprint: actionClaim.runtimeFingerprint,
      piece: {
        space: SPACE,
        scope: "space" as const,
        id: actionClaim.pieceId.slice("space:".length),
        path: ["value"],
      },
      reads: reads.map(address),
      writes: writes.map(address),
      materializerWriteEnvelopes: [],
      directOutputs: writes.map(address),
    },
  };
};

const emptySync = (overrides: Partial<SessionSync> = {}): SessionSync => ({
  type: "sync",
  fromSeq: 0,
  toSeq: 0,
  upserts: [],
  removes: [],
  ...overrides,
});

class PushView implements ReplicaWatchView {
  #pending: PromiseWithResolvers<IteratorResult<SessionSync>>[] = [];
  #queued: {
    sync: SessionSync;
    delivered: PromiseWithResolvers<void>;
    processed: PromiseWithResolvers<void>;
  }[] = [];
  #inFlight: PromiseWithResolvers<void> | undefined;
  #closed = false;

  close(): void {
    this.#closed = true;
    this.#inFlight?.resolve();
    this.#inFlight = undefined;
    for (const queued of this.#queued.splice(0)) {
      queued.delivered.resolve();
      queued.processed.resolve();
    }
    for (const pending of this.#pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }

  push(sync: SessionSync): Promise<void> {
    return this.enqueue(sync).processed;
  }

  enqueue(sync: SessionSync): {
    delivered: Promise<void>;
    processed: Promise<void>;
  } {
    const delivered = Promise.withResolvers<void>();
    const processed = Promise.withResolvers<void>();
    const pending = this.#pending.shift();
    if (pending) {
      this.#inFlight = processed;
      delivered.resolve();
      pending.resolve({ done: false, value: sync });
    } else {
      this.#queued.push({ sync, delivered, processed });
    }
    return { delivered: delivered.promise, processed: processed.promise };
  }

  subscribeSync(): AsyncIterator<SessionSync> {
    return {
      next: () => {
        // The replica asks for the next item only after applying the previous
        // sync. Resolve the test-owned acknowledgement at that exact event so
        // callers never need to poll visible state or guess a deadline.
        this.#inFlight?.resolve();
        this.#inFlight = undefined;
        const queued = this.#queued.shift();
        if (queued) {
          this.#inFlight = queued.processed;
          queued.delivered.resolve();
          return Promise.resolve({ done: false, value: queued.sync });
        }
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        const pending = Promise.withResolvers<IteratorResult<SessionSync>>();
        this.#pending.push(pending);
        return pending.promise;
      },
    };
  }
}

class OverlaySessionFactory implements SessionFactory {
  readonly commits: ClientCommit[] = [];
  readonly view = new PushView();
  claims: ExecutionClaim[] = [claim];
  executionFeedSeq = 0;
  onWatchAdd?: () => SessionSync;
  onTransact?: (
    commit: ClientCommit,
    attempt: number,
  ) => Promise<AppliedCommit>;
  #seq = 0;
  #commitWaiters: {
    count: number;
    pending: PromiseWithResolvers<void>;
  }[] = [];

  constructor(private readonly builtinPassivity = false) {}

  waitForCommitCount(count: number): Promise<void> {
    if (this.commits.length >= count) return Promise.resolve();
    const pending = Promise.withResolvers<void>();
    this.#commitWaiters.push({ count, pending });
    return pending.promise;
  }

  #notifyCommitWaiters(): void {
    this.#commitWaiters = this.#commitWaiters.filter((waiter) => {
      if (this.commits.length < waiter.count) return true;
      waiter.pending.resolve();
      return false;
    });
  }

  create(
    _space: MemorySpace,
    _signer?: Signer,
  ): Promise<ReplicaSessionHandle> {
    const executionClaims = () => [...this.claims];
    const executionFeedSeq = () => this.executionFeedSeq;
    const session = {
      sessionId: "session:client-overlay",
      sessionToken: undefined,
      serverSeq: 0,
      get executionClaims() {
        return executionClaims();
      },
      get executionFeedSeq() {
        return executionFeedSeq();
      },
      transact: async (commit: ClientCommit): Promise<AppliedCommit> => {
        this.commits.push(structuredClone(commit));
        this.#notifyCommitWaiters();
        if (this.onTransact) {
          return await this.onTransact(commit, this.commits.length);
        }
        return {
          seq: ++this.#seq,
          branch: "",
          revisions: [],
        };
      },
      watchAddSync: () =>
        Promise.resolve({
          view: this.view,
          sync: this.onWatchAdd?.() ??
            emptySync({
              execution: {
                fromFeedSeq: 0,
                toFeedSeq: 1,
                snapshot: { claims: [...this.claims] },
                events: [],
              },
            }),
        }),
    } as unknown as ReplicaSession;
    return Promise.resolve({
      client: {
        serverFlags: {
          serverPrimaryExecutionV1: true,
          serverPrimaryExecutionClaimRoutingV1: true,
          serverPrimaryExecutionBuiltinPassivityV1: this.builtinPassivity,
        },
        close: () => Promise.resolve(),
      } as ReplicaSessionHandle["client"],
      session,
    });
  }
}

class OverlayStorageManager extends StorageManager {
  static connect(factory: SessionFactory): OverlayStorageManager {
    return new OverlayStorageManager({
      as: signer,
      memoryHost: new URL("memory://client-overlay"),
    }, factory);
  }
}

function assertCondition(check: () => boolean): void {
  assertEquals(check(), true, "condition did not become true");
}

function notificationCondition(
  storage: StorageManager,
  check: () => boolean,
): Promise<void> {
  if (check()) return Promise.resolve();
  const observed = Promise.withResolvers<void>();
  const subscription = {
    next(_notification: StorageNotification) {
      if (check()) observed.resolve();
      return { done: false as const };
    },
  };
  storage.subscribe(subscription);
  if (check()) observed.resolve();
  return observed.promise.finally(() => storage.unsubscribe(subscription));
}

Deno.test("first watch adopts execution control that arrived before its view existed", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  factory.claims = [];
  factory.executionFeedSeq = 1;
  factory.onWatchAdd = () => {
    // Model a claim delivered to SpaceSession after SpaceReplica seeded its
    // initial cursor, but before watchAddSync created the first WatchView.
    factory.claims = [claim];
    factory.executionFeedSeq = 3;
    return emptySync({
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 3,
        events: [],
      },
    });
  };
  const storage = OverlayStorageManager.connect(factory);
  const query = { space: SPACE, branch: "", pieceId: claim.pieceId };
  try {
    await storage.open(SPACE).sync(INPUT);
    const diagnostics = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(diagnostics.executionFeedSeq, 3);
    assertEquals(diagnostics.snapshotRequired, false);
    assertEquals(diagnostics.claims, [claim]);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

async function writeClaimedOutput(
  storage: StorageManager,
  value: FabricValue,
  readInput = false,
): Promise<void> {
  const tx = storage.edit();
  tx.sourceAction = sourceAction;
  tx.setSchedulerObservation?.(observation());
  if (readInput) {
    const read = tx.read({
      space: SPACE,
      id: INPUT,
      type: "application/json",
      path: ["value"],
    });
    if (read.error) throw read.error;
  }
  const writer = tx.writer(SPACE);
  if (writer.error) throw writer.error;
  const written = writer.ok.write({
    id: OUTPUT,
    type: "application/json",
    path: ["value"],
  }, value);
  if (written.error) throw written.error;
  const result = await tx.commit();
  if (result.error) throw new Error(result.error.message);
}

function beginSourceInputWrite(
  storage: StorageManager,
  value: FabricValue,
  id: URI = INPUT,
): Promise<unknown> {
  const tx = storage.edit();
  const writer = tx.writer(SPACE);
  if (writer.error) throw writer.error;
  const written = writer.ok.write({
    id,
    type: "application/json",
    path: ["value"],
  }, value);
  if (written.error) throw written.error;
  return tx.commit();
}

function visibleOutput(storage: StorageManager): unknown {
  return visibleValue(storage, OUTPUT);
}

function visibleValue(storage: StorageManager, id: URI): unknown {
  const document = storage.open(SPACE).replica.get({
    id,
    type: "application/json",
  })?.is as { value?: unknown } | undefined;
  return document?.value;
}

async function writeClaimedChainValue(
  storage: StorageManager,
  action: object,
  actionClaim: ExecutionClaim,
  reads: readonly URI[],
  output: URI,
  value: FabricValue,
): Promise<void> {
  const tx = storage.edit();
  tx.sourceAction = action;
  tx.setSchedulerObservation?.(observationFor(actionClaim, reads, [output]));
  for (const id of reads) {
    const read = tx.read({
      space: SPACE,
      id,
      type: "application/json",
      path: ["value"],
    });
    if (read.error) throw read.error;
  }
  const writer = tx.writer(SPACE);
  if (writer.error) throw writer.error;
  const written = writer.ok.write({
    id: output,
    type: "application/json",
    path: ["value"],
  }, value);
  if (written.error) throw written.error;
  const result = await tx.commit();
  if (result.error) throw new Error(result.error.message);
}

Deno.test("claimed client computation stays visible locally with zero wire commit", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const counts = getLoggerCountsBreakdown()["storage.v2"] ?? {};
  const suppressedBaseline = counts["execution-client-derived-suppressed"]
    ?.debug ?? 0;
  const upstreamBaseline = counts[
    "execution-client-derived-upstream-commit"
  ]?.debug ?? 0;
  const createdBaseline = counts["execution-overlay-created"]?.debug ?? 0;
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "local-overlay");
    assertEquals(visibleOutput(storage), "local-overlay");
    assertEquals(factory.commits, []);
    const updated = getLoggerCountsBreakdown()["storage.v2"] ?? {};
    assertEquals(
      updated["execution-client-derived-suppressed"]?.debug ?? 0,
      suppressedBaseline + 1,
    );
    assertEquals(
      updated["execution-client-derived-upstream-commit"]?.debug ?? 0,
      upstreamBaseline,
    );
    assertEquals(
      updated["execution-overlay-created"]?.debug ?? 0,
      createdBaseline + 1,
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("ordered revoke drops the matching overlay and resumes upstream authority", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const notifications: StorageNotification[] = [];
  const upstreamBaseline = getLoggerCountsBreakdown()["storage.v2"]?.[
    "execution-client-derived-upstream-commit"
  ]?.debug ?? 0;
  storage.subscribe({
    next(notification) {
      notifications.push(notification);
      return { done: false };
    },
  });
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "local-overlay");

    factory.claims = [];
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.claim.revoke",
          branch: "",
          claim,
          leaseGeneration: claim.leaseGeneration,
          claimGeneration: claim.claimGeneration,
        }],
      },
    }));
    assertCondition(() => visibleOutput(storage) === undefined);
    const invalidation = notifications.find((notification) =>
      notification.type === "execution-claim-invalidation"
    );
    assertEquals(invalidation?.type, "execution-claim-invalidation");
    if (invalidation?.type === "execution-claim-invalidation") {
      assertEquals(invalidation.sourceAction, sourceAction);
      assertEquals(invalidation.diagnosticCode, "claim-revoked");
    }

    await writeClaimedOutput(storage, "client-authoritative");
    assertEquals(factory.commits.length, 1);
    assertEquals(factory.commits[0]?.operations[0], {
      op: "set",
      id: OUTPUT,
      scope: "space",
      value: { value: "client-authoritative" },
    });
    assertEquals(
      getLoggerCountsBreakdown()["storage.v2"]?.[
        "execution-client-derived-upstream-commit"
      ]?.debug ?? 0,
      upstreamBaseline + 1,
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("unserved settlement dirties the claimed producer before exact revoke", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const notifications: StorageNotification[] = [];
  storage.subscribe({
    next(notification) {
      notifications.push(notification);
      return { done: false };
    },
  });
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "unserved-overlay");

    factory.claims = [];
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "unserved",
          },
        }, {
          type: "session.execution.claim.revoke",
          branch: "",
          claim,
          leaseGeneration: claim.leaseGeneration,
          claimGeneration: claim.claimGeneration,
        }],
      },
    }));

    assertCondition(() => visibleOutput(storage) === undefined);
    assertEquals(
      notifications.some((notification) =>
        notification.type === "execution-claim-invalidation" &&
        notification.sourceAction === sourceAction &&
        notification.diagnosticCode === "claim-unserved"
      ),
      true,
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("flag off keeps an otherwise matching claimed computation upstream", async () => {
  resetServerPrimaryExecutionConfig();
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "ordinary-upstream");
    assertEquals(factory.commits.length, 1);
    assertEquals(visibleOutput(storage), "ordinary-upstream");
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("matching no-op settlement clears a claimed overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const droppedBaseline = getLoggerCountsBreakdown()["storage.v2"]?.[
    "execution-overlay-dropped"
  ]?.debug ?? 0;
  const heldTimingBaseline = getTimingStatsBreakdown()["storage.v2"]?.[
    "execution-overlay-held"
  ]?.count ?? 0;
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "local-overlay");
    const settlement: ActionSettlement = {
      branch: "",
      claim,
      inputBasisSeq: toInputBasisSeq(0),
      outcome: "no-op",
    };
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement,
        }],
      },
    }));
    assertCondition(() => visibleOutput(storage) === undefined);
    assertEquals(visibleOutput(storage), undefined);
    assertEquals(
      getLoggerCountsBreakdown()["storage.v2"]?.[
        "execution-overlay-dropped"
      ]?.debug ?? 0,
      droppedBaseline + 1,
    );
    assertEquals(
      getTimingStatsBreakdown()["storage.v2"]?.[
        "execution-overlay-held"
      ]?.count ?? 0,
      heldTimingBaseline + 1,
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("a no-op settlement arriving before speculation clears the later overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics({
        space: SPACE,
        branch: "",
        pieceId: claim.pieceId,
        actionId: claim.actionId,
      }).executionFeedSeq === 2
    );

    await writeClaimedOutput(storage, "late-local-overlay");

    assertEquals(visibleOutput(storage), undefined);
    const diagnostics = storage.getExecutionRoutingDiagnostics({
      space: SPACE,
      branch: "",
      pieceId: claim.pieceId,
      actionId: claim.actionId,
    });
    assertEquals(diagnostics.actions[0]?.pendingOverlayCount, 0);
    assertEquals(diagnostics.actions[0]?.basisCoveredOverlayDrops, 1);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("a committed settlement arriving before speculation retains its data barrier", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "committed",
            acceptedCommitSeq: 5 as AcceptedCommitSeq,
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics({
        space: SPACE,
        branch: "",
        pieceId: claim.pieceId,
        actionId: claim.actionId,
      }).executionFeedSeq === 2
    );

    await writeClaimedOutput(storage, "late-local-overlay");
    assertEquals(visibleOutput(storage), "late-local-overlay");

    await factory.view.push(emptySync({
      toSeq: 5,
      upserts: [{
        branch: "",
        id: OUTPUT,
        seq: 5,
        doc: { value: "server-output" },
      }],
    }));
    assertCondition(() => visibleOutput(storage) === "server-output");
    const diagnostics = storage.getExecutionRoutingDiagnostics({
      space: SPACE,
      branch: "",
      pieceId: claim.pieceId,
      actionId: claim.actionId,
    });
    assertEquals(diagnostics.actions[0]?.pendingOverlayCount, 0);
    assertEquals(diagnostics.actions[0]?.basisCoveredOverlayDrops, 1);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("a later early no-op retains an earlier committed data barrier", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "committed",
            acceptedCommitSeq: 5 as AcceptedCommitSeq,
          },
        }, {
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(1),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics({
        space: SPACE,
        branch: "",
        pieceId: claim.pieceId,
        actionId: claim.actionId,
      }).executionFeedSeq === 3
    );

    await writeClaimedOutput(storage, "held-for-earlier-committed-data");
    assertEquals(visibleOutput(storage), "held-for-earlier-committed-data");

    await factory.view.push(emptySync({
      toSeq: 5,
      upserts: [{
        branch: "",
        id: OUTPUT,
        seq: 5,
        doc: { value: "authoritative-after-merged-barrier" },
      }],
    }));
    assertCondition(() =>
      visibleOutput(storage) === "authoritative-after-merged-barrier"
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("live computation claims are exposed without broadening builtin capture", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const computationAction = {};
  storage.registerExecutionAction(
    computationAction,
    canonicalActionClaimKey(claim),
  );
  try {
    await storage.open(SPACE).sync(INPUT);
    assertEquals(
      storage.hasLiveExecutionClaimForAction(computationAction),
      true,
    );
    assertEquals(storage.captureExecutionClaim(computationAction), undefined);

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        snapshot: { claims: [] },
        events: [],
      },
    }));
    assertCondition(() =>
      storage.hasLiveExecutionClaimForAction(computationAction) === false
    );
  } finally {
    storage.unregisterExecutionAction(computationAction);
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("ordered revoke invalidates a registered computation without a speculative overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const computationAction = {};
  const notifications: StorageNotification[] = [];
  storage.registerExecutionAction(
    computationAction,
    canonicalActionClaimKey(claim),
  );
  storage.subscribe({
    next(notification) {
      notifications.push(notification);
      return { done: false };
    },
  });
  try {
    await storage.open(SPACE).sync(INPUT);

    factory.claims = [];
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.claim.revoke",
          branch: "",
          claim,
          leaseGeneration: claim.leaseGeneration,
          claimGeneration: claim.claimGeneration,
        }],
      },
    }));

    assertCondition(() =>
      notifications.some((notification) =>
        notification.type === "execution-claim-invalidation" &&
        notification.sourceAction === computationAction &&
        notification.diagnosticCode === "claim-revoked"
      )
    );
  } finally {
    storage.unregisterExecutionAction(computationAction);
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("settlement basis older than a direct confirmed read retains the overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const retainedBaseline = getLoggerCountsBreakdown()["storage.v2"]?.[
    "execution-overlay-retained"
  ]?.debug ?? 0;
  try {
    await storage.open(SPACE).sync(INPUT);
    await factory.view.push(emptySync({
      toSeq: 5,
      upserts: [{
        branch: "",
        id: INPUT,
        seq: 5,
        doc: { value: "confirmed-input" },
      }],
    }));
    assertCondition(() =>
      storage.open(SPACE).replica.get({
        id: INPUT,
        type: "application/json",
      }) !== undefined
    );
    await writeClaimedOutput(storage, "basis-five", true);

    await factory.view.push(emptySync({
      fromSeq: 5,
      toSeq: 5,
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(4),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertEquals(visibleOutput(storage), "basis-five");
    assertEquals(
      getLoggerCountsBreakdown()["storage.v2"]?.[
        "execution-overlay-retained"
      ]?.debug ?? 0,
      retainedBaseline + 1,
    );

    await factory.view.push(emptySync({
      fromSeq: 5,
      toSeq: 5,
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(5),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() => visibleOutput(storage) === undefined);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("pending source basis translates to its confirmation-assigned sequence", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const sourceApplied = Promise.withResolvers<AppliedCommit>();
  factory.onTransact = () => sourceApplied.promise;
  const storage = OverlayStorageManager.connect(factory);
  const sourceDrained = Promise.withResolvers<void>();
  let sourceWasPending = false;
  const unsubscribePending = storage.subscribePendingCommits((pending) => {
    if (pending) sourceWasPending = true;
    else if (sourceWasPending) sourceDrained.resolve();
  });
  try {
    await storage.open(SPACE).sync(INPUT);
    const sourceStarted = factory.waitForCommitCount(1);
    const sourceCommit = beginSourceInputWrite(storage, "pending-source");
    await sourceStarted;
    await writeClaimedOutput(storage, "pending-basis-overlay", true);

    const settlement = factory.view.enqueue(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(6),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertEquals(visibleOutput(storage), "pending-basis-overlay");
    const overlayDropped = notificationCondition(
      storage,
      () => visibleOutput(storage) === undefined,
    );

    sourceApplied.resolve({ seq: 6, branch: "", revisions: [] });
    await sourceDrained.promise;
    await sourceCommit;
    await settlement.delivered;
    await overlayDropped;
    await settlement.processed;
    assertCondition(() => visibleOutput(storage) === undefined);
  } finally {
    unsubscribePending();
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("rejected source basis discards its dependent overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const sourceApplied = Promise.withResolvers<AppliedCommit>();
  factory.onTransact = () => sourceApplied.promise;
  const storage = OverlayStorageManager.connect(factory);
  const notifications: StorageNotification[] = [];
  storage.subscribe({
    next(notification) {
      notifications.push(notification);
      return { done: false };
    },
  });
  try {
    await storage.open(SPACE).sync(INPUT);
    const sourceStarted = factory.waitForCommitCount(1);
    const sourceCommit = beginSourceInputWrite(storage, "doomed-source");
    await sourceStarted;
    await writeClaimedOutput(storage, "doomed-overlay", true);
    sourceApplied.reject(Object.assign(new Error("source rejected"), {
      name: "TransactionError",
    }));
    await sourceCommit;
    assertCondition(() => visibleOutput(storage) === undefined);
    assertEquals(
      notifications.some((notification) =>
        notification.type === "execution-claim-invalidation" &&
        notification.diagnosticCode === "source-basis-rejected"
      ),
      true,
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("source rejection transfers a pending no-op before an immediate rerun", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const sourceApplied = Promise.withResolvers<AppliedCommit>();
  factory.onTransact = () => sourceApplied.promise;
  const storage = OverlayStorageManager.connect(factory);
  const query = {
    space: SPACE,
    branch: "",
    pieceId: claim.pieceId,
    actionId: claim.actionId,
  };
  try {
    await storage.open(SPACE).sync(INPUT);
    const sourceStarted = factory.waitForCommitCount(1);
    const sourceCommit = beginSourceInputWrite(storage, "doomed-source");
    await sourceStarted;
    await writeClaimedOutput(storage, "doomed-overlay", true);
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 2
    );
    assertEquals(
      storage.getExecutionRoutingDiagnostics(query).actions[0]
        ?.pendingSettlementCount,
      1,
    );

    sourceApplied.reject(Object.assign(new Error("source rejected"), {
      name: "TransactionError",
    }));
    await sourceCommit;
    assertCondition(() => visibleOutput(storage) === undefined);

    await writeClaimedOutput(storage, "immediate-rerun-overlay");
    assertEquals(visibleOutput(storage), undefined);
    const settled = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(settled.actions[0]?.pendingOverlayCount, 0);
    assertEquals(settled.actions[0]?.pendingSettlementCount, 0);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("early no-op preserves a pending committed barrier after overlay loss", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const sourceApplied = Promise.withResolvers<AppliedCommit>();
  factory.onTransact = () => sourceApplied.promise;
  const storage = OverlayStorageManager.connect(factory);
  const query = {
    space: SPACE,
    branch: "",
    pieceId: claim.pieceId,
    actionId: claim.actionId,
  };
  try {
    await storage.open(SPACE).sync(INPUT);
    const sourceStarted = factory.waitForCommitCount(1);
    const sourceCommit = beginSourceInputWrite(storage, "doomed-source");
    await sourceStarted;
    await writeClaimedOutput(storage, "first-overlay", true);

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "committed",
            acceptedCommitSeq: 7 as AcceptedCommitSeq,
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 2
    );

    sourceApplied.reject(Object.assign(new Error("source rejected"), {
      name: "TransactionError",
    }));
    await sourceCommit;
    assertCondition(() => visibleOutput(storage) === undefined);

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(1),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 3
    );

    await writeClaimedOutput(storage, "second-overlay");
    assertEquals(visibleOutput(storage), "second-overlay");
    const held = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(held.actions[0]?.pendingOverlayCount, 1);
    assertEquals(held.actions[0]?.pendingSettlementCount, 1);

    await factory.view.push(emptySync({
      toSeq: 7,
      upserts: [{
        branch: "",
        id: OUTPUT,
        seq: 7,
        doc: { value: "authoritative-after-recovery" },
      }],
    }));
    assertCondition(() =>
      visibleOutput(storage) === "authoritative-after-recovery"
    );
    const settled = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(settled.actions[0]?.pendingOverlayCount, 0);
    assertEquals(settled.actions[0]?.pendingSettlementCount, 0);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("committed settlement waits for the accepted data to be replica-applied", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "speculative");
    const divergenceBaseline = getLoggerCountsBreakdown()["storage.v2"]?.[
      "execution-overlay-divergence"
    ]?.debug ?? 0;
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "committed",
            acceptedCommitSeq: 7 as AcceptedCommitSeq,
          },
        }],
      },
    }));
    assertEquals(visibleOutput(storage), "speculative");

    await factory.view.push(emptySync({
      toSeq: 7,
      upserts: [{
        branch: "",
        id: OUTPUT,
        seq: 7,
        doc: { value: "authoritative" },
      }],
    }));
    assertCondition(() => visibleOutput(storage) === "authoritative");
    assertEquals(
      getLoggerCountsBreakdown()["storage.v2"]?.[
        "execution-overlay-divergence"
      ]?.debug ?? 0,
      divergenceBaseline + 1,
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("a later live no-op retains an earlier committed data barrier", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const query = {
    space: SPACE,
    branch: "",
    pieceId: claim.pieceId,
    actionId: claim.actionId,
  };
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "speculative");
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "committed",
            acceptedCommitSeq: 7 as AcceptedCommitSeq,
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 2
    );
    assertEquals(visibleOutput(storage), "speculative");

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(1),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 3
    );

    assertEquals(visibleOutput(storage), "speculative");
    const held = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(held.actions[0]?.pendingOverlayCount, 1);
    assertEquals(held.actions[0]?.pendingSettlementCount, 1);

    await factory.view.push(emptySync({
      toSeq: 7,
      upserts: [{
        branch: "",
        id: OUTPUT,
        seq: 7,
        doc: { value: "authoritative" },
      }],
    }));
    assertCondition(() => visibleOutput(storage) === "authoritative");
    const settled = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(settled.actions[0]?.pendingOverlayCount, 0);
    assertEquals(settled.actions[0]?.pendingSettlementCount, 0);
    assertEquals(settled.actions[0]?.basisCoveredOverlayDrops, 1);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("old claim generation settlement cannot clear a replacement overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const replacement = { ...claim, claimGeneration: claim.claimGeneration + 1 };
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "old-overlay");
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.claim.set",
          claim: replacement,
        }],
      },
    }));
    assertCondition(() => visibleOutput(storage) === undefined);
    await writeClaimedOutput(storage, "replacement-overlay");

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertEquals(visibleOutput(storage), "replacement-overlay");
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("two rapid source bases require settlement through the later basis", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await factory.view.push(emptySync({
      toSeq: 5,
      upserts: [{
        branch: "",
        id: INPUT,
        seq: 5,
        doc: { value: "source-five" },
      }],
    }));
    assertCondition(() =>
      storage.open(SPACE).replica.get({
        id: INPUT,
        type: "application/json",
      }) !== undefined
    );
    await writeClaimedOutput(storage, "overlay-five", true);
    await factory.view.push(emptySync({
      fromSeq: 5,
      toSeq: 6,
      upserts: [{
        branch: "",
        id: INPUT,
        seq: 6,
        doc: { value: "source-six" },
      }],
    }));
    assertCondition(() => {
      const value = storage.open(SPACE).replica.get({
        id: INPUT,
        type: "application/json",
      })?.is as { value?: unknown } | undefined;
      return value?.value === "source-six";
    });
    await writeClaimedOutput(storage, "overlay-six", true);

    await factory.view.push(emptySync({
      fromSeq: 6,
      toSeq: 6,
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(5),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertEquals(visibleOutput(storage), "overlay-six");

    await factory.view.push(emptySync({
      fromSeq: 6,
      toSeq: 6,
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(6),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() => visibleOutput(storage) === undefined);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("resolved replace overlays compact physical pending versions without losing basis accounting", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const compactedBaseline = getLoggerCountsBreakdown()["storage.v2"]?.[
    "execution-overlay-pending-versions-compacted"
  ]?.debug ?? 0;
  const query = {
    space: SPACE,
    branch: "",
    pieceId: claim.pieceId,
    actionId: claim.actionId,
  };
  try {
    await storage.open(SPACE).sync(INPUT);
    await factory.view.push(emptySync({
      toSeq: 5,
      upserts: [{
        branch: "",
        id: INPUT,
        seq: 5,
        doc: { value: "resolved-source" },
      }],
    }));
    assertCondition(() => visibleValue(storage, INPUT) === "resolved-source");

    const overlayCount = 100;
    for (let index = 1; index <= overlayCount; index++) {
      await writeClaimedOutput(storage, `overlay-${index}`, true);
    }
    assertEquals(visibleOutput(storage), `overlay-${overlayCount}`);
    assertEquals(factory.commits, []);
    const routed = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(routed.actions[0]?.claimedOverlayRoutes, overlayCount);
    assertEquals(routed.actions[0]?.pendingOverlayCount, overlayCount);
    assertEquals(
      getLoggerCountsBreakdown()["storage.v2"]?.[
        "execution-overlay-pending-versions-compacted"
      ]?.debug ?? 0,
      compactedBaseline + overlayCount - 2,
    );

    await factory.view.push(emptySync({
      fromSeq: 5,
      toSeq: 5,
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(4),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 2
    );
    assertEquals(visibleOutput(storage), `overlay-${overlayCount}`);
    assertEquals(
      storage.getExecutionRoutingDiagnostics(query).actions[0]
        ?.pendingOverlayCount,
      overlayCount,
    );

    await factory.view.push(emptySync({
      fromSeq: 5,
      toSeq: 5,
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(5),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() => visibleOutput(storage) === undefined);
    const settled = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(settled.actions[0]?.pendingOverlayCount, 0);
    assertEquals(settled.actions[0]?.basisCoveredOverlayDrops, overlayCount);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("chained claimed overlays expose the accepted non-transitive basis window and converge", async () => {
  setServerPrimaryExecutionConfig(true);
  const intermediateClaim: ExecutionClaim = {
    ...claim,
    pieceId: "space:of:client-overlay-chain-piece",
    actionId: "action:client-overlay-chain-intermediate",
    implementationFingerprint: "impl:client-overlay-chain-intermediate",
  };
  const downstreamClaim: ExecutionClaim = {
    ...claim,
    pieceId: "space:of:client-overlay-chain-piece",
    actionId: "action:client-overlay-chain-downstream",
    implementationFingerprint: "impl:client-overlay-chain-downstream",
  };
  const intermediateAction = {};
  const downstreamAction = {};
  const factory = new OverlaySessionFactory();
  factory.claims = [intermediateClaim, downstreamClaim];
  const sourceApplied = Promise.withResolvers<AppliedCommit>();
  factory.onTransact = () => sourceApplied.promise;
  const storage = OverlayStorageManager.connect(factory);
  const counts = getLoggerCountsBreakdown()["storage.v2"] ?? {};
  const createdBaseline = counts["execution-overlay-created"]?.debug ?? 0;
  const divergenceBaseline = counts["execution-overlay-divergence"]?.debug ??
    0;
  try {
    await storage.open(SPACE).sync(CHAIN_SOURCE);
    const sourceStarted = factory.waitForCommitCount(1);
    const sourceCommit = beginSourceInputWrite(
      storage,
      "source-new",
      CHAIN_SOURCE,
    );
    await sourceStarted;
    await factory.view.push(emptySync({
      toSeq: 12,
      upserts: [{
        branch: "",
        id: CHAIN_UNRELATED,
        seq: 12,
        doc: Object.freeze({ value: "unrelated-new" }),
      }, {
        branch: "",
        id: CHAIN_INTERMEDIATE,
        seq: 7,
        doc: Object.freeze({ value: "intermediate-stale" }),
      }, {
        branch: "",
        id: CHAIN_DOWNSTREAM,
        seq: 8,
        doc: Object.freeze({ value: "downstream-stale" }),
      }],
    }));
    assertCondition(() =>
      visibleValue(storage, CHAIN_UNRELATED) === "unrelated-new"
    );
    assertEquals(
      visibleValue(storage, CHAIN_INTERMEDIATE),
      "intermediate-stale",
    );
    assertEquals(
      visibleValue(storage, CHAIN_DOWNSTREAM),
      "downstream-stale",
    );
    await writeClaimedChainValue(
      storage,
      intermediateAction,
      intermediateClaim,
      [CHAIN_SOURCE],
      CHAIN_INTERMEDIATE,
      "intermediate-fresh",
    );
    await writeClaimedChainValue(
      storage,
      downstreamAction,
      downstreamClaim,
      [CHAIN_INTERMEDIATE, CHAIN_UNRELATED],
      CHAIN_DOWNSTREAM,
      "downstream-fresh",
    );
    sourceApplied.resolve({ seq: 11, branch: "", revisions: [] });
    await sourceCommit;
    assertEquals(
      visibleValue(storage, CHAIN_DOWNSTREAM),
      "downstream-fresh",
    );
    assertEquals(factory.commits.length, 1);
    assertEquals(
      getLoggerCountsBreakdown()["storage.v2"]?.[
        "execution-overlay-created"
      ]?.debug ?? 0,
      createdBaseline + 2,
    );

    // The direct source commit receives S(L)=11. The downstream overlay read
    // the speculative intermediate plus an unrelated confirmed input at 12.
    // Its direct scalar basis is therefore 12, not the intermediate overlay's
    // transitive dependency on S(L).
    // The server can settle the downstream run at basis 12 after reading the
    // stale confirmed intermediate. Dropping the overlay intentionally exposes
    // that stale result for the accepted v1 non-transitive window.
    await factory.view.push(emptySync({
      fromSeq: 12,
      toSeq: 13,
      upserts: [{
        branch: "",
        id: CHAIN_DOWNSTREAM,
        seq: 13,
        doc: { value: "downstream-from-stale-intermediate" },
      }],
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim: downstreamClaim,
            inputBasisSeq: toInputBasisSeq(12),
            outcome: "committed",
            acceptedCommitSeq: 13 as AcceptedCommitSeq,
          },
        }],
      },
    }));
    assertCondition(() =>
      visibleValue(storage, CHAIN_DOWNSTREAM) ===
        "downstream-from-stale-intermediate"
    );
    assertEquals(
      getLoggerCountsBreakdown()["storage.v2"]?.[
        "execution-overlay-divergence"
      ]?.debug ?? 0,
      divergenceBaseline + 1,
    );

    // The intermediate then settles from the direct source basis. Once the
    // downstream reruns against it, its next committed settlement converges the
    // visible state deterministically without another client overlay.
    await factory.view.push(emptySync({
      fromSeq: 13,
      toSeq: 14,
      upserts: [{
        branch: "",
        id: CHAIN_INTERMEDIATE,
        seq: 14,
        doc: { value: "intermediate-fresh" },
      }],
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim: intermediateClaim,
            inputBasisSeq: toInputBasisSeq(11),
            outcome: "committed",
            acceptedCommitSeq: 14 as AcceptedCommitSeq,
          },
        }],
      },
    }));
    assertCondition(() =>
      visibleValue(storage, CHAIN_INTERMEDIATE) === "intermediate-fresh"
    );
    assertEquals(
      visibleValue(storage, CHAIN_DOWNSTREAM),
      "downstream-from-stale-intermediate",
    );

    await factory.view.push(emptySync({
      fromSeq: 14,
      toSeq: 15,
      upserts: [{
        branch: "",
        id: CHAIN_DOWNSTREAM,
        seq: 15,
        doc: { value: "downstream-fresh" },
      }],
      execution: {
        fromFeedSeq: 3,
        toFeedSeq: 4,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim: downstreamClaim,
            inputBasisSeq: toInputBasisSeq(14),
            outcome: "committed",
            acceptedCommitSeq: 15 as AcceptedCommitSeq,
          },
        }],
      },
    }));
    assertCondition(() =>
      visibleValue(storage, CHAIN_DOWNSTREAM) === "downstream-fresh"
    );
    assertEquals(
      getLoggerCountsBreakdown()["storage.v2"]?.[
        "execution-overlay-divergence"
      ]?.debug ?? 0,
      divergenceBaseline + 1,
    );
  } finally {
    sourceApplied.resolve({ seq: 11, branch: "", revisions: [] });
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("execution feed gap freezes known authority until an authoritative snapshot", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "held-through-gap");
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 99,
        toFeedSeq: 100,
        events: [{
          type: "session.execution.claim.revoke",
          branch: "",
          claim,
          leaseGeneration: claim.leaseGeneration,
          claimGeneration: claim.claimGeneration,
        }],
      },
    }));
    assertEquals(visibleOutput(storage), "held-through-gap");
    await writeClaimedOutput(storage, "still-local-through-gap");
    assertEquals(factory.commits, []);

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 0,
        toFeedSeq: 1,
        snapshot: { claims: [] },
        events: [],
      },
    }));
    assertCondition(() => visibleOutput(storage) === undefined);
    await writeClaimedOutput(storage, "resumed-upstream");
    assertEquals(factory.commits.length, 1);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("reconnect snapshot applies an evicted successful settlement to a live overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "settled-while-disconnected");
    assertEquals(visibleOutput(storage), "settled-while-disconnected");

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 6,
        snapshot: {
          claims: [claim],
          settlementFrontiers: [{
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            throughFeedSeq: 5,
          }],
        },
        events: [],
      },
    }));

    assertCondition(() => visibleOutput(storage) === undefined);
    assertEquals(factory.commits, []);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("reconnect installs a claim before its retained settlement exactly once", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  factory.claims = [];
  const storage = OverlayStorageManager.connect(factory);
  const query = {
    space: SPACE,
    branch: "",
    pieceId: claim.pieceId,
    actionId: claim.actionId,
  };
  try {
    await storage.open(SPACE).sync(INPUT);
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 3,
        snapshot: { claims: [claim] },
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 3
    );
    assertEquals(
      storage.getExecutionRoutingDiagnostics(query).actions[0]?.settlements
        .noOp,
      1,
    );

    await writeClaimedOutput(storage, "late-after-retained-settlement");
    assertCondition(() => visibleOutput(storage) === undefined);
    const diagnostics = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(diagnostics.actions[0]?.settlements.noOp, 1);
    assertEquals(diagnostics.actions[0]?.pendingOverlayCount, 0);
    assertEquals(factory.commits, []);
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("committed reconnect frontier preserves its accepted data barrier", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "held-for-frontier-data");
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 4,
        snapshot: {
          claims: [claim],
          settlementFrontiers: [{
            branch: "",
            claim,
            inputBasisSeq: toInputBasisSeq(0),
            throughFeedSeq: 3,
            requiredAcceptedCommitSeq: 5 as AcceptedCommitSeq,
          }],
        },
        events: [],
      },
    }));
    assertEquals(visibleOutput(storage), "held-for-frontier-data");

    await factory.view.push(emptySync({
      toSeq: 5,
      upserts: [{
        branch: "",
        id: OUTPUT,
        seq: 5,
        doc: { value: "frontier-server-output" },
      }],
    }));
    assertCondition(() => visibleOutput(storage) === "frontier-server-output");
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("execution feed gap keeps an exact claimed builtin passive", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory(true);
  const effectClaim = { ...claim, actionKind: "effect" as const };
  factory.claims = [effectClaim];
  const storage = OverlayStorageManager.connect(factory);
  const effectAction = {};
  storage.registerExecutionAction(effectAction, {
    branch: effectClaim.branch,
    space: effectClaim.space,
    contextKey: effectClaim.contextKey,
    pieceId: effectClaim.pieceId,
    actionId: effectClaim.actionId,
    actionKind: effectClaim.actionKind,
    implementationFingerprint: effectClaim.implementationFingerprint,
    runtimeFingerprint: effectClaim.runtimeFingerprint,
  });
  try {
    await storage.open(SPACE).sync(INPUT);
    assertEquals(storage.captureExecutionClaim(effectAction), effectClaim);
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 99,
        toFeedSeq: 100,
        events: [{
          type: "session.execution.claim.revoke",
          branch: "",
          claim: effectClaim,
          leaseGeneration: effectClaim.leaseGeneration,
          claimGeneration: effectClaim.claimGeneration,
        }],
      },
    }));
    assertEquals(storage.captureExecutionClaim(effectAction), effectClaim);

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 0,
        toFeedSeq: 1,
        snapshot: { claims: [] },
        events: [],
      },
    }));
    assertCondition(() =>
      storage.captureExecutionClaim(effectAction) === undefined
    );
  } finally {
    storage.unregisterExecutionAction(effectAction);
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("a pre-claim client builtin attempt keeps all continuations upstream", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    storage.beginClientExecutionEffect(sourceAction);
    await writeClaimedOutput(storage, "client-in-flight");
    assertEquals(factory.commits.length, 1);
    storage.endClientExecutionEffect(sourceAction);

    await writeClaimedOutput(storage, "passive-after-handoff");
    assertEquals(factory.commits.length, 1);
    assertEquals(visibleOutput(storage), "passive-after-handoff");
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("execution routing diagnostics expose exact settlement barriers and reset only history", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const sourceApplied = Promise.withResolvers<AppliedCommit>();
  factory.onTransact = () => sourceApplied.promise;
  const storage = OverlayStorageManager.connect(factory);
  const query = {
    space: SPACE,
    branch: "",
    pieceId: claim.pieceId,
    actionId: claim.actionId,
  };
  try {
    await storage.open(SPACE).sync(INPUT);
    const sourceStarted = factory.waitForCommitCount(1);
    const sourceCommit = beginSourceInputWrite(storage, "pending-diagnostic");
    await sourceStarted;
    await writeClaimedOutput(storage, "speculative-diagnostic", true);

    const routed = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(routed.space, SPACE);
    assertEquals(routed.branch, "");
    assertEquals(routed.executionFeedSeq, 1);
    assertEquals(routed.executionAppliedSeq, 0);
    assertEquals(routed.snapshotRequired, false);
    assertEquals(routed.claims, [claim]);
    assertEquals(routed.truncatedActionRecords, 0);
    assertEquals(routed.actions.length, 1);
    assertEquals(routed.actions[0]?.key, canonicalActionClaimKey(claim));
    assertEquals(routed.actions[0]?.liveClaim, claim);
    assertEquals(routed.actions[0]?.upstreamRoutes, 0);
    assertEquals(routed.actions[0]?.claimedOverlayRoutes, 1);
    assertEquals(routed.actions[0]?.pendingOverlayCount, 1);
    assertEquals(routed.actions[0]?.unresolvedBasisOverlayCount, 1);
    assertEquals(routed.actions[0]?.pendingSettlementCount, 0);

    const settlement: ActionSettlement = {
      branch: "",
      claim,
      inputBasisSeq: toInputBasisSeq(6),
      outcome: "committed",
      acceptedCommitSeq: 7 as AcceptedCommitSeq,
    };
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement,
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 2
    );

    const awaitingData = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(awaitingData.actions[0]?.settlements, {
      committed: 1,
      noOp: 0,
      failed: 0,
      unserved: 0,
    });
    assertEquals(awaitingData.actions[0]?.lastSettlement, settlement);
    assertEquals(awaitingData.actions[0]?.pendingOverlayCount, 1);
    assertEquals(awaitingData.actions[0]?.pendingSettlementCount, 1);
    assertEquals(awaitingData.actions[0]?.basisCoveredOverlayDrops, 0);

    const reset = storage.getExecutionRoutingDiagnostics({
      ...query,
      resetCounters: true,
    });
    assertEquals(reset.claims, [claim]);
    assertEquals(reset.actions[0]?.claimedOverlayRoutes, 0);
    assertEquals(reset.actions[0]?.settlements, {
      committed: 0,
      noOp: 0,
      failed: 0,
      unserved: 0,
    });
    assertEquals(reset.actions[0]?.pendingOverlayCount, 1);
    assertEquals(reset.actions[0]?.unresolvedBasisOverlayCount, 1);
    assertEquals(reset.actions[0]?.pendingSettlementCount, 1);
    assertEquals(reset.actions[0]?.lastSettlement, settlement);

    sourceApplied.resolve({ seq: 6, branch: "", revisions: [] });
    await sourceCommit;
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).actions[0]
        ?.unresolvedBasisOverlayCount === 0
    );
    assertEquals(
      storage.getExecutionRoutingDiagnostics(query).actions[0]
        ?.pendingSettlementCount,
      1,
    );

    await factory.view.push(emptySync({
      toSeq: 7,
      upserts: [{
        branch: "",
        id: OUTPUT,
        seq: 7,
        doc: { value: "authoritative-diagnostic" },
      }],
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionAppliedSeq === 7
    );
    const applied = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(applied.actions[0]?.basisCoveredOverlayDrops, 1);
    assertEquals(applied.actions[0]?.pendingOverlayCount, 0);
    assertEquals(applied.actions[0]?.pendingSettlementCount, 0);

    await factory.view.push(emptySync({
      fromSeq: 7,
      toSeq: 7,
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 5,
        events: ["no-op", "failed", "unserved"].map((outcome) => ({
          type: "session.execution.settlement" as const,
          settlement: {
            branch: "" as const,
            claim,
            inputBasisSeq: toInputBasisSeq(7),
            outcome,
            ...(outcome === "unserved"
              ? { diagnosticCode: "dynamic-read-outside-static-surface" }
              : {}),
          } as ActionSettlement,
        })),
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 5
    );
    const outcomes = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(outcomes.actions[0]?.settlements, {
      committed: 0,
      noOp: 1,
      failed: 1,
      unserved: 1,
    });
    assertEquals(outcomes.actions[0]?.lastSettlement?.outcome, "unserved");
    assertEquals(outcomes.branchTotals, {
      upstreamRoutes: 0,
      claimedOverlayRoutes: 0,
      settlements: { committed: 0, noOp: 1, failed: 1, unserved: 1 },
      basisCoveredOverlayDrops: 1,
      nonAuthoritativeOverlayDrops: 0,
      settlementDiagnostics: {
        "dynamic-read-outside-static-surface": 1,
      },
      routeDiagnostics: {},
    });
  } finally {
    sourceApplied.resolve({ seq: 6, branch: "", revisions: [] });
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("execution diagnostics clone fabric claim values canonically", async () => {
  setServerPrimaryExecutionConfig(true);
  const metadata = FabricHash.fromString("sha256:abcd");
  const claimWithMetadata = { ...claim, metadata };
  const factory = new OverlaySessionFactory();
  factory.claims = [claimWithMetadata];
  const storage = OverlayStorageManager.connect(factory);
  const query = {
    space: SPACE,
    branch: "",
    pieceId: claim.pieceId,
    actionId: claim.actionId,
  };
  try {
    await storage.open(SPACE).sync(INPUT);
    const routedClaim = storage.getExecutionRoutingDiagnostics(query)
      .claims[0] as ExecutionClaim & { metadata: FabricHash };
    assertInstanceOf(routedClaim.metadata, FabricHash);
    assertEquals(routedClaim.metadata.taggedHashString, "sha256:abcd");

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement: {
            branch: "",
            claim: claimWithMetadata,
            inputBasisSeq: toInputBasisSeq(0),
            outcome: "no-op",
          },
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 2
    );

    const routedSettlement = storage.getExecutionRoutingDiagnostics(query)
      .actions[0]?.lastSettlement as
        | (ActionSettlement & {
          claim: ExecutionClaim & { metadata: FabricHash };
        })
        | undefined;
    assertInstanceOf(routedSettlement?.claim.metadata, FabricHash);
    assertEquals(
      routedSettlement?.claim.metadata.taggedHashString,
      "sha256:abcd",
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("execution routing diagnostics scope authority and count non-authoritative drops", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const query = { space: SPACE, branch: "" };
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "revoked-diagnostic");
    factory.claims = [];
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.claim.revoke",
          branch: "",
          claim,
          leaseGeneration: claim.leaseGeneration,
          claimGeneration: claim.claimGeneration,
        }],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq === 2
    );
    await writeClaimedOutput(storage, "upstream-diagnostic");

    const diagnostics = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(diagnostics.claims, []);
    assertEquals(diagnostics.actions.length, 1);
    assertEquals(diagnostics.actions[0]?.claimedOverlayRoutes, 1);
    assertEquals(diagnostics.actions[0]?.upstreamRoutes, 1);
    assertEquals(diagnostics.actions[0]?.nonAuthoritativeOverlayDrops, 1);
    assertEquals(diagnostics.actions[0]?.pendingOverlayCount, 0);
    assertEquals(
      storage.getExecutionRoutingDiagnostics({
        ...query,
        branch: "other",
      }).actions,
      [],
    );
    assertEquals(
      storage.getExecutionRoutingDiagnostics({
        ...query,
        pieceId: "space:of:other-piece",
      }).actions,
      [],
    );
    assertEquals(
      storage.getExecutionRoutingDiagnostics({
        ...query,
        actionId: "action:other",
      }).actions,
      [],
    );

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 99,
        toFeedSeq: 100,
        events: [],
      },
    }));
    assertCondition(() =>
      storage.getExecutionRoutingDiagnostics(query).snapshotRequired
    );
    const gap = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(gap.executionFeedSeq, 2);
    assertEquals(gap.snapshotRequired, true);

    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 0,
        toFeedSeq: 1,
        snapshot: { claims: [] },
        events: [],
      },
    }));
    assertCondition(() =>
      !storage.getExecutionRoutingDiagnostics(query).snapshotRequired
    );
    assertEquals(
      storage.getExecutionRoutingDiagnostics(query).executionFeedSeq,
      1,
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("execution routing diagnostics bound historical action records", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  factory.claims = [];
  const storage = OverlayStorageManager.connect(factory);
  const query = { space: SPACE, branch: "", pieceId: claim.pieceId };
  try {
    await storage.open(SPACE).sync(INPUT);
    for (let index = 0; index < 129; index++) {
      await writeClaimedChainValue(
        storage,
        {},
        { ...claim, actionId: `action:diagnostic-${index}` },
        [],
        OUTPUT,
        index,
      );
    }

    const diagnostics = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(diagnostics.actions.length, 128);
    assertEquals(diagnostics.truncatedActionRecords, 1);
    assertEquals(diagnostics.branchTotals, {
      upstreamRoutes: 129,
      claimedOverlayRoutes: 0,
      settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
      basisCoveredOverlayDrops: 0,
      nonAuthoritativeOverlayDrops: 0,
      settlementDiagnostics: {},
      routeDiagnostics: {},
    });
    assertEquals(
      storage.getExecutionRoutingDiagnostics({
        ...query,
        actionId: "action:diagnostic-0",
      }).actions,
      [],
    );
    assertEquals(
      storage.getExecutionRoutingDiagnostics({
        ...query,
        actionId: "action:diagnostic-128",
      }).actions[0]?.upstreamRoutes,
      1,
    );

    const reset = storage.getExecutionRoutingDiagnostics({
      ...query,
      resetCounters: true,
    });
    assertEquals(reset.actions, []);
    assertEquals(reset.truncatedActionRecords, 0);
    assertEquals(reset.branchTotals, {
      upstreamRoutes: 0,
      claimedOverlayRoutes: 0,
      settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
      basisCoveredOverlayDrops: 0,
      nonAuthoritativeOverlayDrops: 0,
      settlementDiagnostics: {},
      routeDiagnostics: {},
    });
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("execution routing diagnostics reject an unopened space without mounting it", async () => {
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    assertThrows(
      () =>
        storage.getExecutionRoutingDiagnostics({
          space: SPACE,
          branch: "",
        }),
      Error,
      "has not been opened",
    );
    assertEquals(factory.commits, []);
  } finally {
    await storage.close();
  }
});

// --- C1.6: chain-scoped claim routing -------------------------------------
//
// The client's accept set is its FULL own lattice chain — {space,
// user:<myDid>, session:<myDid>:<mySessionId>} (context-lattice §2,
// amendment A10). The principal is the storage manager's signer (a real
// colon-bearing did:key — amendment A18), and every scoped context key below
// is built with the canonical helpers, never by string concatenation.

const ownUserContextKey = () => userExecutionContextKey(signer.did());
const ownSessionContextKey = () =>
  // OverlaySessionFactory mounts every session as "session:client-overlay";
  // the raw session id itself carries a colon, so canonical encoding is
  // load-bearing here too.
  sessionExecutionContextKey(signer.did(), "session:client-overlay");

Deno.test("own-chain user and session context claims suppress like a space claim", async () => {
  setServerPrimaryExecutionConfig(true);
  try {
    for (const contextKey of [ownUserContextKey(), ownSessionContextKey()]) {
      const factory = new OverlaySessionFactory();
      factory.claims = [{ ...claim, contextKey }];
      const storage = OverlayStorageManager.connect(factory);
      try {
        await storage.open(SPACE).sync(INPUT);
        await writeClaimedOutput(storage, "own-chain-overlay");
        assertEquals(visibleOutput(storage), "own-chain-overlay");
        assertEquals(factory.commits, []);
      } finally {
        await storage.close();
      }
    }
  } finally {
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("foreign-chain context claims never suppress the client", async () => {
  setServerPrimaryExecutionConfig(true);
  const otherPrincipal = "did:key:z6Mk-other-principal";
  try {
    for (
      const contextKey of [
        userExecutionContextKey(otherPrincipal),
        sessionExecutionContextKey(otherPrincipal, "session:client-overlay"),
        sessionExecutionContextKey(signer.did(), "session:someone-else"),
      ]
    ) {
      const factory = new OverlaySessionFactory();
      factory.claims = [{ ...claim, contextKey }];
      const storage = OverlayStorageManager.connect(factory);
      try {
        await storage.open(SPACE).sync(INPUT);
        await writeClaimedOutput(storage, "client-authoritative");
        assertEquals(factory.commits.length, 1);
      } finally {
        await storage.close();
      }
    }
  } finally {
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("a dormant action's user-context claim revoke fires exactly one invalidation wake", async () => {
  // Amendment A15 acceptance: the registered-action seams are keyed by the
  // chain key (ActionClaimKey minus contextKey), so an authority-loss wake
  // for a user-context claim reaches an action registered under the "space"
  // chain representative — exactly once — while the action is dormant (no
  // speculative overlay exists).
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  factory.claims = [];
  const storage = OverlayStorageManager.connect(factory);
  const computationAction = {};
  const notifications: StorageNotification[] = [];
  const userClaim: ExecutionClaim = {
    ...claim,
    contextKey: ownUserContextKey(),
  };
  storage.registerExecutionAction(
    computationAction,
    canonicalActionClaimKey(claim),
  );
  storage.subscribe({
    next(notification) {
      notifications.push(notification);
      return { done: false };
    },
  });
  try {
    await storage.open(SPACE).sync(INPUT);
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{ type: "session.execution.claim.set", claim: userClaim }],
      },
    }));
    assertCondition(() =>
      storage.hasLiveExecutionClaimForAction(computationAction) === true
    );
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 2,
        toFeedSeq: 3,
        events: [{
          type: "session.execution.claim.revoke",
          branch: "",
          claim: userClaim,
          leaseGeneration: userClaim.leaseGeneration,
          claimGeneration: userClaim.claimGeneration,
        }],
      },
    }));
    const wakes = notifications.filter((notification) =>
      notification.type === "execution-claim-invalidation" &&
      notification.sourceAction === computationAction
    );
    assertEquals(wakes.length, 1);
    assertEquals(
      wakes[0]?.type === "execution-claim-invalidation"
        ? wakes[0].diagnosticCode
        : undefined,
      "claim-revoked",
    );
    assertEquals(
      storage.hasLiveExecutionClaimForAction(computationAction),
      false,
    );
  } finally {
    storage.unregisterExecutionAction(computationAction);
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("dual live chain-matching claims route to neither and are counted", async () => {
  // Amendment A3: issuance-side routing disjointness should make this state
  // impossible; if the client ever observes two live claims on its own chain
  // for one action it must not pick one. It fails open (computes locally,
  // commits upstream) and the event is a named counter, not a silent branch.
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  factory.claims = [
    { ...claim },
    { ...claim, contextKey: ownUserContextKey() },
  ];
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "client-authoritative");
    assertEquals(factory.commits.length, 1);
    const diagnostics = storage.getExecutionRoutingDiagnostics({
      space: SPACE,
      branch: "",
    });
    assertEquals(
      diagnostics.branchTotals.routeDiagnostics["dual-chain-claim-match"],
      1,
    );
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});

Deno.test("dual live chain-matching claims disable the scheduling hint and builtin capture", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory(true);
  const effectClaim: ExecutionClaim = { ...claim, actionKind: "effect" };
  factory.claims = [
    { ...claim },
    { ...claim, contextKey: ownUserContextKey() },
    effectClaim,
    { ...effectClaim, contextKey: ownUserContextKey() },
  ];
  const storage = OverlayStorageManager.connect(factory);
  const computationAction = {};
  const effectAction = {};
  storage.registerExecutionAction(
    computationAction,
    canonicalActionClaimKey(claim),
  );
  storage.registerExecutionAction(effectAction, {
    ...canonicalActionClaimKey(claim),
    actionKind: "effect",
  });
  try {
    await storage.open(SPACE).sync(INPUT);
    // Two chain-matching live claims per action: neither the scheduling
    // hint nor builtin capture may pick one (amendment A3 fail-open).
    assertEquals(
      storage.hasLiveExecutionClaimForAction(computationAction),
      false,
    );
    assertEquals(storage.captureExecutionClaim(effectAction), undefined);

    // Narrowed to a single own-chain user claim, the hint returns.
    factory.claims = [{ ...claim, contextKey: ownUserContextKey() }];
    await factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        snapshot: { claims: [...factory.claims] },
        events: [],
      },
    }));
    assertCondition(() =>
      storage.hasLiveExecutionClaimForAction(computationAction) === true
    );
  } finally {
    storage.unregisterExecutionAction(computationAction);
    storage.unregisterExecutionAction(effectAction);
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});
