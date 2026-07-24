// C2.1a + C2.3 (session lanes, host half): the rank-dial session stage and
// canonical wire validation (CA12), session lane grants — the session is its
// OWN anchor, session-end = lane-end, NO re-anchor — threaded through the
// CA1 issuance-binding seams (#requiredLaneGrantForClaim, the lane-binding
// install, assertLaneGrantCurrent, laneAuthority), the amendment-3
// routing-disjointness invariant over session chains, and the A2 ACL drain
// at session rank. Mirrors the C1.3 user-lane fixtures in
// v2-execution-lane-grant-test.ts / v2-execution-acting-context-test.ts.
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import * as MemoryV2 from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import type { ExecutionLease } from "../v2.ts";
import type {
  SchedulerActionObservation,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-session-lane-space";
// Colon-bearing DIDs exercise the canonical percent-encoded lane keys.
const ALICE = "did:key:z6Mk-session-lane-alice";
const BOB = "did:key:z6Mk-session-lane-bob";
const AUDIENCE = "did:key:z6Mk-session-lane-audience";

type ActionClaimKey = {
  branch: string;
  space: string;
  contextKey: "space" | `user:${string}` | `session:${string}:${string}`;
  pieceId: string;
  actionId: string;
  actionKind: "computation" | "effect" | "event-handler";
  implementationFingerprint: string;
  runtimeFingerprint: string;
};

type ExecutionClaim = ActionClaimKey & {
  leaseGeneration: number;
  claimGeneration: number;
  expiresAt: number;
};

type ExecutionControlEvent =
  | { type: "session.execution.claim.set"; claim: ExecutionClaim }
  | {
    type: "session.execution.claim.revoke";
    branch: string;
    claim: ActionClaimKey;
    leaseGeneration: number;
    claimGeneration: number;
  }
  | { type: "session.execution.settlement"; settlement: unknown };

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
  subscribeExecutionControl(
    listener: (event: ExecutionControlEvent) => void,
  ): () => void;
};

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

type SessionGrant = Readonly<{
  space: string;
  branch: string;
  contextKey: `session:${string}:${string}`;
  principal: string;
  sessionId: string;
  laneGeneration: number;
  anchorSessionId: string;
  anchorConnectionId: string;
}>;

type UserGrant = Readonly<{
  contextKey: `user:${string}`;
  laneGeneration: number;
}>;

type LaneServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ActionClaimKey,
  ): Promise<ExecutionClaim>;
  trySetExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ActionClaimKey,
  ): Promise<ExecutionClaim | null>;
  renewExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ExecutionClaim,
  ): Promise<ExecutionClaim | null>;
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  listExecutionClaims(space: string): readonly ExecutionClaim[];
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<UserGrant>;
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<SessionGrant>;
  renewSessionLaneGrant(grant: SessionGrant): Promise<SessionGrant | null>;
  sessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): SessionGrant | null;
  closeSessionLaneGrant(grant: SessionGrant): boolean;
  executionUserLanesEnabled(): boolean;
  executionSessionLanesEnabled(): boolean;
};

/** Multi-principal session-open: the principal rides the authorization
 * payload, so one server can host alice and bob sessions side by side. */
const createLaneServer = (name: string): LaneServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        serverPrimaryExecutionBuiltinPassivityV1: true,
        serverPrimaryExecutionContextLatticeClaimsV1: true,
      },
      acl: { mode: "off", serviceDids: [] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as LaneServer;

const connectLaneClient = async (
  server: Server,
  options: { contextLatticeClaims?: boolean } = {},
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
      serverPrimaryExecutionContextLatticeClaimsV1:
        options.contextLatticeClaims ?? true,
    },
  } as MemoryClient.ConnectOptions);

