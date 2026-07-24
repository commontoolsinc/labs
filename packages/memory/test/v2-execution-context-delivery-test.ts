import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
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

// C1.7 context-scoped delivery: user-context claims reach only the claim
// principal's sessions that negotiated context-lattice-claims-v1; every
// space claim keeps today's delivery exactly. The cohort gate (amendment 11)
// fences a principal's user lane when any session of that principal attaches
// without the subcapability — before the open response releases.

const SPACE = "did:key:z6Mk-context-delivery-space";
// Colon-bearing DIDs exercise the canonical percent-encoded context keys
// end-to-end (amendment 18).
const ALICE = "did:key:z6Mk-context-delivery-alice";
const BOB = "did:key:z6Mk-context-delivery-bob";
const AUDIENCE = "did:key:z6Mk-context-delivery-audience";

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
  executionClaims: readonly ExecutionClaim[];
};

type LaneGrant = Readonly<{
  space: string;
  branch: string;
  contextKey: `user:${string}`;
  principal: string;
  laneGeneration: number;
  anchorSessionId: string;
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
  renewExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: ExecutionClaim,
  ): Promise<ExecutionClaim | null>;
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  listExecutionClaims(space: string): readonly ExecutionClaim[];
  publishActionSettlement(settlement: unknown): boolean;
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<LaneGrant>;
  renewUserLaneGrant(grant: LaneGrant): Promise<LaneGrant | null>;
  userLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): LaneGrant | null;
  sessionsForPrincipal(space: string, principal: string): readonly {
    id: string;
    principal?: string;
    ownerConnectionId: string | null;
  }[];
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
  setServerPrimaryExecutionClaimRankConfig(rank?: "space" | "user"): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

const userKeyOf = (principal: string): `user:${string}` =>
  Engine.userExecutionContextKey(principal);

/** Multi-principal session-open: the principal rides the authorization
 * payload, so one server hosts alice and bob sessions side by side. */
const createDeliveryServer = (
  name: string,
  options: { sessions?: SessionRegistry } = {},
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
      ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as DeliveryServer;

const connectDeliveryClient = async (
  server: Server,
  options: { contextLatticeClaims: boolean },
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
      id: "of:context-delivery-seed",
      value: { value: "seed" },
    }],
  });
};

const claimKeyFor = (
  contextKey: ActionClaimKey["contextKey"],
  actionId = "action:context-derive",
): ActionClaimKey => ({
  branch: "",
  space: SPACE,
  contextKey,
  pieceId: "space:piece:context",
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:context-v1",
  runtimeFingerprint: "runtime:context-v1",
});

const demandAndAcquireLease = async (
  server: DeliveryServer,
  session: ExecutionSession,
): Promise<ExecutionLeaseHandle> => {
  await session.setExecutionDemand("", ["space:piece:context"]);
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

// --- Raw protocol harness (amendment 11: the racing client sends no watch
// or demand messages; the session.open response is the only barrier). ---

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

const rawTransact = async (
  raw: RawConnection,
  requestId: string,
  sessionId: string,
): Promise<ResponseMessage<unknown>> => {
  await raw.connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId,
    space: SPACE,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:context-delivery-raw-write",
        value: { value: "raw-client" },
      }],
    },
  }));
  const message = shiftMessage(raw.messages) as ResponseMessage<unknown>;
  assertEquals(message.type, "response");
  return message;
};

