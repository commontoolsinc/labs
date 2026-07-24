// C2.6 (context-lattice §2, amendment CA4): session-context claims, revokes,
// and settlements are delivered ONLY to the session their contextKey names —
// never to a sibling session of the same principal, never to a foreign
// principal. This is load-bearing, not fan-out hygiene: a sibling session B
// stores every delivered claim (runner storage/v2.ts applyExecutionControlEvent
// → #executionClaims.set), and because the registered-action index is
// CHAIN-keyed (actionClaimChainMapKey strips contextKey), the sibling claim's
// later revoke/generation-replace fires `execution-claim-invalidation` on B's
// OWN registration of the same logical action with no own-claim-liveness
// guard (invalidateRegisteredExecutionActions → facade prepareClaimedRerun +
// invalidateActionForHostWake) — a spurious fail-open re-run on EVERY sibling
// claim churn, quadratic in a principal's concurrent sessions. Discrimination
// (verified red-first against the pre-C2.6 principal-wide predicate): with
// #sessionAcceptsClaim matching on principal alone, the "zero sibling
// delivery" and "zero sibling bookkeeping" assertions below fail — session B
// receives the session:alice:A claim.set/revoke/settlement and retains the
// events and the settlement frontier in its own feed accounting.
//
// The narrowing lives in the single C1.7 delivery predicate
// (#sessionAcceptsClaim), so publish, reconnect snapshots, retained events,
// and settlement frontiers all narrow together. User- and space-context
// delivery are byte-identical to C1.7 (regression legs below and the
// untouched v2-execution-context-delivery-test.ts fixtures).
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import * as MemoryV2 from "../v2.ts";
import {
  encodeMemoryBoundary,
  type ExecutionLease,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  toInputBasisSeq,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-session-delivery-space";
// Colon-bearing DIDs exercise the canonical percent-encoded context keys
// end-to-end (amendment 18 / CA12).
const ALICE = "did:key:z6Mk-session-delivery-alice";
const BOB = "did:key:z6Mk-session-delivery-bob";
const AUDIENCE = "did:key:z6Mk-session-delivery-audience";

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
  | {
    type: "session.execution.settlement";
    settlement: { claim: ExecutionClaim; outcome: string };
  };

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
  subscribeExecutionControl(
    listener: (event: ExecutionControlEvent) => void,
  ): () => void;
};

type SessionGrant = Readonly<{
  space: string;
  branch: string;
  contextKey: `session:${string}:${string}`;
  principal: string;
  sessionId: string;
  laneGeneration: number;
  anchorSessionId: string;
}>;

type UserGrant = Readonly<{
  contextKey: `user:${string}`;
  principal: string;
  laneGeneration: number;
}>;

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

type DeliveryServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ActionClaimKey,
  ): Promise<ExecutionClaim>;
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  listExecutionClaims(space: string): readonly ExecutionClaim[];
  publishActionSettlement(settlement: unknown): boolean;
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
};

const flagsWithoutContextLattice = {
  ...getMemoryProtocolFlags(),
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
};

const flagsWithContextLattice = {
  ...flagsWithoutContextLattice,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
};

const rankDial = MemoryV2 as unknown as {
  setServerPrimaryExecutionClaimRankConfig(
    rank?: "space" | "user" | "session",
  ): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

const userKeyOf = (principal: string): `user:${string}` =>
  Engine.userExecutionContextKey(principal);

const sessionKeyOf = (
  principal: string,
  sessionId: string,
): `session:${string}:${string}` =>
  Engine.sessionExecutionContextKey(principal, sessionId);

/** Multi-principal session-open with an INJECTED SessionRegistry, so the
 * fixtures can assert per-session retained-event and settlement-frontier
 * bookkeeping directly — "session B received nothing" must mean nothing in
 * B's feed accounting either, not merely no live push. */
const createDeliveryServer = (
  name: string,
  sessions: SessionRegistry,
): DeliveryServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      protocolFlags: flagsWithContextLattice,
      acl: { mode: "off", serviceDids: [] },
      sessions,
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as DeliveryServer;

const connectDeliveryClient = async (
  server: Server,
  options: { contextLatticeClaims: boolean } = { contextLatticeClaims: true },
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: options.contextLatticeClaims
      ? flagsWithContextLattice
      : flagsWithoutContextLattice,
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
 * flips the pre-launch compatibility capability to WRITE, which the lane
 * grant WRITE requirement (amendment 2) needs. */
const seedSpaceWrite = async (session: ExecutionSession): Promise<void> => {
  await session.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:session-delivery-seed",
      value: { value: "seed" },
    }],
  });
};

