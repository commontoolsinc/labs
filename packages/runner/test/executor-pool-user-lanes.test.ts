import { assert, assertEquals } from "@std/assert";
import type { BranchName } from "@commonfabric/memory/v2";
import type {
  AcceptedCommitListener,
  AuthenticatedExecutionDemand,
  ExecutionDemandListener,
  ExecutionDemandSnapshot,
  ExecutionLeaseHandle,
  UserLaneGrant,
} from "@commonfabric/memory/v2/server";
import {
  SharedExecutionPool,
  type SpaceExecutor,
  type SpaceExecutorFactory,
  type SpaceExecutorLaneDemand,
  type SpaceExecutorStartOptions,
} from "../src/executor/shared-execution-pool.ts";

const SPACE = "did:key:z6Mk-pool-user-lanes";
const BRANCH = "" as BranchName;
// Colon-bearing DIDs: canonical lane keys percent-encode the principal.
const ALICE = "did:key:z6Mk-pool-lane-alice";
const BOB = "did:key:z6Mk-pool-lane-bob";

const laneKeyOf = (principal: string): `user:${string}` =>
  `user:${encodeURIComponent(principal)}`;

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
  principal: string,
  sessionIndex: number,
  pieces: readonly string[],
  negotiates = true,
): AuthenticatedExecutionDemand => ({
  space: SPACE,
  branch: BRANCH,
  sessionId: `session:${principal}:${sessionIndex}`,
  connectionId: `connection:${principal}:${sessionIndex}`,
  principal,
  pieces,
  negotiatesContextLatticeClaims: negotiates,
});

/** Lane-capable control: mirrors the C1.3/C1.7 server surface with
 * deterministic in-memory grants. */
class LaneFakeControl {
  listener: ExecutionDemandListener | undefined;
  leaseCount = 0;
  hostLanesEnabled = true;
  cohort = new Map<string, boolean>();
  readonly grants = new Map<string, UserLaneGrant>();
  readonly generations = new Map<string, number>();
  readonly openCalls: string[] = [];
  readonly closeCalls: UserLaneGrant[] = [];
  openRejects = new Set<string>();

