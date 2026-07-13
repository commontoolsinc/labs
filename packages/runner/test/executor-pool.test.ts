import { assertEquals } from "@std/assert";
import { getTimingStatsBreakdown } from "@commonfabric/utils/logger";
import type { BranchName, ExecutionLease } from "@commonfabric/memory/v2";
import type {
  AcceptedCommitEvent,
  AcceptedCommitListener,
  AuthenticatedExecutionDemand,
  ExecutionDemandListener,
  ExecutionDemandSnapshot,
  ExecutionLeaseHandle,
} from "@commonfabric/memory/v2/server";
import {
  type ExecutionPoolControl,
  SharedExecutionPool,
  type SpaceExecutor,
  type SpaceExecutorFactory,
  type SpaceExecutorStartOptions,
} from "../src/executor/shared-execution-pool.ts";

const SPACE = "did:key:z6Mk-shared-execution-pool";
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
});

const acceptedCommit = ({
  branch = BRANCH,
  dataSeq = 1,
  originSessionId,
  stale = true,
}: {
  branch?: BranchName;
  dataSeq?: number;
  originSessionId?: string;
  stale?: boolean;
} = {}): AcceptedCommitEvent => ({
  order: dataSeq,
  deliverySeq: dataSeq,
  space: SPACE,
  ...(originSessionId !== undefined ? { originSessionId } : {}),
  branch,
  dataSeq,
  revisions: [],
  schedulerUpdateIds: [],
  staleDemandedReaders: stale
    ? [{
      branch,
      pieceId: "space:piece:a",
      processGeneration: 1,
      actionId: "action:stale",
      executionContextKey: "space",
      latestObservationId: 1,
      directDirtySeq: dataSeq,
      staleSeq: null,
      unknownReason: null,
    }]
    : [],
});

class FakeExecutionControl {
  readonly events: string[];
  readonly acceptedCommitListeners = new Map<
    string,
    Set<AcceptedCommitListener>
  >();
  readonly acquisitionOptions: (
    | { preferredOriginSessionId?: string }
    | undefined
  )[] = [];
  listener: ExecutionDemandListener | undefined;
  current: ExecutionLeaseHandle | null = null;
  acquired = 0;
  acquisitionSucceeds = true;
  renewals = 0;
  renewalSucceeds = true;
  renewalError: unknown;
  drainError: unknown;
  legacyOwned = false;
  drains = 0;
  finished = 0;

  constructor(events: string[] = []) {
    this.events = events;
  }