const claimKeyFor = (
  contextKey: ActionClaimKey["contextKey"],
  actionId = "action:session-derive",
): ActionClaimKey => ({
  branch: "",
  space: SPACE,
  contextKey,
  pieceId: "space:piece:session-delivery",
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:session-delivery-v1",
  runtimeFingerprint: "runtime:session-delivery-v1",
});

const demandAndAcquireLease = async (
  server: DeliveryServer,
  session: ExecutionSession,
): Promise<ExecutionLeaseHandle> => {
  await session.setExecutionDemand("", ["space:piece:session-delivery"]);
  const lease = await server.acquireExecutionLease(SPACE, "");
  assertExists(lease);
  return lease;
};

const recordControl = (
  session: ExecutionSession,
): { events: ExecutionControlEvent[]; unsubscribe: () => void } => {
  const events: ExecutionControlEvent[] = [];
  const unsubscribe = session.subscribeExecutionControl((event) =>
    events.push(event)
  );
  return { events, unsubscribe };
};

const feedStateOf = (
  sessions: SessionRegistry,
  sessionId: string,
): {
  eventContextKeys: string[];
  frontierContextKeys: string[];
} => {
  const state = sessions.get(SPACE, sessionId);
  assertExists(state);
  return {
    eventContextKeys: state.executionEvents.map((entry) =>
      entry.event.type === "session.execution.settlement"
        ? entry.event.settlement.claim.contextKey
        : entry.event.claim.contextKey
    ),
    frontierContextKeys: [...state.executionSettlementFrontiers.values()].map((
      frontier,
    ) => frontier.claim.contextKey),
  };
};

// --- Raw protocol harness (for reconnect snapshots and the takeover
// downgrade; mirrors v2-execution-context-delivery-test.ts). ---

type RawConnection = {
  connection: ReturnType<Server["connect"]>;
  messages: ServerMessage[];
  auth: SessionOpenAuthMetadata;
  close(): void;
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const rawConnect = async (
  server: Server,
  flags: Record<string, boolean>,
): Promise<RawConnection> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary({
    type: "hello",
    protocol: MEMORY_PROTOCOL,
    flags,
  }));
  const message = shiftMessage(messages);
  assertEquals(message.type, "hello.ok");
  const response = message as HelloOkMessage;
  assertExists(response.sessionOpen);
  return {
    connection,
    messages,
    auth: response.sessionOpen,
    close: () => connection.close(),
  };
};

const rawOpen = async (
  raw: RawConnection,
  requestId: string,
  principal: string,
  session: SessionDescriptor = {},
): Promise<ResponseMessage<SessionOpenResult>> => {
  await raw.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId,
    space: SPACE,
    session,
    invocation: {
      aud: raw.auth.audience,
      challenge: raw.auth.challenge.value,
    },
    authorization: { principal },
  }));
  const message = shiftMessage(raw.messages) as ResponseMessage<
    SessionOpenResult
  >;
  assertEquals(message.type, "response");
  if (message.ok?.sessionOpen !== undefined) {
    raw.auth = message.ok.sessionOpen;
  }
  return message;
};

/** Takeover-resume from a FRESH connection (the prior connection stays open,
 * so the session lane's anchor is not drained before the open response builds
 * the snapshot we assert on). */
const takeoverResume = async (
  server: Server,
  opened: ResponseMessage<SessionOpenResult>,
  flags: Record<string, boolean>,
  requestId: string,
  principal: string,
): Promise<ResponseMessage<SessionOpenResult>> => {
  assertExists(opened.ok);
  const raw = await rawConnect(server, flags);
  const resumed = await rawOpen(raw, requestId, principal, {
    sessionId: opened.ok.sessionId,
    sessionToken: opened.ok.sessionToken,
    seenSeq: opened.ok.serverSeq,
    executionFeedSeq: opened.ok.sync?.execution?.toFeedSeq ?? 0,
  });
  raw.close();
  return resumed;
};

