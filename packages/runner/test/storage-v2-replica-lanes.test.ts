/**
 * C1.5b — per-lane acting context; shared replica re-keyed by effective
 * scope key (context-lattice §2/§7 intra-Worker confidentiality boundary).
 *
 * Amendment A16 (binding): a lane's reads materialize confirmed state plus
 * ONLY its own lane's pending versions; other lanes' localSeqs are
 * unresolvable for it. Amendment FA6 (Worker half): accepted-commit
 * revision→instance matching compares resolved scopeKeys, with
 * declared-scope fallback only when a scopeKey is absent.
 *
 * Inertness: with no lane ever engaged (the flag-off world), every key
 * reduces byte-identically to the pre-lane keys — pinned below.
 */

import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import {
  type ClientCommit,
  type GraphQuery,
  resetPersistentSchedulerStateConfig,
  type SchedulerExecutionContextKey,
  type SessionSync,
  setPersistentSchedulerStateConfig,
  userExecutionContextKey,
  type WatchSpec,
} from "@commonfabric/memory/v2";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import type {
  ReplicaReadOptions,
  ReplicaSession,
  ReplicaSessionHandle,
  ReplicaWatchView,
} from "../src/storage/v2-replica-session.ts";
import {
  type ActionTransactionRouter,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { acceptedRevisionMatchesSnapshot } from "../src/storage/v2-host-provider.ts";

const signer = await Identity.fromPassphrase("replica lane test principal");
const SPACE = signer.did() as MemorySpace;
const SHARED = "of:lane-shared-doc" as URI;
const SCOPED = "of:lane-scoped-doc" as URI;
const OUT = "of:lane-out-doc" as URI;

const LANE_A = userExecutionContextKey("did:key:lane-a");
const LANE_B = userExecutionContextKey("did:key:lane-b");

const emptySync = (overrides: Partial<SessionSync> = {}): SessionSync => ({
  type: "sync",
  fromSeq: 0,
  toSeq: 0,
  upserts: [],
  removes: [],
  ...overrides,
});

class LaneView implements ReplicaWatchView {
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
    if (pending) {
      pending.resolve({ done: false, value: sync });
    } else {
      this.#queued.push(sync);
    }
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

/** Session factory capturing commits and per-request read options so lane
 * threading through the C1.4b read seam is observable. */
class LaneSessionFactory implements SessionFactory {
  readonly commits: ClientCommit[] = [];
  readonly watchAddOptions: (ReplicaReadOptions | undefined)[] = [];
  readonly queryGraphOptions: (ReplicaReadOptions | undefined)[] = [];
  readonly view = new LaneView();
  onWatchAdd?: (watches: WatchSpec[]) => SessionSync;
  #seq = 0;

  create(
    _space: MemorySpace,
    _signer?: Signer,
  ): Promise<ReplicaSessionHandle> {
    const session = {
      sessionId: "session:lane-test",
      sessionToken: undefined,
      serverSeq: 0,
      transact: (commit: ClientCommit): Promise<AppliedCommit> => {
        this.commits.push(structuredClone(commit));
        return Promise.resolve({
          seq: ++this.#seq,
          branch: "",
          revisions: [],
        });
      },
      queryGraph: (_query: GraphQuery, options?: ReplicaReadOptions) => {
        this.queryGraphOptions.push(options);
        return Promise.resolve({ serverSeq: this.#seq, entities: [] });
      },
      watchAddSync: (
        watches: WatchSpec[],
        options?: ReplicaReadOptions,
      ) => {
        this.watchAddOptions.push(options);
        return Promise.resolve({
          view: this.view,
          sync: this.onWatchAdd?.(watches) ?? emptySync(),
        });
      },
    } as unknown as ReplicaSession;
    return Promise.resolve({
      client: {
        serverFlags: { persistentSchedulerState: true },
        close: () => Promise.resolve(),
      } as ReplicaSessionHandle["client"],
      session,
    });
  }
}

class LaneStorageManager extends StorageManager {
  static connect(
    factory: SessionFactory,
    options: {
      shadowWrites?: boolean;
      actionTransactionRouter?: ActionTransactionRouter;
      executionLaneForAction?: (
        action: object,
      ) => SchedulerExecutionContextKey | undefined;
    } = {},
  ): LaneStorageManager {
    return new LaneStorageManager({
      as: signer,
      memoryHost: new URL("memory://replica-lane-test"),
      ...options,
    }, factory);
  }
}

const docValue = (
  storage: StorageManager,
  id: URI,
  scope?: "space" | "user" | "session",
): unknown => {
  const document = storage.open(SPACE).replica.get({
    id,
    type: "application/json",
    scope,
  })?.is as { value?: unknown } | undefined;
  return document?.value;
};

async function writeDoc(
  storage: StorageManager,
  id: URI,
  value: unknown,
  options: {
    scope?: "space" | "user" | "session";
    sourceAction?: object;
    readIds?: readonly URI[];
  } = {},
): Promise<void> {
  const tx = storage.edit();
  if (options.sourceAction !== undefined) {
    tx.sourceAction = options.sourceAction;
  }
  for (const readId of options.readIds ?? []) {
    const read = tx.read({
      space: SPACE,
      id: readId,
      type: "application/json",
      path: ["value"],
    });
    if (read.error) throw read.error;
  }
  const writer = tx.writer(SPACE);
  if (writer.error) throw writer.error;
  const written = writer.ok.write({
    id,
    type: "application/json",
    path: ["value"],
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
  }, value as never);
  if (written.error) throw written.error;
  const result = await tx.commit();
  if (result.error) throw new Error(result.error.message);
}

const seedConfirmed = (
  factory: LaneSessionFactory,
  entries: {
    id: URI;
    scope?: "space" | "user" | "session";
    scopeKey?: string;
    value: unknown;
  }[],
  toSeq = 1,
): void => {
  factory.onWatchAdd = () =>
    emptySync({
      toSeq,
      upserts: entries.map((entry) => ({
        branch: "",
        id: entry.id,
        ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
        ...(entry.scopeKey !== undefined ? { scopeKey: entry.scopeKey } : {}),
        seq: toSeq,
        // Frozen like real wire documents: an unfrozen fixture doc would be
        // mutated in place by the transaction writer and hide the commit.
        doc: Object.freeze({ value: entry.value }) as never,
      })),
    });
};

Deno.test("A16: lane reads see confirmed state plus only their own lane's pending versions of a shared doc", async () => {
  const factory = new LaneSessionFactory();
  const storage = LaneStorageManager.connect(factory, { shadowWrites: true });
  try {
    seedConfirmed(factory, [{ id: SHARED, value: "base" }]);
    await storage.open(SPACE).sync(SHARED);
    assertEquals(docValue(storage, SHARED), "base");

    // Lane A's local (executor-shadow) pending write on the SHARED broad doc.
    await storage.runWithExecutionLane(
      SPACE,
      LANE_A,
      () => writeDoc(storage, SHARED, "a-pending"),
    );

    // Lane A sees its own pending version...
    storage.runWithExecutionLane(SPACE, LANE_A, () => {
      assertEquals(docValue(storage, SHARED), "a-pending");
    });
    // ...lane B and the space lane see confirmed state only (§7 boundary).
    storage.runWithExecutionLane(SPACE, LANE_B, () => {
      assertEquals(docValue(storage, SHARED), "base");
    });
    assertEquals(docValue(storage, SHARED), "base");
  } finally {
    await storage.close();
  }
});

Deno.test("A16: interleaved lanes materialize independent pending stacks over one shared record", async () => {
  const factory = new LaneSessionFactory();
  const storage = LaneStorageManager.connect(factory, { shadowWrites: true });
  try {
    seedConfirmed(factory, [{ id: SHARED, value: "base" }]);
    await storage.open(SPACE).sync(SHARED);

    await storage.runWithExecutionLane(
      SPACE,
      LANE_A,
      () => writeDoc(storage, SHARED, "a1"),
    );
    await storage.runWithExecutionLane(
      SPACE,
      LANE_B,
      () => writeDoc(storage, SHARED, "b1"),
    );
    await storage.runWithExecutionLane(
      SPACE,
      LANE_A,
      () => writeDoc(storage, SHARED, "a2"),
    );

    // Repeated reads exercise the lane-keyed materialization prefix cache.
    for (let i = 0; i < 2; i++) {
      storage.runWithExecutionLane(SPACE, LANE_A, () => {
        assertEquals(docValue(storage, SHARED), "a2");
      });
      storage.runWithExecutionLane(SPACE, LANE_B, () => {
        assertEquals(docValue(storage, SHARED), "b1");
      });
      assertEquals(docValue(storage, SHARED), "base");
    }
  } finally {
    await storage.close();
  }
});

Deno.test("scoped docs are distinct per-lane instances keyed by effective scope key", async () => {
  const factory = new LaneSessionFactory();
  const storage = LaneStorageManager.connect(factory, { shadowWrites: true });
  try {
    await storage.runWithExecutionLane(
      SPACE,
      LANE_A,
      () => writeDoc(storage, SCOPED, "alice", { scope: "user" }),
    );

    storage.runWithExecutionLane(SPACE, LANE_A, () => {
      assertEquals(docValue(storage, SCOPED, "user"), "alice");
    });
    // Lane B's user-scoped instance of the same id is a different document.
    storage.runWithExecutionLane(SPACE, LANE_B, () => {
      assertEquals(docValue(storage, SCOPED, "user"), undefined);
    });
    // The space lane's declared-key instance is untouched too.
    assertEquals(docValue(storage, SCOPED, "user"), undefined);
  } finally {
    await storage.close();
  }
});

Deno.test("sync upserts attribute to a lane instance only via a registered lane's resolved scopeKey", async () => {
  const factory = new LaneSessionFactory();
  const storage = LaneStorageManager.connect(factory, { shadowWrites: true });
  try {
    // Register lane A on this replica (C1.8 owns full lane lifecycle).
    storage.runWithExecutionLane(SPACE, LANE_A, () => {});
    seedConfirmed(factory, [
      { id: SCOPED, scope: "user", scopeKey: LANE_A, value: "alice-doc" },
    ]);
    await storage.open(SPACE).sync(SCOPED, undefined, "user");

    storage.runWithExecutionLane(SPACE, LANE_A, () => {
      assertEquals(docValue(storage, SCOPED, "user"), "alice-doc");
    });
    storage.runWithExecutionLane(SPACE, LANE_B, () => {
      assertEquals(docValue(storage, SCOPED, "user"), undefined);
    });
    assertEquals(docValue(storage, SCOPED, "user"), undefined);
  } finally {
    await storage.close();
  }
});

Deno.test("inertness: with no lane registered, scopeKey-bearing upserts land on today's declared keys", async () => {
  const factory = new LaneSessionFactory();
  const storage = LaneStorageManager.connect(factory);
  try {
    // C1.4b hosts already stamp resolved scope keys (e.g. the sponsor's own
    // user instance) on every upsert. Without lanes this must stay
    // byte-identical to the pre-lane world: the declared key is the key.
    seedConfirmed(factory, [
      {
        id: SCOPED,
        scope: "user",
        scopeKey: userExecutionContextKey("did:key:sponsor"),
        value: "sponsor-doc",
      },
    ]);
    await storage.open(SPACE).sync(SCOPED, undefined, "user");
    assertEquals(docValue(storage, SCOPED, "user"), "sponsor-doc");
  } finally {
    await storage.close();
  }
});

Deno.test("A16: an upstream commit baselines shared-doc reads against confirmed state, never a foreign lane's pending version", async () => {
  const factory = new LaneSessionFactory();
  const actionA = {};
  const actionB = {};
  // Route lane A's transactions into the local shadow overlay and lane B's
  // upstream, mirroring an unclaimed discovery run next to a claimed rerun.
  const router: ActionTransactionRouter = (input) =>
    input.sourceAction === actionA
      ? { disposition: "local", kind: "executor-shadow" }
      : { disposition: "upstream" };
  const storage = LaneStorageManager.connect(factory, {
    shadowWrites: true,
    actionTransactionRouter: router,
    executionLaneForAction: (action) =>
      action === actionA ? LANE_A : action === actionB ? LANE_B : undefined,
  });
  try {
    seedConfirmed(factory, [{ id: SHARED, value: "base" }]);
    await storage.open(SPACE).sync(SHARED);

    // Lane A parks an unconfirmed pending version on the shared doc.
    await writeDoc(storage, SHARED, "a-pending", { sourceAction: actionA });

    // Lane B reads the shared doc and writes its output upstream.
    await writeDoc(storage, OUT, "b-out", {
      sourceAction: actionB,
      readIds: [SHARED],
    });

    const upstream = factory.commits.find((commit) =>
      commit.operations.some((operation) =>
        operation.op !== "sqlite" && operation.id === OUT
      )
    );
    assert(upstream !== undefined, "lane B's commit reached the host");
    // Lane A's pending version is unresolvable for lane B: the shared-doc
    // read must be a confirmed read at the confirmed seq, and no pending
    // read may name lane A's localSeq.
    assertEquals(upstream.reads.pending, []);
    const sharedRead = upstream.reads.confirmed.find((read) =>
      read.id === SHARED
    );
    assert(sharedRead !== undefined, "lane B's commit read the shared doc");
    assertEquals(sharedRead.seq, 1);
  } finally {
    await storage.close();
  }
});

Deno.test("inertness: same-lane pending reads still name prior local versions (pre-lane behavior pinned)", async () => {
  const factory = new LaneSessionFactory();
  // No lanes anywhere: plain client manager, two sequential upstream writes.
  const storage = LaneStorageManager.connect(factory);
  try {
    seedConfirmed(factory, [{ id: SHARED, value: "base" }]);
    await storage.open(SPACE).sync(SHARED);

    // First write stays pending (unconfirmed) while the second is built:
    // block the factory's transact from confirming by delaying via a queued
    // microtask barrier — simplest deterministic shape: issue both writes in
    // the same turn.
    const first = writeDoc(storage, SHARED, "first");
    const second = writeDoc(storage, OUT, "out", { readIds: [SHARED] });
    await Promise.all([first, second]);

    const outCommit = factory.commits.find((commit) =>
      commit.operations.some((operation) =>
        operation.op !== "sqlite" && operation.id === OUT
      )
    );
    assert(outCommit !== undefined);
    // The same (space) lane still baselines against its own pending version.
    assertEquals(outCommit.reads.pending.length, 1);
    assertEquals(outCommit.reads.pending[0]!.id, SHARED);
  } finally {
    await storage.close();
  }
});

Deno.test("A6: the scheduler observation batch partitions into one commit per asserted lane", async () => {
  setPersistentSchedulerStateConfig(true);
  const factory = new LaneSessionFactory();
  const storage = LaneStorageManager.connect(factory);
  try {
    seedConfirmed(factory, [{ id: SHARED, value: "base" }]);
    await storage.open(SPACE).sync(SHARED);
    const observation = (marker: string) => ({
      version: 2,
      transactionKind: "observation" as const,
      marker,
    });

    const provider = storage.open(SPACE);
    const commitObservation = (marker: string) =>
      provider.replica.commitNative!({
        operations: [],
        preconditions: [],
        schedulerObservation: observation(marker),
      } as never);
    const commits = [
      commitObservation("space-1"),
      storage.runWithExecutionLane(
        SPACE,
        LANE_A,
        () => commitObservation("lane-a-1"),
      ),
      commitObservation("space-2"),
    ];
    await Promise.all(commits);
    await storage.open(SPACE).synced();

    const batches = factory.commits.filter((commit) =>
      commit.schedulerObservationBatch !== undefined
    );
    // One commit per lane (A6 one-commit-one-lane, Worker/client side):
    // the two space observations share a flush; lane A's flushes alone.
    assertEquals(batches.length, 2);
    const sizes = batches.map((batch) =>
      batch.schedulerObservationBatch!.length
    ).sort();
    assertEquals(sizes, [1, 2]);
  } finally {
    await storage.close();
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C1.4b read seam: pulls and scoped reads carry the acting lane as per-request acting context", async () => {
  const factory = new LaneSessionFactory();
  const storage = LaneStorageManager.connect(factory, { shadowWrites: true });
  try {
    await storage.open(SPACE).sync(SHARED);
    assertEquals(factory.watchAddOptions, [undefined]);

    await storage.runWithExecutionLane(
      SPACE,
      LANE_A,
      () => storage.open(SPACE).sync(SCOPED, undefined, "user"),
    );
    assertEquals(factory.watchAddOptions.length, 2);
    assertEquals(factory.watchAddOptions[1], { actingContext: LANE_A });
  } finally {
    await storage.close();
  }
});

Deno.test("FA6: revision→instance matching compares resolved scope keys with declared-scope fallback only when absent", () => {
  const snapshot = (scopeKey?: string) => ({
    branch: "",
    id: "of:doc",
    scope: "user" as const,
    ...(scopeKey !== undefined ? { scopeKey } : {}),
    seq: 3,
    document: null,
  });
  const revision = (scopeKey?: string) => ({
    branch: "",
    id: "of:doc",
    scope: "user",
    ...(scopeKey !== undefined ? { scopeKey } : {}),
    seq: 4,
  });

  // Exact instance match and mismatch when both sides carry the key.
  assertEquals(
    acceptedRevisionMatchesSnapshot(revision(LANE_A), snapshot(LANE_A)),
    true,
  );
  assertEquals(
    acceptedRevisionMatchesSnapshot(revision(LANE_A), snapshot(LANE_B)),
    false,
  );
  // Declared-scope fallback when either side lacks a resolved key
  // (older host or older snapshot).
  assertEquals(
    acceptedRevisionMatchesSnapshot(revision(undefined), snapshot(LANE_B)),
    true,
  );
  assertEquals(
    acceptedRevisionMatchesSnapshot(revision(LANE_A), snapshot(undefined)),
    true,
  );
  // Declared fallback still discriminates by declared scope + id.
  assertEquals(
    acceptedRevisionMatchesSnapshot(
      { id: "of:doc", scope: "space" },
      snapshot(undefined),
    ),
    false,
  );
});

Deno.test("C1.8: pruning a closed lane reverts scopeKey attribution to declared keys", async () => {
  const factory = new LaneSessionFactory();
  const storage = LaneStorageManager.connect(factory, { shadowWrites: true });
  try {
    // Engage, then fully drain the lane. Its #executionLanes registration
    // must not outlive the close (the C1.5b follow-on lifecycle).
    storage.runWithExecutionLane(SPACE, LANE_A, () => {});
    storage.pruneExecutionLane(SPACE, LANE_A);

    seedConfirmed(factory, [
      { id: SCOPED, scope: "user", scopeKey: LANE_A, value: "alice-doc" },
    ]);
    await storage.open(SPACE).sync(SCOPED, undefined, "user");

    // With the lane pruned, the upsert lands on today's declared key — the
    // pre-lane world — instead of a retired lane instance.
    assertEquals(docValue(storage, SCOPED, "user"), "alice-doc");
    storage.runWithExecutionLane(SPACE, LANE_B, () => {
      assertEquals(docValue(storage, SCOPED, "user"), undefined);
    });
  } finally {
    await storage.close();
  }
});

Deno.test("C1.8: a pruned lane's still-pending localSeq stays unresolvable for other lanes", async () => {
  const factory = new LaneSessionFactory();
  const actionA = {};
  const actionB = {};
  const router: ActionTransactionRouter = (input) =>
    input.sourceAction === actionA
      ? { disposition: "local", kind: "executor-shadow" }
      : { disposition: "upstream" };
  const storage = LaneStorageManager.connect(factory, {
    shadowWrites: true,
    actionTransactionRouter: router,
    executionLaneForAction: (action) =>
      action === actionA ? LANE_A : action === actionB ? LANE_B : undefined,
  });
  try {
    seedConfirmed(factory, [{ id: SHARED, value: "base" }]);
    await storage.open(SPACE).sync(SHARED);

    // Lane A parks an unconfirmed pending version, then its lane closes.
    await writeDoc(storage, SHARED, "a-pending", { sourceAction: actionA });
    storage.pruneExecutionLane(SPACE, LANE_A);

    // A16 must keep holding for the straggler: pruning may forget only
    // SETTLED attributions — a pending localSeq that fell back to "space"
    // would leak lane A's unconfirmed version into lane B's baseline.
    await writeDoc(storage, OUT, "b-out", {
      sourceAction: actionB,
      readIds: [SHARED],
    });
    const upstream = factory.commits.find((commit) =>
      commit.operations.some((operation) =>
        operation.op !== "sqlite" && operation.id === OUT
      )
    );
    assert(upstream !== undefined, "lane B's commit reached the host");
    assertEquals(upstream.reads.pending, []);
    const sharedRead = upstream.reads.confirmed.find((read) =>
      read.id === SHARED
    );
    assert(sharedRead !== undefined, "lane B's commit read the shared doc");
    assertEquals(sharedRead.seq, 1);
  } finally {
    await storage.close();
  }
});