// (a) Context-scoped publish: a user:alice claim (and its revoke) reaches
// only alice's negotiating sessions — never bob's, never a non-negotiating
// alice session. The cohort gate makes "live user claim beside an attached
// non-negotiating alice session" unreachable, so the non-negotiating leg
// pins what such a session observes across its own fencing attach.
Deno.test("user-context claims are delivered only to the principal's negotiating sessions", async () => {
  const server = createDeliveryServer("memory-v2-context-delivery-publish");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const aliceLatticeClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const alicePlainClient = await connectDeliveryClient(server, {
    contextLatticeClaims: false,
  });
  const bobLatticeClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const aliceLattice = await mountAs(aliceLatticeClient, ALICE);
  const bobLattice = await mountAs(bobLatticeClient, BOB);
  try {
    await seedSpaceWrite(aliceLattice);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    const lease = await demandAndAcquireLease(server, aliceLattice);
    const aliceLatticeControl = recordControl(aliceLattice);
    const bobLatticeControl = recordControl(bobLattice);

    // Set and explicitly revoke: both directions are principal-scoped.
    await server.openUserLaneGrant(SPACE, "", ALICE);
    const firstUserClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor(userKeyOf(ALICE)),
    );
    assertEquals(firstUserClaim.contextKey, userKeyOf(ALICE));
    assertEquals(
      aliceLatticeControl.events.map((event) => event.type),
      ["session.execution.claim.set"],
    );
    assertEquals(
      (aliceLatticeControl.events[0] as { claim: ExecutionClaim }).claim,
      firstUserClaim,
    );
    assertEquals(bobLatticeControl.events, []);
    assertEquals(server.revokeExecutionClaim(firstUserClaim), true);
    assertEquals(
      aliceLatticeControl.events.map((event) => event.type),
      ["session.execution.claim.set", "session.execution.claim.revoke"],
    );
    assertEquals(bobLatticeControl.events, []);

    // A live user claim again, then the non-negotiating alice session
    // attaches: its fence revokes the claim, and that revoke too reaches
    // only alice's negotiating session.
    await server.openUserLaneGrant(SPACE, "", ALICE);
    await server.setExecutionClaim(lease, claimKeyFor(userKeyOf(ALICE)));
    const alicePlain = await mountAs(alicePlainClient, ALICE);
    const alicePlainControl = recordControl(alicePlain);
    assertEquals(
      aliceLatticeControl.events.map((event) => event.type),
      [
        "session.execution.claim.set",
        "session.execution.claim.revoke",
        "session.execution.claim.set",
        "session.execution.claim.revoke",
      ],
    );
    assertEquals(bobLatticeControl.events, []);

    // Space claims keep full-cohort delivery (regression, item e).
    const spaceClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor("space", "action:space-derive"),
    );
    for (
      const control of [
        aliceLatticeControl,
        alicePlainControl,
        bobLatticeControl,
      ]
    ) {
      const last = control.events.at(-1);
      assertExists(last);
      assertEquals(last.type, "session.execution.claim.set");
      assertEquals(
        (last as { claim: ExecutionClaim }).claim,
        spaceClaim,
      );
    }
    // The space claim is the ONLY event the non-negotiating alice session
    // and bob's session ever observed.
    assertEquals(alicePlainControl.events.length, 1);
    assertEquals(bobLatticeControl.events.length, 1);

    aliceLatticeControl.unsubscribe();
    alicePlainControl.unsubscribe();
    bobLatticeControl.unsubscribe();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceLatticeClient.close();
    await alicePlainClient.close();
    await bobLatticeClient.close();
    await server.close();
  }
});

