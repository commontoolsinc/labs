// C3.7 — claims bind foreign authorization generations; idle revocation +
// cleanup: the §7 "revocation while idle" gate.
//
// A cross-space-read claim (C3.6) binds, per foreign read space, the
// {(space, principal, epoch)} the issuance preflight authorized the READ
// under (C3.2's authorization_epoch table, captured in the same synchronous
// engine section as the READ check). An `ForeignAuthorizationEpochBump`
// (local ACL apply, or an inbound bump over the transport) that covers a
// bound entry revokes the idle claim through the existing revoke path.
//
// Fixture map (plan row C3.7):
//  (a) idle revocation via a LOCAL-authored bump: a claim reading B under
//      epoch N revokes when B's ACL changes the acting principal's
//      generation; the client observes the revoke (fail-open); an UNRELATED
//      principal's bump does NOT revoke — a scoped-lane claim revokes on the
//      LANE principal's B-access loss, not the sponsor's (C3A4 precision).
//  (b) the REMOTE-inbound bump path: a foreign-authorization-epoch.bump for
//      B arriving over the transport (no local commit) updates the cache and
//      revokes the home claim.
//  (c) C3A6 cleanup: a bump-revoke unsubscribes the foreign-reader demand
//      pair when it was the LAST claim reading B (refcount), and does NOT
//      when another live cross-space claim still reads B; the executor mirror
//      rows are NOT tombstoned (recorded ruling — read-surface-derived
//      host-trust metadata).
//  (d) re-issuance (C3A3): after a bump-revoke, a re-issued claim binds the
//      NEW epoch (it survives an inbound bump at that epoch a stale binding
//      would not); a re-issue after READ loss soft-declines.
//  (e) fail-closed: an UNKNOWN effective epoch (cache eviction/restart)
//      revokes (over-revoke, never under-revoke).
//  (f) regression: a same-space claim carries no binding and every C3.7
//      revocation path is dormant; the ordinary revoke/expiry paths stay
//      green.
//
// Barrier-driven throughout: every await is a transact/host-API result or the
// cross-space settle barrier — no sleeps.
import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import * as MemoryV2 from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";
import {
  type ExecutionClaim,
  type ExecutionControlEvent,
  resetPersistentSchedulerStateConfig,
  setPersistentSchedulerStateConfig,
  userExecutionContextKey,
} from "../v2.ts";
import { parseCrossSpaceMessage } from "../v2/cross-space.ts";

const HOME_SPACE = "did:key:z6Mk-xsp-idle-home";
const READ_SPACE = "did:key:z6Mk-xsp-idle-read";
const ADMIN = "did:key:z6Mk-xsp-idle-admin";
const SPONSOR = "did:key:z6Mk-xsp-idle-sponsor";
const LANE_PRINCIPAL = "did:key:z6Mk-xsp-idle-lane";
const OTHER = "did:key:z6Mk-xsp-idle-writer";
const AUDIENCE = "did:key:z6Mk-xsp-idle-audience";

const PIECE_ROOT = "of:xsp-idle:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:xsp-idle-reader";
const FOREIGN_DOC = "of:xsp-idle:source";
const HOME_SOURCE = "of:xsp-idle:home-source";
const HOME_OUTPUT = "of:xsp-idle:output";