const mountAs = async (
  client: MemoryClient.Client,
  principal: string,
): Promise<ExecutionSession> =>
  await client.mount(SPACE, {}, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

/** Empty spaces resolve READ for authenticated principals; the first commit
 * flips the pre-launch compatibility capability to WRITE, which the grant
 * and lease WRITE checks require. */
const seedSpaceWrite = async (session: ExecutionSession): Promise<void> => {
  await session.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:session-lane-seed",
      value: { value: "seed" },
    }],
  });
};

const laneClaimKey = (
  contextKey: ActionClaimKey["contextKey"],
  actionId = "action:session-lane-derive",
): ActionClaimKey => ({
  branch: "",
  space: SPACE,
  contextKey,
  pieceId: "space:piece:session-lane",
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:session-lane-v1",
  runtimeFingerprint: "runtime:session-lane-v1",
});

const rankDial = MemoryV2 as unknown as {
  setServerPrimaryExecutionClaimRankConfig(
    rank?: "space" | "user" | "session",
  ): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

const sessionKeyOf = (
  principal: string,
  sessionId: string,
): `session:${string}:${string}` =>
  Engine.sessionExecutionContextKey(principal, sessionId);

const userKeyOf = (principal: string): `user:${string}` =>
  Engine.userExecutionContextKey(principal);

const demandAndAcquireLease = async (
  server: LaneServer,
  session: ExecutionSession,
): Promise<ExecutionLeaseHandle> => {
  await session.setExecutionDemand("", ["space:piece:session-lane"]);
  const lease = await server.acquireExecutionLease(SPACE, "");
  assertExists(lease);
  return lease;
};

const sessionAddress = (id: string): SchedulerObservationAddress => ({
  space: SPACE,
  scope: "session",
  id,
  path: ["value"],
});

const observationFor = (
  claim: ExecutionClaim,
  surfaces: {
    reads?: readonly SchedulerObservationAddress[];
    writes?: readonly SchedulerObservationAddress[];
  },
): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: SPACE,
  branch: "",
  pieceId: claim.pieceId,
  processGeneration: 1,
  actionId: claim.actionId,
  actionKind: "computation",
  implementationFingerprint: claim.implementationFingerprint,
  runtimeFingerprint: claim.runtimeFingerprint,
  executionClaimAssertion: {
    contextKey: claim.contextKey,
    leaseGeneration: claim.leaseGeneration,
    claimGeneration: claim.claimGeneration,
  },
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [...(surfaces.reads ?? [])],
  shallowReads: [],
  actualChangedWrites: [...(surfaces.writes ?? [])],
  currentKnownWrites: [...(surfaces.writes ?? [])],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: claim.implementationFingerprint,
    runtimeFingerprint: claim.runtimeFingerprint,
    piece: {
      space: SPACE,
      scope: "space",
      id: claim.pieceId.slice("space:".length),
      path: [],
    },
    reads: [...(surfaces.reads ?? [])],
    writes: [...(surfaces.writes ?? [])],
    materializerWriteEnvelopes: [],
    directOutputs: [...(surfaces.writes ?? [])],
  },
  status: "success",
});

// ---------------------------------------------------------------------------
// (a) Dial-off regression: below the session stage, session claims reject at
// issuance exactly as before C2.1, at every lower stage of the ladder.
// ---------------------------------------------------------------------------