  subscribeExecutionDemands(listener: ExecutionDemandListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  subscribeAcceptedCommits(
    space: string,
    listener: AcceptedCommitListener,
  ): () => void {
    let listeners = this.acceptedCommitListeners.get(space);
    if (listeners === undefined) {
      listeners = new Set();
      this.acceptedCommitListeners.set(space, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.acceptedCommitListeners.delete(space);
    };
  }

  acquireExecutionLease(
    _space?: string,
    _branch?: BranchName,
    options?: { preferredOriginSessionId?: string },
  ): Promise<ExecutionLeaseHandle | null> {
    this.acquired++;
    this.acquisitionOptions.push(options);
    if (!this.acquisitionSucceeds) return Promise.resolve(null);
    this.current ??= lease(this.acquired);
    return Promise.resolve(this.current);
  }

  currentExecutionLease(): Promise<ExecutionLease | null> {
    return Promise.resolve(this.current);
  }

  renewExecutionLease(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    this.renewals++;
    if (this.renewalError !== undefined) {
      return Promise.reject(this.renewalError);
    }
    return Promise.resolve(this.renewalSucceeds ? current : null);
  }

  beginExecutionLeaseDrain(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    this.events.push("begin-drain");
    this.drains++;
    if (this.drainError !== undefined) {
      return Promise.reject(this.drainError);
    }
    const draining = { ...current, state: "draining" as const };
    this.current = draining as ExecutionLeaseHandle;
    return Promise.resolve(this.current);
  }

  legacyBackgroundActive(): Promise<boolean> {
    return Promise.resolve(this.legacyOwned);
  }

  finishExecutionLeaseDrain(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLease | null> {
    this.events.push("finish-drain");
    this.finished++;
    const revoked = { ...current, state: "revoked" as const };
    this.current = null;
    return Promise.resolve(revoked);
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
    const listeners = [
      ...(this.acceptedCommitListeners.get(event.space) ?? []),
    ];
    await Promise.all(listeners.map((listener) => listener(event)));
  }

  acceptedCommitListenerCount(space = SPACE): number {
    return this.acceptedCommitListeners.get(space)?.size ?? 0;
  }
}

Deno.test("shared execution pool fails closed without a legacy ownership interlock", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const controlWithoutInterlock: ExecutionPoolControl = {
    subscribeExecutionDemands: control.subscribeExecutionDemands.bind(control),
    subscribeAcceptedCommits: control.subscribeAcceptedCommits.bind(control),
    acquireExecutionLease: control.acquireExecutionLease.bind(control),
    renewExecutionLease: control.renewExecutionLease.bind(control),
    beginExecutionLeaseDrain: control.beginExecutionLeaseDrain.bind(control),
    finishExecutionLeaseDrain: control.finishExecutionLeaseDrain.bind(control),
  };
  const pool = new SharedExecutionPool({
    control: controlWithoutInterlock,
    factory,
  });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    assertEquals(factory.starts.length, 0);
    assertEquals(control.acquired, 0);
    assertEquals(pool.snapshot(SPACE, BRANCH)?.state, "excluded");
  } finally {
    await pool.close();
  }
});

class FakeExecutor implements SpaceExecutor {
  readonly events: string[];
  demandUpdates: readonly string[][] = [];
  wakes = 0;
  settled = 0;
  settleResult = 0;
  settleError: unknown;
  settleGate: Promise<void> | undefined;
  readonly settleStarted = Promise.withResolvers<void>();
  stopped = 0;
  stopOptions: ({ abrupt?: boolean } | undefined)[] = [];
  stopGate: Promise<void> | undefined;
  readonly stopStarted = Promise.withResolvers<void>();

  constructor(events: string[] = []) {
    this.events = events;
  }

  setDemand(pieces: readonly string[]): Promise<void> {
    this.demandUpdates = [...this.demandUpdates, [...pieces]];
    return Promise.resolve();
  }

  wake(): Promise<void> {
    this.wakes++;
    return Promise.resolve();
  }

  async settle(): Promise<number> {
    this.events.push("settle");
    this.settled++;
    this.settleStarted.resolve();
    await this.settleGate;
    if (this.settleError !== undefined) throw this.settleError;
    return this.settleResult;
  }

  async stop(options?: { abrupt?: boolean }): Promise<void> {
    this.events.push(options?.abrupt ? "stop-abrupt" : "stop-graceful");
    this.stopOptions.push(options);
    this.stopped++;
    this.stopStarted.resolve();
    await this.stopGate;
  }
}

class FakeExecutorFactory implements SpaceExecutorFactory {
  readonly events: string[];
  readonly executors: FakeExecutor[] = [];
  starts: Parameters<SpaceExecutorFactory["start"]>[0][] = [];

  constructor(events: string[] = []) {
    this.events = events;
  }

  start(
    options: Parameters<SpaceExecutorFactory["start"]>[0],
  ): Promise<SpaceExecutor> {
    this.starts.push(options);
    const executor = new FakeExecutor(this.events);
    this.executors.push(executor);
    return Promise.resolve(executor);
  }
}

class ManualTimers {
  readonly records = new Map<
    number,
    { callback: () => void; delayMs: number; cleared: boolean; fired: boolean }
  >();
  #next = 0;

  readonly setTimer = (callback: () => void, delayMs: number): number => {
    const timer = ++this.#next;
    this.records.set(timer, {
      callback,
      delayMs,
      cleared: false,
      fired: false,
    });
    return timer;
  };

  readonly clearTimer = (timer: number): void => {
    const record = this.records.get(timer);
    if (record !== undefined) record.cleared = true;
  };

  fire(predicate: (delayMs: number) => boolean): void {
    const timer = [...this.records.values()].find((timer) =>
      !timer.cleared && !timer.fired && predicate(timer.delayMs)
    );
    if (timer === undefined) throw new Error("missing expected timer");
    timer.fired = true;
    timer.callback();
  }