const rankDial = MemoryV2 as unknown as {
  setServerPrimaryExecutionClaimRankConfig(
    rank?: "space" | "user" | "session" | "cross-space-read",
  ): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
  subscribeExecutionControl(
    listener: (event: ExecutionControlEvent) => void,
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

/** The soft-private server surface the fixtures drive (the standalone-type
 * cast convention the wake test established — a `Server & {...}` intersection
 * collapses to `never` on the redeclared private registry field). */
type IdleServer = {
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
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<{ contextKey: string }>;
  listExecutionClaims(space: string): readonly ExecutionClaim[];
  hasLiveExecutionClaim(claim: ExecutionClaim): boolean;
  revokeExecutionClaim(claim: ExecutionClaim): boolean;
  expireExecutionClaims(now?: number): number;
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
  revalidateCrossSpaceReadClaimsAgainstRemoteEpoch(
    authoritySpace: string,
    linkId: string,
  ): number;
  effectiveRemoteAuthorizationEpoch(
    linkId: string,
    authoritySpace: string,
    principal: string,
  ): number | undefined;
  crossSpaceRouter(): {
    transport: {
      channelTo(space: string): {
        linkId: string;
        onMessage(handler: (wire: string) => void): void;
      };
    };
    link(from: string, to: string): {
      linkId: string;
      send(message: unknown): void;
    };
  };
  settleCrossSpaceDeliveries(): Promise<void>;
  settleForeignReaderSubscriptions(): Promise<void>;
  foreignReaderSubscriptionsByReadSpace: Map<string, Map<string, unknown>>;
  openEngine(space: string): Promise<Engine.Engine>;
  flushSessions(): Promise<void>;
  close(): Promise<void>;
};

/** The executor-authored mirror rows READ_SPACE's engine holds for the home
 * space (owner_space = HOME_SPACE) — read straight off the engine so the
 * assertion is independent of subscription/notice plumbing. */
const mirrorRowCountForHome = async (server: IdleServer): Promise<number> => {
  const engine = await server.openEngine(READ_SPACE);
  return Engine.listSchedulerActionSnapshots(engine, {
    ownerSpace: HOME_SPACE,
  }).snapshots.length;
};

const fullFlags = (crossSpace: boolean) => ({
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
  ...(crossSpace ? { serverPrimaryExecutionCrossSpaceClaimsV1: true } : {}),
});

const createServer = (name: string): IdleServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      protocolFlags: fullFlags(true),
      acl: { mode: "enforce", serviceDids: [ADMIN] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as unknown as IdleServer;

const connectClient = (server: IdleServer): Promise<MemoryClient.Client> =>
  MemoryClient.connect({
    transport: MemoryClient.loopback(server as unknown as Server),
    protocolFlags: fullFlags(true),
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
    operations: [{ op: "set", id: `of:${space}`, value: { value: acl } }],
  });

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
  implementationFingerprint: "impl:xsp-idle",
  runtimeFingerprint: "runtime:xsp-idle",
});

const foreignAddress = (id = FOREIGN_DOC): SchedulerObservationAddress => ({
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

interface Harness {
  server: IdleServer;
  sponsor: ExecutionSession;
  lease: ExecutionLeaseHandle;
  revokes: ExecutionClaim[];
  connect(): Promise<MemoryClient.Client>;
  mount(
    client: MemoryClient.Client,
    space: string,
    principal: string,
  ): Promise<ExecutionSession>;
  /** Rewrite READ_SPACE's ACL from a fresh admin session (own localSeq). */
  rewriteReadAcl(acl: Record<string, "READ" | "WRITE" | "OWNER">): Promise<
    void
  >;
  close(): Promise<void>;
}

/**
 * Co-hosted harness: HOME (sponsor + lane principal WRITE) and READ_SPACE
 * (sponsor + lane principal READ, OTHER WRITE — the seeded foreign doc). The
 * executor plane lands on HOME with a bound sponsor session; the sponsor
 * session's control feed records revokes.
 */
const setupHarness = async (name: string): Promise<Harness> => {
  rankDial.setServerPrimaryExecutionClaimRankConfig("cross-space-read");
  const server = createServer(name);
  const clients: MemoryClient.Client[] = [];
  const connect = async () => {
    const client = await connectClient(server);
    clients.push(client);
    return client;
  };
  const adminClient = await connect();
  const sponsorClient = await connect();
  const otherClient = await connect();
  const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
  const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
  await writeAcl(adminHome, 1, HOME_SPACE, {
    [ADMIN]: "OWNER",
    [SPONSOR]: "WRITE",
    [LANE_PRINCIPAL]: "WRITE",
  });
  await writeAcl(adminRead, 2, READ_SPACE, {
    [ADMIN]: "OWNER",
    [SPONSOR]: "READ",
    [LANE_PRINCIPAL]: "READ",
    [OTHER]: "WRITE",
  });
  const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
  const reader = await mountAs(otherClient, READ_SPACE, OTHER);
  await reader.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: FOREIGN_DOC, value: { value: 41 } }],
  });
  await sponsor.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: HOME_SOURCE, value: { value: 7 } }],
  });
  const revokes: ExecutionClaim[] = [];
  sponsor.subscribeExecutionControl((event) => {
    if (event.type === "session.execution.claim.revoke") {
      revokes.push(event.claim as ExecutionClaim);
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
  let adminReadSeq = 2;
  return {
    server,
    sponsor,
    lease,
    revokes,
    connect,
    mount: mountAs,
    rewriteReadAcl: async (acl) => {
      const client = await connect();
      const session = await mountAs(client, READ_SPACE, ADMIN);
      await writeAcl(session, ++adminReadSeq, READ_SPACE, acl);
      await server.settleCrossSpaceDeliveries();
    },
    close: async () => {
      unbind();
      for (const client of clients) await client.close().catch(() => {});
      await server.close().catch(() => {});
      rankDial.resetServerPrimaryExecutionClaimRankConfig();
    },
  };
};

const readLinkId = (server: IdleServer): string =>
  server.crossSpaceRouter().transport.channelTo(READ_SPACE).linkId;

// ---------------------------------------------------------------------------
// (a) idle revocation via a LOCAL-authored bump + lane-principal precision.
// ---------------------------------------------------------------------------

Deno.test("C3.7 (a): a B ACL change revokes the idle claim bound under the acting principal; the client observes the revoke", async () => {
  const harness = await setupHarness("xsp-idle-local");
  const { server } = harness;
  try {
    const claim = await server.setExecutionClaim(harness.lease, claimInput(), {
      foreignReadSpaces: [READ_SPACE],
    });
    assertEquals(claim.crossSpaceReadSpaces, [READ_SPACE]);
    assert(server.hasLiveExecutionClaim(claim), "claim live before the bump");

    // B's ACL drops the sponsor's READ → a per-principal epoch bump on the
    // sponsor → the idle claim (bound under the sponsor) revokes.
    await harness.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [LANE_PRINCIPAL]: "READ",
      [OTHER]: "WRITE",
    });
    assert(
      !server.hasLiveExecutionClaim(claim),
      "the idle claim revoked on the sponsor's B-access bump",
    );
    // The client observed the revoke (fail-open rerun path).
    await server.flushSessions();
    assert(
      harness.revokes.some((c) => c.actionId === ACTION_ID),
      "the sponsor's control feed carried the revoke",
    );
  } finally {
    await harness.close();
  }
});

