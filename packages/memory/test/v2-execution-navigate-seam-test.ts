// The navigateTo SEAM, host half (navigate-to-server-side.md §2c, owner gate 2;
// gates §5 items 3 and 4).
//
// `navigateTo` splits: the DECISION to navigate derives from pattern state and
// runs server-side, the ACTUATION is a shell view change and stays a client
// rendering effect, and a fourth `ExecutionControlEvent` variant —
// `session.execution.navigate` — is the seam between them. This file pins the
// three properties that make that safe, each of which was hard-won elsewhere and
// is cheap to lose here:
//
//  1. EXACT-SESSION DELIVERY (§5 item 3). The navigation reaches the one session
//     its claim's contextKey names — not a sibling session of the same
//     principal, and not a co-tenant of the same space. No new addressing was
//     built for this: the variant carries a claim, so the existing delivery
//     predicate (`#sessionAcceptsClaim`) narrows it, and `navigateTo`'s
//     session-scoped write confines the claim to session rank.
//
//  2. NO REPLAY (§5 item 4). Claim set/revoke/settlement are idempotent state,
//     which is why the feed retains and replays them on reconnect. A navigation
//     is a one-shot command; a replayed one yanks the user's view on every
//     reconnect. It is dropped at `appendExecutionEvent` rather than filtered at
//     the replay site, so no path — replayed events, reconnect snapshot,
//     settlement frontier — can carry it.
//
//  3. RANK CONTAINMENT AT THE PUBLISH BOUNDARY. The publisher refuses anything
//     but a session-rank claim. This is the second of two independent guards
//     (the first is classification-time, in the runner's
//     `navigate-to-rank-containment.test.ts`) and it exists because of an
//     asymmetry in the delivery predicate itself: its principal comparison sits
//     INSIDE the `contextKey !== "space"` branch, so a space-rank claim delivers
//     to every session in the space regardless of principal. Correct for state
//     reconciliation; for a view change it would drag every co-tenant of a
//     shared space to a piece one of them opened.
//
// Harness copied from v2-execution-session-lane-grant-test.ts (its
// two-sessions-of-one-principal-plus-a-second-principal topology is exactly what
// leg 1 needs) with its own SessionRegistry so retention is directly observable.
import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { SessionRegistry } from "../v2/session-registry.ts";
import * as MemoryV2 from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import type { ExecutionLease, SessionSync } from "../v2.ts";

const SPACE = "did:key:z6Mk-navigate-seam-space";
const ALICE = "did:key:z6Mk-navigate-seam-alice";
const BOB = "did:key:z6Mk-navigate-seam-bob";
const AUDIENCE = "did:key:z6Mk-navigate-seam-audience";
const PIECE = "space:piece:navigate-seam";

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

type NavigateTarget = {
  space: string;
  id: string;
  path: readonly string[];
  scope?: "space" | "user" | "session";
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
  | { type: "session.execution.settlement"; settlement: unknown }
  | {
    type: "session.execution.navigate";
    claim: ActionClaimKey;
    target: NavigateTarget;
  };

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
  contextKey: `session:${string}:${string}`;
  laneGeneration: number;
}>;

type SeamServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ActionClaimKey,
  ): Promise<ExecutionClaim>;
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<{ contextKey: `user:${string}`; laneGeneration: number }>;
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<SessionGrant>;
  publishExecutionNavigate(
    claim: ActionClaimKey & {
      leaseGeneration: number;
      claimGeneration: number;
    },
    target: NavigateTarget,
  ): boolean;
  attachExecutionFeed(
    space: string,
    sessionId: string,
    sync: SessionSync,
    options?: { snapshotFromFeedSeq?: number },
  ): SessionSync;
  readonly executionStats: {
    navigatesPublished: number;
    navigatesDeclined: number;
    navigatesDeclinedCauses: Record<string, number>;
  };
};

const createSeamServer = (
  name: string,
  sessions: SessionRegistry,
): SeamServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      sessions,
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
  ) as SeamServer;

const connectSeamClient = async (
  server: Server,
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
      serverPrimaryExecutionContextLatticeClaimsV1: true,
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

const seedSpaceWrite = async (session: ExecutionSession): Promise<void> => {
  await session.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:navigate-seam-seed",
      value: { value: "seed" },
    }],
  });
};

/** A `navigateTo` action claim: an EFFECT (the builtin's factory returns
 *  `isEffect: true`), keyed on the real server-builtin fingerprint. */
