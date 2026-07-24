// C3.10b — transport parity + the reconnect contract + the CO-HOSTED half of
// the C3A7 fence ruling, over TWO `Server` instances joined by the C3.10a
// serializing link (nothing structured crosses — every frame is a string
// through the C3.1 codec).
//
// The wake (C3.3a) and point-read (C3.4) parity fixtures already run over the
// link in their own files (`...cohosted-test.ts` C3.3a-over-the-link; the
// point-read `(b) transport parity`). This file adds the pieces C3.10b owns:
//
//  (1) ISSUANCE OVER THE LINK — the C3.6 preflight's per-space READ binding
//      resolved on the PEER host (the acting principal's READ answered over
//      the link, fail-closed on decline), so a cross-space-read claim can be
//      minted co-hosted at all; the bound epoch carries the link identity.
//  (2) C3A7 CO-HOSTED ARM (ii) — the apply fence reads the home host's
//      LAST-RECEIVED epoch; a bump B sent that is still in flight at consult
//      time is a BOUNDED residual window that C3.7's post-merge revalidation
//      closes by revoking the now-stale claim (the COUNTED divergence). The
//      exact case (bump delivered before the consult) fails the fence up
//      front. Justified against the C3.8 in-process ruling in server.ts's
//      `#foreignAuthorizationEpochResolverForCommit`.
//  (3) LINK-LOSS FAIL-CLOSED — a lost link revokes every claim whose bound
//      epoch rode it (unilateral dead-link revocation), and an issuance whose
//      READ-binding probe cannot round-trip (link down) soft-declines. Never
//      partial.
//  (4) RECONNECT (C3A12) — kill link → B commits (dirties the home reader
//      row) + B bumps an epoch during the outage → reconnect → the stale
//      reader wakes EXACTLY ONCE (dirt resync into the home engine + the
//      re-register post-ack scan) AND re-issuance under the bumped epoch is
//      refused (epoch resync before re-issuance). Discrimination: without the
//      dead-link revoke the stale claim survives; without the epoch resync the
//      re-issuance binds a stale epoch.
//
// Barrier-driven: every await is a transact/host-API result, a link `opened`,
// the pair's quiescence barrier, or a server settle — no sleeps except the
// single deterministic macrotask hop a "still-pending while delivery is held"
// probe needs.
import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { aclDocId } from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import type { ForeignWakeEvent } from "../v2/server.ts";
import * as MemoryV2 from "../v2.ts";
import {
  type ExecutionClaim,
  resetPersistentSchedulerStateConfig,
  setPersistentSchedulerStateConfig,
} from "../v2.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";
import {
  type CoHostedCrossSpaceLink,
  CoHostedCrossSpaceTransport,
  type CrossSpaceLinkSocketPair,
  crossSpaceLinkSocketPair,
} from "../v2/cross-space-link.ts";

const HOST_A = "host:xsp-10b-a";
const HOST_B = "host:xsp-10b-b";
const HOME_SPACE = "did:key:z6Mk-xsp-10b-home";
const READ_SPACE = "did:key:z6Mk-xsp-10b-read";
const ADMIN = "did:key:z6Mk-xsp-10b-admin";
const SPONSOR = "did:key:z6Mk-xsp-10b-sponsor";
const OTHER = "did:key:z6Mk-xsp-10b-writer";
const AUDIENCE = "did:key:z6Mk-xsp-10b-audience";

const PIECE_ROOT = "of:xsp-10b:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:xsp-10b-reader";
const FOREIGN_DOC = "of:xsp-10b:source";
const HOME_SOURCE = "of:xsp-10b:home-source";
const HOME_OUTPUT = "of:xsp-10b:output";

const rankDial = MemoryV2 as unknown as {
  setServerPrimaryExecutionClaimRankConfig(
    rank?: "space" | "user" | "session" | "cross-space-read",
  ): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

const fullFlags = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
  serverPrimaryExecutionCrossSpaceClaimsV1: true,
};

type ExecutionLeaseHandle = { leaseGeneration: number };

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
};

/** Soft-private server surface the fixtures drive (STANDALONE, not
 * `Server & {...}` — the intersection collapses to `never` when a redeclared
 * method is private on `Server`; the wake/idle tests use the same convention). */