Deno.test("C3.7 (a)/C3A4: a scoped-lane claim revokes on the LANE principal's B-access loss, not the sponsor's", async () => {
  const harness = await setupHarness("xsp-idle-precision");
  const { server } = harness;
  try {
    // A user lane owned by LANE_PRINCIPAL (HOME WRITE + a connected session).
    const laneClient = await harness.connect();
    await harness.mount(laneClient, HOME_SPACE, LANE_PRINCIPAL);
    await server.openUserLaneGrant(HOME_SPACE, "", LANE_PRINCIPAL);
    const laneKey = userExecutionContextKey(
      LANE_PRINCIPAL,
    ) as SchedulerExecutionContextKey;

    // Space-lane claim (bound under SPONSOR) and a user-lane claim (bound
    // under LANE_PRINCIPAL), both reading B, distinct actions.
    const spaceClaim = await server.setExecutionClaim(
      harness.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    const laneClaim = await server.trySetExecutionClaim(
      harness.lease,
      claimInput(laneKey, "action:xsp-idle-lane-reader"),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertExists(laneClaim, "the user-lane cross-space claim issued");
    assert(server.hasLiveExecutionClaim(spaceClaim));
    assert(server.hasLiveExecutionClaim(laneClaim));

    // Bump ONLY the sponsor's B epoch: the space-lane claim revokes; the
    // user-lane claim (bound under LANE_PRINCIPAL, unbumped) survives.
    await harness.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [LANE_PRINCIPAL]: "READ",
      [OTHER]: "WRITE",
    });
    assert(!server.hasLiveExecutionClaim(spaceClaim), "sponsor claim revoked");
    assert(
      server.hasLiveExecutionClaim(laneClaim),
      "the lane-principal claim survives an unrelated principal's bump (C3A4)",
    );

    // Now bump the LANE principal's B epoch: the user-lane claim revokes.
    await harness.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [OTHER]: "WRITE",
    });
    assert(
      !server.hasLiveExecutionClaim(laneClaim),
      "the lane-principal claim revoked on the LANE principal's B-access loss",
    );
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (b) the REMOTE-inbound bump path.
// ---------------------------------------------------------------------------

Deno.test("C3.7 (b): an inbound foreign-authorization-epoch.bump for B (no local commit) revokes the home claim through the cache", async () => {
  const harness = await setupHarness("xsp-idle-remote");
  const { server } = harness;
  try {
    const claim = await server.setExecutionClaim(harness.lease, claimInput(), {
      foreignReadSpaces: [READ_SPACE],
    });
    assert(server.hasLiveExecutionClaim(claim), "claim live");

    // Inject a bump for the sponsor on B directly over the transport — no B
    // ACL commit, so the LOCAL arm never fires; the remote cache is the sole
    // mover. A high epoch guarantees it exceeds the bound generation.
    server.crossSpaceRouter().link(READ_SPACE, HOME_SPACE).send({
      type: "foreign-authorization-epoch.bump",
      target: { kind: "principal", principal: SPONSOR },
      epoch: 999,
    });
    await server.settleCrossSpaceDeliveries();
    assert(
      !server.hasLiveExecutionClaim(claim),
      "the remote-inbound bump revoked the home claim",
    );
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (d) re-issuance under the new epoch; re-issue after READ loss soft-declines.
// ---------------------------------------------------------------------------

Deno.test("C3.7 (d)/C3A3: after a bump-revoke a re-issued claim binds the NEW epoch; a re-issue after READ loss soft-declines", async () => {
  const harness = await setupHarness("xsp-idle-reissue");
  const { server } = harness;
  try {
    const first = await server.setExecutionClaim(harness.lease, claimInput(), {
      foreignReadSpaces: [READ_SPACE],
    });
    assert(server.hasLiveExecutionClaim(first));

    // Bump the sponsor's B generation while KEEPING READ (READ → WRITE ⊇
    // READ): the first claim revokes, the sponsor still holds B READ.
    await harness.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
      [LANE_PRINCIPAL]: "READ",
      [OTHER]: "WRITE",
    });
    assert(!server.hasLiveExecutionClaim(first), "first claim revoked");

    // Re-issue: the preflight re-reads the CURRENT epoch, so the re-issued
    // claim binds the new generation.
    const reissued = await server.setExecutionClaim(
      harness.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assert(server.hasLiveExecutionClaim(reissued), "re-issue succeeded");

    // Proof it bound the NEW epoch: an inbound bump AT the current epoch does
    // not revoke it (a stale binding at the old epoch WOULD be revoked, since
    // the current effective strictly exceeds it).
    const linkId = readLinkId(server);
    const currentEpoch = server.effectiveRemoteAuthorizationEpoch(
      linkId,
      READ_SPACE,
      SPONSOR,
    );
    assertExists(currentEpoch, "the sponsor's B epoch is known via the cache");
    server.crossSpaceRouter().link(READ_SPACE, HOME_SPACE).send({
      type: "foreign-authorization-epoch.bump",
      target: { kind: "principal", principal: SPONSOR },
      epoch: currentEpoch,
    });
    await server.settleCrossSpaceDeliveries();
    assert(
      server.hasLiveExecutionClaim(reissued),
      "the re-issued claim survives a bump at the epoch it bound (bound NEW)",
    );

    // Now the sponsor LOSES B READ: a re-issue soft-declines (trySet ⇒ null).
    server.revokeExecutionClaim(reissued);
    await harness.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [LANE_PRINCIPAL]: "READ",
      [OTHER]: "WRITE",
    });
    const declined = await server.trySetExecutionClaim(
      harness.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertEquals(declined, null, "re-issue after READ loss soft-declines");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (e) fail-closed: an unknown effective epoch revokes.
// ---------------------------------------------------------------------------

Deno.test("C3.7 (e)/C3A3: an unknown effective epoch (cache eviction/restart) fails closed and revokes", async () => {
  const harness = await setupHarness("xsp-idle-failclosed");
  const { server } = harness;
  try {
    const claim = await server.setExecutionClaim(harness.lease, claimInput(), {
      foreignReadSpaces: [READ_SPACE],
    });
    assert(server.hasLiveExecutionClaim(claim));

    // Revalidate against a link incarnation this host has learned NOTHING
    // about (models a reconnect/restart that cleared the epoch cache): the
    // effective remote epoch is undefined → fail closed → revoke.
    assertEquals(
      server.effectiveRemoteAuthorizationEpoch(
        "link:post-restart-unknown",
        READ_SPACE,
        SPONSOR,
      ),
      undefined,
      "the (link, space) is genuinely unknown",
    );
    const revoked = server.revalidateCrossSpaceReadClaimsAgainstRemoteEpoch(
      READ_SPACE,
      "link:post-restart-unknown",
    );
    assertEquals(
      revoked,
      1,
      "the unknown-epoch claim was revoked (fail closed)",
    );
    assert(!server.hasLiveExecutionClaim(claim), "claim gone");
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (f) regression: same-space claims carry no binding; C3.7 paths dormant.
// ---------------------------------------------------------------------------

Deno.test("C3.7 (f): a same-space claim carries no binding — a B ACL bump and an inbound bump both leave it untouched; ordinary revoke still works", async () => {
  const harness = await setupHarness("xsp-idle-regression");
  const { server } = harness;
  try {
    const sameSpace = await server.setExecutionClaim(
      harness.lease,
      claimInput(),
    );
    assertEquals("crossSpaceReadSpaces" in sameSpace, false);
    assert(server.hasLiveExecutionClaim(sameSpace));

    // A B ACL bump — the local arm scans, finds no binding for this claim.
    await harness.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [OTHER]: "WRITE",
    });
    // An inbound bump for B — the remote arm scans, finds no binding.
    server.crossSpaceRouter().link(READ_SPACE, HOME_SPACE).send({
      type: "foreign-authorization-epoch.bump",
      target: { kind: "floor" },
      epoch: 999,
    });
    await server.settleCrossSpaceDeliveries();
    assert(
      server.hasLiveExecutionClaim(sameSpace),
      "the same-space claim is untouched by C3.7's revocation paths",
    );

    // The ordinary revoke path still works byte-identically.
    assert(server.revokeExecutionClaim(sameSpace), "explicit revoke works");
    assert(!server.hasLiveExecutionClaim(sameSpace));
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// (c) C3A6 cleanup: subscription refcount + the mirror-tombstone ruling.
// ---------------------------------------------------------------------------

Deno.test("C3.7 (c)/C3A6: a bump-revoke unsubscribes the demand pair only when it is the LAST claim reading B; the mirror rows are not tombstoned", async () => {
  setPersistentSchedulerStateConfig(true);
  const harness = await setupHarness("xsp-idle-cleanup");
  const { server } = harness;
  try {
    // The sponsor's own session lane, so the cross-space mirrored reader (a
    // cross-space summary floors at SESSION context — the wake pipeline's
    // conservative posture) has a matching subscription pair and B commits
    // actually emit notices toward HOME.
    await server.openSessionLaneGrant(
      HOME_SPACE,
      "",
      SPONSOR,
      harness.sponsor.sessionId,
    );
    // A user lane owned by LANE_PRINCIPAL, so two cross-space claims under
    // different principals can co-exist (the refcount has two entries).
    const laneClient = await harness.connect();
    await harness.mount(laneClient, HOME_SPACE, LANE_PRINCIPAL);
    await server.openUserLaneGrant(HOME_SPACE, "", LANE_PRINCIPAL);
    const laneKey = userExecutionContextKey(
      LANE_PRINCIPAL,
    ) as SchedulerExecutionContextKey;

    // Tap the notices B sends toward HOME's inbox.
    const staleNotices: string[] = [];
    server.crossSpaceRouter().transport.channelTo(HOME_SPACE).onMessage(
      (wire) => {
        const parsed = parseCrossSpaceMessage(wire);
        if (parsed.ok && parsed.message.type === "foreign-stale-readers") {
          staleNotices.push(parsed.message.type);
        }
      },
    );
    const otherClient = await harness.connect();
    const otherB = await harness.mount(otherClient, READ_SPACE, OTHER);
    let otherSeq = 0;
    const commitToB = async (value: number) => {
      await otherB.transact({
        localSeq: ++otherSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: FOREIGN_DOC, value: { value } }],
      });
      await server.settleForeignReaderSubscriptions();
      await server.settleCrossSpaceDeliveries();
    };

    const spaceClaim = await server.setExecutionClaim(
      harness.lease,
      claimInput(),
      { foreignReadSpaces: [READ_SPACE] },
    );
    const laneClaim = await server.trySetExecutionClaim(
      harness.lease,
      claimInput(laneKey, "action:xsp-idle-cleanup-lane"),
      { foreignReadSpaces: [READ_SPACE] },
    );
    assertExists(laneClaim);

    // Serve one claimed foreign read + commit its observation: this plants
    // the executor MIRROR rows in READ_SPACE's engine and the home read-index
    // row that drives the subscription reconciler.
    const outcome = await server.executorForeignPointRead(harness.lease, {
      readSpace: READ_SPACE,
      claim: claimRefOf(spaceClaim),
      address: { id: FOREIGN_DOC },
    });
    assert(outcome.status === "served", "point read served");
    await harness.sponsor.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: HOME_OUTPUT, value: { value: 42 } }],
      schedulerObservation: claimedObservation(spaceClaim, [
        { space: READ_SPACE, id: FOREIGN_DOC, seq: outcome.seq },
      ]),
    });
    await server.settleForeignReaderSubscriptions();
    await server.settleCrossSpaceDeliveries();

    const readRegistry = () =>
      server.foreignReaderSubscriptionsByReadSpace.get(READ_SPACE);
    assertExists(readRegistry(), "a foreign-reader subscription is live on B");
    const mirrorRowsBefore = await mirrorRowCountForHome(server);
    assert(mirrorRowsBefore > 0, "the observation planted mirror rows in B");

    // While the subscription is LIVE, a B commit against the mirrored doc
    // emits a stale-reader notice toward HOME — the demand the C3A6 cleanup
    // must retire once the last authorized reader is gone.
    await commitToB(101);
    assert(staleNotices.length >= 1, "a live subscription wakes on B commits");
    const noticesWhileLive = staleNotices.length;

    // Bump ONLY the sponsor's B epoch: the space-lane claim revokes, but the
    // lane-principal claim still reads B — the subscription is REFCOUNTED and
    // must PERSIST.
    await harness.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [LANE_PRINCIPAL]: "READ",
      [OTHER]: "WRITE",
    });
    assert(!server.hasLiveExecutionClaim(spaceClaim), "space claim revoked");
    assert(server.hasLiveExecutionClaim(laneClaim), "lane claim survives");
    assertExists(
      readRegistry(),
      "the subscription survives while another claim still reads B",
    );

    // Bump the LANE principal's B epoch: the last claim reading B revokes →
    // the demand pair unsubscribes (the read host stops emitting notices).
    await harness.rewriteReadAcl({
      [ADMIN]: "OWNER",
      [OTHER]: "WRITE",
    });
    assert(!server.hasLiveExecutionClaim(laneClaim), "lane claim revoked");
    assertEquals(
      readRegistry(),
      undefined,
      "the last-claim revoke unsubscribed the demand pair (C3A6 (a))",
    );

    // The fourth acceptance clause, literally: after the LAST authorized
    // reader lost access, B emits NO further ForeignStaleReaders for that
    // demand — a B commit that woke HOME moments ago now wakes nothing.
    await commitToB(102);
    assertEquals(
      staleNotices.length,
      noticesWhileLive,
      "B emits no further ForeignStaleReaders once the last reader lost access",
    );

    // C3A6 (b) ruling pinned: the executor mirror rows are UPSERT-ONLY and
    // read-surface-derived — a revoke does NOT tombstone them. Every mirror
    // row the observation planted is still in READ_SPACE's engine after both
    // claims were revoked (the read-surface path, not the revocation, owns
    // their retraction).
    assertEquals(
      await mirrorRowCountForHome(server),
      mirrorRowsBefore,
      "mirror rows persist after revocation (not tombstoned — C3A6 (b))",
    );
  } finally {
    await harness.close();
    resetPersistentSchedulerStateConfig();
  }
});