  subscribeExecutionDemands(listener: ExecutionDemandListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  subscribeAcceptedCommits(
    _space: string,
    _listener: AcceptedCommitListener,
  ): () => void {
    return () => {};
  }

  legacyBackgroundActive(): boolean {
    return false;
  }

  acquireExecutionLease(): Promise<ExecutionLeaseHandle | null> {
    return Promise.resolve(lease(++this.leaseCount));
  }

  renewExecutionLease(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    return Promise.resolve(current);
  }

  beginExecutionLeaseDrain(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    return Promise.resolve(
      { ...current, state: "draining" } as ExecutionLeaseHandle,
    );
  }

  finishExecutionLeaseDrain(
    current: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null> {
    return Promise.resolve(
      { ...current, state: "revoked" } as ExecutionLeaseHandle,
    );
  }

  executionUserLanesEnabled(): boolean {
    return this.hostLanesEnabled;
  }

  principalCohortNegotiatesContextLatticeClaims(
    _space: string,
    principal: string,
  ): boolean {
    return this.cohort.get(principal) ?? false;
  }

  openUserLaneGrant(
    space: string,
    branch: BranchName,
    principal: string,
  ): Promise<UserLaneGrant> {
    this.openCalls.push(principal);
    if (this.openRejects.has(principal)) {
      return Promise.reject(
        new Error("user lane grant requires a connected session"),
      );
    }
    const generation = (this.generations.get(principal) ?? 0) + 1;
    this.generations.set(principal, generation);
    const grant = Object.freeze({
      space,
      branch,
      contextKey: laneKeyOf(principal),
      principal,
      laneGeneration: generation,
      anchorSessionId: `session:${principal}:1`,
      anchorConnectionId: `connection:${principal}:1`,
      anchorSessionToken: "token",
    }) as unknown as UserLaneGrant;
    this.grants.set(principal, grant);
    return Promise.resolve(grant);
  }

  renewUserLaneGrant(grant: UserLaneGrant): Promise<UserLaneGrant | null> {
    return Promise.resolve(
      this.grants.get(grant.principal) === grant ? grant : null,
    );
  }

  closeUserLaneGrant(grant: UserLaneGrant): boolean {
    this.closeCalls.push(grant);
    if (this.grants.get(grant.principal) !== grant) return false;
    this.grants.delete(grant.principal);
    return true;
  }

  /** Host-side drain simulation (anchor disconnect / ACL fence). */
  drainLane(principal: string): void {
    this.grants.delete(principal);
  }

  emit(
    order: number,
    demands: readonly AuthenticatedExecutionDemand[],
  ): Promise<void> | void {
    const snapshot: ExecutionDemandSnapshot = {
      space: SPACE,
      branch: BRANCH,
      order,
      demands,
    };
    return this.listener?.(snapshot);
  }
}

type DemandCall = {
  pieces: readonly string[];
  lanes: readonly SpaceExecutorLaneDemand[] | undefined;
};

class LaneFakeExecutor implements SpaceExecutor {
  readonly demandCalls: DemandCall[] = [];

  setDemand(
    pieces: readonly string[],
    lanes?: readonly SpaceExecutorLaneDemand[],
  ): Promise<void> {
    this.demandCalls.push({ pieces: [...pieces], lanes });
    return Promise.resolve();
  }

  wake(): Promise<void> {
    return Promise.resolve();
  }

  settle(): Promise<number> {
    return Promise.resolve(0);
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

class LaneFakeExecutorFactory implements SpaceExecutorFactory {
  readonly starts: SpaceExecutorStartOptions[] = [];
  readonly executors: LaneFakeExecutor[] = [];

  start(options: SpaceExecutorStartOptions): Promise<SpaceExecutor> {
    this.starts.push(options);
    const executor = new LaneFakeExecutor();
    this.executors.push(executor);
    return Promise.resolve(executor);
  }
}

const laneSetup = (options: { userLaneCandidates?: boolean } = {}) => {
  const control = new LaneFakeControl();
  const factory = new LaneFakeExecutorFactory();
  const pool = new SharedExecutionPool({
    control,
    factory,
    userLaneCandidates: options.userLaneCandidates ?? true,
  });
  pool.start();
  return { control, factory, pool };
};

Deno.test("pool aggregates a principal's demand across sessions into one lane", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  try {
    await control.emit(1, [
      demand(ALICE, 1, ["piece:a"]),
      demand(ALICE, 2, ["piece:b", "piece:a"]),
      // Bob never negotiated the subcapability: no lane, space union only.
      demand(BOB, 1, ["piece:c"], false),
    ]);
    await pool.idle();

    assertEquals(control.openCalls, [ALICE]);
    assertEquals(factory.starts.length, 1);
    assertEquals(factory.starts[0].pieces, ["piece:a", "piece:b", "piece:c"]);
    assertEquals(factory.starts[0].lanes, [{
      contextKey: laneKeyOf(ALICE),
      pieces: ["piece:a", "piece:b"],
      resetClaims: true,
    }]);
    const metrics = pool.metrics();
    assertEquals(metrics.userLanesOpened, 1);
    assertEquals(metrics.activeUserLanes, 1);
    assertEquals(metrics.userLaneReanchors, 0);
  } finally {
    await pool.close();
  }
});

Deno.test("pool opens no lane while any inertness leg is missing", async (t) => {
  await t.step("runner dial off", async () => {
    const { control, factory, pool } = laneSetup({ userLaneCandidates: false });
    control.cohort.set(ALICE, true);
    try {
      await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
      await pool.idle();
      assertEquals(control.openCalls, []);
      assertEquals(factory.starts.length, 1);
      assertEquals(factory.starts[0].lanes, undefined);
      // The live wire stays byte-identical too: a demand change re-sends
      // pieces with NO lanes argument.
      await control.emit(2, [demand(ALICE, 1, ["piece:a", "piece:d"])]);
      await pool.idle();
      assertEquals(factory.executors[0].demandCalls, [{
        pieces: ["piece:a", "piece:d"],
        lanes: undefined,
      }]);
      assertEquals(pool.metrics().activeUserLanes, 0);
    } finally {
      await pool.close();
    }
  });

  await t.step("host dials off", async () => {
    const { control, factory, pool } = laneSetup();
    control.cohort.set(ALICE, true);
    control.hostLanesEnabled = false;
    try {
      await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
      await pool.idle();
      assertEquals(control.openCalls, []);
      assertEquals(factory.starts[0].lanes, undefined);
    } finally {
      await pool.close();
    }
  });

  await t.step("cohort predicate refuses", async () => {
    const { control, factory, pool } = laneSetup();
    // Alice negotiates on this row, but another of her sessions does not:
    // the C1.7 predicate answers for the whole principal.
    control.cohort.set(ALICE, false);
    try {
      await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
      await pool.idle();
      assertEquals(control.openCalls, []);
      assertEquals(factory.starts[0].lanes, undefined);
    } finally {
      await pool.close();
    }
  });
});

Deno.test("anchor loss with surviving demand re-anchors under a new generation with a lane reset", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  const rows = [
    demand(ALICE, 1, ["piece:a"]),
    demand(ALICE, 2, ["piece:a"]),
  ];
  try {
    await control.emit(1, rows);
    await pool.idle();
    assertEquals(control.generations.get(ALICE), 1);

    // Host-side drain (the anchoring session disconnected); the surviving
    // session's demand republish drives the pool to re-anchor.
    control.drainLane(ALICE);
    await control.emit(2, [rows[1]]);
    await pool.idle();

    assertEquals(control.openCalls, [ALICE, ALICE]);
    assertEquals(control.generations.get(ALICE), 2);
    const executor = factory.executors[0];
    assertEquals(executor.demandCalls.length, 1);
    assertEquals(executor.demandCalls[0].lanes, [{
      contextKey: laneKeyOf(ALICE),
      pieces: ["piece:a"],
      resetClaims: true,
    }]);
    const metrics = pool.metrics();
    assertEquals(metrics.userLaneReanchors, 1);
    assertEquals(metrics.activeUserLanes, 1);

    // The one-shot reset does not linger: an unrelated demand change later
    // re-sends the lane without resetClaims.
    await control.emit(3, [
      rows[1],
      demand(BOB, 1, ["piece:c"], false),
    ]);
    await pool.idle();
    assertEquals(executor.demandCalls.at(-1)?.lanes, [{
      contextKey: laneKeyOf(ALICE),
      pieces: ["piece:a"],
    }]);
  } finally {
    await pool.close();
  }
});

Deno.test("last-session departure fully drains the lane and prunes the wire", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  control.cohort.set(BOB, true);
  try {
    await control.emit(1, [
      demand(ALICE, 1, ["piece:a"]),
      demand(BOB, 1, ["piece:b"]),
    ]);
    await pool.idle();
    assertEquals(pool.metrics().activeUserLanes, 2);
    const aliceGrant = control.grants.get(ALICE)!;

    // Alice's last demanding session departs; bob survives.
    await control.emit(2, [demand(BOB, 1, ["piece:b"])]);
    await pool.idle();
    assertEquals(control.closeCalls, [aliceGrant]);
    assertEquals(control.grants.has(ALICE), false);
    const executor = factory.executors[0];
    assertEquals(executor.demandCalls.at(-1), {
      pieces: ["piece:b"],
      lanes: [{ contextKey: laneKeyOf(BOB), pieces: ["piece:b"] }],
    });
    const metrics = pool.metrics();
    assertEquals(metrics.userLanesClosed, 1);
    assertEquals(metrics.activeUserLanes, 1);

    // Demand-empty hibernation closes the remaining lane (full drain).
    await control.emit(3, []);
    await pool.idle();
    assertEquals(pool.metrics().activeUserLanes, 0);
    assertEquals(control.grants.size, 0);
  } finally {
    await pool.close();
  }
});

Deno.test("a cohort flip closes the lane on the next reconciliation", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  try {
    await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
    await pool.idle();
    assertEquals(pool.metrics().activeUserLanes, 1);

    // A non-negotiating session attached: the host fenced the lane (A11) and
    // the cohort predicate now refuses. The pool must not re-open it.
    control.cohort.set(ALICE, false);
    control.drainLane(ALICE);
    await control.emit(2, [
      demand(ALICE, 1, ["piece:a"]),
      demand(ALICE, 2, ["piece:a"], false),
    ]);
    await pool.idle();
    assertEquals(control.openCalls, [ALICE]);
    assertEquals(pool.metrics().activeUserLanes, 0);
    const executor = factory.executors[0];
    // Once lanes were wired to this Worker generation, removal is an
    // explicit empty array — never a silent omission.
    assertEquals(executor.demandCalls.at(-1)?.lanes, []);
    assert(executor.demandCalls.length > 0);
  } finally {
    await pool.close();
  }
});

Deno.test("an open failure parks the lane without blocking the space union", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  control.openRejects.add(ALICE);
  try {
    await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
    await pool.idle();
    assertEquals(control.openCalls, [ALICE]);
    assertEquals(factory.starts.length, 1);
    assertEquals(factory.starts[0].pieces, ["piece:a"]);
    assertEquals(factory.starts[0].lanes, undefined);
    assertEquals(pool.metrics().activeUserLanes, 0);

    // The next snapshot retries and succeeds.
    control.openRejects.delete(ALICE);
    await control.emit(2, [demand(ALICE, 1, ["piece:a"])]);
    await pool.idle();
    assertEquals(pool.metrics().activeUserLanes, 1);
    assertEquals(factory.executors[0].demandCalls.at(-1)?.lanes, [{
      contextKey: laneKeyOf(ALICE),
      pieces: ["piece:a"],
      resetClaims: true,
    }]);
  } finally {
    await pool.close();
  }
});
