// C3.3b — executor-authored observation mirroring under the C3A5
// acting-principal READ rule: the mirror SEND gate keys on the
// observation's ACTING principal holding READ on the read space (the
// same `#capabilityFor` resolution enforcement uses, at send time,
// against the read space's current ACL state), replacing C3.1b's
// open-session-of-the-writing-principal predicate — which was
// connection-liveness-blind (never true for a headless sponsor: the
// cold-start wake hole) and checked the wrong principal for scoped
// lanes. Denial is a silent drop of the mirror only, counted in
// `executionStats.crossSpaceMirrorsWithheld`.
//
// Pre-C3.5 the engine's claimed-action firewall still rejects foreign
// READ addresses on SERVED attempts (`foreign-space-surface`, C3A2 —
// the relax is C3.5's), so the executor-authored foreign-reading rows
// that exist today are UNSERVED-attempt discovery rows: a claimed
// attempt reporting `executionUnservedAttempt` persists its discovered
// foreign surface without provenance, floored at the acting identity's
// session context (`schedulerStaticContextFloor`'s crossesSpace rule).
// These fixtures drive exactly that channel; C3.11's two-space gate
// re-covers both C3.3 halves once C3.5/C3.6 relax served attempts.
//
// Fixture map (plan row C3.3b; amendment C3A5):
//  (a) executor-authored (claimed, space-lane sponsor) observation with
//      a foreign read mirrors when the SPONSOR holds READ on B, with the
//      sponsor holding NO open session on B (headless), and the C3.3a
//      wake pipeline fires end-to-end from the mirrored row: B's commit
//      produces exactly one notice-driven foreign wake. Doubles as
//  (d) the old predicate's false-negative closed: the sponsor has no
//      open session anywhere on B and the mirror flows anyway (reverting
//      to the open-session predicate reds this fixture).
//  (b) scoped-lane claimed observations gate on the LANE principal's
//      READ, not the sponsor's — user and session legs, plus the
//      converse: the lane principal without B READ is withheld even
//      while the SPONSOR holds B READ.
//  (c) denial: the acting principal lacks READ on B (enforcing ACL
//      excludes them) — no mirror frame is SENT, zero scheduler rows
//      exist in B for the action (direct engine inspection — the
//      write-bypass hole closed), the withheld counter increments, the
//      home observation is intact, and B commits wake nothing.
//  (e) implicit-access B (no ACL doc, empty space): mirrors flow per
//      the implicit READ semantics of `#resolveCapability`.
//  (f) client-observation regression: a client principal holding READ
//      on B mirrors WITHOUT an open session on B (the liveness
//      blindness closed for the client class under the same rule); the
//      acl-off client tests (carriage/wake suites) pin byte-identical
//      behavior for the unchanged path.
//
// Barrier-driven throughout: every await is a transact response, the
// server's cross-space/subscription settle barriers, or a bounded
// microtask spin on synchronous engine state — no sleeps.
import { assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import type { ForeignWakeEvent } from "../v2/server.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";
import {
  resetPersistentSchedulerStateConfig,
  resetServerPrimaryExecutionClaimRankConfig,
  type ServerPrimaryExecutionClaimRank,
  setPersistentSchedulerStateConfig,
  setServerPrimaryExecutionClaimRankConfig,
} from "../v2.ts";
import {
  type CrossSpaceMessage,
  type ForeignObservationMirror,
  parseCrossSpaceMessage,
} from "../v2/cross-space.ts";

const HOME_SPACE = "did:key:z6Mk-xsp-mirror-gate-home";
const READ_SPACE = "did:key:z6Mk-xsp-mirror-gate-read";
const ADMIN = "did:key:z6Mk-xsp-mirror-gate-admin";
const SPONSOR = "did:key:z6Mk-xsp-mirror-gate-sponsor";
const ALICE = "did:key:z6Mk-xsp-mirror-gate-alice";
const OTHER = "did:key:z6Mk-xsp-mirror-gate-other";
const AUDIENCE = "did:key:z6Mk-xsp-mirror-gate-audience";

const PIECE_ROOT = "of:xsp-mirror-gate:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:xsp-mirror-gate-reader";

const FOREIGN_SOURCE: SchedulerObservationAddress = {
  space: READ_SPACE,
  id: "of:xsp-mirror-gate:source",
  scope: "space",
  path: ["value"],
};
const HOME_OUTPUT: SchedulerObservationAddress = {
  space: HOME_SPACE,
  id: "of:xsp-mirror-gate:output",
  scope: "space",
  path: ["value"],
};

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
};

