import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import {
  type ActionSettlement,
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

const signer = await Identity.fromPassphrase(
  "client execution overlay test principal",
);
const SPACE = signer.did() as MemorySpace;
const INPUT = "of:client-overlay-input" as URI;
const OUTPUT = "of:client-overlay-output" as URI;
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
  reads: [],
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
    reads: [],
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
  #seq = 0;

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
          serverPrimaryExecutionBuiltinPassivityV1: false,
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
): Promise<void> {
  const tx = storage.edit();
  tx.sourceAction = sourceAction;
  tx.setSchedulerObservation?.(observation());
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

function visibleOutput(storage: StorageManager): unknown {
  const document = storage.open(SPACE).replica.get({
    id: OUTPUT,
    type: "application/json",
  })?.is as { value?: unknown } | undefined;
  return document?.value;
}

Deno.test("claimed client computation stays visible locally with zero wire commit", async () => {
  setServerPrimaryExecutionConfig(true);
  const factory = new OverlaySessionFactory();
  const storage = OverlayStorageManager.connect(factory);
  try {
    await storage.open(SPACE).sync(INPUT);
    await writeClaimedOutput(storage, "local-overlay");
    assertEquals(visibleOutput(storage), "local-overlay");
    assertEquals(factory.commits, []);
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
  } finally {
    await storage.close();
    resetServerPrimaryExecutionConfig();
  }
});