  hasActive(delayMs: number): boolean {
    return [...this.records.values()].some((timer) =>
      !timer.cleared && !timer.fired && timer.delayMs === delayMs
    );
  }
}

Deno.test("accepted commit cold-starts parked demand on behalf of its origin", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();
  const timingBefore = getTimingStatsBreakdown()["execution.pool"] ?? {};
  const wakeBefore = timingBefore.wake?.count ?? 0;

  try {
    control.acquisitionSucceeds = false;
    await control.emit(1, [
      demand(1, ["piece:a"]),
      demand(2, ["piece:b"]),
    ]);
    await pool.idle();

    assertEquals(control.acquired, 1);
    assertEquals(factory.starts.length, 0);
    assertEquals(control.acceptedCommitListenerCount(), 1);

    control.acquisitionSucceeds = true;
    await control.emitAccepted(acceptedCommit({
      dataSeq: 7,
      originSessionId: "session:2",
    }));
    await pool.idle();

    assertEquals(factory.starts.length, 1);
    assertEquals(control.acquisitionOptions, [
      undefined,
      { preferredOriginSessionId: "session:2" },
    ]);
    assertEquals(pool.metrics().acceptedCommitNotifications, 1);
    assertEquals(pool.metrics().acceptedCommitIndexDecisions, 1);
    assertEquals(pool.metrics().suppressedUnrelatedCommits, 0);
    assertEquals(pool.metrics().parkedWakeAttempts, 1);
    assertEquals(pool.metrics().parkedWakeStarts, 1);
    assertEquals(
      getTimingStatsBreakdown()["execution.pool"]?.wake?.count,
      wakeBefore + 1,
    );

    // A live Worker owns the accepted-commit feed for its realm. The pool
    // must neither duplicate that wake nor start another generation.
    await control.emitAccepted(acceptedCommit({
      dataSeq: 8,
      originSessionId: "session:1",
    }));
    await pool.idle();
    assertEquals(factory.starts.length, 1);
    assertEquals(factory.executors[0]?.wakes, 0);
    assertEquals(pool.metrics().acceptedCommitNotifications, 2);
    assertEquals(pool.metrics().acceptedCommitIndexDecisions, 2);
    assertEquals(pool.metrics().parkedWakeAttempts, 1);
    assertEquals(pool.metrics().parkedWakeStarts, 1);

    await pool.close();
    assertEquals(control.acceptedCommitListenerCount(), 0);
    assertEquals(pool.metrics().demandEmptyHibernations, 0);
  } finally {
    await pool.close();
  }
});

Deno.test("accepted commit wake ignores wrong-branch and unstale events", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

  try {
    control.acquisitionSucceeds = false;
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    assertEquals(control.acquired, 1);

    await control.emitAccepted(acceptedCommit({
      branch: "alternate" as BranchName,
      dataSeq: 2,
      originSessionId: "session:1",
    }));
    await control.emitAccepted(acceptedCommit({
      dataSeq: 3,
      originSessionId: "session:1",
      stale: false,
    }));
    await pool.idle();

    assertEquals(control.acquired, 1);
    assertEquals(factory.starts.length, 0);
    assertEquals(pool.metrics().acceptedCommitNotifications, 2);
    assertEquals(pool.metrics().acceptedCommitIndexDecisions, 1);
    assertEquals(pool.metrics().suppressedUnrelatedCommits, 1);
    assertEquals(pool.metrics().parkedWakeAttempts, 0);
    assertEquals(pool.metrics().parkedWakeStarts, 0);
  } finally {
    await pool.close();
  }
});