/** Opaque host-API lease handle (identity is what matters, not shape). */
type ExecutionLeaseHandle = object;

type ExecutionClaim = {
  contextKey: SchedulerExecutionContextKey;
  leaseGeneration: number;
  claimGeneration: number;
};

type GateServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  setExecutionClaim(
    lease: ExecutionLeaseHandle,
    claim: {
      branch: string;
      space: string;
      contextKey: SchedulerExecutionContextKey;
      pieceId: string;
      actionId: string;
      actionKind: "computation";
      implementationFingerprint: string;
      runtimeFingerprint: string;
    },
  ): Promise<ExecutionClaim>;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<{ contextKey: string; laneGeneration: number }>;
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<{ contextKey: string; laneGeneration: number }>;
};

/** Test-only reach into declared-private server internals (the soft-
 * private convention the carriage/wake tests established). */
type GateServerInternals = {
  settleForeignReaderSubscriptions(): Promise<void>;
  settleCrossSpaceDeliveries(): Promise<void>;
  openEngine(space: string): Promise<Engine.Engine>;
};

const internalsOf = (server: Server): GateServerInternals =>
  server as unknown as GateServerInternals;

const createGateServer = (name: string): GateServer =>
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
      acl: { mode: "enforce", serviceDids: [ADMIN] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as GateServer;

const connectGateClient = async (
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
  space: string,
  principal: string,
): Promise<ExecutionSession> =>
  await client.mount(space, {}, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

/** ACL-only genesis/mutation commit (default branch, single space-scoped
 * set of the ACL doc — the required shape). */
const writeAcl = async (
  session: ExecutionSession,
  localSeq: number,
  space: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  await session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${space}`,
      value: { value: acl },
    }],
  });
};

/** Tap every frame crossing the server's in-process transport (the
 * loopback channel broadcasts to all onMessage handlers). */
const tapCrossSpaceFrames = (server: Server): CrossSpaceMessage[] => {
  const frames: CrossSpaceMessage[] = [];
  server.crossSpaceRouter().transport.channelTo(HOME_SPACE).onMessage(
    (wire) => {
      const parsed = parseCrossSpaceMessage(wire);
      if (parsed.ok) frames.push(parsed.message);
    },
  );
  return frames;
};

const mirrorFrames = (
  frames: readonly CrossSpaceMessage[],
): ForeignObservationMirror[] =>
  frames.filter(
    (frame): frame is ForeignObservationMirror =>
      frame.type === "foreign-observation.mirror",
  );

/** The pre-C3.5 executor-authored foreign-read shape: an UNSERVED
 * claimed attempt whose observation carries the discovered foreign
 * surface (the served-attempt firewall relax is C3.5's — see the file
 * header). */
const unservedForeignObservation = (
  claim: ExecutionClaim,
  actionId = ACTION_ID,
): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: HOME_SPACE,
  branch: "",
  pieceId: SCHEDULER_PIECE_ID,
  processGeneration: 1,
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:xsp-mirror-gate",
  runtimeFingerprint: "runtime:xsp-mirror-gate",
  executionClaimAssertion: {
    contextKey: claim.contextKey,
    leaseGeneration: claim.leaseGeneration,
    claimGeneration: claim.claimGeneration,
  },
  executionUnservedAttempt: { diagnosticCode: "foreign-read-space" },
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [FOREIGN_SOURCE],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [HOME_OUTPUT],
  declaredWrites: [HOME_OUTPUT],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: "impl:xsp-mirror-gate",
    runtimeFingerprint: "runtime:xsp-mirror-gate",
    piece: { space: HOME_SPACE, id: PIECE_ROOT, scope: "space", path: [] },
    reads: [FOREIGN_SOURCE],
    writes: [HOME_OUTPUT],
    materializerWriteEnvelopes: [],
    directOutputs: [HOME_OUTPUT],
  },
  status: "success",
});

/** Plain CLIENT observation (no claim assertion) reading the foreign
 * source — the C3.1b/C3.3a client-mirrored shape. */
const clientForeignObservation = (
  actionId = ACTION_ID,
): SchedulerActionObservation => {
  const {
    executionClaimAssertion: _claim,
    executionUnservedAttempt: _unserved,
    ...observation
  } = unservedForeignObservation(
    { contextKey: "space", leaseGeneration: 0, claimGeneration: 0 },
    actionId,
  );
  return observation as SchedulerActionObservation;
};

const claimInput = (
  contextKey: SchedulerExecutionContextKey,
  actionId = ACTION_ID,
) => ({
  branch: "",
  space: HOME_SPACE,
  contextKey,
  pieceId: SCHEDULER_PIECE_ID,
  actionId,
  actionKind: "computation" as const,
  implementationFingerprint: "impl:xsp-mirror-gate",
  runtimeFingerprint: "runtime:xsp-mirror-gate",
});

/** Snapshot rows a space's engine holds for the HOME-owned action —
 * mirror evidence on the read engine, home evidence on the home one. */
const actionSnapshots = (
  engine: Engine.Engine,
  actionId = ACTION_ID,
) =>
  Engine.listSchedulerActionSnapshots(engine, {
    branch: "",
    ownerSpace: HOME_SPACE,
    pieceId: SCHEDULER_PIECE_ID,
    actionId,
  }).snapshots;

/** Direct engine inspection for the (c) write-bypass assertion: count
 * EVERY scheduler row the read engine holds for the home owner space —
 * reader/snapshot/state/write rows all ride the mirror upsert, so all
 * must be zero when the mirror was withheld. */
const schedulerRowsForOwner = (
  engine: Engine.Engine,
  ownerSpace: string,
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (
    const table of [
      "scheduler_action_snapshot",
      "scheduler_action_state",
      "scheduler_read_index",
      "scheduler_write_index",
    ]
  ) {
    counts[table] = (engine.database.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE owner_space = :owner`,
    ).get({ owner: ownerSpace }) as { n: number }).n;
  }
  return counts;
};

