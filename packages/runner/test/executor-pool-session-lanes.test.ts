// C2.7 (pool half): session-lane demand derivation and lifecycle. Design
// §2 at session rank — "a session's demand implies demand for its own
// session-context lane": one desired lane per connected, claims-v1-
// negotiating session with published demand, pieces scoped to the OWNING
// session's rows only (never the principal union, never the space union),
// no cohort gate (C2.3: per-session negotiation; a session claim never
// suppresses a sibling). The pool keys desired lanes by the authenticated
// demand row's sessionId and never fabricates a context key (CA9) — the
// canonical key comes back on the GRANT. Session-end = lane-end: the
// departed session's lane closes fully and the wire prunes it, which is
// what makes the CA13 parked skip emergent host-side.
import { assert, assertEquals } from "@std/assert";
import type { BranchName } from "@commonfabric/memory/v2";
import type {
  AcceptedCommitListener,
  AuthenticatedExecutionDemand,
  ExecutionDemandListener,
  ExecutionDemandSnapshot,
  ExecutionLeaseHandle,
  SessionLaneGrant,
  UserLaneGrant,
} from "@commonfabric/memory/v2/server";
import {
  SharedExecutionPool,
  type SpaceExecutor,
  type SpaceExecutorFactory,
  type SpaceExecutorLaneDemand,
  type SpaceExecutorStartOptions,
} from "../src/executor/shared-execution-pool.ts";

const SPACE = "did:key:z6Mk-pool-session-lanes";
const BRANCH = "" as BranchName;
// Colon-bearing DIDs: canonical lane keys percent-encode both segments.
const ALICE = "did:key:z6Mk-pool-session-alice";
const BOB = "did:key:z6Mk-pool-session-bob";

const userLaneKeyOf = (principal: string): `user:${string}` =>
  `user:${encodeURIComponent(principal)}`;

const sessionLaneKeyOf = (
  principal: string,
  sessionId: string,
): `session:${string}:${string}` =>
  `session:${encodeURIComponent(principal)}:${encodeURIComponent(sessionId)}`;

const sessionIdOf = (principal: string, sessionIndex: number): string =>
  `session:${principal}:${sessionIndex}`;

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
  sessionId: sessionIdOf(principal, sessionIndex),
  connectionId: `connection:${principal}:${sessionIndex}`,
  principal,
  pieces,
  negotiatesContextLatticeClaims: negotiates,
});

/** Lane-capable control: mirrors the C2.3 server surface with
 * deterministic in-memory session grants beside the C1.3/C1.7 user
 * grants. */