Deno.test("below the session stage, session-rank issuance stays rejected exactly as today", async () => {
  const server = createLaneServer("memory-v2-session-lane-dial-off");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    const lease = await demandAndAcquireLease(server, session);
    const sessionClaim = laneClaimKey(sessionKeyOf(ALICE, session.sessionId));
    for (const stage of ["space", "user"] as const) {
      rankDial.setServerPrimaryExecutionClaimRankConfig(stage);
      await assertRejects(
        () => server.setExecutionClaim(lease, sessionClaim),
        Error,
        "rank is not enabled",
        stage,
      );
      assertEquals(server.executionSessionLanesEnabled(), false, stage);
    }
    // Space issuance is untouched by the widened ladder.
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    const spaceClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey("space"),
    );
    assertEquals(spaceClaim.contextKey, "space");
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (c) CA12: malformed session keys are one clean typed rejection at the
// wire validator — even at the session stage, so it is the canonical-shape
// check rejecting, not the rank gate.
// ---------------------------------------------------------------------------

Deno.test("malformed session claim keys reject at the wire as invalid input (CA12)", async () => {
  const server = createLaneServer("memory-v2-session-lane-ca12");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, session);
    for (
      const malformed of [
        // Naive raw colon-bearing DID: ambiguous segmentation.
        `session:${ALICE}:${session.sessionId}`,
        // The CA12 red case shapes.
        "session:a:b:c",
        "session::",
        // A did with no session id.
        `session:${encodeURIComponent(ALICE)}`,
        // Non-canonical escapes decode but do not round-trip byte-exactly.
        "session:a%2fb:s",
      ] as ActionClaimKey["contextKey"][]
    ) {
      await assertRejects(
        () => server.setExecutionClaim(lease, laneClaimKey(malformed)),
        TypeError,
        "invalid execution claim input",
        malformed,
      );
    }
    assertEquals(server.listExecutionClaims(SPACE), []);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// C2.3 grant lifecycle: anchoring, WRITE, per-session negotiation, and the
// ladder's host-side pairs.
// ---------------------------------------------------------------------------

Deno.test("session lane grants anchor on exactly that live session with WRITE", async () => {
  const server = createLaneServer("memory-v2-session-lane-anchoring");
  const aliceClient = await connectLaneClient(server);
  const aliceSession = await mountAs(aliceClient, ALICE);
  const bobClient = await connectLaneClient(server);
  const bobSession = await mountAs(bobClient, BOB);
  try {
    // Empty space: alice's capability resolves READ, so amendment 2 refuses
    // the grant even though her session is connected.
    await assertRejects(
      () =>
        server.openSessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId),
      Error,
      "WRITE",
    );
    await seedSpaceWrite(aliceSession);
    const grant = await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      aliceSession.sessionId,
    );
    assertEquals(grant.principal, ALICE);
    assertEquals(grant.sessionId, aliceSession.sessionId);
    assertEquals(
      grant.contextKey,
      sessionKeyOf(ALICE, aliceSession.sessionId),
    );
    assertEquals(grant.laneGeneration, 1);
    // The session is its own anchor.
    assertEquals(grant.anchorSessionId, aliceSession.sessionId);
    assertEquals(
      server.sessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId),
      grant,
    );
    // Re-opening while the anchor lives returns the same live grant.
    assertEquals(
      await server.openSessionLaneGrant(
        SPACE,
        "",
        ALICE,
        aliceSession.sessionId,
      ),
      grant,
    );

    // An unknown session id has nothing to anchor on.
    await assertRejects(
      () => server.openSessionLaneGrant(SPACE, "", ALICE, "no-such-session"),
      Error,
      "live connected session",
    );
    // Another principal's session can never anchor alice's lane.
    await assertRejects(
      () => server.openSessionLaneGrant(SPACE, "", ALICE, bobSession.sessionId),
      Error,
      "live connected session",
    );
  } finally {
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});

Deno.test("session lane grants require the lane session to negotiate context-lattice-claims-v1", async () => {
  const server = createLaneServer("memory-v2-session-lane-negotiation");
  const negotiatingClient = await connectLaneClient(server);
  const negotiatingSession = await mountAs(negotiatingClient, ALICE);
  // The same principal, attached WITHOUT the subcapability: her sibling's
  // lane is fine (per-session gate), but her own session cannot hold one.
  const plainClient = await connectLaneClient(server, {
    contextLatticeClaims: false,
  });
  const plainSession = await mountAs(plainClient, ALICE);
  try {
    await seedSpaceWrite(negotiatingSession);
    await assertRejects(
      () =>
        server.openSessionLaneGrant(SPACE, "", ALICE, plainSession.sessionId),
      Error,
      "negotiate",
    );
    // The negotiating sibling's grant opens — deliberately NOT the user-lane
    // principal-wide cohort gate: a session claim never suppresses a sibling
    // session under chain-scoped routing.
    const grant = await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      negotiatingSession.sessionId,
    );
    assertEquals(grant.sessionId, negotiatingSession.sessionId);
  } finally {
    await negotiatingClient.close();
    await plainClient.close();
    await server.close();
  }
});