const ZERO_OWNER_ROWS = {
  scheduler_action_snapshot: 0,
  scheduler_action_state: 0,
  scheduler_read_index: 0,
  scheduler_write_index: 0,
};

/** Stand up the executor plane on HOME: demand → lease → bind → claim.
 * The demand and the bound session both belong to the SPONSOR session
 * (the C1.4 shape: the bound executor session's principal IS the lease
 * sponsor). Returns the claim and the unbind hook. */
const claimAs = async (
  server: GateServer,
  sponsorSession: ExecutionSession,
  contextKey: SchedulerExecutionContextKey,
  rank?: ServerPrimaryExecutionClaimRank,
): Promise<{
  claim: ExecutionClaim;
  lease: ExecutionLeaseHandle;
  unbind: () => void;
}> => {
  await sponsorSession.setExecutionDemand("", [PIECE_ROOT]);
  const lease = await server.acquireExecutionLease(HOME_SPACE, "");
  assertExists(lease, "sponsor lease");
  const unbind = server.bindExecutionSession(
    HOME_SPACE,
    sponsorSession.sessionId,
    lease,
  );
  const claim = await issueClaim(server, lease, contextKey, ACTION_ID, rank);
  return { claim, lease, unbind };
};

const issueClaim = async (
  server: GateServer,
  lease: ExecutionLeaseHandle,
  contextKey: SchedulerExecutionContextKey,
  actionId: string,
  rank?: ServerPrimaryExecutionClaimRank,
): Promise<ExecutionClaim> => {
  if (rank !== undefined) setServerPrimaryExecutionClaimRankConfig(rank);
  try {
    return await server.setExecutionClaim(
      lease,
      claimInput(contextKey, actionId),
    );
  } finally {
    if (rank !== undefined) resetServerPrimaryExecutionClaimRankConfig();
  }
};

