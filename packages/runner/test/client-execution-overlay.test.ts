import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import {
  type AcceptedCommitSeq,
  type ActionSettlement,
  canonicalActionClaimKey,
  type ClientCommit,
  type ExecutionClaim,
  resetServerPrimaryExecutionConfig,
  type SessionSync,
  setServerPrimaryExecutionConfig,
  toInputBasisSeq,
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
  #queued: SessionSync[] = [];
  #closed = false;

  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }

  push(sync: SessionSync): void {
    const pending = this.#pending.shift();
    if (pending) pending.resolve({ done: false, value: sync });
    else this.#queued.push(sync);
  }

  subscribeSync(): AsyncIterator<SessionSync> {
    return {
      next: () => {
        const queued = this.#queued.shift();
        if (queued) return Promise.resolve({ done: false, value: queued });
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
  onTransact?: (
    commit: ClientCommit,
    attempt: number,
  ) => Promise<AppliedCommit>;
  #seq = 0;

  constructor(private readonly builtinPassivity = false) {}

  create(
    _space: MemorySpace,
    _signer?: Signer,
  ): Promise<ReplicaSessionHandle> {
    const session = {
      sessionId: "session:client-overlay",
      sessionToken: undefined,
      serverSeq: 0,
      get executionClaims() {
        return [...thisFactory.claims];
      },
      transact: async (commit: ClientCommit): Promise<AppliedCommit> => {
        this.commits.push(structuredClone(commit));
        if (this.onTransact) {
          return await this.onTransact(commit, this.commits.length);
        }
        return {
          seq: ++this.#seq,
          branch: "",
          revisions: [],
        };
      },
      watchAddSync: async () => ({
        view: this.view,
        sync: emptySync({
          execution: {
            fromFeedSeq: 0,
            toFeedSeq: 1,
            snapshot: { claims: [...this.claims] },
            events: [],
          },
        }),
      }),
    } as unknown as ReplicaSession;
    const thisFactory = this;
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

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}

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
    factory.view.push(emptySync({
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
    await waitFor(() => visibleOutput(storage) === undefined);
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
    factory.view.push(emptySync({
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

    await waitFor(() => visibleOutput(storage) === undefined);
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
    factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement,
        }],
      },
    }));
    await waitFor(() => visibleOutput(storage) === undefined);
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

Deno.test("settlement basis older than a direct confirmed read retains the overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const retainedBaseline = getLoggerCountsBreakdown()["storage.v2"]?.[
    "execution-overlay-retained"
  ]?.debug ?? 0;
  try {
    await storage.open(SPACE).sync(INPUT);
    factory.view.push(emptySync({
      toSeq: 5,
      upserts: [{
        branch: "",
        id: INPUT,
        seq: 5,
        doc: { value: "confirmed-input" },
      }],
    }));
    await waitFor(() =>
      storage.open(SPACE).replica.get({
        id: INPUT,
        type: "application/json",
      }) !== undefined
    );
    await writeClaimedOutput(storage, "basis-five", true);

    factory.view.push(emptySync({
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(visibleOutput(storage), "basis-five");
    assertEquals(
      getLoggerCountsBreakdown()["storage.v2"]?.[
        "execution-overlay-retained"
      ]?.debug ?? 0,
      retainedBaseline + 1,
    );

    factory.view.push(emptySync({
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
    await waitFor(() => visibleOutput(storage) === undefined);
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
  try {
    await storage.open(SPACE).sync(INPUT);
    const sourceCommit = beginSourceInputWrite(storage, "pending-source");
    await waitFor(() => factory.commits.length === 1);
    await writeClaimedOutput(storage, "pending-basis-overlay", true);

    factory.view.push(emptySync({
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(visibleOutput(storage), "pending-basis-overlay");

    sourceApplied.resolve({ seq: 6, branch: "", revisions: [] });
    await sourceCommit;
    await waitFor(() => visibleOutput(storage) === undefined);
  } finally {
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
    const sourceCommit = beginSourceInputWrite(storage, "doomed-source");
    await waitFor(() => factory.commits.length === 1);
    await writeClaimedOutput(storage, "doomed-overlay", true);
    sourceApplied.reject(Object.assign(new Error("source rejected"), {
      name: "TransactionError",
    }));
    await sourceCommit;
    await waitFor(() => visibleOutput(storage) === undefined);
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
    factory.view.push(emptySync({
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(visibleOutput(storage), "speculative");

    factory.view.push(emptySync({
      toSeq: 7,
      upserts: [{
        branch: "",
        id: OUTPUT,
        seq: 7,
        doc: { value: "authoritative" },
      }],
    }));
    await waitFor(() => visibleOutput(storage) === "authoritative");
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

Deno.test("old claim generation settlement cannot clear a replacement overlay", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  const replacement = { ...claim, claimGeneration: claim.claimGeneration + 1 };
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "old-overlay");
    factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.claim.set",
          claim: replacement,
        }],
      },
    }));
    await waitFor(() => visibleOutput(storage) === undefined);
    await writeClaimedOutput(storage, "replacement-overlay");

    factory.view.push(emptySync({
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    factory.view.push(emptySync({
      toSeq: 5,
      upserts: [{
        branch: "",
        id: INPUT,
        seq: 5,
        doc: { value: "source-five" },
      }],
    }));
    await waitFor(() =>
      storage.open(SPACE).replica.get({
        id: INPUT,
        type: "application/json",
      }) !== undefined
    );
    await writeClaimedOutput(storage, "overlay-five", true);
    factory.view.push(emptySync({
      fromSeq: 5,
      toSeq: 6,
      upserts: [{
        branch: "",
        id: INPUT,
        seq: 6,
        doc: { value: "source-six" },
      }],
    }));
    await waitFor(() => {
      const value = storage.open(SPACE).replica.get({
        id: INPUT,
        type: "application/json",
      })?.is as { value?: unknown } | undefined;
      return value?.value === "source-six";
    });
    await writeClaimedOutput(storage, "overlay-six", true);

    factory.view.push(emptySync({
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(visibleOutput(storage), "overlay-six");

    factory.view.push(emptySync({
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
    await waitFor(() => visibleOutput(storage) === undefined);
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
    const sourceCommit = beginSourceInputWrite(
      storage,
      "source-new",
      CHAIN_SOURCE,
    );
    await waitFor(() => factory.commits.length === 1);
    factory.view.push(emptySync({
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
    await waitFor(() =>
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
    factory.view.push(emptySync({
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
    await waitFor(() =>
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
    factory.view.push(emptySync({
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
    await waitFor(() =>
      visibleValue(storage, CHAIN_INTERMEDIATE) === "intermediate-fresh"
    );
    assertEquals(
      visibleValue(storage, CHAIN_DOWNSTREAM),
      "downstream-from-stale-intermediate",
    );

    factory.view.push(emptySync({
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
    await waitFor(() =>
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
    factory.view.push(emptySync({
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(visibleOutput(storage), "held-through-gap");
    await writeClaimedOutput(storage, "still-local-through-gap");
    assertEquals(factory.commits, []);

    factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 0,
        toFeedSeq: 1,
        snapshot: { claims: [] },
        events: [],
      },
    }));
    await waitFor(() => visibleOutput(storage) === undefined);
    await writeClaimedOutput(storage, "resumed-upstream");
    assertEquals(factory.commits.length, 1);
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
    factory.view.push(emptySync({
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(storage.captureExecutionClaim(effectAction), effectClaim);

    factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 0,
        toFeedSeq: 1,
        snapshot: { claims: [] },
        events: [],
      },
    }));
    await waitFor(() =>
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
  const storage = OverlayStorageManager.connect(factory);
  const query = {
    space: SPACE,
    branch: "",
    pieceId: claim.pieceId,
    actionId: claim.actionId,
  };
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "speculative-diagnostic");

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
    assertEquals(routed.actions[0]?.unresolvedBasisOverlayCount, 0);
    assertEquals(routed.actions[0]?.pendingSettlementCount, 0);

    const settlement: ActionSettlement = {
      branch: "",
      claim,
      inputBasisSeq: toInputBasisSeq(0),
      outcome: "committed",
      acceptedCommitSeq: 7 as AcceptedCommitSeq,
    };
    factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 1,
        toFeedSeq: 2,
        events: [{
          type: "session.execution.settlement",
          settlement,
        }],
      },
    }));
    await waitFor(() =>
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
    assertEquals(reset.actions[0]?.pendingSettlementCount, 1);

    factory.view.push(emptySync({
      toSeq: 7,
      upserts: [{
        branch: "",
        id: OUTPUT,
        seq: 7,
        doc: { value: "authoritative-diagnostic" },
      }],
    }));
    await waitFor(() =>
      storage.getExecutionRoutingDiagnostics(query).executionAppliedSeq === 7
    );
    const applied = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(applied.actions[0]?.basisCoveredOverlayDrops, 1);
    assertEquals(applied.actions[0]?.pendingOverlayCount, 0);
    assertEquals(applied.actions[0]?.pendingSettlementCount, 0);

    factory.view.push(emptySync({
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
          } as ActionSettlement,
        })),
      },
    }));
    await waitFor(() =>
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
    factory.view.push(emptySync({
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
    await waitFor(() =>
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

    factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 99,
        toFeedSeq: 100,
        events: [],
      },
    }));
    await waitFor(() =>
      storage.getExecutionRoutingDiagnostics(query).snapshotRequired
    );
    const gap = storage.getExecutionRoutingDiagnostics(query);
    assertEquals(gap.executionFeedSeq, 2);
    assertEquals(gap.snapshotRequired, true);

    factory.view.push(emptySync({
      execution: {
        fromFeedSeq: 0,
        toFeedSeq: 1,
        snapshot: { claims: [] },
        events: [],
      },
    }));
    await waitFor(() =>
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
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});
