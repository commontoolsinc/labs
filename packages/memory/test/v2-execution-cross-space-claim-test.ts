// C3.6 + C3.6b — cross-space-read claim issuance admission, the delivery
// cohort gate, and the composed serve loop.
//
// Fixture map (plan rows C3.6 / C3.6b):
//  (c) issuance preflight (C3A17): under the cross-space-read stage AND the
//      host's cross-space-claims-v1 advertisement, a space-lane claim issued
//      with foreignReadSpaces=[B] BINDS the acting principal's (the lease
//      sponsor's) READ on B before it is recorded — the sponsor holding B
//      READ issues a claim carrying crossSpaceReadSpaces=[B]; the sponsor
//      WITHOUT B READ soft-declines (trySet ⇒ null, the client keeps running
//      locally); a session-lane claim gates on the LANE principal's B access,
//      not the sponsor's.
//  (f) regression: with the stage OFF (rank dial < cross-space-read) OR the
//      advertisement off, the same cross-space issuance soft-declines, and a
//      claim issued WITHOUT foreignReadSpaces is byte-identically same-space
//      (no crossSpaceReadSpaces field, every branch dormant).
//  (d) C3.6b: a cross-space-read claim delivers ONLY to sessions negotiating
//      cross-space-claims-v1 (#sessionAcceptsClaim narrowing); the mixed-
//      version race is prevented at issuance (a non-negotiating cohort member
//      refuses the claim); and a non-negotiating ATTACH fences the live
//      cross-space-read claims of the cohort (the amendment-11 fence) before
//      its open response, revoking them.
//  (b) THE PAYOFF: the C3.5 composed loop now SERVES through the C3.6 issuance
//      path — a point read lands, the claimed rerun's commit settles SERVED
//      with the vector basis, and the live claim carries crossSpaceReadSpaces.
//
// Barrier-driven throughout: every await is a transact response, a host API
// result, or a bounded microtask spin on synchronous state — no sleeps.
import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import * as MemoryV2 from "../v2.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";
import {
  type ActionSettlement,
  type ExecutionClaim,
  toInputBasisSeq,
  userExecutionContextKey,
} from "../v2.ts";

const HOME_SPACE = "did:key:z6Mk-xsp-claim-home";
const READ_SPACE = "did:key:z6Mk-xsp-claim-read";
const ADMIN = "did:key:z6Mk-xsp-claim-admin";
const SPONSOR = "did:key:z6Mk-xsp-claim-sponsor";
const LANE_PRINCIPAL = "did:key:z6Mk-xsp-claim-lane";
const OTHER = "did:key:z6Mk-xsp-claim-writer";
const AUDIENCE = "did:key:z6Mk-xsp-claim-audience";

const PIECE_ROOT = "of:xsp-claim:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:xsp-claim-reader";
const FOREIGN_DOC = "of:xsp-claim:source";
const HOME_SOURCE = "of:xsp-claim:home-source";
const HOME_OUTPUT = "of:xsp-claim:output";

const rankDial = MemoryV2 as unknown as {
  setServerPrimaryExecutionClaimRankConfig(
    rank?: "space" | "user" | "session" | "cross-space-read",
  ): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
  subscribeExecutionControl(
    listener: (event: { type: string; settlement?: ActionSettlement }) => void,
  ): () => void;
  noteAppliedCommit(seq: number): void;
};

type ExecutionLeaseHandle = { leaseGeneration: number };

type HostClaim = {
  contextKey: SchedulerExecutionContextKey;
  pieceId: string;
  actionId: string;
  actionKind: "computation";
  implementationFingerprint: string;
  runtimeFingerprint: string;
  leaseGeneration: number;
  claimGeneration: number;
};

type ClaimServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: unknown,
    options?: { foreignReadSpaces?: readonly string[] },
  ): Promise<ExecutionClaim>;
  trySetExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: unknown,
    options?: { foreignReadSpaces?: readonly string[] },
  ): Promise<ExecutionClaim | null>;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<{ contextKey: string }>;
  executorForeignPointRead(
    lease: ExecutionLeaseHandle,
    request: {
      readSpace: string;
      claim: HostClaim;
      address: { id: string; scope?: "space" | "user" | "session" };
    },
  ): Promise<
    | { status: "served"; space: string; seq: number; branch: string }
    | { status: "denied" | "failed"; code: string }
  >;
};

/** Full negotiating set: server-primary + routing + context-lattice + the
 * C3.6b cross-space subcapability. Dropping `serverPrimaryExecutionCross
 * SpaceClaimsV1` yields a routing-but-non-cross-space session. */
const fullFlags = (crossSpace: boolean) => ({
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
  ...(crossSpace ? { serverPrimaryExecutionCrossSpaceClaimsV1: true } : {}),
});

const createServer = (
  name: string,
  advertiseCrossSpace: boolean,
): ClaimServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      // The host ADVERTISES cross-space-claims-v1 here (merged over ambient).
      protocolFlags: fullFlags(advertiseCrossSpace),
      acl: { mode: "enforce", serviceDids: [ADMIN] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as ClaimServer;

const connectClient = async (
  server: Server,
  crossSpace: boolean,
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: fullFlags(crossSpace),
  } as MemoryClient.ConnectOptions);

const mountAs = async (
  client: MemoryClient.Client,
  space: string,
  principal: string,
): Promise<ExecutionSession> =>
  await client.mount(space, {}, (_space, _session, context) => ({
    invocation: { aud: context.audience, challenge: context.challenge.value },
    authorization: { principal },
  })) as ExecutionSession;

const writeAcl = async (
  session: ExecutionSession,
  localSeq: number,
  space: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  await session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: `of:${space}`, value: { value: acl } }],
  });
};

const claimInput = (
  contextKey: SchedulerExecutionContextKey = "space",
  actionId = ACTION_ID,
) => ({
  branch: "",
  space: HOME_SPACE,
  contextKey,
  pieceId: SCHEDULER_PIECE_ID,
  actionId,
  actionKind: "computation" as const,
  implementationFingerprint: "impl:xsp-claim",
  runtimeFingerprint: "runtime:xsp-claim",
});

const foreignAddress = (
  id: string = FOREIGN_DOC,
): SchedulerObservationAddress => ({
  space: READ_SPACE,
  scope: "space",
  id,
  path: ["value"],
});

const homeAddress = (id: string): SchedulerObservationAddress => ({
  space: HOME_SPACE,
  scope: "space",
  id,
  path: ["value"],
});

const claimedObservation = (
  claim: ExecutionClaim,
  foreignReadStamps: readonly { space: string; id: string; seq: number }[],
): SchedulerActionObservation => {
  const reads = [homeAddress(HOME_SOURCE), foreignAddress()];
  return {
    version: 2,
    ownerSpace: HOME_SPACE,
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
    foreignReadStamps,
    completeActionScopeSummary: {
      version: 1,
      complete: true,
      implementationFingerprint: claim.implementationFingerprint,
      runtimeFingerprint: claim.runtimeFingerprint,
      piece: { space: HOME_SPACE, scope: "space", id: PIECE_ROOT, path: [] },
      reads: [...reads],
      writes: [homeAddress(HOME_OUTPUT)],
      materializerWriteEnvelopes: [],
      directOutputs: [homeAddress(HOME_OUTPUT)],
    },
    observedAtSeq: 0,
    transactionKind: "action-run",
    reads: [...reads],
    shallowReads: [],
    actualChangedWrites: [homeAddress(HOME_OUTPUT)],
    currentKnownWrites: [homeAddress(HOME_OUTPUT)],
    declaredWrites: [homeAddress(HOME_OUTPUT)],
    materializerWriteEnvelopes: [],
    status: "success",
  } as unknown as SchedulerActionObservation;
};