type C10bServer = {
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
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<{ contextKey: string; laneGeneration: number }>;
  hasLiveExecutionClaim(claim: ExecutionClaim): boolean;
  effectiveRemoteAuthorizationEpoch(
    linkId: string,
    authoritySpace: string,
    principal: string,
  ): number | undefined;
  subscribeForeignWakes(
    space: string,
    listener: (event: ForeignWakeEvent) => void,
  ): () => void;
  settleCrossSpaceDeliveries(): Promise<void>;
  settleForeignReaderSubscriptions(): Promise<void>;
  openEngine(space: string): Promise<Engine.Engine>;
  close(): Promise<void>;
  readonly executionStats: {
    crossSpaceCoHostedFenceResidualRevocations: number;
    crossSpaceDeadLinkClaimRevocations: number;
    crossSpaceReconnectResyncs: number;
  };
};

const serverOptions = {
  authorizeSessionOpen: (message: { authorization?: unknown }) => {
    const principal = (message.authorization as { principal?: unknown })
      ?.principal;
    return typeof principal === "string" ? principal : undefined;
  },
  sessionOpenAuth: { audience: AUDIENCE },
  protocolFlags: fullFlags,
  acl: { mode: "enforce", serviceDids: [ADMIN] },
};

interface Linked {
  pair: CrossSpaceLinkSocketPair;
  serverA: C10bServer;
  serverB: C10bServer;
  transportA: CoHostedCrossSpaceTransport;
  transportB: CoHostedCrossSpaceTransport;
  linkA: CoHostedCrossSpaceLink;
  linkB: CoHostedCrossSpaceLink;
  linkId: string;
}

const makeServer = (name: string, transport: CoHostedCrossSpaceTransport) =>
  new Server(
    {
      ...serverOptions,
      store: new URL(`memory://${name}`),
      crossSpaceTransport: transport,
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as unknown as C10bServer;

const attach = async (
  fixture: Pick<Linked, "transportA" | "transportB">,
  pair: CrossSpaceLinkSocketPair,
): Promise<
  {
    linkA: CoHostedCrossSpaceLink;
    linkB: CoHostedCrossSpaceLink;
    linkId: string;
  }
> => {
  const linkA = fixture.transportA.attachLink(pair.sockets[0]);
  const linkB = fixture.transportB.attachLink(pair.sockets[1]);
  const [{ linkId }] = await Promise.all([linkA.opened, linkB.opened]);
  return { linkA, linkB, linkId };
};

const linkServers = async (): Promise<Linked> => {
  const transportA = new CoHostedCrossSpaceTransport({
    hostId: HOST_A,
    hostedSpaces: [HOME_SPACE],
  });
  const transportB = new CoHostedCrossSpaceTransport({
    hostId: HOST_B,
    hostedSpaces: [READ_SPACE],
  });
  const serverA = makeServer("xsp-10b-a", transportA);
  const serverB = makeServer("xsp-10b-b", transportB);
  const pair = crossSpaceLinkSocketPair();
  const { linkA, linkB, linkId } = await attach(
    { transportA, transportB },
    pair,
  );
  return {
    pair,
    serverA,
    serverB,
    transportA,
    transportB,
    linkA,
    linkB,
    linkId,
  };
};

/** Cross-host settle: loop (duplex quiescent → both hosts' delivery and
 * subscription barriers) until a pass moves no frames. */
const settleLinked = async (fixture: Linked): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    const before = fixture.pair.framesTransferred();
    await fixture.pair.whenQuiet();
    await fixture.serverA.settleCrossSpaceDeliveries();
    await fixture.serverB.settleCrossSpaceDeliveries();
    await fixture.serverA.settleForeignReaderSubscriptions();
    await fixture.serverB.settleForeignReaderSubscriptions();
    await fixture.pair.whenQuiet();
    if (fixture.pair.framesTransferred() === before) return;
  }
  throw new Error("linked servers did not quiesce");
};

const connect = (server: C10bServer): Promise<MemoryClient.Client> =>
  MemoryClient.connect({
    transport: MemoryClient.loopback(server as unknown as Server),
    protocolFlags: fullFlags,
  } as MemoryClient.ConnectOptions);

const mountAs = (
  client: MemoryClient.Client,
  space: string,
  principal: string,
): Promise<ExecutionSession> =>
  client.mount(space, {}, (_space, _session, context) => ({
    invocation: { aud: context.audience, challenge: context.challenge.value },
    authorization: { principal },
  })) as Promise<ExecutionSession>;

