// C3.3a (C3A11) — the pool's foreign-wake entry and the provider-channel
// notice leg.
//
// Fixture (d): the distinct foreign-wake entry BYPASSES the home-seq
// suppression gates — a foreign wake whose read-space seq is numerically
// far below the slot's settled HOME watermark still starts the Worker,
// while a home accepted-commit wake at the same number is suppressed
// (the regression contrast that pins the gate bypass as deliberate).
// Foreign seqs never merge into `pendingWakeSeq`/`lastSettledSeq`. The
// parked-lane skip: a slot whose demand has no pieces reconciles to
// nothing (dirt stays durable host-side). A control without
// `subscribeForeignWakes` keeps the pool byte-identical.
//
// The provider leg: `createHostProviderChannel` forwards a server
// foreign wake over the ordered MessagePort, and the Worker-side
// replica session delivers it to `onForeignWake` — the running-Worker
// notice leg (the Worker cannot READ the foreign data until C3.4; the
// consumption path only marks/schedules, and the servability posture
// keeps such attempts unserved — fail closed, client fallback).
import { assert, assertEquals } from "@std/assert";
import type { BranchName } from "@commonfabric/memory/v2";
import type {
  AcceptedCommitEvent,
  AcceptedCommitListener,
  AuthenticatedExecutionDemand,
  ExecutionDemandListener,
  ExecutionDemandSnapshot,
  ExecutionLeaseHandle,
  ForeignWakeEvent,
  ForeignWakeListener,
} from "@commonfabric/memory/v2/server";
import { Server } from "@commonfabric/memory/v2/server";
import {
  SharedExecutionPool,
  type SpaceExecutor,
  type SpaceExecutorFactory,
} from "../src/executor/shared-execution-pool.ts";
import {
  createHostProviderChannel,
  type ForeignWakeNotice,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";

const SPACE = "did:key:z6Mk-foreign-wake-pool";
const READ_SPACE = "did:key:z6Mk-foreign-wake-read";
const BRANCH = "" as BranchName;

const lease = (generation = 1): ExecutionLeaseHandle => ({
  version: 1,
  space: SPACE,
  branch: BRANCH,
  leaseGeneration: generation,
  hostId: "host:test",
  onBehalfOf: "did:key:z6Mk-sponsor",
  state: "active",
  expiresAt: Date.now() + 60_000,
} as ExecutionLeaseHandle);

const demand = (
  index: number,
  pieces: readonly string[],
): AuthenticatedExecutionDemand => ({
  space: SPACE,
  branch: BRANCH,
  sessionId: `session:${index}`,
  connectionId: `connection:${index}`,
  principal: `did:key:z6Mk-user-${index}`,
  pieces,
  negotiatesContextLatticeClaims: false,
});

const foreignWake = (
  { branch = BRANCH, readSeq = 1, readers = true }: {
    branch?: BranchName;
    readSeq?: number;
    readers?: boolean;
  } = {},
): ForeignWakeEvent => ({
  space: SPACE,
  branch,
  readSpace: READ_SPACE,
  readSeq,
  origin: "notice",
  staleForeignReaders: readers
    ? [{
      branch,
      pieceId: "space:piece:a",
      processGeneration: 1,
      actionId: "action:foreign-stale",
      executionContextKey: "space",
    }]
    : [],
});

const acceptedCommit = (
  { dataSeq = 1 }: { dataSeq?: number } = {},
): AcceptedCommitEvent => ({
  order: dataSeq,
  deliverySeq: dataSeq,
  space: SPACE,
  branch: BRANCH,
  dataSeq,
  revisions: [],
  schedulerUpdateIds: [],
  staleDemandedReaders: [{
    branch: BRANCH,
    pieceId: "space:piece:a",
    processGeneration: 1,
    actionId: "action:stale",
    executionContextKey: "space",
    latestObservationId: 1,
    directDirtySeq: dataSeq,
    staleSeq: null,
    unknownReason: null,
  }],
});

class FakeControl {
  listener: ExecutionDemandListener | undefined;
  acceptedListeners = new Set<AcceptedCommitListener>();
  foreignListeners = new Set<ForeignWakeListener>();
  foreignSubscriptions = 0;
  current: ExecutionLeaseHandle | null = null;
  acquired = 0;
  acquisitionSucceeds = true;

  subscribeExecutionDemands(listener: ExecutionDemandListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  subscribeAcceptedCommits(
    _space: string,
    listener: AcceptedCommitListener,
  ): () => void {
    this.acceptedListeners.add(listener);
    return () => {
      this.acceptedListeners.delete(listener);
    };
  }

  subscribeForeignWakes(
    _space: string,
    listener: ForeignWakeListener,
  ): () => void {
    this.foreignSubscriptions++;
    this.foreignListeners.add(listener);
    return () => {
      this.foreignListeners.delete(listener);
    };
  }

  acquireExecutionLease(): Promise<ExecutionLeaseHandle | null> {
    this.acquired++;
    if (!this.acquisitionSucceeds) return Promise.resolve(null);
    this.current ??= lease(this.acquired);
    return Promise.resolve(this.current);
  }

  renewExecutionLease(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    return Promise.resolve(current);
  }

  beginExecutionLeaseDrain(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    const draining = { ...current, state: "draining" as const };
    this.current = draining as ExecutionLeaseHandle;
    return Promise.resolve(this.current);
  }

  finishExecutionLeaseDrain(current: ExecutionLeaseHandle) {
    const revoked = { ...current, state: "revoked" as const };
    this.current = null;
    return Promise.resolve(revoked);
  }

  legacyBackgroundActive(): boolean {
    return false;
  }

  emit(order: number, demands: readonly AuthenticatedExecutionDemand[]) {
    const snapshot: ExecutionDemandSnapshot = {
      space: SPACE,
      branch: BRANCH,
      order,
      demands,
    };
    return this.listener?.(snapshot);
  }

  async emitAccepted(event: AcceptedCommitEvent): Promise<void> {
    await Promise.all(
      [...this.acceptedListeners].map((listener) => listener(event)),
    );
  }

  async emitForeignWake(event: ForeignWakeEvent): Promise<void> {
    await Promise.all(
      [...this.foreignListeners].map((listener) => listener(event)),
    );
  }
}

class FakeExecutor implements SpaceExecutor {
  settleResult = 0;
  settleStarted = Promise.withResolvers<void>();
  settleGate: Promise<void> | undefined;

  setDemand(): Promise<void> {
    return Promise.resolve();
  }

  wake(): Promise<void> {
    return Promise.resolve();
  }

  async settle(): Promise<number> {
    this.settleStarted.resolve();
    await this.settleGate;
    return this.settleResult;
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeFactory implements SpaceExecutorFactory {
  readonly executors: FakeExecutor[] = [];

  start(): Promise<SpaceExecutor> {
    const executor = new FakeExecutor();
    this.executors.push(executor);
    return Promise.resolve(executor);
  }
}

Deno.test("C3.3a (d): a foreign wake bypasses the home-seq suppression gates while the equivalent home wake is suppressed", async () => {
  const control = new FakeControl();
  const factory = new FakeFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();
  try {
    // Worker #1 runs, then a demand-empty drain begins; the graceful
    // settle reports HOME seq 100. A replacement demand arrives mid-drain
    // (the slot survives) while lease acquisition fails — the slot parks
    // with demand AND lastSettledSeq = 100.
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    assertEquals(factory.executors.length, 1);
    const first = factory.executors[0];
    first.settleResult = 100;
    const settleGate = Promise.withResolvers<void>();
    first.settleGate = settleGate.promise;
    const drain = control.emit(2, []);
    await first.settleStarted.promise;
    control.acquisitionSucceeds = false;
    const revive = control.emit(3, [demand(1, ["piece:a"])]);
    settleGate.resolve();
    await drain;
    await revive;
    await pool.idle();
    assertEquals(
      pool.snapshot(SPACE, BRANCH)?.state,
      "waiting",
      "parked: demand present, no lease, no Worker",
    );
    assertEquals(factory.executors.length, 1);
    const acquiredBefore = control.acquired;

    // Home-domain regression contrast: an accepted-commit wake whose
    // dataSeq (5) trails lastSettledSeq (100) is SUPPRESSED — no
    // acquisition attempt, no Worker.
    await control.emitAccepted(acceptedCommit({ dataSeq: 5 }));
    await pool.idle();
    assertEquals(control.acquired, acquiredBefore, "home seq gate held");
    assertEquals(factory.executors.length, 1);

    // The C3A11 bypass: a FOREIGN wake carrying readSeq 5 — another
    // space's clock, numerically far below the home watermark — still
    // wakes: the entry consults no home seq state.
    control.acquisitionSucceeds = true;
    await control.emitForeignWake(foreignWake({ readSeq: 5 }));
    await pool.idle();
    assertEquals(
      factory.executors.length,
      2,
      "the foreign wake started a Worker despite readSeq << lastSettledSeq",
    );
    assertEquals(pool.snapshot(SPACE, BRANCH)?.state, "live");
    const metrics = pool.metrics();
    assertEquals(metrics.foreignWakeNotifications, 1);
    assertEquals(metrics.foreignWakeAttempts, 1);

    // A foreign wake while the executor is LIVE defers to the provider
    // leg (no restart, no reconcile churn).
    await control.emitForeignWake(foreignWake({ readSeq: 6 }));
    await pool.idle();
    assertEquals(factory.executors.length, 2);
    assertEquals(pool.metrics().foreignWakeAttempts, 1);

    // Branch identity still filters (a wake for another lane is not
    // this slot's), and an empty readers list is a no-op.
    await control.emitForeignWake(
      foreignWake({ branch: "other" as BranchName, readSeq: 7 }),
    );
    await control.emitForeignWake(foreignWake({ readSeq: 8, readers: false }));
    await pool.idle();
    assertEquals(pool.metrics().foreignWakeAttempts, 1);
  } finally {
    await pool.close();
  }
  assertEquals(control.foreignListeners.size, 0, "unsubscribed on close");
});

Deno.test("C3.3a (d): the parked-lane skip — a foreign wake with no demanded pieces reconciles to nothing (dirt stays durable host-side)", async () => {
  const control = new FakeControl();
  const factory = new FakeFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();
  try {
    // Demand row present but with ZERO pieces: the slot exists (the
    // subscription is live) while the union is empty — the §4-parity
    // parked shape at the pool boundary.
    await control.emit(1, [demand(1, [])]);
    await pool.idle();
    assertEquals(factory.executors.length, 0);
    await control.emitForeignWake(foreignWake({ readSeq: 3 }));
    await pool.idle();
    assertEquals(
      factory.executors.length,
      0,
      "no demanded pieces — the wake parks; durable dirt waits for the " +
        "next demand join's post-ack scan",
    );
    assertEquals(control.acquired, 0);
    assertEquals(pool.metrics().foreignWakeAttempts, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("C3.3a (d): a control without subscribeForeignWakes keeps the pool byte-identical (foreign wakes simply never arrive)", async () => {
  const control = new FakeControl();
  const factory = new FakeFactory();
  const bare = {
    subscribeExecutionDemands: control.subscribeExecutionDemands.bind(control),
    subscribeAcceptedCommits: control.subscribeAcceptedCommits.bind(control),
    acquireExecutionLease: control.acquireExecutionLease.bind(control),
    renewExecutionLease: control.renewExecutionLease.bind(control),
    beginExecutionLeaseDrain: control.beginExecutionLeaseDrain.bind(control),
    finishExecutionLeaseDrain: control.finishExecutionLeaseDrain.bind(control),
    legacyBackgroundActive: control.legacyBackgroundActive.bind(control),
  };
  const pool = new SharedExecutionPool({ control: bare, factory });
  pool.start();
  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    assertEquals(factory.executors.length, 1);
    assertEquals(control.foreignSubscriptions, 0);
    assertEquals(pool.metrics().foreignWakeNotifications, 0);
  } finally {
    await pool.close();
  }
});

Deno.test("C3.3a (C3A11 provider leg): a server foreign wake reaches the Worker-side replica's onForeignWake over the provider port", async () => {
  const server = new Server(
    {
      authorizeSessionOpen(message: { authorization?: unknown }) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: "did:key:z6Mk-foreign-wake-audience" },
    } as unknown as ConstructorParameters<typeof Server>[0],
  );
  const channel = createHostProviderChannel({
    server,
    space: SPACE,
    authorizeSessionOpen: (_space, _session, context) => ({
      invocation: {
        aud: context.audience,
        challenge: context.challenge.value,
      },
      authorization: { principal: "did:key:z6Mk-foreign-wake-worker" },
    }),
  });
  const received: ForeignWakeNotice[] = [];
  const receivedFirst = Promise.withResolvers<void>();
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: SPACE as `did:${string}:${string}`,
    space: SPACE as `did:${string}:${string}`,
    onForeignWake: (notice) => {
      received.push(notice);
      receivedFirst.resolve();
    },
  });
  try {
    // Mount the replica session for real (a commit awaits the mount) so
    // the home space is served — and therefore router-registered — and
    // the Worker-side receivers are wired before the wake flows.
    const replica = storage.open(SPACE as `did:${string}:${string}`).replica;
    assert(replica.commitNative);
    const seeded = await replica.commitNative({
      operations: [{
        op: "set",
        id: "of:foreign-wake:seed",
        type: "application/json",
        value: { value: { seeded: true } },
      }],
    });
    assertEquals(seeded.error, undefined);
    assert(
      server.crossSpaceRouter().isHosted(SPACE),
      "the served home space registered its protocol inbox",
    );

    // Dispatch a foreign wake through the server's home-side arm: an
    // inbound `ForeignStaleReaders` from the read space (both spaces
    // hosted on this server, exactly the in-process topology).
    await server.writeDocument(READ_SPACE, "of:seed", { seeded: true });
    server.crossSpaceRouter().link(READ_SPACE, SPACE).send({
      type: "foreign-stale-readers",
      branch: BRANCH,
      commitSeq: 7,
      readers: [{
        branch: BRANCH,
        pieceId: "space:piece:a",
        processGeneration: 1,
        actionId: "action:foreign-stale",
        executionContextKey: "space",
      }],
    });
    await receivedFirst.promise;
    assertEquals(received.length, 1);
    assertEquals(received[0].space, SPACE);
    assertEquals(received[0].readSpace, READ_SPACE);
    assertEquals(received[0].readSeq, 7);
    assertEquals(received[0].origin, "notice");
    assertEquals(received[0].staleForeignReaders, [{
      branch: BRANCH,
      // The provider stamps the HOME owner so the Worker's stale-reader
      // identity key matches its registrations.
      ownerSpace: SPACE,
      pieceId: "space:piece:a",
      processGeneration: 1,
      actionId: "action:foreign-stale",
      executionContextKey: "space",
    }]);
  } finally {
    await storage.close();
    await channel.dispose();
    await server.close();
  }
});