const claimRefOf = (claim: ExecutionClaim): HostClaim => ({
  contextKey: claim.contextKey,
  pieceId: claim.pieceId,
  actionId: claim.actionId,
  actionKind: "computation",
  implementationFingerprint: claim.implementationFingerprint,
  runtimeFingerprint: claim.runtimeFingerprint,
  leaseGeneration: claim.leaseGeneration,
  claimGeneration: claim.claimGeneration,
});

const spinUntil = async (
  predicate: () => boolean,
  what: string,
): Promise<void> => {
  for (let i = 0; i < 10_000; i++) {
    if (predicate()) return;
    await undefined;
  }
  throw new Error(`spinUntil gave up: ${what}`);
};

interface HarnessOptions {
  /** Rank dial stage; default the C3.6 `cross-space-read` (issuance-on). */
  stage?: "space" | "user" | "session" | "cross-space-read";
  /** Whether the HOST advertises cross-space-claims-v1 (default true). */
  advertiseCrossSpace?: boolean;
  /** Whether the sponsor's cohort peers negotiate cross-space (default true). */
  cohortNegotiatesCrossSpace?: boolean;
  /** Grant the sponsor READ on READ_SPACE (default true). */
  sponsorReadsB?: boolean;
}

interface Harness {
  server: ClaimServer;
  adminClient: MemoryClient.Client;
  sponsorClient: MemoryClient.Client;
  otherClient: MemoryClient.Client;
  sponsor: ExecutionSession;
  lease: ExecutionLeaseHandle;
  settlements: ActionSettlement[];
  homeSourceSeq: number;
  connect(crossSpace: boolean): Promise<MemoryClient.Client>;
  mountHome(client: MemoryClient.Client, principal: string): Promise<
    ExecutionSession
  >;
  unbind: () => void;
  close(): Promise<void>;
}

/**
 * Two-space co-hosted harness: HOME (sponsor WRITE) and READ_SPACE (sponsor
 * READ unless suppressed, OTHER WRITE — the seeded foreign doc). The executor
 * plane lands on HOME: demand → lease → bound sponsor session. The admin and
 * sponsor sessions negotiate the full set (cohort uniform) unless
 * `cohortNegotiatesCrossSpace` is false, which makes the admin session a
 * routing-but-non-cross-space cohort member.
 */
const setupHarness = async (
  name: string,
  options: HarnessOptions = {},
): Promise<Harness> => {
  const {
    stage = "cross-space-read",
    advertiseCrossSpace = true,
    cohortNegotiatesCrossSpace = true,
    sponsorReadsB = true,
  } = options;
  rankDial.setServerPrimaryExecutionClaimRankConfig(stage);
  const server = createServer(name, advertiseCrossSpace);
  const clients: MemoryClient.Client[] = [];
  const connect = async (crossSpace: boolean) => {
    const client = await connectClient(server, crossSpace);
    clients.push(client);
    return client;
  };
  const adminClient = await connect(cohortNegotiatesCrossSpace);
  const sponsorClient = await connect(true);
  const otherClient = await connect(true);
  const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
  const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
  await writeAcl(adminHome, 1, HOME_SPACE, {
    [ADMIN]: "OWNER",
    [SPONSOR]: "WRITE",
  });
  await writeAcl(adminRead, 2, READ_SPACE, {
    [ADMIN]: "OWNER",
    ...(sponsorReadsB ? { [SPONSOR]: "READ" as const } : {}),
    [OTHER]: "WRITE",
  });
  const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
  const reader = await mountAs(otherClient, READ_SPACE, OTHER);
  await reader.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 41 } }],
  });
  const seeded = await sponsor.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: HOME_SOURCE, value: { value: 7 } }],
  });
  const settlements: ActionSettlement[] = [];
  sponsor.subscribeExecutionControl((event) => {
    if (event.type === "session.execution.settlement") {
      settlements.push(event.settlement as ActionSettlement);
    }
  });
  await sponsor.setExecutionDemand("", [PIECE_ROOT]);
  const lease = await server.acquireExecutionLease(HOME_SPACE, "");
  assertExists(lease, "sponsor lease");
  const unbind = server.bindExecutionSession(
    HOME_SPACE,
    sponsor.sessionId,
    lease,
  );
  return {
    server,
    adminClient,
    sponsorClient,
    otherClient,
    sponsor,
    lease,
    settlements,
    homeSourceSeq: seeded.seq,
    connect,
    mountHome: (client, principal) => mountAs(client, HOME_SPACE, principal),
    unbind,
    close: async () => {
      unbind();
      for (const client of clients) await client.close();
      await server.close();
      rankDial.resetServerPrimaryExecutionClaimRankConfig();
    },
  };
};

