import { assertEquals } from "@std/assert";
import type { BranchName, ExecutionLease } from "@commonfabric/memory/v2";
import type {
  AuthenticatedExecutionDemand,
  ExecutionDemandListener,
  ExecutionDemandSnapshot,
  ExecutionLeaseHandle,
} from "@commonfabric/memory/v2/server";
import {
  SharedExecutionPool,
  type SpaceExecutor,
  type SpaceExecutorFactory,
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

class FakeExecutionControl {
  listener: ExecutionDemandListener | undefined;
  current: ExecutionLeaseHandle | null = null;
  acquired = 0;
  renewals = 0;
  renewalSucceeds = true;
  drains = 0;
  finished = 0;

  subscribeExecutionDemands(listener: ExecutionDemandListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  acquireExecutionLease(): Promise<ExecutionLeaseHandle | null> {
    this.acquired++;
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
    return Promise.resolve(this.renewalSucceeds ? current : null);
  }

  beginExecutionLeaseDrain(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    this.drains++;
    const draining = { ...current, state: "draining" as const };
    this.current = draining as ExecutionLeaseHandle;
    return Promise.resolve(this.current);
  }

  finishExecutionLeaseDrain(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLease | null> {
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
}

class FakeExecutor implements SpaceExecutor {
  demandUpdates: readonly string[][] = [];
  wakes = 0;
  stopped = 0;
  stopGate: Promise<void> | undefined;
  readonly stopStarted = Promise.withResolvers<void>();

  setDemand(pieces: readonly string[]): Promise<void> {
    this.demandUpdates = [...this.demandUpdates, [...pieces]];
    return Promise.resolve();
  }

  wake(): Promise<void> {
    this.wakes++;
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.stopped++;
    this.stopStarted.resolve();
    await this.stopGate;
  }
}

class FakeExecutorFactory implements SpaceExecutorFactory {
  readonly executors: FakeExecutor[] = [];
  starts: Parameters<SpaceExecutorFactory["start"]>[0][] = [];

  start(
    options: Parameters<SpaceExecutorFactory["start"]>[0],
  ): Promise<SpaceExecutor> {
    this.starts.push(options);
    const executor = new FakeExecutor();
    this.executors.push(executor);
    return Promise.resolve(executor);
  }
}

Deno.test("shared execution pool unions ten client references into one worker", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

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

    await control.emit(2, demands.slice(1));
    await pool.idle();
    assertEquals(factory.starts.length, 1);
    assertEquals(factory.executors[0]?.stopped, 0);

    await control.emit(3, []);
    await pool.idle();
    assertEquals(factory.executors[0]?.stopped, 1);
    assertEquals(control.finished, 1);
    assertEquals(pool.snapshot(SPACE, BRANCH), undefined);
  } finally {
    await pool.close();
  }
});

Deno.test("shared execution pool updates disjoint roots without restarting", async () => {
  const control = new FakeExecutionControl();
  const factory = new FakeExecutorFactory();
  const pool = new SharedExecutionPool({ control, factory });
  pool.start();

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
    const stopGate = Promise.withResolvers<void>();
    first.stopGate = stopGate.promise;

    control.emit(2, []);
    await first.stopStarted.promise;
    const redemanded = control.emit(3, active);

    stopGate.resolve();
    await redemanded;
    await pool.idle();

    assertEquals(first.stopped, 1);
    assertEquals(factory.starts.length, 2);
    assertEquals(pool.snapshot(SPACE, BRANCH), {
      state: "live",
      referenceCount: 1,
      pieces: ["piece:a"],
      leaseGeneration: 2,
    });

    // A later update must still reconcile against the replacement generation,
    // not create a second mapped slot beside an orphaned Worker.
    await control.emit(4, [demand(1, ["piece:a", "piece:b"])]);
    await pool.idle();
    assertEquals(factory.starts.length, 2);
    assertEquals(factory.executors[1]?.demandUpdates, [[
      "piece:a",
      "piece:b",
    ]]);
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
  } finally {
    await pool.close();
  }
});