const navigateClaimKey = (
  contextKey: ActionClaimKey["contextKey"],
  actionId = "action:navigate-to",
): ActionClaimKey => ({
  branch: "",
  space: SPACE,
  contextKey,
  pieceId: PIECE,
  actionId,
  actionKind: "effect",
  implementationFingerprint: "impl:cf:builtin/navigateTo:server-v1",
  runtimeFingerprint: "runtime:navigate-seam-v1",
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

const demandAndAcquireLease = async (
  server: SeamServer,
  session: ExecutionSession,
): Promise<ExecutionLeaseHandle> => {
  await session.setExecutionDemand("", [PIECE]);
  const lease = await server.acquireExecutionLease(SPACE, "");
  assertExists(lease);
  return lease;
};

/** The resolved navigation target — the four `NormalizedFullLink` fields the
 *  shell's own `navigateCallback` path already round-trips. */
const TARGET: NavigateTarget = {
  space: SPACE,
  id: "of:navigate-seam-room",
  path: [],
};

const emptySync = (): SessionSync => ({
  type: "sync",
  fromSeq: 0,
  toSeq: 0,
  upserts: [],
  removes: [],
});

// ---------------------------------------------------------------------------
// §5 item 3 — exact-session delivery.
// ---------------------------------------------------------------------------

Deno.test("a navigate reaches only the claim's own session — not a sibling, not another principal", async () => {
  const sessions = new SessionRegistry({ maxExecutionEvents: 16 });
  const server = createSeamServer("memory-v2-navigate-seam-delivery", sessions);
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectSeamClient(server);
  const bobSession = await mountAs(bobClient, BOB);
  const aliceClient = await connectSeamClient(server);
  const aliceSession = await mountAs(aliceClient, ALICE);
  const siblingClient = await connectSeamClient(server);
  const aliceSibling = await mountAs(siblingClient, ALICE);
  try {
    await seedSpaceWrite(bobSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, bobSession);
    // Both of alice's sessions hold a lane and a live claim on the SAME logical
    // action — the legitimate fan-out. If addressing were chain-keyed rather
    // than session-exact, one navigation would move both devices.
    await server.openSessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId);
    await server.openSessionLaneGrant(SPACE, "", ALICE, aliceSibling.sessionId);
    const claim = await server.setExecutionClaim(
      lease,
      navigateClaimKey(sessionKeyOf(ALICE, aliceSession.sessionId)),
    );
    await server.setExecutionClaim(
      lease,
      navigateClaimKey(sessionKeyOf(ALICE, aliceSibling.sessionId)),
    );

    const observed: ExecutionControlEvent[] = [];
    const siblingObserved: ExecutionControlEvent[] = [];
    const bobObserved: ExecutionControlEvent[] = [];
    const unsubscribe = aliceSession.subscribeExecutionControl((event) =>
      observed.push(event)
    );
    const unsubscribeSibling = aliceSibling.subscribeExecutionControl((event) =>
      siblingObserved.push(event)
    );
    const unsubscribeBob = bobSession.subscribeExecutionControl((event) =>
      bobObserved.push(event)
    );

    assertEquals(server.publishExecutionNavigate(claim, TARGET), true);
    assertEquals(server.executionStats.navigatesPublished, 1);
    assertEquals(server.executionStats.navigatesDeclined, 0);

    // The issuing session actuates, and the payload survives the wire intact.
    const navigates = observed.filter((event) =>
      event.type === "session.execution.navigate"
    );
    assertEquals(navigates.length, 1);
    const navigate = navigates[0] as Extract<
      ExecutionControlEvent,
      { type: "session.execution.navigate" }
    >;
    assertEquals(navigate.target, { space: SPACE, id: TARGET.id, path: [] });
    assertEquals(
      navigate.claim.contextKey,
      sessionKeyOf(ALICE, aliceSession.sessionId),
    );
    // ...and the claim rides as ADDRESSING only: the canonical key, with no
    // authority generations that could be mistaken for a claim mutation.
    assert(
      !("leaseGeneration" in navigate.claim),
      "the navigate's claim must be the canonical key, not a claim incarnation",
    );

    // THE CONTAINMENT. A sibling session of the SAME principal — holding its own
    // live claim on the same logical action — observes nothing. Pre-C2.6 this
    // predicate over-broadcast to siblings; if that regressed, a navigation
    // would move every device the user has open.
    assertEquals(
      siblingObserved.filter((event) =>
        event.type === "session.execution.navigate"
      ),
      [],
    );
    // And a DIFFERENT principal in the same space observes nothing — the outcome
    // that would be unacceptable under any framing.
    assertEquals(
      bobObserved.filter((event) =>
        event.type === "session.execution.navigate"
      ),
      [],
    );

    unsubscribe();
    unsubscribeSibling();
    unsubscribeBob();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await siblingClient.close();
    await bobClient.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// §5 item 4 — no replay.
// ---------------------------------------------------------------------------

Deno.test("a navigate is never retained, so no reconnect can redeliver it", async () => {
  const sessions = new SessionRegistry({ maxExecutionEvents: 16 });
  const server = createSeamServer("memory-v2-navigate-seam-replay", sessions);
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectSeamClient(server);
  const bobSession = await mountAs(bobClient, BOB);
  const aliceClient = await connectSeamClient(server);
  const aliceSession = await mountAs(aliceClient, ALICE);
  try {
    await seedSpaceWrite(bobSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, bobSession);
    await server.openSessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId);
    const claim = await server.setExecutionClaim(
      lease,
      navigateClaimKey(sessionKeyOf(ALICE, aliceSession.sessionId)),
    );

    const state = sessions.get(SPACE, aliceSession.sessionId);
    assertExists(state);
    // POSITIVE LEG, and it is load-bearing: the claim.set for this very action
    // IS retained. Without it a "no navigate in the replay" assertion would pass
    // on a session that retains nothing at all, and the test would be vacuous.
    const retainedBefore = state.executionEvents.map((entry) =>
      entry.event.type
    );
    assert(
      retainedBefore.includes("session.execution.claim.set"),
      `instrument blind: nothing retained to replay; saw ${
        JSON.stringify(retainedBefore)
      }`,
    );
    const cursorBefore = state.executionFeedSeq;

    assertEquals(server.publishExecutionNavigate(claim, TARGET), true);

    // (a) It never entered retention.
    assertEquals(
      state.executionEvents.filter((entry) =>
        entry.event.type === "session.execution.navigate"
      ),
      [],
    );
    // (b) But it DID take its ordinal in the feed. The sequence must advance or
    //     the next batch's `fromFeedSeq === #executionFeedSeq` contiguity check
    //     on the client would reject the batch after it and demand a snapshot.
    assertEquals(state.executionFeedSeq, cursorBefore + 1);

    // (c) A reconnect from BEFORE the navigate replays the retained claim events
    //     and no navigate — neither as an event nor inside the snapshot.
    const resumed = server.attachExecutionFeed(
      SPACE,
      aliceSession.sessionId,
      emptySync(),
      { snapshotFromFeedSeq: 0 },
    );
    const batch = resumed.execution;
    assertExists(batch);
    assertEquals(
      batch.events.filter((event) =>
        event.type === "session.execution.navigate"
      ),
      [],
    );
    assert(
      batch.events.some((event) =>
        event.type === "session.execution.claim.set"
      ),
      "the reconnect must still replay the retained claim events",
    );
    assertExists(batch.snapshot);
    // The claim itself is still live and still in the snapshot: suppressing the
    // navigate must not suppress the authority state that rides beside it.
    assertEquals(batch.snapshot.claims.length, 1);
    assertEquals(
      batch.snapshot.claims[0].contextKey,
      sessionKeyOf(ALICE, aliceSession.sessionId),
    );
    // (d) And no settlement frontier was minted for it — the coalescer is
    //     unreachable for this variant by type, and this is the runtime witness.
    assertEquals(state.executionSettlementFrontiers.size, 0);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Rank containment at the publish boundary, and staleness.
// ---------------------------------------------------------------------------

Deno.test("the publisher refuses any claim that is not session rank, or not live", async () => {
  const sessions = new SessionRegistry({ maxExecutionEvents: 16 });
  const server = createSeamServer("memory-v2-navigate-seam-rank", sessions);
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectSeamClient(server);
  const bobSession = await mountAs(bobClient, BOB);
  const aliceClient = await connectSeamClient(server);
  const aliceSession = await mountAs(aliceClient, ALICE);
  try {
    await seedSpaceWrite(bobSession);
    const lease = await demandAndAcquireLease(server, bobSession);

    // SPACE rank: a live claim, and still refused. This is the shape whose
    // delivery has no principal filter, so publishing it would move every
    // co-tenant of the space.
    rankDial.setServerPrimaryExecutionClaimRankConfig("space");
    const spaceClaim = await server.setExecutionClaim(
      lease,
      navigateClaimKey("space", "action:navigate-space-rank"),
    );
    assertEquals(server.publishExecutionNavigate(spaceClaim, TARGET), false);

    // USER rank: also live, also refused. Milder — one principal's devices — but
    // still not the issuing session, and §8b's demand plumbing means the tighter
    // scope costs nothing.
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    await server.openUserLaneGrant(SPACE, "", ALICE);
    const userClaim = await server.setExecutionClaim(
      lease,
      navigateClaimKey(
        Engine.userExecutionContextKey(ALICE),
        "action:navigate-user-rank",
      ),
    );
    assertEquals(server.publishExecutionNavigate(userClaim, TARGET), false);

    assertEquals(server.executionStats.navigatesPublished, 0);
    assertEquals(server.executionStats.navigatesDeclined, 2);
    assertEquals(server.executionStats.navigatesDeclinedCauses, {
      "non-session-rank": 2,
    });

    // A REVOKED session claim navigates nobody. The actuation belongs to the run
    // that earned that exact authority incarnation; once it is gone, a late
    // in-flight navigation must land nowhere rather than on a session whose
    // claim was taken away.
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    await server.openSessionLaneGrant(SPACE, "", ALICE, aliceSession.sessionId);
    const sessionClaim = await server.setExecutionClaim(
      lease,
      navigateClaimKey(sessionKeyOf(ALICE, aliceSession.sessionId)),
    );
    assertEquals(server.publishExecutionNavigate(sessionClaim, TARGET), true);
    assertEquals(server.revokeExecutionClaim(sessionClaim), true);
    assertEquals(server.publishExecutionNavigate(sessionClaim, TARGET), false);
    assertEquals(server.executionStats.navigatesPublished, 1);
    assertEquals(
      server.executionStats.navigatesDeclinedCauses["no-live-claim"],
      1,
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});