// (b) Reconnect snapshots go through the same predicate: bob's snapshot has
// none of alice's user-context claims or settlement frontiers; a
// non-negotiating alice session gets none either; alice's negotiating
// session gets both.
Deno.test("reconnect snapshots exclude foreign and non-negotiated user-context claims and frontiers", async () => {
  const server = createDeliveryServer("memory-v2-context-delivery-snapshot");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const aliceClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const aliceSession = await mountAs(aliceClient, ALICE);
  try {
    await seedSpaceWrite(aliceSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    const lease = await demandAndAcquireLease(server, aliceSession);
    await server.openUserLaneGrant(SPACE, "", ALICE);

    // Two raw sessions open BEFORE the claims exist and detach, then resume
    // after, so each resume carries a snapshot (executionFeedSeq pins the
    // suffix). The non-negotiating alice session must open LAST: any attach
    // of it fences the lane (cohort gate), and while detached it blocks the
    // lane from opening at all (conservative TTL semantics).
    const aliceLatticeRaw = await rawConnect(server, flagsWithContextLattice);
    const aliceLatticeOpen = await rawOpen(aliceLatticeRaw, "open-al", ALICE);
    assertExists(aliceLatticeOpen.ok?.sync?.execution);
    const bobLatticeRaw = await rawConnect(server, flagsWithContextLattice);
    const bobLatticeOpen = await rawOpen(bobLatticeRaw, "open-bl", BOB);
    assertExists(bobLatticeOpen.ok?.sync?.execution);
    aliceLatticeRaw.close();
    bobLatticeRaw.close();

    const userClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor(userKeyOf(ALICE)),
    );
    const spaceClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor("space", "action:space-derive"),
    );
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim: userClaim,
        inputBasisSeq: toInputBasisSeq(7),
        outcome: "no-op",
      }),
      true,
    );

    const resume = async (
      opened: ResponseMessage<SessionOpenResult>,
      flags: Record<string, boolean>,
      requestId: string,
      principal: string,
    ) => {
      assertExists(opened.ok);
      const raw = await rawConnect(server, flags);
      const resumed = await rawOpen(raw, requestId, principal, {
        sessionId: opened.ok.sessionId,
        sessionToken: opened.ok.sessionToken,
        seenSeq: opened.ok.serverSeq,
        executionFeedSeq: opened.ok.sync?.execution?.toFeedSeq ?? 0,
      });
      raw.close();
      assertExists(resumed.ok?.sync?.execution?.snapshot);
      return resumed.ok.sync.execution.snapshot as {
        claims: ExecutionClaim[];
        settlementFrontiers?: { claim: ExecutionClaim }[];
      };
    };
    const byActionId = (left: ExecutionClaim, right: ExecutionClaim) =>
      left.actionId.localeCompare(right.actionId);

    const aliceSnapshot = await resume(
      aliceLatticeOpen,
      flagsWithContextLattice,
      "resume-al",
      ALICE,
    );
    assertEquals(
      aliceSnapshot.claims.toSorted(byActionId),
      [userClaim, spaceClaim].toSorted(byActionId),
    );
    assertEquals(
      aliceSnapshot.settlementFrontiers?.map((frontier) =>
        frontier.claim.contextKey
      ),
      [userKeyOf(ALICE)],
    );

    // Foreign principal, negotiating: alice's live user claim and frontier
    // are absent while the space claim is present.
    const bobSnapshot = await resume(
      bobLatticeOpen,
      flagsWithContextLattice,
      "resume-bl",
      BOB,
    );
    assertEquals(bobSnapshot.claims, [spaceClaim]);
    assertEquals(bobSnapshot.settlementFrontiers, undefined);

    // Same principal, non-negotiating, FIRST attach: admission fences the
    // lane (revoking the user claim) before this very response's snapshot is
    // built, and the snapshot filter hides user-context state either way —
    // the response carries the space claim only and no leaked revoke event.
    const alicePlainRaw = await rawConnect(server, flagsWithoutContextLattice);
    const alicePlainOpen = await rawOpen(alicePlainRaw, "open-ap", ALICE);
    alicePlainRaw.close();
    assertExists(alicePlainOpen.ok?.sync?.execution);
    assertEquals(alicePlainOpen.ok.sync.execution.events, []);
    assertEquals(alicePlainOpen.ok.sync.execution.snapshot?.claims, [
      spaceClaim,
    ]);
    assertEquals(
      alicePlainOpen.ok.sync.execution.snapshot?.settlementFrontiers,
      undefined,
    );
    assertEquals(server.userLaneGrant(SPACE, "", ALICE), null);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await server.close();
  }
});

// (c) The amendment-11 race: a raw client of alice WITHOUT the subcapability
// that transacts immediately after open cannot overlap a live lane — the
// fence lands before the open response (the response is the barrier; no
// sleeps).
Deno.test("a non-negotiating attach fences the principal's lane before the open response", async () => {
  const server = createDeliveryServer("memory-v2-context-delivery-fence");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const aliceClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const bobClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const aliceSession = await mountAs(aliceClient, ALICE);
  const bobSession = await mountAs(bobClient, BOB);
  try {
    await seedSpaceWrite(aliceSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    const lease = await demandAndAcquireLease(server, aliceSession);
    const grant = await server.openUserLaneGrant(SPACE, "", ALICE);
    const aliceClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor(userKeyOf(ALICE)),
    );
    await server.openUserLaneGrant(SPACE, "", BOB);
    const bobClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor(userKeyOf(BOB), "action:bob-derive"),
    );

    const raw = await rawConnect(server, flagsWithoutContextLattice);
    const opened = await rawOpen(raw, "open-race", ALICE);
    assertExists(opened.ok);
    // The open response already carries the post-fence world: alice's lane is
    // drained, her user claim revoked, and the snapshot the same response
    // built contains no user-context claims.
    assertEquals(server.userLaneGrant(SPACE, "", ALICE), null);
    assertEquals(
      server.listExecutionClaims(SPACE).map((claim) => claim.contextKey),
      [userKeyOf(BOB)],
    );
    assertEquals(
      opened.ok.sync?.execution?.snapshot?.claims ?? [],
      [],
    );
    // The fence bumped the generation: neither the drained grant nor the
    // swept claim can renew back to life (amendment 12 semantics).
    assertEquals(await server.renewUserLaneGrant(grant), null);
    assertEquals(await server.renewExecutionClaim(lease, aliceClaim), null);
    // Bob's lane is untouched: the fence is principal-scoped.
    assertExists(server.userLaneGrant(SPACE, "", BOB));
    assertExists(await server.renewExecutionClaim(lease, bobClaim));

    // The raw client's immediate first message is a transact: it lands after
    // the fence by protocol order, never beside a live lane.
    const committed = await rawTransact(raw, "race-write", opened.ok.sessionId);
    assertEquals(committed.error, undefined);
    // A fenced lane cannot re-open while the non-negotiating session lives.
    await assertRejects(
      () => server.openUserLaneGrant(SPACE, "", ALICE),
      Error,
      "context-lattice-claims-v1",
    );
    raw.close();
    bobSession.close();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});