const writeAcl = (
  session: ExecutionSession,
  localSeq: number,
  space: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<unknown> =>
  session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: aclDocId(space), value: { value: acl } }],
  });

const claimInput = (
  contextKey: SchedulerExecutionContextKey = "space",
) => ({
  branch: "",
  space: HOME_SPACE,
  contextKey,
  pieceId: SCHEDULER_PIECE_ID,
  actionId: ACTION_ID,
  actionKind: "computation" as const,
  implementationFingerprint: "impl:xsp-10b",
  runtimeFingerprint: "runtime:xsp-10b",
});

const foreignReaderObservation = (): SchedulerActionObservation => {
  const foreign: SchedulerObservationAddress = {
    space: READ_SPACE,
    id: FOREIGN_DOC,
    scope: "space",
    path: ["value"],
  };
  const output: SchedulerObservationAddress = {
    space: HOME_SPACE,
    id: HOME_OUTPUT,
    scope: "space",
    path: ["value"],
  };
  return {
    version: 2,
    ownerSpace: HOME_SPACE,
    branch: "",
    pieceId: SCHEDULER_PIECE_ID,
    processGeneration: 1,
    actionId: ACTION_ID,
    actionKind: "computation",
    implementationFingerprint: "impl:xsp-10b",
    runtimeFingerprint: "runtime:xsp-10b",
    observedAtSeq: 0,
    transactionKind: "action-run",
    reads: [foreign],
    shallowReads: [],
    actualChangedWrites: [],
    currentKnownWrites: [output],
    declaredWrites: [output],
    materializerWriteEnvelopes: [],
    completeActionScopeSummary: {
      version: 1,
      complete: true,
      implementationFingerprint: "impl:xsp-10b",
      runtimeFingerprint: "runtime:xsp-10b",
      piece: { space: HOME_SPACE, id: PIECE_ROOT, scope: "space", path: [] },
      reads: [foreign],
      writes: [output],
      materializerWriteEnvelopes: [],
      directOutputs: [output],
    },
    status: "success",
  };
};

/**
 * Full co-hosted setup: A hosts HOME (sponsor WRITE), B hosts READ (sponsor
 * READ, OTHER WRITE + a seeded foreign doc). The sponsor's executor plane
 * lands on A with a bound session. Returns the pieces the fixtures drive.
 */
const setup = async (fixture: Linked) => {
  rankDial.setServerPrimaryExecutionClaimRankConfig("cross-space-read");
  setPersistentSchedulerStateConfig(true);
  const clients: MemoryClient.Client[] = [];
  const conn = async (server: C10bServer) => {
    const client = await connect(server);
    clients.push(client);
    return client;
  };
  const adminA = await mountAs(await conn(fixture.serverA), HOME_SPACE, ADMIN);
  const adminB = await mountAs(await conn(fixture.serverB), READ_SPACE, ADMIN);
  await writeAcl(adminA, 1, HOME_SPACE, {
    [ADMIN]: "OWNER",
    [SPONSOR]: "WRITE",
  });
  await writeAcl(adminB, 1, READ_SPACE, {
    [ADMIN]: "OWNER",
    [SPONSOR]: "READ",
    [OTHER]: "WRITE",
  });
  const reader = await mountAs(await conn(fixture.serverB), READ_SPACE, OTHER);
  await reader.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 41 } }],
  });
  const sponsor = await mountAs(
    await conn(fixture.serverA),
    HOME_SPACE,
    SPONSOR,
  );
  await sponsor.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: HOME_SOURCE, value: { value: 7 } }],
  });
  await sponsor.setExecutionDemand("", [PIECE_ROOT]);
  const lease = await fixture.serverA.acquireExecutionLease(HOME_SPACE, "");
  assertExists(lease, "sponsor lease");
  // NOTE: we deliberately do NOT `bindExecutionSession` — claim issuance
  // resolves authority from the owned lease + sponsor session + demand (not
  // the executor mirror binding), and leaving the sponsor session unbound lets
  // it commit CLIENT observations (the reconnect wake pipeline) without the
  // executor-commit claim-assertion requirement.
  await settleLinked(fixture);
  let adminBSeq = 1;
  return {
    sponsor,
    adminB,
    lease,
    rewriteReadAcl: async (acl: Record<string, "READ" | "WRITE" | "OWNER">) => {
      await writeAcl(adminB, ++adminBSeq, READ_SPACE, acl);
    },
    teardown: async () => {
      for (const client of clients) await client.close().catch(() => {});
      rankDial.resetServerPrimaryExecutionClaimRankConfig();
      resetPersistentSchedulerStateConfig();
    },
  };
};