Deno.test("C3.3b (a)+(d): a headless sponsor's claimed space-lane observation mirrors under the sponsor's B READ and the C3.3a wake pipeline fires end-to-end", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createGateServer("xsp-mirror-gate-e2e");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const adminClient = await connectGateClient(server);
  const sponsorClient = await connectGateClient(server);
  const otherClient = await connectGateClient(server);
  const wakes: ForeignWakeEvent[] = [];
  server.subscribeForeignWakes(HOME_SPACE, (event) => {
    wakes.push(event);
  });
  let unbind = () => {};
  try {
    // Enforcing ACLs: the sponsor holds WRITE at home and READ on B —
    // and NEVER opens a session on B (the (d) headless shape; B is
    // hosted and committed to by OTHER only).
    const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
    const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
    await writeAcl(adminHome, 1, HOME_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
    });
    await writeAcl(adminRead, 1, READ_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "READ",
      [OTHER]: "WRITE",
    });
    const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
    const reader = await mountAs(otherClient, READ_SPACE, OTHER);
    await sponsor.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:xsp-mirror-gate:seed",
        value: { value: 1 },
      }],
    });

    const { claim, unbind: unbindSession } = await claimAs(
      server,
      sponsor,
      "space",
    );
    unbind = unbindSession;
    const sponsorContextKey = Engine.sessionExecutionContextKey(
      SPONSOR,
      sponsor.sessionId,
    ) as SchedulerExecutionContextKey;

    // The executor's unserved attempt lands the discovery row home-side
    // at the sponsor's session context (crossing floor) ...
    await sponsor.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: unservedForeignObservation(claim),
    });
    const homeEngine = await internals.openEngine(HOME_SPACE);
    const homeSnapshots = actionSnapshots(homeEngine);
    assertEquals(homeSnapshots.length, 1, "home discovery row");
    assertEquals(homeSnapshots[0].executionContextKey, sponsorContextKey);

    // ... and the mirror flowed to B under the sponsor's READ — with no
    // open session of the sponsor on B (the old predicate's false
    // negative, closed).
    const mirrors = mirrorFrames(frames);
    assertEquals(mirrors.length, 1, "exactly one mirror frame");
    assertEquals(mirrors[0].fromSpace, HOME_SPACE);
    assertEquals(mirrors[0].toSpace, READ_SPACE);
    assertEquals(mirrors[0].originExecutionContextKey, sponsorContextKey);
    assertEquals(mirrors[0].scopeContext, {
      principal: SPONSOR,
      sessionId: sponsor.sessionId,
    });
    assertEquals(mirrors[0].writerSessionId, sponsorContextKey);
    const readEngine = await internals.openEngine(READ_SPACE);
    const mirrored = actionSnapshots(readEngine);
    assertEquals(mirrored.length, 1, "mirrored row in B");
    assertEquals(mirrored[0].executionContextKey, sponsorContextKey);
    assertEquals(server.executionStats.crossSpaceMirrorsWithheld, 0);

    // C3.3a pipeline from the executor-authored row: the sponsor's
    // session lane joins the subscription (the row's context IS that
    // lane). Registration replays the C3A9 read-to-mirror window mark
    // as ONE catch-up wake first: B's ACL genesis predates the mirror
    // upsert, so the conservative window closure marked the action
    // dirty at B's then-current seq and the C3A10 post-ack scan
    // surfaces it — the executor row rides the same soundness
    // machinery as client rows.
    await server.openSessionLaneGrant(
      HOME_SPACE,
      "",
      SPONSOR,
      sponsor.sessionId,
    );
    await sponsor.setExecutionDemand("", [PIECE_ROOT]);
    await internals.settleForeignReaderSubscriptions();
    assertEquals(wakes.length, 1, "the C3A9 window mark replays as a wake");
    assertEquals(wakes[0].origin, "resubscribe-scan");

    // The live leg: B commits against the mirrored read — exactly one
    // notice-driven wake for the executor-authored row.
    await reader.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: FOREIGN_SOURCE.id,
        value: { value: "b-commit" },
      }],
    });
    await internals.settleForeignReaderSubscriptions();
    assertEquals(wakes.length, 2, "exactly one notice-driven foreign wake");
    assertEquals(wakes[1].space, HOME_SPACE);
    assertEquals(wakes[1].readSpace, READ_SPACE);
    assertEquals(wakes[1].origin, "notice");
    assertEquals(wakes[1].readSeq, 2, "B's commit seq, B's clock");
    assertEquals(wakes[1].staleForeignReaders, [{
      branch: "",
      pieceId: SCHEDULER_PIECE_ID,
      processGeneration: 1,
      actionId: ACTION_ID,
      executionContextKey: sponsorContextKey,
    }]);
  } finally {
    unbind();
    await otherClient.close().catch(() => {});
    await sponsorClient.close().catch(() => {});
    await adminClient.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.3b (b): a user-lane claimed observation gates on the LANE principal's B READ, not the sponsor's — both directions", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createGateServer("xsp-mirror-gate-user-lane");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const adminClient = await connectGateClient(server);
  const sponsorClient = await connectGateClient(server);
  const aliceClient = await connectGateClient(server);
  const otherClient = await connectGateClient(server);
  let unbind = () => {};
  try {
    // Leg 1: ALICE (the lane principal) holds READ on B; the SPONSOR
    // holds NOTHING on B. The lane's mirror must flow.
    const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
    const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
    await writeAcl(adminHome, 1, HOME_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
      [ALICE]: "WRITE",
    });
    await writeAcl(adminRead, 1, READ_SPACE, {
      [ADMIN]: "OWNER",
      [ALICE]: "READ",
      [OTHER]: "WRITE",
    });
    const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
    // ALICE's home session anchors her lane; she never mounts B either.
    await mountAs(aliceClient, HOME_SPACE, ALICE);
    // OTHER's session keeps B hosted so the gate — not hosting — is
    // what decides every send below.
    await mountAs(otherClient, READ_SPACE, OTHER);
    await sponsor.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:xsp-mirror-gate:seed",
        value: { value: 1 },
      }],
    });

    await server.openUserLaneGrant(HOME_SPACE, "", ALICE);
    const { claim, lease, unbind: unbindSession } = await claimAs(
      server,
      sponsor,
      Engine.userExecutionContextKey(ALICE) as SchedulerExecutionContextKey,
      "user",
    );
    unbind = unbindSession;
    await sponsor.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: unservedForeignObservation(claim),
    });

    // The crossing floor parks the user-lane row at the LANE principal's
    // session rank, scope-anchored at the committing (sponsor) session.
    const laneContextKey = Engine.sessionExecutionContextKey(
      ALICE,
      sponsor.sessionId,
    ) as SchedulerExecutionContextKey;
    const homeEngine = await internals.openEngine(HOME_SPACE);
    assertEquals(
      actionSnapshots(homeEngine).map((row) => row.executionContextKey),
      [laneContextKey],
      "home row at the lane principal's context",
    );
    const mirrors = mirrorFrames(frames);
    assertEquals(mirrors.length, 1, "the lane's mirror flowed");
    assertEquals(mirrors[0].originExecutionContextKey, laneContextKey);
    assertEquals(mirrors[0].scopeContext, {
      principal: ALICE,
      sessionId: sponsor.sessionId,
    });
    const readEngine = await internals.openEngine(READ_SPACE);
    assertEquals(
      actionSnapshots(readEngine).map((row) => row.executionContextKey),
      [laneContextKey],
      "mirrored row in B under the lane context",
    );
    assertEquals(server.executionStats.crossSpaceMirrorsWithheld, 0);

    // Leg 2 (the converse): flip B's ACL — ALICE loses READ, the
    // SPONSOR gains it — and run a SECOND action on the same lane. Its
    // mirror must be withheld: the gate keys on the LANE principal's
    // access at send time, and the sponsor's own READ must not leak
    // into the lane's authority.
    await writeAcl(adminRead, 2, READ_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "READ",
      [OTHER]: "WRITE",
    });
    const secondActionId = `${ACTION_ID}-2`;
    const secondClaim = await issueClaim(
      server,
      lease,
      Engine.userExecutionContextKey(ALICE) as SchedulerExecutionContextKey,
      secondActionId,
      "user",
    );
    await sponsor.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: unservedForeignObservation(
        secondClaim,
        secondActionId,
      ),
    });
    assertEquals(
      mirrorFrames(frames).length,
      1,
      "no second mirror frame — withheld at the send gate",
    );
    assertEquals(server.executionStats.crossSpaceMirrorsWithheld, 1);
    // The second action never reached B; the first action's row (sent
    // while the lane held READ) is untouched — C3.7 owns revocation
    // cleanup of already-mirrored rows (C3A6).
    assertEquals(
      actionSnapshots(readEngine, secondActionId).length,
      0,
      "the withheld action has no mirrored row in B",
    );
    assertEquals(actionSnapshots(readEngine).length, 1);
    // Home-side the second observation landed — only its mirror was
    // withheld.
    assertEquals(
      actionSnapshots(homeEngine, secondActionId).map((row) =>
        row.executionContextKey
      ),
      [laneContextKey],
    );
  } finally {
    unbind();
    resetServerPrimaryExecutionClaimRankConfig();
    await otherClient.close().catch(() => {});
    await aliceClient.close().catch(() => {});
    await sponsorClient.close().catch(() => {});
    await adminClient.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.3b (b): a session-lane claimed observation mirrors under the LANE principal's B READ at the grant's own session", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createGateServer("xsp-mirror-gate-session-lane");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const adminClient = await connectGateClient(server);
  const sponsorClient = await connectGateClient(server);
  const aliceClient = await connectGateClient(server);
  const otherClient = await connectGateClient(server);
  let unbind = () => {};
  try {
    const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
    const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
    await writeAcl(adminHome, 1, HOME_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
      [ALICE]: "WRITE",
    });
    await writeAcl(adminRead, 1, READ_SPACE, {
      [ADMIN]: "OWNER",
      [ALICE]: "READ",
      [OTHER]: "WRITE",
    });
    const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
    const alice = await mountAs(aliceClient, HOME_SPACE, ALICE);
    await mountAs(otherClient, READ_SPACE, OTHER);
    await sponsor.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:xsp-mirror-gate:seed",
        value: { value: 1 },
      }],
    });

    const laneContextKey = Engine.sessionExecutionContextKey(
      ALICE,
      alice.sessionId,
    ) as SchedulerExecutionContextKey;
    await server.openSessionLaneGrant(HOME_SPACE, "", ALICE, alice.sessionId);
    const { claim, unbind: unbindSession } = await claimAs(
      server,
      sponsor,
      laneContextKey,
      "session",
    );
    unbind = unbindSession;
    await sponsor.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: unservedForeignObservation(claim),
    });

    // The session lane acts as the GRANT's session (CA8): the row, the
    // mirror's origin key, and the mirror's scope context all carry the
    // lane's own {principal, sessionId} — never the sponsor's.
    const mirrors = mirrorFrames(frames);
    assertEquals(mirrors.length, 1, "the session lane's mirror flowed");
    assertEquals(mirrors[0].originExecutionContextKey, laneContextKey);
    assertEquals(mirrors[0].scopeContext, {
      principal: ALICE,
      sessionId: alice.sessionId,
    });
    const readEngine = await internals.openEngine(READ_SPACE);
    assertEquals(
      actionSnapshots(readEngine).map((row) => row.executionContextKey),
      [laneContextKey],
      "mirrored row in B under the session-lane context",
    );
    assertEquals(server.executionStats.crossSpaceMirrorsWithheld, 0);
  } finally {
    unbind();
    resetServerPrimaryExecutionClaimRankConfig();
    await otherClient.close().catch(() => {});
    await aliceClient.close().catch(() => {});
    await sponsorClient.close().catch(() => {});
    await adminClient.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.3b (c): an acting principal without B READ produces zero mirror rows and zero wake; the home observation is intact and the counter names the denial", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createGateServer("xsp-mirror-gate-denial");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const adminClient = await connectGateClient(server);
  const sponsorClient = await connectGateClient(server);
  const otherClient = await connectGateClient(server);
  const wakes: ForeignWakeEvent[] = [];
  server.subscribeForeignWakes(HOME_SPACE, (event) => {
    wakes.push(event);
  });
  let unbind = () => {};
  try {
    // B's enforcing ACL excludes the sponsor entirely; B is hosted and
    // live via OTHER, so the SEND gate — not hosting — decides.
    const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
    const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
    await writeAcl(adminHome, 1, HOME_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
    });
    await writeAcl(adminRead, 1, READ_SPACE, {
      [ADMIN]: "OWNER",
      [OTHER]: "WRITE",
    });
    const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
    const reader = await mountAs(otherClient, READ_SPACE, OTHER);
    await sponsor.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:xsp-mirror-gate:seed",
        value: { value: 1 },
      }],
    });

    const { claim, unbind: unbindSession } = await claimAs(
      server,
      sponsor,
      "space",
    );
    unbind = unbindSession;
    await sponsor.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: unservedForeignObservation(claim),
    });
    await internals.settleCrossSpaceDeliveries();

    // Send-side withhold: no mirror frame even ENTERED the transport.
    assertEquals(mirrorFrames(frames).length, 0, "no mirror frame sent");
    assertEquals(server.executionStats.crossSpaceMirrorsWithheld, 1);
    // The write-bypass hole closed: direct engine inspection shows B
    // holds NO scheduler rows for the home owner space — no reader
    // rows, no snapshots, no state, nothing to plant.
    const readEngine = await internals.openEngine(READ_SPACE);
    assertEquals(schedulerRowsForOwner(readEngine, HOME_SPACE), {
      ...ZERO_OWNER_ROWS,
    });
    // The home observation is intact — only the mirror was withheld.
    const homeEngine = await internals.openEngine(HOME_SPACE);
    const sponsorContextKey = Engine.sessionExecutionContextKey(
      SPONSOR,
      sponsor.sessionId,
    ) as SchedulerExecutionContextKey;
    assertEquals(
      actionSnapshots(homeEngine).map((row) => row.executionContextKey),
      [sponsorContextKey],
    );

    // And zero wake: with no mirrored row, B's commits dirty nothing
    // for the home action even with demand and lanes registered.
    await server.openSessionLaneGrant(
      HOME_SPACE,
      "",
      SPONSOR,
      sponsor.sessionId,
    );
    await sponsor.setExecutionDemand("", [PIECE_ROOT]);
    await internals.settleForeignReaderSubscriptions();
    await reader.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: FOREIGN_SOURCE.id,
        value: { value: "b-commit" },
      }],
    });
    await internals.settleForeignReaderSubscriptions();
    assertEquals(wakes.length, 0, "zero foreign wakes for the denied mirror");
  } finally {
    unbind();
    await otherClient.close().catch(() => {});
    await sponsorClient.close().catch(() => {});
    await adminClient.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.3b (e): an implicit-access read space (no ACL doc) admits mirrors per the implicit READ semantics", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createGateServer("xsp-mirror-gate-implicit");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const adminClient = await connectGateClient(server);
  const sponsorClient = await connectGateClient(server);
  const otherClient = await connectGateClient(server);
  let unbind = () => {};
  try {
    const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
    await writeAcl(adminHome, 1, HOME_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
    });
    const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
    // B stays EMPTY with no ACL doc: `#resolveCapability` grants
    // implicit READ on an empty authenticated space. OTHER's session
    // only keeps it hosted.
    await mountAs(otherClient, READ_SPACE, OTHER);
    await sponsor.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:xsp-mirror-gate:seed",
        value: { value: 1 },
      }],
    });

    const { claim, unbind: unbindSession } = await claimAs(
      server,
      sponsor,
      "space",
    );
    unbind = unbindSession;
    await sponsor.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: unservedForeignObservation(claim),
    });

    assertEquals(mirrorFrames(frames).length, 1, "mirror flowed");
    const readEngine = await internals.openEngine(READ_SPACE);
    assertEquals(actionSnapshots(readEngine).length, 1, "mirrored row in B");
    assertEquals(server.executionStats.crossSpaceMirrorsWithheld, 0);
  } finally {
    unbind();
    await otherClient.close().catch(() => {});
    await sponsorClient.close().catch(() => {});
    await adminClient.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.3b (f): a client observation mirrors under the client principal's B READ with no open session on B", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createGateServer("xsp-mirror-gate-client");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const adminClient = await connectGateClient(server);
  const aliceClient = await connectGateClient(server);
  const otherClient = await connectGateClient(server);
  try {
    const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
    const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
    await writeAcl(adminHome, 1, HOME_SPACE, {
      [ADMIN]: "OWNER",
      [ALICE]: "WRITE",
    });
    await writeAcl(adminRead, 1, READ_SPACE, {
      [ADMIN]: "OWNER",
      [ALICE]: "READ",
      [OTHER]: "WRITE",
    });
    // ALICE holds READ on B but opens NO session there: under the old
    // open-session predicate this client mirror was withheld too — the
    // liveness blindness was never executor-specific.
    const alice = await mountAs(aliceClient, HOME_SPACE, ALICE);
    await mountAs(otherClient, READ_SPACE, OTHER);
    await alice.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: clientForeignObservation(),
    });

    const aliceContextKey = Engine.sessionExecutionContextKey(
      ALICE,
      alice.sessionId,
    ) as SchedulerExecutionContextKey;
    const mirrors = mirrorFrames(frames);
    assertEquals(mirrors.length, 1, "the client mirror flowed");
    assertEquals(mirrors[0].originExecutionContextKey, aliceContextKey);
    // The client arm of the acting derivation collapses to the session's
    // own scope context — byte-identical to the pre-C3.3b message shape.
    assertEquals(mirrors[0].scopeContext, {
      principal: ALICE,
      sessionId: alice.sessionId,
    });
    assertEquals(mirrors[0].writerSessionId, aliceContextKey);
    const readEngine = await internals.openEngine(READ_SPACE);
    assertEquals(
      actionSnapshots(readEngine).map((row) => row.executionContextKey),
      [aliceContextKey],
      "mirrored row in B under the client's session context",
    );
    assertEquals(server.executionStats.crossSpaceMirrorsWithheld, 0);
  } finally {
    await otherClient.close().catch(() => {});
    await aliceClient.close().catch(() => {});
    await adminClient.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});