// (c continued) Same-session takeover with downgraded capabilities re-runs
// the gate: capability flags are per attach, not per session lifetime.
Deno.test("a takeover attach with downgraded capabilities fences the lane", async () => {
  const server = createDeliveryServer("memory-v2-context-delivery-takeover");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const aliceClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const aliceSession = await mountAs(aliceClient, ALICE);
  try {
    await seedSpaceWrite(aliceSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");

    const raw = await rawConnect(server, flagsWithContextLattice);
    const opened = await rawOpen(raw, "open-lattice", ALICE);
    assertExists(opened.ok);
    const grant = await server.openUserLaneGrant(SPACE, "", ALICE);
    assertEquals(grant.laneGeneration, 1);

    // The SAME session re-attaches from a connection that did not negotiate
    // the subcapability: takeover admission must fence before responding.
    const downgraded = await rawConnect(server, flagsWithoutContextLattice);
    const takeover = await rawOpen(downgraded, "open-downgraded", ALICE, {
      sessionId: opened.ok.sessionId,
      sessionToken: opened.ok.sessionToken,
      seenSeq: opened.ok.serverSeq,
    });
    assertExists(takeover.ok);
    assertEquals(server.userLaneGrant(SPACE, "", ALICE), null);
    assertEquals(await server.renewUserLaneGrant(grant), null);
    raw.close();
    downgraded.close();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceClient.close();
    await server.close();
  }
});

// (d) Detached-session semantics pinned: a TTL-detached session still counts
// against the principal's cohort (conservative — it can resume and transact
// at any moment within the TTL), while an expired one does not.
Deno.test("TTL-detached sessions count toward the principal cohort", async () => {
  const server = createDeliveryServer("memory-v2-context-delivery-detached");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const aliceLatticeClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const aliceSession = await mountAs(aliceLatticeClient, ALICE);
  try {
    await seedSpaceWrite(aliceSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");

    const plainRaw = await rawConnect(server, flagsWithoutContextLattice);
    const plainOpen = await rawOpen(plainRaw, "open-plain", ALICE);
    assertExists(plainOpen.ok);
    // Connected non-negotiating session: the cohort gate refuses the lane.
    await assertRejects(
      () => server.openUserLaneGrant(SPACE, "", ALICE),
      Error,
      "context-lattice-claims-v1",
    );

    // Detach it (connection close): within the TTL it still counts.
    plainRaw.close();
    const detached = server.sessionsForPrincipal(SPACE, ALICE).filter(
      (session) => session.ownerConnectionId === null,
    );
    assertEquals(detached.length, 1);
    assertEquals(detached[0].id, plainOpen.ok.sessionId);
    await assertRejects(
      () => server.openUserLaneGrant(SPACE, "", ALICE),
      Error,
      "context-lattice-claims-v1",
    );
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceLatticeClient.close();
    await server.close();
  }
});

Deno.test("expired detached sessions leave the principal cohort", async () => {
  // ttlMs 0: a detached session expires immediately, deterministically —
  // presence is decided by the registry prune, not a timer race.
  const server = createDeliveryServer("memory-v2-context-delivery-expired", {
    sessions: new SessionRegistry({ ttlMs: 0 }),
  });
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const aliceLatticeClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const aliceSession = await mountAs(aliceLatticeClient, ALICE);
  try {
    await seedSpaceWrite(aliceSession);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");

    const plainRaw = await rawConnect(server, flagsWithoutContextLattice);
    const plainOpen = await rawOpen(plainRaw, "open-plain", ALICE);
    assertExists(plainOpen.ok);
    plainRaw.close();

    // The zero-TTL detach pruned the session: only the negotiating session
    // remains in the cohort and the lane opens.
    assertEquals(
      server.sessionsForPrincipal(SPACE, ALICE).map((session) => session.id),
      [aliceSession.sessionId],
    );
    const grant = await server.openUserLaneGrant(SPACE, "", ALICE);
    assertEquals(grant.principal, ALICE);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await aliceLatticeClient.close();
    await server.close();
  }
});

// (e) Space-claim regression: with the subcapability in the fleet, space
// claims keep byte-identical delivery to negotiating and non-negotiating
// sessions alike, live and across reconnect snapshots.
Deno.test("space claims keep byte-identical delivery across the mixed fleet", async () => {
  const server = createDeliveryServer("memory-v2-context-delivery-space");
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const latticeClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const plainClient = await connectDeliveryClient(server, {
    contextLatticeClaims: false,
  });
  const latticeSession = await mountAs(latticeClient, ALICE);
  const plainSession = await mountAs(plainClient, BOB);
  try {
    await seedSpaceWrite(latticeSession);
    const lease = await demandAndAcquireLease(server, latticeSession);
    const latticeControl = recordControl(latticeSession);
    const plainControl = recordControl(plainSession);
    const spaceClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor("space", "action:space-derive"),
    );
    assertEquals(server.revokeExecutionClaim(spaceClaim), true);
    assertEquals(latticeControl.events, plainControl.events);
    assertEquals(latticeControl.events.map((event) => event.type), [
      "session.execution.claim.set",
      "session.execution.claim.revoke",
    ]);
    assertEquals(
      (latticeControl.events[0] as { claim: ExecutionClaim }).claim,
      spaceClaim,
    );
    latticeControl.unsubscribe();
    plainControl.unsubscribe();
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await latticeClient.close();
    await plainClient.close();
    await server.close();
  }
});

// Amendment 9: C1.7 folds the rank dial behind the subcapability — a host
// that does not advertise context-lattice-claims-v1 never issues user-rank
// claims, whatever the dial says (they would be deliverable to no one).
Deno.test("user-rank issuance requires the context-lattice-claims-v1 advertisement", async () => {
  const server = new Server(
    {
      store: new URL("memory://memory-v2-context-delivery-issuance-gate"),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      // The base capability without the subcapability.
      protocolFlags: flagsWithoutContextLattice,
      acl: { mode: "off", serviceDids: [] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as DeliveryServer;
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const client = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const session = await mountAs(client, ALICE);
  try {
    await seedSpaceWrite(session);
    rankDial.setServerPrimaryExecutionClaimRankConfig("user");
    const lease = await demandAndAcquireLease(server, session);
    await assertRejects(
      () => server.setExecutionClaim(lease, claimKeyFor(userKeyOf(ALICE))),
      Error,
      "claim rank",
    );
    // Space claims are untouched by the subcapability.
    const spaceClaim = await server.setExecutionClaim(
      lease,
      claimKeyFor("space", "action:space-derive"),
    );
    assertEquals(server.listExecutionClaims(SPACE), [spaceClaim]);
  } finally {
    rankDial.resetServerPrimaryExecutionClaimRankConfig();
    await client.close();
    await server.close();
  }
});

// sessionsForPrincipal is the single A17 seam: principal-scoped, space-scoped,
// and connection-liveness-aware (a detached session is listed until its TTL
// prunes it; a foreign principal or foreign space never is).
Deno.test("sessionsForPrincipal pins the connected-or-detached liveness notion", async () => {
  const server = createDeliveryServer("memory-v2-context-delivery-sessions");
  const aliceClient = await connectDeliveryClient(server, {
    contextLatticeClaims: true,
  });
  const bobClient = await connectDeliveryClient(server, {
    contextLatticeClaims: false,
  });
  const aliceSession = await mountAs(aliceClient, ALICE);
  await mountAs(bobClient, BOB);
  try {
    assertEquals(
      server.sessionsForPrincipal(SPACE, ALICE).map((session) => session.id),
      [aliceSession.sessionId],
    );
    assertEquals(server.sessionsForPrincipal(SPACE, BOB).length, 1);
    assertEquals(
      server.sessionsForPrincipal("did:key:z6Mk-other-space", ALICE),
      [],
    );
    const raw = await rawConnect(server, flagsWithoutContextLattice);
    const opened = await rawOpen(raw, "open-second", ALICE);
    assertExists(opened.ok);
    assertEquals(server.sessionsForPrincipal(SPACE, ALICE).length, 2);
    raw.close();
    // Detached (TTL pending): still present, now ownerless.
    const sessions = server.sessionsForPrincipal(SPACE, ALICE);
    assertEquals(sessions.length, 2);
    assert(
      sessions.some((session) =>
        session.id === opened.ok?.sessionId &&
        session.ownerConnectionId === null
      ),
    );
  } finally {
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});