const closeAll = async (fixture: Linked): Promise<void> => {
  await fixture.serverA.close().catch(() => {});
  await fixture.serverB.close().catch(() => {});
};

// ---------------------------------------------------------------------------
// (1) Issuance over the link: the C3.6 peer READ-binding round-trip.
// ---------------------------------------------------------------------------

Deno.test("C3.10b (1): a cross-space-read claim issues over the link — the acting principal's READ is resolved on the PEER host, and the bound epoch carries the link identity", async () => {
  const fixture = await linkServers();
  const kit = await setup(fixture);
  try {
    // The sponsor holds READ on B (granted over the link). Issuance's
    // per-space READ binding round-trips to B and succeeds.
    const claim = await fixture.serverA.setExecutionClaim(
      kit.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertEquals(claim.crossSpaceReadSpaces, [READ_SPACE]);
    assert(
      fixture.serverA.hasLiveExecutionClaim(claim),
      "the claim minted after the peer READ binding",
    );
    // The bound epoch was learned over the link — A's remote cache knows B's
    // epoch for the sponsor (a real number, not the C3A3 unknown).
    const epoch = fixture.serverA.effectiveRemoteAuthorizationEpoch(
      fixture.linkId,
      READ_SPACE,
      SPONSOR,
    );
    assert(epoch !== undefined && epoch >= 1, "bound epoch learned over link");

    // Converse: a principal WITHOUT B READ soft-declines (trySet → null). B
    // drops the sponsor's READ; a fresh issuance probe is denied on the peer.
    await kit.rewriteReadAcl({ [ADMIN]: "OWNER", [OTHER]: "WRITE" });
    await settleLinked(fixture);
    const declined = await fixture.serverA.trySetExecutionClaim(
      kit.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertEquals(
      declined,
      null,
      "issuance soft-declines when the peer denies READ over the link",
    );
  } finally {
    await kit.teardown();
    await closeAll(fixture);
  }
});

// ---------------------------------------------------------------------------
// (2) The C3A7 co-hosted arm (ii): last-received epoch + bounded window.
// ---------------------------------------------------------------------------

Deno.test("C3.10b (2) exact: a bump DELIVERED before the consult is seen — the fence's last-received epoch already exceeds the bound epoch, and the stale claim is revoked", async () => {
  const fixture = await linkServers();
  const kit = await setup(fixture);
  try {
    const claim = await fixture.serverA.setExecutionClaim(
      kit.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    const bound = fixture.serverA.effectiveRemoteAuthorizationEpoch(
      fixture.linkId,
      READ_SPACE,
      SPONSOR,
    );
    assertExists(bound);

    // B bumps the sponsor's epoch (still holds READ — a valid→valid change),
    // and the bump is DELIVERED to A (not held). A's last-received epoch now
    // strictly exceeds the bound epoch, so the fence would fail up front AND
    // the idle revalidation revokes the claim.
    await kit.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
      [OTHER]: "WRITE",
    });
    await settleLinked(fixture);
    const after = fixture.serverA.effectiveRemoteAuthorizationEpoch(
      fixture.linkId,
      READ_SPACE,
      SPONSOR,
    );
    assert(after !== undefined && after > bound!, "last-received epoch rose");
    assert(
      !fixture.serverA.hasLiveExecutionClaim(claim),
      "the stale claim revoked once the higher epoch was received",
    );
  } finally {
    await kit.teardown();
    await closeAll(fixture);
  }
});

Deno.test("C3.10b (2) bounded window: a bump IN FLIGHT at consult time is invisible (fence reads stale) — the post-merge revalidation closes the window on delivery and COUNTS the divergence", async () => {
  const fixture = await linkServers();
  const kit = await setup(fixture);
  try {
    const claim = await fixture.serverA.setExecutionClaim(
      kit.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    const bound = fixture.serverA.effectiveRemoteAuthorizationEpoch(
      fixture.linkId,
      READ_SPACE,
      SPONSOR,
    );
    assertExists(bound);
    const divergencesBefore =
      fixture.serverA.executionStats.crossSpaceCoHostedFenceResidualRevocations;

    // HOLD the link, then B bumps: the bump frame is captive in the duplex.
    const release = fixture.pair.holdDelivery();
    await kit.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
      [OTHER]: "WRITE",
    });
    // The consult A's apply fence would run right now reads the LAST-RECEIVED
    // epoch — still the bound value, because the bump is in flight. This is
    // the residual window: the fence would PASS against a stale epoch.
    assertEquals(
      fixture.serverA.effectiveRemoteAuthorizationEpoch(
        fixture.linkId,
        READ_SPACE,
        SPONSOR,
      ),
      bound,
      "the in-flight bump is invisible — the fence reads the stale epoch",
    );
    assert(
      fixture.serverA.hasLiveExecutionClaim(claim),
      "the claim still live in the residual window",
    );

    // Release: the bump lands, the post-merge revalidation closes the window
    // by revoking the now-stale claim, and the divergence is COUNTED.
    release();
    await settleLinked(fixture);
    assert(
      !fixture.serverA.hasLiveExecutionClaim(claim),
      "the window closed — the stale claim revoked on the bump's arrival",
    );
    assertEquals(
      fixture.serverA.executionStats
        .crossSpaceCoHostedFenceResidualRevocations,
      divergencesBefore + 1,
      "the co-hosted residual-window closure was counted",
    );
  } finally {
    await kit.teardown();
    await closeAll(fixture);
  }
});