// (a)+(c) The CA4 acceptance: with alice's sessions A and B BOTH negotiating
// claims-v1, a session:alice:A claim, its settlement, and its revoke reach
// session A alone — session B and bob observe ZERO delivery and carry ZERO
// feed bookkeeping (no retained events, no settlement frontier). Space
// delivery is unchanged (regression leg d).
Deno.test("session-context claims, settlements, and revokes reach only the named session", async () => {
  const sessions = new SessionRegistry();
  const server = createDeliveryServer(
    "memory-v2-session-delivery-publish",
    sessions,
  );
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const aliceAClient = await connectDeliveryClient(server);
  const aliceBClient = await connectDeliveryClient(server);
  const bobClient = await connectDeliveryClient(server);
  const aliceA = await mountAs(aliceAClient, ALICE);
  const aliceB = await mountAs(aliceBClient, ALICE);
  const bob = await mountAs(bobClient, BOB);
  try {
    await seedSpaceWrite(aliceA);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, aliceA);
    await server.openSessionLaneGrant(SPACE, "", ALICE, aliceA.sessionId);
    const controlA = recordControl(aliceA);
    const controlB = recordControl(aliceB);
    const controlBob = recordControl(bob);

    const sessionClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor(sessionKeyOf(ALICE, aliceA.sessionId)),
    );
    assertEquals(
      sessionClaim.contextKey,
      sessionKeyOf(ALICE, aliceA.sessionId),
    );
    assertEquals(
      controlA.events.map((event) => event.type),
      ["session.execution.claim.set"],
    );
    assertEquals(
      (controlA.events[0] as { claim: ExecutionClaim }).claim,
      sessionClaim,
    );
    // The sibling and the foreign principal received NOTHING.
    assertEquals(controlB.events, []);
    assertEquals(controlBob.events, []);

    // A successful settlement follows the same narrowing, in delivery AND in
    // the per-session frontier accounting a reconnect would replay.
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim: sessionClaim,
        inputBasisSeq: toInputBasisSeq(7),
        outcome: "no-op",
      }),
      true,
    );
    assertEquals(
      controlA.events.map((event) => event.type),
      ["session.execution.claim.set", "session.execution.settlement"],
    );
    assertEquals(controlB.events, []);
    assertEquals(controlBob.events, []);
    // ZERO sibling bookkeeping: nothing retained, nothing in the frontier
    // map, so nothing for B's reconnect path to replay or reconcile. (The
    // POSITIVE side — session A's own retained events and frontier — is
    // pinned protocol-level by the snapshot fixture below, on ack-free raw
    // sessions; a mounted loopback client acks its feed on a timer, so
    // registry-state assertions are deterministic only for the empty case.)
    assertEquals(feedStateOf(sessions, aliceB.sessionId), {
      eventContextKeys: [],
      frontierContextKeys: [],
    });
    assertEquals(feedStateOf(sessions, bob.sessionId), {
      eventContextKeys: [],
      frontierContextKeys: [],
    });

    // The revoke — the exact event whose sibling delivery drives the CA4
    // chain-keyed spurious rerun — reaches only session A.
    assertEquals(server.revokeExecutionClaim(sessionClaim), true);
    assertEquals(
      controlA.events.map((event) => event.type),
      [
        "session.execution.claim.set",
        "session.execution.settlement",
        "session.execution.claim.revoke",
      ],
    );
    assertEquals(controlB.events, []);
    assertEquals(controlBob.events, []);
    assertEquals(feedStateOf(sessions, aliceB.sessionId), {
      eventContextKeys: [],
      frontierContextKeys: [],
    });

    // Space-claim regression: full-cohort delivery is byte-identical.
    const spaceClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor("space", "action:space-derive"),
    );
    for (const control of [controlA, controlB, controlBob]) {
      const last = control.events.at(-1);
      assertExists(last);
      assertEquals(last.type, "session.execution.claim.set");
      assertEquals((last as { claim: ExecutionClaim }).claim, spaceClaim);
    }
    assertEquals(controlB.events.length, 1);
    assertEquals(controlBob.events.length, 1);

    controlA.unsubscribe();
    controlB.unsubscribe();
    controlBob.unsubscribe();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceAClient.close();
    await aliceBClient.close();
    await bobClient.close();
    await server.close();
  }
});