Deno.test("the session dial stage is a ladder: user lanes stay enabled above it", async () => {
  const server = createLaneServer("memory-v2-session-lane-ladder");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    assertEquals(server.executionUserLanesEnabled(), true);
    assertEquals(server.executionSessionLanesEnabled(), false);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    assertEquals(server.executionUserLanesEnabled(), true);
    assertEquals(server.executionSessionLanesEnabled(), true);
    // A user-rank claim still issues at the session stage.
    const lease = await demandAndAcquireLease(server, session);
    await server.openUserLaneGrant(SPACE, "", ALICE);
    const userClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey(userKeyOf(ALICE), "action:session-lane-ladder-user"),
    );
    assertEquals(userClaim.contextKey, userKeyOf(ALICE));
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

Deno.test("session-rank issuance requires a live session lane grant (CA1 issuance binding)", async () => {
  const server = createLaneServer("memory-v2-session-lane-required");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, session);
    const claim = laneClaimKey(sessionKeyOf(ALICE, session.sessionId));
    await assertRejects(
      () => server.setExecutionClaim(lease, claim),
      Error,
      "lane grant",
    );
    assertEquals(await server.trySetExecutionClaim(lease, claim), null);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (b) Dial-on: a canonical session claim is admitted, commits over the wire
// under a live session lane grant + binding at the lane's own session
// context, and settles.
// ---------------------------------------------------------------------------

Deno.test("through a sponsor-bound provider session, a session lane commits at its own session context", async () => {
  const server = createLaneServer("memory-v2-session-lane-wire-commit");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectLaneClient(server);
  const bobSession = await mountAs(bobClient, BOB);
  const aliceClient = await connectLaneClient(server);
  const aliceSession = await mountAs(aliceClient, ALICE);
  // Alice's OTHER session: the same principal, a different session — it must
  // never observe the lane's session-scoped instance.
  const aliceObserverClient = await connectLaneClient(server);
  const aliceObserver = await mountAs(aliceObserverClient, ALICE);
  let unbind = () => {};
  try {
    await seedSpaceWrite(bobSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, bobSession);
    unbind = server.bindExecutionSession(SPACE, bobSession.sessionId, lease);
    await server.openSessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId);
    const claim = await server.setExecutionClaim(
      lease,
      laneClaimKey(sessionKeyOf(ALICE, aliceSession.sessionId)),
    );
    assertEquals(
      claim.contextKey,
      sessionKeyOf(ALICE, aliceSession.sessionId),
    );

    const output = sessionAddress("of:session-lane-wire-output");
    const applied = await bobSession.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: output.id,
        scope: "session",
        value: { value: 21 },
      }],
      schedulerObservation: observationFor(claim, { writes: [output] }),
    }) as Engine.AppliedCommit;
    assertExists(applied.schedulerObservationResults);
    const [result] = applied.schedulerObservationResults;
    assert(result.status === "kept");
    // Settled at the lane's session context — not bob's executor session.
    assertEquals(
      result.executionContextKey,
      sessionKeyOf(ALICE, aliceSession.sessionId),
    );
    assertEquals(result.executionProvenance?.onBehalfOf, BOB);

    // The lane session reads ITS instance…
    const laneView = await aliceSession.queryGraph({
      roots: [{
        id: output.id,
        scope: "session",
        selector: { path: [], schema: false },
      }],
    });
    assertEquals(
      laneView.entities.find((entity) => entity.id === output.id)?.document,
      { value: 21 },
    );
    // …while the same principal's OTHER session sees nothing (session-scope
    // isolation between two live sessions of one principal).
    const observerView = await aliceObserver.queryGraph({
      roots: [{
        id: output.id,
        scope: "session",
        selector: { path: [], schema: false },
      }],
    });
    assertEquals(
      observerView.entities.find((entity) => entity.id === output.id)
        ?.document ?? null,
      null,
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    unbind();
    await aliceObserverClient.close();
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (d) Session-end = lane-end: disconnect drains exactly that session's lane —
// generation fenced before the claim sweep, siblings untouched, no re-anchor.
// ---------------------------------------------------------------------------

Deno.test("disconnect drains only that session's lane; siblings survive and nothing re-anchors", async () => {
  const server = createLaneServer("memory-v2-session-lane-drain-isolation");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectLaneClient(server);
  const bobSession = await mountAs(bobClient, BOB);
  const aliceClient = await connectLaneClient(server);
  const aliceSession = await mountAs(aliceClient, ALICE);
  const aliceSiblingClient = await connectLaneClient(server);
  const aliceSibling = await mountAs(aliceSiblingClient, ALICE);
  try {
    await seedSpaceWrite(bobSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, bobSession);
    // One logical action fans out to two sessions of one principal — the
    // legitimate fan-out (no single client identity matches both claims).
    const grant = await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      aliceSession.sessionId,
    );
    const siblingGrant = await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      aliceSibling.sessionId,
    );
    const claim = await server.setExecutionClaim(
      lease,
      laneClaimKey(sessionKeyOf(ALICE, aliceSession.sessionId)),
    );
    const siblingClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey(sessionKeyOf(ALICE, aliceSibling.sessionId)),
    );

    const siblingObserved: ExecutionControlEvent[] = [];
    const unsubscribe = aliceSibling.subscribeExecutionControl((event) =>
      siblingObserved.push(event)
    );

    await aliceClient.close();

    // Only the dead session's lane drained: its grant fenced, its claim
    // revoked; the sibling's grant, claim, and the lease survive untouched.
    assertEquals(
      server.sessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId),
      null,
    );
    assertEquals(
      server.sessionLaneGrant(SPACE, "", ALICE, aliceSibling.sessionId),
      siblingGrant,
    );
    assertEquals(server.listExecutionClaims(SPACE), [siblingClaim]);
    // C2.6 (CA4): the dead session's revoke is addressed to the dead session
    // alone — the SIBLING observes nothing. Pre-C2.6 this very fixture pinned
    // the over-broadcast (the sibling received the revoke), which is the CA4
    // quadratic-rerun mechanism: the client's chain-keyed action index would
    // turn that delivered sibling revoke into an execution-claim-invalidation
    // of the sibling's own registration of the same logical action.
    assertEquals(siblingObserved, []);
    // The swept claim cannot renew, and the drained incarnation can never be
    // renewed back to life.
    assertEquals(await server.renewExecutionClaim(lease, claim), null);
    assertExists(await server.renewExecutionClaim(lease, siblingClaim));
    assertEquals(await server.renewSessionLaneGrant(grant), null);
    // NO re-anchor: the same principal's surviving session does NOT inherit
    // the dead session's lane, and the dead session cannot be re-granted.
    assertEquals(
      server.sessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId),
      null,
    );
    await assertRejects(
      () =>
        server.openSessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId),
      Error,
      "live connected session",
    );
    unsubscribe();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await aliceSiblingClient.close();
    await bobClient.close();
    await server.close();
  }
});