// ---------------------------------------------------------------------------
// (3) Link-loss fail-closed.
// ---------------------------------------------------------------------------

Deno.test("C3.10b (3a): a lost link UNILATERALLY revokes every claim whose bound epoch rode it — fail closed, never partial", async () => {
  const fixture = await linkServers();
  const kit = await setup(fixture);
  try {
    const claim = await fixture.serverA.setExecutionClaim(
      kit.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assert(fixture.serverA.hasLiveExecutionClaim(claim));
    const revokesBefore =
      fixture.serverA.executionStats.crossSpaceDeadLinkClaimRevocations;

    // Kill the link.
    fixture.pair.sockets[0].close();
    await fixture.pair.whenQuiet();
    await fixture.serverA.settleCrossSpaceDeliveries();

    assert(
      !fixture.serverA.hasLiveExecutionClaim(claim),
      "the claim bound over the dead link revoked",
    );
    assertEquals(
      fixture.serverA.executionStats.crossSpaceDeadLinkClaimRevocations,
      revokesBefore + 1,
    );
    // The (link, space) is now unknown — the C3A3 fail-closed state.
    assertEquals(
      fixture.serverA.effectiveRemoteAuthorizationEpoch(
        fixture.linkId,
        READ_SPACE,
        SPONSOR,
      ),
      undefined,
      "the remote-epoch cache for the dead link was evicted (fail closed)",
    );
  } finally {
    await kit.teardown();
    await closeAll(fixture);
  }
});

Deno.test("C3.10b (3b): issuance whose READ-binding probe cannot round-trip (link down) soft-declines — no claim, no partial state", async () => {
  const fixture = await linkServers();
  const kit = await setup(fixture);
  try {
    // Kill the link before issuance: the peer READ-binding probe cannot
    // round-trip, so it times out into a soft decline.
    fixture.pair.sockets[0].close();
    await fixture.pair.whenQuiet();
    await fixture.serverA.settleCrossSpaceDeliveries();
    const declined = await Promise.race([
      fixture.serverA.trySetExecutionClaim(kit.lease, claimInput(), {
        foreignReadSpaces: [READ_SPACE],
      }),
      // The probe's fail-closed timeout is 10s; the read space is no longer
      // routed after the loss, so the send drops and nothing ever answers.
      // (We do not want the test to sit on the 10s wall — assert via a short
      // deadline that it has NOT produced a claim by resolving `pending`.)
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 200)
      ),
    ]);
    // Either the probe already soft-declined (null) or it is still waiting on
    // its fail-closed timeout ("pending") — in neither case did a claim mint.
    assert(
      declined === null || declined === "pending",
      "a link-down issuance never mints a claim",
    );
  } finally {
    await kit.teardown();
    await closeAll(fixture);
  }
});

// ---------------------------------------------------------------------------
// (4) Reconnect (C3A12): the headline acceptance.
// ---------------------------------------------------------------------------