// (b) Reconnect snapshots go through the same predicate: a session's snapshot
// is "the space lane + its user lane's claims + ITS OWN session lane's" —
// never a sibling's (context-lattice §2). Session B's snapshot carries no
// session:alice:A claim and no session:alice:A settlement frontier; session
// A's carries its own. Resumes are takeovers from fresh connections: the
// prior connections stay open, so no disconnect drain races the assertion.
Deno.test("reconnect snapshots shrink to the session's own lanes plus the space lane", async () => {
  const sessions = new SessionRegistry();
  const server = createDeliveryServer(
    "memory-v2-session-delivery-snapshot",
    sessions,
  );
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const executorClient = await connectDeliveryClient(server);
  const executorSession = await mountAs(executorClient, ALICE);
  const rawA = await rawConnect(server, flagsWithContextLattice);
  const rawB = await rawConnect(server, flagsWithContextLattice);
  try {
    await seedSpaceWrite(executorSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, executorSession);

    const openedA = await rawOpen(rawA, "open-a", ALICE);
    assertExists(openedA.ok?.sync?.execution);
    const openedB = await rawOpen(rawB, "open-b", ALICE);
    assertExists(openedB.ok?.sync?.execution);

    // One claim per rank: session A's own lane, alice's user lane (all alice
    // sessions negotiate, so the C1.7 cohort gate admits it at the session
    // dial stage — the ladder), and the space lane. Distinct actionIds keep
    // the three claims routing-disjoint.
    await server.openSessionLaneGrant(SPACE, "", ALICE, openedA.ok.sessionId);
    const sessionClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor(sessionKeyOf(ALICE, openedA.ok.sessionId)),
    );
    await server.openUserLaneGrant(SPACE, "", ALICE);
    const userClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor(userKeyOf(ALICE), "action:user-derive"),
    );
    const spaceClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor("space", "action:space-derive"),
    );
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim: sessionClaim,
        inputBasisSeq: toInputBasisSeq(7),
        outcome: "no-op",
      }),
      true,
    );

    const byActionId = (left: ExecutionClaim, right: ExecutionClaim) =>
      left.actionId.localeCompare(right.actionId);
    const snapshotOf = (resumed: ResponseMessage<SessionOpenResult>) => {
      assertExists(resumed.ok?.sync?.execution?.snapshot);
      return resumed.ok.sync.execution.snapshot as {
        claims: ExecutionClaim[];
        settlementFrontiers?: { claim: ExecutionClaim }[];
      };
    };

    // Sibling session B: the space and user lanes, NOT session A's lane —
    // neither the claim nor its settlement frontier.
    const resumedB = await takeoverResume(
      server,
      openedB,
      flagsWithContextLattice,
      "resume-b",
      ALICE,
    );
    const snapshotB = snapshotOf(resumedB);
    assertEquals(
      snapshotB.claims.toSorted(byActionId),
      [userClaim, spaceClaim].toSorted(byActionId),
    );
    assertEquals(snapshotB.settlementFrontiers, undefined);
    // And B's retained-event suffix carried no session-context event either.
    assertEquals(
      (resumedB.ok?.sync?.execution?.events ?? []).filter((event) =>
        (event.type === "session.execution.settlement"
          ? event.settlement.claim.contextKey
          : event.claim.contextKey) === sessionClaim.contextKey
      ),
      [],
    );

    // Session A: its OWN session lane rides along, frontier included.
    const resumedA = await takeoverResume(
      server,
      openedA,
      flagsWithContextLattice,
      "resume-a",
      ALICE,
    );
    const snapshotA = snapshotOf(resumedA);
    assertEquals(
      snapshotA.claims.toSorted(byActionId),
      [sessionClaim, userClaim, spaceClaim].toSorted(byActionId),
    );
    assertEquals(
      snapshotA.settlementFrontiers?.map((frontier) =>
        frontier.claim.contextKey
      ),
      [sessionKeyOf(ALICE, openedA.ok.sessionId)],
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    rawA.close();
    rawB.close();
    await executorClient.close();
    await server.close();
  }
});