// ---------------------------------------------------------------------------
// (c) issuance preflight (C3A17).
// ---------------------------------------------------------------------------

Deno.test("C3.6 (c): a space-lane claim binds the sponsor's B READ and records crossSpaceReadSpaces", async () => {
  const harness = await setupHarness("xsp-claim-issue");
  try {
    const claim = await harness.server.setExecutionClaim(
      harness.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertEquals(claim.crossSpaceReadSpaces, [READ_SPACE]);
  } finally {
    await harness.close();
  }
});

Deno.test("C3.6 (c): the sponsor WITHOUT B READ soft-declines (trySet ⇒ null)", async () => {
  const harness = await setupHarness("xsp-claim-denied", {
    sponsorReadsB: false,
  });
  try {
    const claim = await harness.server.trySetExecutionClaim(
      harness.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertEquals(claim, null);
    // Discrimination: a SAME-SPACE claim (no foreignReadSpaces) is unaffected
    // by the missing B READ — it issues, byte-identically.
    const sameSpace = await harness.server.setExecutionClaim(
      harness.lease,
      claimInput(),
    );
    assertEquals("crossSpaceReadSpaces" in sameSpace, false);
  } finally {
    await harness.close();
  }
});

Deno.test("C3.6 (c): a user-lane claim gates on the LANE principal's B access, not the sponsor's", async () => {
  // The SPONSOR lacks B READ; the LANE principal HAS it. A user-lane
  // cross-space-read claim must still issue — the preflight binds the lane
  // GRANT's principal, not the lease sponsor (C3A4 enumeration).
  const harness = await setupHarness("xsp-claim-lane", {
    sponsorReadsB: false,
  });
  try {
    // Fresh admin sessions (own localSeq) re-grant: LANE_PRINCIPAL gains HOME
    // WRITE (to anchor + own its lane) and B READ; SPONSOR keeps NO B READ.
    const adminClient2 = await harness.connect(true);
    const adminHome2 = await harness.mountHome(adminClient2, ADMIN);
    const adminRead2 = await mountAs(adminClient2, READ_SPACE, ADMIN);
    await writeAcl(adminHome2, 1, HOME_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
      [LANE_PRINCIPAL]: "WRITE",
    });
    await writeAcl(adminRead2, 1, READ_SPACE, {
      [ADMIN]: "OWNER",
      [LANE_PRINCIPAL]: "READ",
      [OTHER]: "WRITE",
    });
    // A connected LANE_PRINCIPAL session on HOME anchors the lane (negotiating
    // the full set, so both cohort gates stay uniform).
    const laneClient = await harness.connect(true);
    await harness.mountHome(laneClient, LANE_PRINCIPAL);
    await harness.server.openUserLaneGrant(HOME_SPACE, "", LANE_PRINCIPAL);
    const laneKey = userExecutionContextKey(LANE_PRINCIPAL);
    const claim = await harness.server.trySetExecutionClaim(
      harness.lease,
      claimInput(laneKey),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertExists(
      claim,
      "user-lane claim issues on the lane principal's B READ",
    );
    assertEquals(claim.contextKey, laneKey);
    assertEquals(claim.crossSpaceReadSpaces, [READ_SPACE]);
    // Discrimination: the SPACE lane (acting = the sponsor, who lacks B READ)
    // still soft-declines — proving the user-lane admission was the lane
    // principal's access, not a stage-wide relaxation.
    assertEquals(
      await harness.server.trySetExecutionClaim(harness.lease, claimInput(), {
        foreignReadSpaces: [READ_SPACE],
      }),
      null,
    );
  } finally {
    await harness.close();
  }
});

Deno.test("C3.6 (c): granting the sponsor B READ flips a soft-decline to an issued claim", async () => {
  const harness = await setupHarness("xsp-claim-flip", {
    sponsorReadsB: false,
  });
  try {
    assertEquals(
      await harness.server.trySetExecutionClaim(harness.lease, claimInput(), {
        foreignReadSpaces: [READ_SPACE],
      }),
      null,
    );
    // Grant SPONSOR READ on B (the acting principal is the live sponsor).
    const adminRead = await mountAs(harness.adminClient, READ_SPACE, ADMIN);
    await writeAcl(adminRead, 3, READ_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "READ",
      [OTHER]: "WRITE",
    });
    const claim = await harness.server.trySetExecutionClaim(
      harness.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertExists(claim);
    assertEquals(claim.crossSpaceReadSpaces, [READ_SPACE]);
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (f) stage-off / advertisement-off regression.
// ---------------------------------------------------------------------------

Deno.test("C3.6 (f): with the stage OFF the same cross-space issuance soft-declines", async () => {
  const harness = await setupHarness("xsp-claim-stageoff", { stage: "space" });
  try {
    assertEquals(
      await harness.server.trySetExecutionClaim(harness.lease, claimInput(), {
        foreignReadSpaces: [READ_SPACE],
      }),
      null,
    );
    // A same-space claim still issues (stage-off is byte-identical for it).
    const sameSpace = await harness.server.setExecutionClaim(
      harness.lease,
      claimInput(),
    );
    assertEquals("crossSpaceReadSpaces" in sameSpace, false);
  } finally {
    await harness.close();
  }
});

Deno.test("C3.6 (f): with the advertisement OFF the cross-space issuance soft-declines (ordering invariant)", async () => {
  const harness = await setupHarness("xsp-claim-noadvert", {
    advertiseCrossSpace: false,
  });
  try {
    assertEquals(
      await harness.server.trySetExecutionClaim(harness.lease, claimInput(), {
        foreignReadSpaces: [READ_SPACE],
      }),
      null,
    );
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (d) C3.6b delivery gate, mixed-version race, and the attach fence.
// ---------------------------------------------------------------------------

Deno.test("C3.6b (d): the mixed-version race is prevented — a non-negotiating cohort member refuses issuance", async () => {
  // The admin (space cohort peer) negotiates ROUTING but NOT cross-space.
  const harness = await setupHarness("xsp-claim-mixedrace", {
    cohortNegotiatesCrossSpace: false,
  });
  try {
    assertEquals(
      await harness.server.trySetExecutionClaim(harness.lease, claimInput(), {
        foreignReadSpaces: [READ_SPACE],
      }),
      null,
    );
  } finally {
    await harness.close();
  }
});

const snapshotClaimsFor = (server: ClaimServer, sessionId: string) =>
  (server as unknown as {
    attachExecutionFeed(
      space: string,
      sessionId: string,
      sync: Record<string, never>,
      options: { snapshotFromFeedSeq?: number },
    ): { execution?: { snapshot?: { claims?: ExecutionClaim[] } } };
  }).attachExecutionFeed(HOME_SPACE, sessionId, {}, { snapshotFromFeedSeq: 0 })
    .execution?.snapshot?.claims ?? [];

Deno.test("C3.6b (d): a cross-space-read claim delivers to a negotiating session's snapshot", async () => {
  const harness = await setupHarness("xsp-claim-delivery");
  try {
    const claim = await harness.server.setExecutionClaim(
      harness.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertExists(claim.crossSpaceReadSpaces);
    // A NEGOTIATING peer (fresh ADMIN — HOME OWNER, cross-space on) receives
    // the claim in its reconnect snapshot. It does not fence (it negotiates).
    const negClient = await harness.connect(true);
    const neg = await harness.mountHome(negClient, ADMIN);
    const negClaims = snapshotClaimsFor(harness.server, neg.sessionId);
    assert(
      negClaims.some((c) =>
        c.actionId === ACTION_ID && c.crossSpaceReadSpaces !== undefined
      ),
      "the negotiating session receives the cross-space-read claim",
    );
    assert(harness.server.hasLiveExecutionClaim(claim), "still live");
  } finally {
    await harness.close();
  }
});

Deno.test("C3.6b (d): a non-negotiating attach FENCES the live cross-space-read claim, and that session gets no claim (amendment-11)", async () => {
  const harness = await setupHarness("xsp-claim-fence");
  try {
    const claim = await harness.server.setExecutionClaim(
      harness.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    // A same-space claim on the same space to prove the fence is targeted.
    const sameSpace = await harness.server.setExecutionClaim(
      harness.lease,
      claimInput("space", "action:same-space"),
    );
    assert(harness.server.hasLiveExecutionClaim(claim), "claim is live");
    // A routing session (SPONSOR — HOME WRITE) that does NOT negotiate
    // cross-space attaches to HOME: the amendment-11 fence revokes the
    // space-lane cross-space-read claim before its open response releases.
    const nonClient = await harness.connect(false);
    const non = await harness.mountHome(nonClient, SPONSOR);
    await spinUntil(
      () => !harness.server.hasLiveExecutionClaim(claim),
      "cross-space-read claim fenced by the non-negotiating attach",
    );
    // The non-negotiating session's own snapshot never carries it, and the
    // targeted same-space claim survives (the fence is cross-space-only).
    const nonClaims = snapshotClaimsFor(harness.server, non.sessionId);
    assert(
      !nonClaims.some((c) => c.actionId === ACTION_ID),
      "the non-negotiating session receives no cross-space-read claim",
    );
    assert(
      harness.server.hasLiveExecutionClaim(sameSpace),
      "a same-space claim survives a non-negotiating attach",
    );
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (b) THE PAYOFF: the composed loop SERVES through the C3.6 issuance path.
// ---------------------------------------------------------------------------

Deno.test("C3.6 (b): the composed loop serves — cross-space claim + point read + claimed rerun settles committed with the vector", async () => {
  const harness = await setupHarness("xsp-claim-serves");
  const { server, sponsor, lease, settlements, homeSourceSeq } = harness;
  try {
    const claim = await server.setExecutionClaim(lease, claimInput(), {
      foreignReadSpaces: [READ_SPACE],
    });
    assertEquals(claim.crossSpaceReadSpaces, [READ_SPACE]);

    const outcome = await server.executorForeignPointRead(lease, {
      readSpace: READ_SPACE,
      claim: claimRefOf(claim),
      address: { id: FOREIGN_DOC },
    });
    assert(outcome.status === "served", "point read served");

    const committed = await sponsor.transact({
      localSeq: 2,
      reads: {
        confirmed: [{
          id: HOME_SOURCE,
          path: MemoryV2.toDocumentPath(["value"]),
          seq: homeSourceSeq,
        }],
        pending: [],
      },
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 42 } }],
      schedulerObservation: claimedObservation(claim, [
        { space: READ_SPACE, id: FOREIGN_DOC, seq: outcome.seq },
      ]),
    });

    sponsor.noteAppliedCommit(committed.seq);
    await server.flushSessions();
    await spinUntil(() => settlements.length === 1, "committed settlement");
    const settlement = settlements[0];
    assertEquals(settlement.outcome, "committed");
    // The settlement carries the vector basis: home scalar + B component.
    assertEquals(settlement.inputBasis, [
      { space: HOME_SPACE, seq: toInputBasisSeq(homeSourceSeq) },
      { space: READ_SPACE, seq: toInputBasisSeq(outcome.seq) },
    ]);
    // And the live claim still carries its cross-space-read capability.
    assert(server.hasLiveExecutionClaim(claim));
    assertEquals(claim.crossSpaceReadSpaces, [READ_SPACE]);
  } finally {
    await harness.close();
  }
});