Deno.test("accepted commit wake honors settle watermark and coalesces replacements", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();
  const timingBefore = getTimingStatsBreakdown()["execution.pool"] ?? {};
  const wakeBefore = timingBefore.wake?.count ?? 0;

  try {
    const active = [
      demand(1, ["piece:a"]),
      demand(2, ["piece:b"]),
    ];
    await control.emit(1, active);
    await pool.idle();
    const first = factory.executors[0]!;
    first.settleResult = 10;
    const settleGate = Promise.withResolvers<void>();
    first.settleGate = settleGate.promise;

    control.emit(2, []);
    await first.settleStarted.promise;
    const redemanded = control.emit(3, active);
    control.legacyOwned = true;
    settleGate.resolve();
    await redemanded;
    await pool.idle();

    assertEquals(first.stopped, 1);
    assertEquals(factory.starts.length, 1);
    assertEquals(pool.snapshot(SPACE, BRANCH)?.state, "excluded");

    control.legacyOwned = false;
    await control.emitAccepted(acceptedCommit({
      dataSeq: 10,
      originSessionId: "session:1",
    }));
    await pool.idle();
    assertEquals(control.acquired, 1);
    assertEquals(factory.starts.length, 1);

    await Promise.all(
      [11, 12, 13].map((dataSeq) =>
        control.emitAccepted(acceptedCommit({
          dataSeq,
          originSessionId: "session:2",
        }))
      ),
    );
    await pool.idle();

    assertEquals(factory.starts.length, 2);
    assertEquals(control.acquired, 2);
    assertEquals(control.acquisitionOptions[1], {
      preferredOriginSessionId: "session:2",
    });
    assertEquals(pool.metrics().acceptedCommitNotifications, 4);
    assertEquals(pool.metrics().acceptedCommitIndexDecisions, 4);
    assertEquals(pool.metrics().suppressedUnrelatedCommits, 0);
    assertEquals(pool.metrics().parkedWakeAttempts, 1);
    assertEquals(pool.metrics().parkedWakeStarts, 1);

    // A later successful generation reporting an older sequence must not move
    // the lane's coverage barrier backward.
    const second = factory.executors[1]!;
    second.settleResult = 5;
    const secondSettleGate = Promise.withResolvers<void>();
    second.settleGate = secondSettleGate.promise;
    control.emit(4, []);
    await second.settleStarted.promise;
    const redemandedAgain = control.emit(5, active);
    control.legacyOwned = true;
    secondSettleGate.resolve();
    await redemandedAgain;
    await pool.idle();

    control.legacyOwned = false;
    await control.emitAccepted(acceptedCommit({
      dataSeq: 10,
      originSessionId: "session:1",
    }));
    await pool.idle();
    assertEquals(control.acquired, 2);
    assertEquals(factory.starts.length, 2);
    assertEquals(pool.metrics().parkedWakeAttempts, 1);

    await control.emitAccepted(acceptedCommit({
      dataSeq: 14,
      originSessionId: "session:2",
    }));
    await pool.idle();
    assertEquals(control.acquired, 3);
    assertEquals(factory.starts.length, 3);
    assertEquals(pool.metrics().acceptedCommitNotifications, 6);
    assertEquals(pool.metrics().acceptedCommitIndexDecisions, 6);
    assertEquals(pool.metrics().parkedWakeAttempts, 2);
    assertEquals(pool.metrics().parkedWakeStarts, 2);
    assertEquals(pool.metrics().demandEmptyHibernations, 0);
    assertEquals(
      getTimingStatsBreakdown()["execution.pool"]?.wake?.count,
      wakeBefore + 2,
    );
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool unions ten client references into one worker", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();
  const timingBefore = getTimingStatsBreakdown()["execution.pool"] ?? {};
  const hibernateBefore = timingBefore.hibernate?.count ?? 0;

  try {
    const demands = Array.from(
      { length: 10 },
      (_, index) => demand(index, ["piece:shared"]),
    );
    await control.emit(1, demands);
    await pool.idle();

    assertEquals(factory.starts.length, 1);
    assertEquals(factory.starts[0]?.pieces, ["piece:shared"]);
    assertEquals(pool.snapshot(SPACE, BRANCH), {
      state: "live",
      referenceCount: 10,
      pieces: ["piece:shared"],
      leaseGeneration: 1,
    });
    assertEquals(pool.metrics(), {
      activeLanes: 1,
      activeWorkers: 1,
      activeDemands: 10,
      states: {
        waiting: 0,
        excluded: 0,
        starting: 0,
        live: 1,
        draining: 0,
        backoff: 0,
      },
      demandSnapshots: 1,
      workersStarted: 1,
      workersStopped: 0,
      abruptStops: 0,
      leaseLosses: 0,
      leaseReplacements: 0,
      sponsorRotations: 0,
      crashes: 0,
      acceptedCommitNotifications: 0,
      acceptedCommitIndexDecisions: 0,
      suppressedUnrelatedCommits: 0,
      parkedWakeAttempts: 0,
      parkedWakeStarts: 0,
      demandEmptyHibernations: 0,
    });

    await control.emit(2, demands.slice(1));
    await pool.idle();
    assertEquals(factory.starts.length, 1);
    assertEquals(factory.executors[0]?.stopped, 0);

    await control.emit(3, []);
    await pool.idle();
    assertEquals(factory.executors[0]?.stopped, 1);
    assertEquals(control.finished, 1);
    assertEquals(pool.snapshot(SPACE, BRANCH), undefined);
    assertEquals(control.acceptedCommitListenerCount(), 0);
    assertEquals(pool.metrics(), {
      activeLanes: 0,
      activeWorkers: 0,
      activeDemands: 0,
      states: {
        waiting: 0,
        excluded: 0,
        starting: 0,
        live: 0,
        draining: 0,
        backoff: 0,
      },
      demandSnapshots: 3,
      workersStarted: 1,
      workersStopped: 1,
      abruptStops: 0,
      leaseLosses: 0,
      leaseReplacements: 0,
      sponsorRotations: 0,
      crashes: 0,
      acceptedCommitNotifications: 0,
      acceptedCommitIndexDecisions: 0,
      suppressedUnrelatedCommits: 0,
      parkedWakeAttempts: 0,
      parkedWakeStarts: 0,
      demandEmptyHibernations: 1,
    });
    assertEquals(
      getTimingStatsBreakdown()["execution.pool"]?.hibernate?.count,
      hibernateBefore + 1,
    );
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool updates disjoint roots without restarting", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();
  const timingBefore = getTimingStatsBreakdown()["execution.pool"] ?? {};
  const startBefore = timingBefore["worker-start"]?.count ?? 0;
  const demandBefore = timingBefore["demand-update"]?.count ?? 0;
  const settleBefore = timingBefore["worker-settle"]?.count ?? 0;

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    await control.emit(2, [
      demand(1, ["piece:a"]),
      demand(2, ["piece:b"]),
    ]);
    await pool.idle();

    assertEquals(factory.starts.length, 1);
    assertEquals(factory.executors[0]?.demandUpdates, [[
      "piece:a",
      "piece:b",
    ]]);
    assertEquals(pool.snapshot(SPACE, BRANCH)?.referenceCount, 2);
    await control.emit(3, []);
    await pool.idle();
    const timingAfter = getTimingStatsBreakdown()["execution.pool"] ?? {};
    assertEquals(timingAfter["worker-start"]?.count ?? 0, startBefore + 1);
    assertEquals(timingAfter["demand-update"]?.count ?? 0, demandBefore + 1);
    assertEquals(timingAfter["worker-settle"]?.count ?? 0, settleBefore + 1);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool renews authority before reusing a live worker", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

  try {
    const active = [demand(1, ["piece:a"])];
    await control.emit(1, active);
    await pool.idle();

    control.renewalSucceeds = false;
    await control.emit(2, active);
    await pool.idle();

    assertEquals(control.renewals, 1);
    assertEquals(factory.executors[0]?.stopped, 1);
    assertEquals(factory.starts.length, 2);
    assertEquals(factory.starts[1]?.lease.leaseGeneration, 2);
    assertEquals(pool.metrics().leaseLosses, 1);
    assertEquals(pool.metrics().leaseReplacements, 1);
    assertEquals(pool.metrics().workersStarted, 2);
    assertEquals(pool.metrics().abruptStops, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool treats a rejected demand-time renewal as lease loss", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

  try {
    const active = [demand(1, ["piece:a"])];
    await control.emit(1, active);
    await pool.idle();

    control.renewalError = new Error("renew transport failed");
    await control.emit(2, active);
    await pool.idle();

    assertEquals(factory.executors[0]?.stopOptions, [{ abrupt: true }]);
    assertEquals(factory.starts.length, 2);
    assertEquals(pool.metrics().leaseLosses, 1);
    assertEquals(pool.metrics().activeWorkers, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool treats a rejected scheduled renewal as lease loss", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const timers = new ManualTimers();
  const pool = new SharedExecutionPool({
    control,
    factory,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    control.renewalError = new Error("renew transport failed");
    timers.fire((delayMs) => delayMs > 2_000);
    await pool.idle();

    assertEquals(factory.executors[0]?.stopOptions, [{ abrupt: true }]);
    assertEquals(factory.starts.length, 2);
    assertEquals(pool.metrics().leaseLosses, 1);
    assertEquals(pool.metrics().activeWorkers, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool settles before fencing a graceful drain", async () => {
  const events: string[] = [];
  const control = new FakeExecutionControl(events);
  const factory = new FakeExecutorFactory(events);
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    const executor = factory.executors[0]!;
    const settleGate = Promise.withResolvers<void>();
    executor.settleGate = settleGate.promise;

    control.emit(2, []);
    await executor.settleStarted.promise;

    assertEquals(events, ["settle"]);
    assertEquals(control.current?.state, "active");
    assertEquals(control.drains, 0);
    assertEquals(executor.stopped, 0);

    settleGate.resolve();
    await pool.idle();

    assertEquals(events, [
      "settle",
      "begin-drain",
      "stop-graceful",
      "finish-drain",
    ]);
    assertEquals(executor.stopOptions, [undefined]);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool renews its unfenced lease throughout settle", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const timers = new Map<
    number,
    { callback: () => void; delayMs: number; cleared: boolean }
  >();
  let nextTimer = 0;
  const pool = new SharedExecutionPool({
    control,
    factory,
    settleTimeoutMs: 60_000,
    setTimer: (callback, delayMs) => {
      const timer = ++nextTimer;
      timers.set(timer, { callback, delayMs, cleared: false });
      return timer;
    },
    clearTimer: (timer) => {
      const record = timers.get(timer);
      if (record !== undefined) record.cleared = true;
    },
  });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    const executor = factory.executors[0]!;
    const settleGate = Promise.withResolvers<void>();
    executor.settleGate = settleGate.promise;

    control.emit(2, []);
    await executor.settleStarted.promise;
    const renewal = [...timers.values()].find((timer) =>
      !timer.cleared && timer.delayMs < 60_000
    );
    renewal?.callback();
    for (let index = 0; index < 4; index++) await Promise.resolve();

    assertEquals(control.renewals, 1);
    assertEquals(control.current?.state, "active");
    assertEquals(control.drains, 0);

    settleGate.resolve();
    await pool.idle();
    assertEquals(control.finished, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool hard cap fences and abruptly stops an unsettled worker", async () => {
  const events: string[] = [];
  const control = new FakeExecutionControl(events);
  const factory = new FakeExecutorFactory(events);
  const timers = new Map<
    number,
    { callback: () => void; delayMs: number; cleared: boolean }
  >();
  let nextTimer = 0;
  const pool = new SharedExecutionPool({
    control,
    factory,
    settleTimeoutMs: 17,
    setTimer: (callback, delayMs) => {
      const timer = ++nextTimer;
      timers.set(timer, { callback, delayMs, cleared: false });
      return timer;
    },
    clearTimer: (timer) => {
      const record = timers.get(timer);
      if (record !== undefined) record.cleared = true;
    },
  });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    const executor = factory.executors[0]!;
    executor.settleGate = new Promise(() => {});

    control.emit(2, []);
    await executor.settleStarted.promise;
    const settleTimer = [...timers.values()].find((timer) =>
      !timer.cleared && timer.delayMs === 17
    );
    assertEquals(settleTimer?.delayMs, 17);

    settleTimer?.callback();
    await pool.idle();

    assertEquals(events, [
      "settle",
      "begin-drain",
      "stop-abrupt",
      "finish-drain",
    ]);
    assertEquals(executor.stopOptions, [{ abrupt: true }]);
    assertEquals(control.finished, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool fences and abruptly stops a worker that fails to settle", async () => {
  const events: string[] = [];
  const control = new FakeExecutionControl(events);
  const factory = new FakeExecutorFactory(events);
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    factory.executors[0]!.settleError = new Error("settle failed");

    await control.emit(2, []);
    await pool.idle();

    assertEquals(events, [
      "settle",
      "begin-drain",
      "stop-abrupt",
      "finish-drain",
    ]);
    assertEquals(factory.executors[0]?.stopOptions, [{ abrupt: true }]);
    assertEquals(pool.metrics().demandEmptyHibernations, 0);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool abruptly stops and cleans up when drain control rejects", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    control.drainError = new Error("drain transport failed");

    await control.emit(2, []);
    await pool.idle();

    assertEquals(factory.executors[0]?.stopOptions, [{ abrupt: true }]);
    assertEquals(pool.metrics().leaseLosses, 1);
    assertEquals(pool.snapshot(SPACE, BRANCH), undefined);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool abruptly fences when settle-time renewal fails", async () => {
  const events: string[] = [];
  const control = new FakeExecutionControl(events);
  const factory = new FakeExecutorFactory(events);
  const timers = new Map<
    number,
    { callback: () => void; delayMs: number; cleared: boolean }
  >();
  let nextTimer = 0;
  const pool = new SharedExecutionPool({
    control,
    factory,
    settleTimeoutMs: 60_000,
    setTimer: (callback, delayMs) => {
      const timer = ++nextTimer;
      timers.set(timer, { callback, delayMs, cleared: false });
      return timer;
    },
    clearTimer: (timer) => {
      const record = timers.get(timer);
      if (record !== undefined) record.cleared = true;
    },
  });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    const executor = factory.executors[0]!;
    executor.settleGate = new Promise(() => {});
    control.renewalSucceeds = false;

    control.emit(2, []);
    await executor.settleStarted.promise;
    const renewal = [...timers.values()].find((timer) =>
      !timer.cleared && timer.delayMs < 60_000
    );
    renewal?.callback();
    await pool.idle();

    assertEquals(events, [
      "settle",
      "begin-drain",
      "stop-abrupt",
      "finish-drain",
    ]);
    assertEquals(control.renewals, 1);
    assertEquals(executor.stopOptions, [{ abrupt: true }]);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool stops a fenced worker before releasing its lease", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

  try {
    const active = [demand(1, ["piece:a"])];
    await control.emit(1, active);
    await pool.idle();
    const executor = factory.executors[0]!;
    const stopGate = Promise.withResolvers<void>();
    executor.stopGate = stopGate.promise;

    control.renewalSucceeds = false;
    control.emit(2, active);
    const reconcile = pool.idle();
    const stopStarted = await Promise.race([
      executor.stopStarted.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assertEquals(stopStarted, true);
    const stoppedDuringHandoff = executor.stopped;
    const leaseStateDuringHandoff = control.current?.state;
    const finishedDuringHandoff = control.finished;

    stopGate.resolve();
    await reconcile;
    assertEquals(stoppedDuringHandoff, 1);
    assertEquals(leaseStateDuringHandoff, "draining");
    assertEquals(finishedDuringHandoff, 0);
    assertEquals(control.finished, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool retains demand that arrives during drain", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

  try {
    const active = [demand(1, ["piece:a"])];
    await control.emit(1, active);
    await pool.idle();
    const first = factory.executors[0]!;
    const settleGate = Promise.withResolvers<void>();
    first.settleGate = settleGate.promise;

    control.emit(2, []);
    await first.settleStarted.promise;
    assertEquals(control.drains, 0);
    const redemanded = [
      control.emit(3, active),
      control.emit(4, [demand(1, ["piece:a", "piece:b"])]),
      control.emit(5, [demand(1, ["piece:b"])]),
    ];

    settleGate.resolve();
    await Promise.all(redemanded);
    await pool.idle();

    assertEquals(first.stopped, 1);
    assertEquals(factory.starts.length, 2);
    assertEquals(pool.snapshot(SPACE, BRANCH), {
      state: "live",
      referenceCount: 1,
      pieces: ["piece:b"],
      leaseGeneration: 2,
    });

    // A later update must still reconcile against the replacement generation,
    // not create a second mapped slot beside an orphaned Worker.
    await control.emit(6, [demand(1, ["piece:a", "piece:b"])]);
    await pool.idle();
    assertEquals(factory.starts.length, 2);
    assertEquals(factory.executors[1]?.demandUpdates, [[
      "piece:a",
      "piece:b",
    ]]);
    assertEquals(pool.metrics().demandEmptyHibernations, 0);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool fails closed while legacy background owns a space", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  let legacyOwned = true;
  const pool = new SharedExecutionPool({
    control,
    factory,
    legacyBackgroundActive: () => Promise.resolve(legacyOwned),
  });
  pool.start();

  try {
    const active = [demand(1, ["piece:a"])];
    await control.emit(1, active);
    await pool.idle();
    assertEquals(factory.starts.length, 0);
    assertEquals(control.acquired, 0);
    assertEquals(pool.snapshot(SPACE, BRANCH)?.state, "excluded");

    legacyOwned = false;
    await control.emit(2, active);
    await pool.idle();
    assertEquals(factory.starts.length, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool fences a crashed worker before replacement", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const timers = new Map<
    number,
    { callback: () => void; delayMs: number; cleared: boolean }
  >();
  let nextTimer = 0;
  const pool = new SharedExecutionPool({
    control,
    factory,
    setTimer: (callback, delayMs) => {
      const timer = ++nextTimer;
      timers.set(timer, { callback, delayMs, cleared: false });
      return timer;
    },
    clearTimer: (timer) => {
      const record = timers.get(timer);
      if (record !== undefined) record.cleared = true;
    },
  });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    factory.starts[0]?.onCrash(new Error("worker crashed"));
    await pool.idle();

    assertEquals(factory.executors[0]?.stopped, 1);
    assertEquals(control.finished, 1);
    assertEquals(factory.starts.length, 1);
    assertEquals(pool.snapshot(SPACE, BRANCH)?.state, "backoff");
    const backoff = [...timers.values()].find((timer) => !timer.cleared);
    assertEquals(backoff?.delayMs, 1_000);

    backoff?.callback();
    await pool.idle();
    assertEquals(factory.starts.length, 2);
    assertEquals(factory.starts[1]?.lease.leaseGeneration, 2);
    assertEquals(pool.metrics().crashes, 1);
    assertEquals(pool.metrics().leaseReplacements, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool escalates backoff across repeated live crashes", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const timers = new ManualTimers();
  const pool = new SharedExecutionPool({
    control,
    factory,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    factory.starts[0]?.onCrash(new Error("first live crash"));
    await pool.idle();
    timers.fire((delayMs) => delayMs === 1_000);
    await pool.idle();

    factory.starts[1]?.onCrash(new Error("second live crash"));
    await pool.idle();
    assertEquals(timers.hasActive(2_000), true);
    assertEquals(pool.metrics().crashes, 2);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool resets crash backoff after a healthy renewal", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const timers = new ManualTimers();
  const pool = new SharedExecutionPool({
    control,
    factory,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  pool.start();

  try {
    await control.emit(1, [demand(1, ["piece:a"])]);
    await pool.idle();
    factory.starts[0]?.onCrash(new Error("first live crash"));
    await pool.idle();
    timers.fire((delayMs) => delayMs === 1_000);
    await pool.idle();

    // Surviving until the replacement renews its authority establishes the
    // health boundary for this crash streak.
    timers.fire((delayMs) => delayMs > 2_000);
    await pool.idle();
    factory.starts[1]?.onCrash(new Error("post-renewal crash"));
    await pool.idle();

    assertEquals(timers.hasActive(1_000), true);
    assertEquals(control.renewals, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("closing the pool aborts a Worker generation still starting", async () => {
  const control = new FakeExecutionControl();
  const started = Promise.withResolvers<void>();
  let startupAborted = false;
  const factory: SpaceExecutorFactory = {
    start(options: SpaceExecutorStartOptions): Promise<SpaceExecutor> {
      started.resolve();
      const signal = options.signal;
      if (signal === undefined) {
        throw new Error("pool did not supply startup cancellation");
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          startupAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

  const demandUpdate = control.emit(1, [demand(1, ["piece:a"])]);
  await started.promise;
  await pool.close();
  await demandUpdate;

  assertEquals(startupAborted, true);
  assertEquals(control.finished, 1);
  assertEquals(pool.metrics().activeLanes, 0);
});