// (e) The per-session negotiation gate, and why it suffices without a
// principal-wide cohort fence (the mixed-version reasoning, CA4/C1.7):
//
// The C1.7 cohort gate exists because a user:alice claim SUPPRESSES every
// negotiating alice session while a non-negotiating alice session — which
// never receives the claim — would keep executing the same user-scoped
// action client-side: double execution of one logical state. At session rank
// that race needs a NON-negotiating attach of the SAME session id concurrent
// with a live session:alice:A lane. It cannot exist: (1) a sibling session
// (any version) never matches session:alice:A under the client's own-chain
// acceptance, so its local execution of its OWN session context is correct,
// not duplicated — no cross-session fence is needed; (2) a session id has
// exactly one live SessionState per space, its negotiation flag is
// recomputed on EVERY attach, and the amendment-11 admission fence
// (#fenceLanesForNonNegotiatingAttach, extended over session lanes by C2.3)
// synchronously drains the attaching session's OWN lane — generation bump +
// claim sweep — before a non-negotiating open/resume/takeover response
// releases. So the fence already sits in openSession admission, exactly
// where C1.7's cohort fence lives; delivery only needs the per-session
// negotiation check.
Deno.test("a takeover downgrade fences the session's own lane and leaks no session-context event", async () => {
  const sessions = new SessionRegistry();
  const server = createDeliveryServer(
    "memory-v2-session-delivery-downgrade",
    sessions,
  );
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const executorClient = await connectDeliveryClient(server);
  const executorSession = await mountAs(executorClient, ALICE);
  const rawC = await rawConnect(server, flagsWithContextLattice);
  try {
    await seedSpaceWrite(executorSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("session");
    const lease = await demandAndAcquireLease(server, executorSession);

    const openedC = await rawOpen(rawC, "open-c", ALICE);
    assertExists(openedC.ok?.sync?.execution);
    const grant = await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      openedC.ok.sessionId,
    );
    const sessionClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor(sessionKeyOf(ALICE, openedC.ok.sessionId)),
    );
    // The negotiating attach retained its own claim.set, as C2.6 delivers.
    assertEquals(feedStateOf(sessions, openedC.ok.sessionId), {
      eventContextKeys: [sessionClaim.contextKey],
      frontierContextKeys: [],
    });

    // The SAME session resumes from a connection WITHOUT claims-v1: the
    // admission fence drains its lane before the response, and the response
    // itself — events and snapshot both — carries no session-context state:
    // a session that did not negotiate claims-v1 on its CURRENT attach gets
    // no session claims even for its own session id. The downgraded
    // connection STAYS OPEN, so the re-open rejection below exercises the
    // negotiation gate, not connection liveness.
    const downgradedRaw = await rawConnect(server, flagsWithoutContextLattice);
    const downgraded = await rawOpen(downgradedRaw, "resume-downgraded", ALICE, {
      sessionId: openedC.ok.sessionId,
      sessionToken: openedC.ok.sessionToken,
      seenSeq: openedC.ok.serverSeq,
      executionFeedSeq: openedC.ok.sync?.execution?.toFeedSeq ?? 0,
    });
    assertExists(downgraded.ok?.sync?.execution);
    assertEquals(
      server.sessionLaneGrant(SPACE, "", ALICE, openedC.ok.sessionId),
      null,
    );
    assertEquals(
      server.listExecutionClaims(SPACE).map((claim) => claim.contextKey),
      [],
    );
    assertEquals(await server.renewSessionLaneGrant(grant), null);
    assertEquals(downgraded.ok.sync.execution.events, []);
    assertEquals(downgraded.ok.sync.execution.snapshot?.claims, []);
    // The fenced lane cannot re-open onto the non-negotiating attach.
    await assertRejects(
      () =>
        server.openSessionLaneGrant(SPACE, "", ALICE, openedC.ok!.sessionId),
      Error,
      "negotiate",
    );
    downgradedRaw.close();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    rawC.close();
    await executorClient.close();
    await server.close();
  }
});