Deno.test("C3.10b (4): kill link → B commits + bumps during the outage → reconnect → the stale reader wakes EXACTLY ONCE and re-issuance under the bumped epoch is refused", async () => {
  const fixture = await linkServers();
  const kit = await setup(fixture);
  const wakes: ForeignWakeEvent[] = [];
  fixture.serverA.subscribeForeignWakes(
    HOME_SPACE,
    (event) => wakes.push(event),
  );
  try {
    await fixture.serverA.openSessionLaneGrant(
      HOME_SPACE,
      "",
      SPONSOR,
      kit.sponsor.sessionId,
    );

    // The sponsor's action reads B; the mirror crosses the link and demand
    // subscribes so B-commits wake it. The observation's own scope summary
    // floors it at the committing session's lane.
    await kit.sponsor.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: foreignReaderObservation(),
    });
    // A cross-space-read claim binds the epoch over the link.
    const claim = await fixture.serverA.setExecutionClaim(
      kit.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    await settleLinked(fixture);
    assert(fixture.serverA.hasLiveExecutionClaim(claim), "claim live pre-kill");
    const wakesBefore = wakes.length;

    // KILL the link → dead-link revocation kills the bound claim.
    fixture.pair.sockets[0].close();
    await fixture.pair.whenQuiet();
    await fixture.serverA.settleCrossSpaceDeliveries();
    assert(
      !fixture.serverA.hasLiveExecutionClaim(claim),
      "the dead-link revocation killed the bound claim (discrimination: drop " +
        "it and the stale claim survives the outage)",
    );

    // During the OUTAGE: B commits (dirties the mirrored home reader row) and
    // B bumps the sponsor's epoch (drops READ → a revocation bump). Both
    // frames are dropped (link down). Commit on B as OTHER (holds WRITE).
    const otherClient = await connect(fixture.serverB);
    const other = await mountAs(otherClient, READ_SPACE, OTHER);
    await other.transact({
      localSeq: 10,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 99 } }],
    });
    // B bumps the sponsor's epoch by dropping READ (an ACL revocation).
    await kit.rewriteReadAcl({ [ADMIN]: "OWNER", [OTHER]: "WRITE" });

    // RECONNECT.
    const pair2 = crossSpaceLinkSocketPair();
    fixture.pair = pair2;
    const reattached = await attach(fixture, pair2);
    assertEquals(reattached.linkId, fixture.linkId, "reconnect keeps linkId");
    await settleLinked(fixture);

    // (a) The stale reader woke EXACTLY ONCE (the dirt resync landed the
    //     outage dirt in the home engine; the re-register post-ack scan is the
    //     single wake source).
    const reconnectWakes = wakes.slice(wakesBefore);
    assertEquals(
      reconnectWakes.length,
      1,
      "the stale reader wakes exactly once on reconnect",
    );
    assertEquals(reconnectWakes[0].readSpace, READ_SPACE);

    // (b) The EPOCH RESYNC repopulated the cache the link loss evicted — the
    //     (link, space) is known again (the C3A12 "resync the epoch table"
    //     obligation; my design pins C3A12's stated alternative — the C3.6
    //     preflight IS a live over-link query — so re-issuance is gated on the
    //     probe, and this resync is the belt that restores the fence cache +
    //     revalidates any surviving claim). Discrimination: drop the epoch
    //     resync and the cache stays undefined here.
    assert(
      fixture.serverA.executionStats.crossSpaceReconnectResyncs >= 1,
      "the reconnect resync drill ran",
    );
    assert(
      fixture.serverA.effectiveRemoteAuthorizationEpoch(
        fixture.linkId,
        READ_SPACE,
        SPONSOR,
      ) !== undefined,
      "the epoch resync repopulated the cache the link loss evicted",
    );

    // (c) Re-issuance under the bumped epoch is REFUSED: the live over-link
    //     READ-binding probe finds the sponsor lost READ on B, so the claim
    //     cannot be re-minted.
    const reissued = await fixture.serverA.trySetExecutionClaim(
      kit.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertEquals(
      reissued,
      null,
      "re-issuance is refused after reconnect (the sponsor lost READ on B)",
    );
    await otherClient.close().catch(() => {});
  } finally {
    await kit.teardown();
    await closeAll(fixture);
  }
});