class SessionLaneFakeControl {
  listener: ExecutionDemandListener | undefined;
  leaseCount = 0;
  hostUserLanesEnabled = true;
  hostSessionLanesEnabled = true;
  cohort = new Map<string, boolean>();
  readonly userGrants = new Map<string, UserLaneGrant>();
  readonly userGenerations = new Map<string, number>();
  readonly sessionGrants = new Map<string, SessionLaneGrant>();
  readonly sessionGenerations = new Map<string, number>();
  readonly openUserCalls: string[] = [];
  readonly openSessionCalls: string[] = [];
  readonly closeSessionCalls: SessionLaneGrant[] = [];
  sessionOpenRejects = new Set<string>();

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
    return this.hostUserLanesEnabled;
  }

  executionSessionLanesEnabled(): boolean {
    return this.hostSessionLanesEnabled;
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
    this.openUserCalls.push(principal);
    const generation = (this.userGenerations.get(principal) ?? 0) + 1;
    this.userGenerations.set(principal, generation);
    const grant = Object.freeze({
      space,
      branch,
      contextKey: userLaneKeyOf(principal),
      principal,
      laneGeneration: generation,
      anchorSessionId: sessionIdOf(principal, 1),
      anchorConnectionId: `connection:${principal}:1`,
      anchorSessionToken: "token",
    }) as unknown as UserLaneGrant;
    this.userGrants.set(principal, grant);
    return Promise.resolve(grant);
  }

  renewUserLaneGrant(grant: UserLaneGrant): Promise<UserLaneGrant | null> {
    return Promise.resolve(
      this.userGrants.get(grant.principal) === grant ? grant : null,
    );
  }

  closeUserLaneGrant(grant: UserLaneGrant): boolean {
    if (this.userGrants.get(grant.principal) !== grant) return false;
    this.userGrants.delete(grant.principal);
    return true;
  }

  openSessionLaneGrant(
    space: string,
    branch: BranchName,
    principal: string,
    sessionId: string,
  ): Promise<SessionLaneGrant> {
    this.openSessionCalls.push(sessionId);
    if (this.sessionOpenRejects.has(sessionId)) {
      return Promise.reject(
        new Error(
          "session lane grant requires that live connected session of the lane principal",
        ),
      );
    }
    const generation = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, generation);
    const grant = Object.freeze({
      space,
      branch,
      contextKey: sessionLaneKeyOf(principal, sessionId),
      principal,
      sessionId,
      laneGeneration: generation,
      anchorSessionId: sessionId,
      anchorConnectionId: `connection:${sessionId}`,
      anchorSessionToken: "token",
    }) as unknown as SessionLaneGrant;
    this.sessionGrants.set(sessionId, grant);
    return Promise.resolve(grant);
  }

  renewSessionLaneGrant(
    grant: SessionLaneGrant,
  ): Promise<SessionLaneGrant | null> {
    return Promise.resolve(
      this.sessionGrants.get(grant.sessionId) === grant ? grant : null,
    );
  }

  closeSessionLaneGrant(grant: SessionLaneGrant): boolean {
    this.closeSessionCalls.push(grant);
    if (this.sessionGrants.get(grant.sessionId) !== grant) return false;
    this.sessionGrants.delete(grant.sessionId);
    return true;
  }

  /** Host-side drain simulation (owning session disconnected). */
  drainSessionLane(sessionId: string): void {
    this.sessionGrants.delete(sessionId);
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

const laneSetup = (
  options: {
    userLaneCandidates?: boolean;
    sessionLaneCandidates?: boolean;
  } = {},
) => {
  const control = new SessionLaneFakeControl();
  const factory = new LaneFakeExecutorFactory();
  const pool = new SharedExecutionPool({
    control,
    factory,
    userLaneCandidates: options.userLaneCandidates ?? true,
    sessionLaneCandidates: options.sessionLaneCandidates ?? true,
  });
  pool.start();
  return { control, factory, pool };
};

Deno.test("pool derives one session lane per negotiating session, pieces scoped to the OWNING session only", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  try {
    await control.emit(1, [
      demand(ALICE, 1, ["piece:a"]),
      demand(ALICE, 2, ["piece:b", "piece:a"]),
      // Bob's session never negotiated claims-v1: no session lane for it.
      demand(BOB, 1, ["piece:c"], false),
    ]);
    await pool.idle();

    assertEquals(control.openSessionCalls, [
      sessionIdOf(ALICE, 1),
      sessionIdOf(ALICE, 2),
    ]);
    assertEquals(factory.starts.length, 1);
    assertEquals(factory.starts[0].pieces, ["piece:a", "piece:b", "piece:c"]);
    // The wire carries the user lane (principal aggregate, design §2) AND
    // one session lane per session, each session lane scoped to ITS OWN
    // session's demand — s1 never sees s2's piece and vice versa.
    assertEquals(factory.starts[0].lanes, [
      {
        contextKey: sessionLaneKeyOf(ALICE, sessionIdOf(ALICE, 1)),
        pieces: ["piece:a"],
        resetClaims: true,
      },
      {
        contextKey: sessionLaneKeyOf(ALICE, sessionIdOf(ALICE, 2)),
        pieces: ["piece:a", "piece:b"],
        resetClaims: true,
      },
      {
        contextKey: userLaneKeyOf(ALICE),
        pieces: ["piece:a", "piece:b"],
        resetClaims: true,
      },
    ]);
    const metrics = pool.metrics();
    assertEquals(metrics.sessionLanesOpened, 2);
    assertEquals(metrics.activeSessionLanes, 2);
    assertEquals(metrics.userLanesOpened, 1);
    assertEquals(metrics.activeUserLanes, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("pool opens no session lane while any inertness leg is missing", async (t) => {
  await t.step("runner session dial off (user lanes untouched)", async () => {
    const { control, factory, pool } = laneSetup({
      sessionLaneCandidates: false,
    });
    control.cohort.set(ALICE, true);
    try {
      await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
      await pool.idle();
      assertEquals(control.openSessionCalls, []);
      assertEquals(factory.starts[0].lanes, [{
        contextKey: userLaneKeyOf(ALICE),
        pieces: ["piece:a"],
        resetClaims: true,
      }]);
      assertEquals(pool.metrics().activeSessionLanes, 0);
    } finally {
      await pool.close();
    }
  });

  await t.step("host session dial off", async () => {
    const { control, pool } = laneSetup();
    control.cohort.set(ALICE, true);
    control.hostSessionLanesEnabled = false;
    try {
      await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
      await pool.idle();
      assertEquals(control.openSessionCalls, []);
      assertEquals(pool.metrics().activeSessionLanes, 0);
    } finally {
      await pool.close();
    }
  });

  await t.step("user runner dial off (rank ladder)", async () => {
    // Session candidacy layers on user candidacy (C2.5's ladder): with the
    // user leg off, the session leg must stay inert too.
    const { control, factory, pool } = laneSetup({
      userLaneCandidates: false,
    });
    control.cohort.set(ALICE, true);
    try {
      await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
      await pool.idle();
      assertEquals(control.openSessionCalls, []);
      assertEquals(factory.starts[0].lanes, undefined);
    } finally {
      await pool.close();
    }
  });
});

Deno.test("session-end = lane-end: the departed session's lane fully drains and the wire prunes; siblings survive", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  try {
    await control.emit(1, [
      demand(ALICE, 1, ["piece:a"]),
      demand(ALICE, 2, ["piece:a"]),
    ]);
    await pool.idle();
    assertEquals(pool.metrics().activeSessionLanes, 2);
    const departedGrant = control.sessionGrants.get(sessionIdOf(ALICE, 1))!;

    // s1 disconnected: the host already drained its grant and removed its
    // demand row; the republish drives the pool to close its lane record.
    control.drainSessionLane(sessionIdOf(ALICE, 1));
    await control.emit(2, [demand(ALICE, 2, ["piece:a"])]);
    await pool.idle();

    assertEquals(control.closeSessionCalls, [departedGrant]);
    assertEquals(control.sessionGrants.has(sessionIdOf(ALICE, 1)), false);
    // The sibling's lane and the user lane are untouched (per-session
    // lifecycle, C2.3): no drain, no reset, no generation bump.
    assertEquals(
      control.sessionGenerations.get(sessionIdOf(ALICE, 2)),
      1,
    );
    const executor = factory.executors[0];
    assertEquals(executor.demandCalls.at(-1)?.lanes, [
      {
        contextKey: sessionLaneKeyOf(ALICE, sessionIdOf(ALICE, 2)),
        pieces: ["piece:a"],
      },
      { contextKey: userLaneKeyOf(ALICE), pieces: ["piece:a"] },
    ]);
    const metrics = pool.metrics();
    assertEquals(metrics.sessionLanesClosed, 1);
    assertEquals(metrics.activeSessionLanes, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("a host-side drain with surviving demand re-opens the session's OWN lane under a new generation with a lane reset", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  const row = demand(ALICE, 1, ["piece:a"]);
  try {
    await control.emit(1, [row]);
    await pool.idle();
    assertEquals(control.sessionGenerations.get(row.sessionId), 1);

    // The host drained the lane (brief disconnect); the SAME session
    // re-attached and its demand republish drives the reopen — a NEW
    // incarnation of its own lane (reconnect catch-up), never a sibling
    // adoption (session lanes have no re-anchor path).
    control.drainSessionLane(row.sessionId);
    await control.emit(2, [row]);
    await pool.idle();

    assertEquals(control.openSessionCalls, [row.sessionId, row.sessionId]);
    assertEquals(control.sessionGenerations.get(row.sessionId), 2);
    const executor = factory.executors[0];
    assertEquals(executor.demandCalls.at(-1)?.lanes, [
      {
        contextKey: sessionLaneKeyOf(ALICE, row.sessionId),
        pieces: ["piece:a"],
        resetClaims: true,
      },
      { contextKey: userLaneKeyOf(ALICE), pieces: ["piece:a"] },
    ]);
    const metrics = pool.metrics();
    assertEquals(metrics.sessionLaneReopens, 1);
    assertEquals(metrics.activeSessionLanes, 1);
  } finally {
    await pool.close();
  }
});

Deno.test("a session demand shrink retires only that session's lane; the user lane is untouched (and vice versa)", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  try {
    await control.emit(1, [
      demand(ALICE, 1, ["piece:a"]),
      demand(ALICE, 2, ["piece:a"]),
    ]);
    await pool.idle();
    assertEquals(pool.metrics().activeSessionLanes, 2);
    assertEquals(pool.metrics().activeUserLanes, 1);

    // s1's demand shrinks to empty (its row disappears): only s1's session
    // lane retires; the user lane keeps aggregating s2's surviving demand.
    await control.emit(2, [demand(ALICE, 2, ["piece:a"])]);
    await pool.idle();
    assertEquals(pool.metrics().activeSessionLanes, 1);
    assertEquals(pool.metrics().activeUserLanes, 1);
    const executor = factory.executors[0];
    assertEquals(executor.demandCalls.at(-1)?.lanes, [
      {
        contextKey: sessionLaneKeyOf(ALICE, sessionIdOf(ALICE, 2)),
        pieces: ["piece:a"],
      },
      { contextKey: userLaneKeyOf(ALICE), pieces: ["piece:a"] },
    ]);

    // Vice versa: a cohort flip (a non-negotiating sibling attached) closes
    // the USER lane while s2's own session lane — gated only on ITS OWN
    // negotiation — survives.
    control.cohort.set(ALICE, false);
    control.userGrants.delete(ALICE);
    await control.emit(3, [
      demand(ALICE, 2, ["piece:a"]),
      demand(ALICE, 3, ["piece:a"], false),
    ]);
    await pool.idle();
    assertEquals(pool.metrics().activeUserLanes, 0);
    assertEquals(pool.metrics().activeSessionLanes, 1);
    assertEquals(executor.demandCalls.at(-1)?.lanes, [{
      contextKey: sessionLaneKeyOf(ALICE, sessionIdOf(ALICE, 2)),
      pieces: ["piece:a"],
    }]);
  } finally {
    await pool.close();
  }
});

Deno.test("a session-lane open failure parks that lane without blocking the space union or the user lane", async () => {
  const { control, factory, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  control.sessionOpenRejects.add(sessionIdOf(ALICE, 1));
  try {
    await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
    await pool.idle();
    assertEquals(control.openSessionCalls, [sessionIdOf(ALICE, 1)]);
    assertEquals(factory.starts.length, 1);
    assertEquals(factory.starts[0].pieces, ["piece:a"]);
    assertEquals(factory.starts[0].lanes, [{
      contextKey: userLaneKeyOf(ALICE),
      pieces: ["piece:a"],
      resetClaims: true,
    }]);
    assertEquals(pool.metrics().activeSessionLanes, 0);

    // The next snapshot retries and succeeds.
    control.sessionOpenRejects.delete(sessionIdOf(ALICE, 1));
    await control.emit(2, [demand(ALICE, 1, ["piece:a"])]);
    await pool.idle();
    assertEquals(pool.metrics().activeSessionLanes, 1);
    assertEquals(factory.executors[0].demandCalls.at(-1)?.lanes, [
      {
        contextKey: sessionLaneKeyOf(ALICE, sessionIdOf(ALICE, 1)),
        pieces: ["piece:a"],
        resetClaims: true,
      },
      { contextKey: userLaneKeyOf(ALICE), pieces: ["piece:a"] },
    ]);
  } finally {
    await pool.close();
  }
});

Deno.test("pool teardown fully drains session lanes alongside user lanes", async () => {
  const { control, pool } = laneSetup();
  control.cohort.set(ALICE, true);
  try {
    await control.emit(1, [demand(ALICE, 1, ["piece:a"])]);
    await pool.idle();
    assertEquals(pool.metrics().activeSessionLanes, 1);
    assert(control.sessionGrants.size === 1);
  } finally {
    await pool.close();
  }
  assertEquals(control.sessionGrants.size, 0);
  assertEquals(control.userGrants.size, 0);
  assertEquals(pool.metrics().activeSessionLanes, 0);
});