Deno.test("issuance racing a session lane drain is declined and nothing survives", async () => {
  const server = createLaneServer("memory-v2-session-lane-drain-race");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const sponsorClient = await connectLaneClient(server);
  const sponsorSession = await mountAs(sponsorClient, BOB);
  const aliceClient = await connectLaneClient(server);
  const aliceSession = await mountAs(aliceClient, ALICE);
  try {
    await seedSpaceWrite(sponsorSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, sponsorSession);
    const grant = await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      aliceSession.sessionId,
    );

    // Barrier interleave (amendment 12), no timing sleeps: the issuance
    // binds the live grant synchronously, then awaits engine access; the
    // synchronous session detach drains the lane — fencing the generation
    // BEFORE sweeping claims — so the issuance's post-await re-validation
    // observes the fence and declines instead of orphaning a claim.
    const issuance = server.trySetExecutionClaim(
      lease,
      laneClaimKey(sessionKeyOf(ALICE, aliceSession.sessionId)),
    );
    server.detachSession(
      SPACE,
      grant.anchorSessionId,
      grant.anchorConnectionId,
    );
    assertEquals(await issuance, null);
    assertEquals(
      server.sessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId),
      null,
    );
    assertEquals(
      server.listExecutionClaims(SPACE).filter((claim) =>
        claim.contextKey === sessionKeyOf(ALICE, aliceSession.sessionId)
      ),
      [],
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await sponsorClient.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (e) A2 at session rank: a mid-run WRITE revocation drains the session lane
// in the awaited ACL reconciliation, before any later commit arrives.
// ---------------------------------------------------------------------------

Deno.test("acting-principal WRITE loss drains the session lane before a later commit (claim-not-live)", async () => {
  const server = createLaneServer("memory-v2-session-lane-write-loss");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectLaneClient(server);
  const bobSession = await mountAs(bobClient, BOB);
  // A second sponsor session stays UNBOUND so it can commit the ACL change
  // (a lease-bound session may only commit claimed action transactions).
  const adminClient = await connectLaneClient(server);
  const adminSession = await mountAs(adminClient, BOB);
  const aliceClient = await connectLaneClient(server);
  const aliceSession = await mountAs(aliceClient, ALICE);
  let unbind = () => {};
  try {
    await seedSpaceWrite(bobSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, bobSession);
    unbind = server.bindExecutionSession(SPACE, bobSession.sessionId, lease);
    await server.openSessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId);
    const claim = await server.setExecutionClaim(
      lease,
      laneClaimKey(sessionKeyOf(ALICE, aliceSession.sessionId)),
    );

    // A valid ACL granting only the sponsor OWNER revokes alice's implicit
    // WRITE mid-run; the awaited ACL response has already reconciled — the
    // session lane whose principal lost WRITE is drained (generation fenced,
    // claims revoked) before any later commit arrives.
    await adminSession.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}`,
        value: { value: { [BOB]: "OWNER" } },
      }],
    });

    assertEquals(
      server.sessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId),
      null,
    );
    const output = sessionAddress("of:session-lane-write-loss-output");
    const before =
      server.executionStats.leaseFenceRejectCauses["claim-not-live"] ?? 0;
    await assertRejects(
      () =>
        bobSession.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: output.id,
            scope: "session",
            value: { value: "must-not-land" },
          }],
          schedulerObservation: observationFor(claim, { writes: [output] }),
        }),
      Error,
      "not live",
    );
    assertEquals(
      server.executionStats.leaseFenceRejectCauses["claim-not-live"],
      before + 1,
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    unbind();
    await aliceClient.close();
    await adminClient.close();
    await bobClient.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// (f) Routing-disjointness over session chains (amendment 3 extended): a
// chain-compatible live claim rejects issuance; lane moves publish
// revoke-before-issue; distinct sessions and principals coexist.
// ---------------------------------------------------------------------------

Deno.test("session claims are routing-disjoint against chain-compatible lanes and coexist across chains", async () => {
  const server = createLaneServer("memory-v2-session-lane-disjointness");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectLaneClient(server);
  const bobSession = await mountAs(bobClient, BOB);
  const aliceClient = await connectLaneClient(server);
  const aliceSession = await mountAs(aliceClient, ALICE);
  const aliceSiblingClient = await connectLaneClient(server);
  const aliceSibling = await mountAs(aliceSiblingClient, ALICE);
  try {
    await seedSpaceWrite(bobSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, bobSession);
    const aliceSessionKey = sessionKeyOf(ALICE, aliceSession.sessionId);
    await server.openSessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId);

    const events: ExecutionControlEvent[] = [];
    let sawSessionClaimSet = () => {};
    const sessionClaimSet = new Promise<void>((resolve) => {
      sawSessionClaimSet = resolve;
    });
    const unsubscribe = aliceSession.subscribeExecutionControl((event) => {
      events.push(event);
      if (
        event.type === "session.execution.claim.set" &&
        event.claim.contextKey === aliceSessionKey
      ) {
        sawSessionClaimSet();
      }
    });

    // A live SPACE claim for the tuple is chain-compatible with any session
    // claim: one client identity would match both. Issuance rejects; the
    // race-tolerant path declines.
    const spaceClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey("space"),
    );
    await assertRejects(
      () => server.setExecutionClaim(lease, laneClaimKey(aliceSessionKey)),
      Error,
      "chain-compatible",
    );
    assertEquals(
      await server.trySetExecutionClaim(lease, laneClaimKey(aliceSessionKey)),
      null,
    );

    // The lane move is revoke-published-before-issue: release the space
    // claim, then the session issuance succeeds, and the feed orders the
    // revoke before the set.
    assert(server.revokeExecutionClaim(spaceClaim));
    const sessionClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey(aliceSessionKey),
    );
    assertEquals(sessionClaim.contextKey, aliceSessionKey);
    await sessionClaimSet;
    const revokeIndex = events.findIndex((event) =>
      event.type === "session.execution.claim.revoke" &&
      event.claim.contextKey === "space"
    );
    const issueIndex = events.findIndex((event) =>
      event.type === "session.execution.claim.set" &&
      event.claim.contextKey === aliceSessionKey
    );
    assert(revokeIndex >= 0, "space revoke event must be published");
    assert(issueIndex >= 0, "session claim.set event must be published");
    assert(
      revokeIndex < issueIndex,
      "lane moves publish the revoke before the new claim",
    );

    // user:alice for the same tuple is chain-compatible with
    // session:alice:s1 — alice's s1 chain would match both.
    await server.openUserLaneGrant(SPACE, "", ALICE);
    await assertRejects(
      () => server.setExecutionClaim(lease, laneClaimKey(userKeyOf(ALICE))),
      Error,
      "chain-compatible",
    );

    // The legitimate fan-out coexists: another principal's session and the
    // same principal's OTHER session match no common client identity.
    await server.openSessionLaneGrant(SPACE, "", BOB, bobSession.sessionId);
    const bobClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey(sessionKeyOf(BOB, bobSession.sessionId)),
    );
    assertEquals(
      bobClaim.contextKey,
      sessionKeyOf(BOB, bobSession.sessionId),
    );
    await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      aliceSibling.sessionId,
    );
    const siblingClaim = await server.setExecutionClaim(
      lease,
      laneClaimKey(sessionKeyOf(ALICE, aliceSibling.sessionId)),
    );
    assertEquals(
      siblingClaim.contextKey,
      sessionKeyOf(ALICE, aliceSibling.sessionId),
    );
    // Renewal's disjointness re-check tolerates the legitimate fan-out.
    assertExists(await server.renewExecutionClaim(lease, sessionClaim));
    unsubscribe();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await aliceSiblingClient.close();
    await bobClient.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Dial-down regression: dropping the ladder below session revokes live
// session claims at their next renewal, mirroring the flag-off revoke.
// ---------------------------------------------------------------------------

Deno.test("lowering the dial below session revokes live session claims at renewal", async () => {
  const server = createLaneServer("memory-v2-session-lane-dial-down");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectLaneClient(server);
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, session);
    await server.openSessionLaneGrant(SPACE, "", ALICE, session.sessionId);
    const claim = await server.setExecutionClaim(
      lease,
      laneClaimKey(sessionKeyOf(ALICE, session.sessionId)),
    );
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    assertEquals(await server.renewExecutionClaim(lease, claim), null);
    assertEquals(server.listExecutionClaims(SPACE), []);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});
