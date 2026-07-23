// C3.4 — executor foreign point reads under the acting context, host
// side: the home host's read-time authority liveness (C3A4), the
// forward over the C3.1 protocol, the read host's serve arm (the same
// `#authorizeMessageWithEngine` resolution as every other read path),
// the (seq, epoch) response stamp, and the requestId correlation with
// its fail-closed timeout.
//
// Fixture map (plan row C3.4; amendments C3A4, C3A9 hook, C3A13):
//  (a) e2e in-process: a space-lane claimed attempt under the LIVE
//      lease reads a B-space doc — served with B's covering seq, B's
//      DEFAULT branch (decision #4: the home channel branch is never
//      stamped onto the foreign read), the document, and the acting
//      principal's B-epoch stamp; the exchange crosses the router as
//      wire frames (module boundary — the C3A1 discipline); an
//      unwritten doc serves `document: null` at the same stamp shape.
//  (c) C3A4 read-time liveness: sponsor rotation (lease drain +
//      re-acquire), claim revocation, user-lane drain, and session-lane
//      drain (client disconnect) each reject HOME-SIDE in the constant
//      C1.3 fence-cause shape — byte-identical across ALL modes (no
//      which-authority-died oracle) — and send ZERO foreign frames.
//  (d) denial: an acting principal without READ on B gets
//      denied{foreign-read-access-denied}; a scoped-lane read gates on
//      the LANE principal's B access, not the sponsor's (both
//      directions); no document ever rides a denial.
//  (e) decision #3: a user/session-scoped foreign address is refused
//      with the named code at the SEND side (host API — zero frames)
//      AND the SERVE side (a hand-sent wire request).
//  (f) the served stamp equals B's CURRENT effective epoch for the
//      acting principal, and an ACL mutation between two reads yields a
//      strictly higher stamp (C3.8's consumption seam).
//  (h) requestId correlation: two in-flight reads resolve their own
//      documents; an unanswered read fails closed with
//      `foreign-read-timeout`; a forged result from a space that is not
//      the addressed read space is dropped (the pending-map half of
//      C3A13) and the read still times out.
//  (b) transport parity: the same served flow over the C3.10a co-hosted
//      link — two Servers sharing nothing but the serializing duplex.
//
// Dated pointers (2026-07-18): C3.5 consumes the stamps as the vector
// input basis and lifts the unserved posture; C3.8's apply fence
// re-validates stamped epochs by equality; C3.10b owns link-loss
// pending-read disposition and reruns these fixtures over its
// reconnect contract.
//
// Barrier-driven except where the timeout IS the subject: every other
// await is a transact response, a host API result, a settle barrier, or
// a bounded microtask spin on tapped frames — no sleeps.
import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import {
  type ExecutorForeignPointReadClaimRef,
  type ExecutorForeignPointReadOutcome,
  Server,
} from "../v2/server.ts";
import type { SchedulerExecutionContextKey } from "../v2/engine.ts";
import {
  resetServerPrimaryExecutionClaimRankConfig,
  type ServerPrimaryExecutionClaimRank,
  setServerPrimaryExecutionClaimRankConfig,
} from "../v2.ts";
import {
  type CrossSpaceMessage,
  type ForeignPointRead,
  type ForeignPointReadResult,
  parseCrossSpaceMessage,
} from "../v2/cross-space.ts";
import {
  CoHostedCrossSpaceTransport,
  crossSpaceLinkSocketPair,
} from "../v2/cross-space-link.ts";

const HOME_SPACE = "did:key:z6Mk-xsp-pread-home";
const READ_SPACE = "did:key:z6Mk-xsp-pread-read";
const BLACKHOLE_SPACE = "did:key:z6Mk-xsp-pread-blackhole";
const EVIL_SPACE = "did:key:z6Mk-xsp-pread-evil";
const ADMIN = "did:key:z6Mk-xsp-pread-admin";
const SPONSOR = "did:key:z6Mk-xsp-pread-sponsor";
const ALICE = "did:key:z6Mk-xsp-pread-alice";
const OTHER = "did:key:z6Mk-xsp-pread-other";
const AUDIENCE = "did:key:z6Mk-xsp-pread-audience";

const PIECE_ROOT = "of:xsp-pread:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:xsp-pread-reader";
const FOREIGN_DOC = "of:xsp-pread:source";
const FOREIGN_DOC_B = "of:xsp-pread:source-b";

/** The constant C3A4 rejection, asserted byte-for-byte. */
const CONSTANT_REJECTION = {
  name: "ExecutionLeaseFenceError",
  message: "claim-not-live: foreign point read requires live acting " +
    "authority at the bound generations",
};

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
};

/** Opaque host-API lease handle (identity is what matters, not shape). */
type ExecutionLeaseHandle = { leaseGeneration: number };

type HostClaim = ExecutorForeignPointReadClaimRef;

type PointReadServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  beginExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
  ): Promise<ExecutionLeaseHandle | null>;
  finishExecutionLeaseDrain(
    lease: ExecutionLeaseHandle,
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
  ): Promise<
    HostClaim & { contextKey: SchedulerExecutionContextKey }
  >;
  revokeExecutionClaim(claim: unknown): boolean;
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
  closeUserLaneGrant(grant: unknown): boolean;
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<{ contextKey: string; laneGeneration: number }>;
  executorForeignPointRead(
    lease: ExecutionLeaseHandle,
    request: {
      readSpace: string;
      claim: HostClaim;
      address: { id: string; scope?: "space" | "user" | "session" };
    },
  ): Promise<ExecutorForeignPointReadOutcome>;
};

type ServerInternals = {
  settleCrossSpaceDeliveries(): Promise<void>;
  openEngine(space: string): Promise<Engine.Engine>;
};

const internalsOf = (server: Server): ServerInternals =>
  server as unknown as ServerInternals;

const EXECUTION_FLAGS = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
  serverPrimaryExecutionContextLatticeClaimsV1: true,
};

const createServer = (
  name: string,
  options: {
    aclMode?: "enforce" | "off";
    foreignPointReadTimeoutMs?: number;
  } = {},
): PointReadServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      protocolFlags: EXECUTION_FLAGS,
      acl: { mode: options.aclMode ?? "enforce", serviceDids: [ADMIN] },
      ...(options.foreignPointReadTimeoutMs !== undefined
        ? {
          executionControl: {
            foreignPointReadTimeoutMs: options.foreignPointReadTimeoutMs,
          },
        }
        : {}),
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as PointReadServer;

const connectClient = async (
  server: Server,
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: EXECUTION_FLAGS,
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

const writeDoc = async (
  session: ExecutionSession,
  localSeq: number,
  id: string,
  value: number,
): Promise<void> => {
  await session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id, value: { value } }],
  });
};

/** Tap every frame crossing the in-process transport (the loopback
 * channel broadcasts to all onMessage handlers). */
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

const pointReadFrames = (
  frames: readonly CrossSpaceMessage[],
): ForeignPointRead[] =>
  frames.filter(
    (frame): frame is ForeignPointRead => frame.type === "foreign-point-read",
  );

const pointReadResultFrames = (
  frames: readonly CrossSpaceMessage[],
): ForeignPointReadResult[] =>
  frames.filter(
    (frame): frame is ForeignPointReadResult =>
      frame.type === "foreign-point-read.result",
  );

/** Bounded microtask spin (no timers) on tapped-frame state. */
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
  implementationFingerprint: "impl:xsp-pread",
  runtimeFingerprint: "runtime:xsp-pread",
});

const claimRefOf = (
  claim: HostClaim & { contextKey: SchedulerExecutionContextKey },
): HostClaim => ({
  contextKey: claim.contextKey,
  pieceId: SCHEDULER_PIECE_ID,
  actionId: ACTION_ID,
  actionKind: "computation",
  implementationFingerprint: "impl:xsp-pread",
  runtimeFingerprint: "runtime:xsp-pread",
  leaseGeneration: claim.leaseGeneration,
  claimGeneration: claim.claimGeneration,
});

const issueClaim = async (
  server: PointReadServer,
  lease: ExecutionLeaseHandle,
  contextKey: SchedulerExecutionContextKey,
  rank?: ServerPrimaryExecutionClaimRank,
) => {
  if (rank !== undefined) setServerPrimaryExecutionClaimRankConfig(rank);
  try {
    return await server.setExecutionClaim(lease, claimInput(contextKey));
  } finally {
    if (rank !== undefined) resetServerPrimaryExecutionClaimRankConfig();
  }
};

const expectConstantRejection = async (
  promise: Promise<unknown>,
): Promise<{ name: string; message: string }> => {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof Error, "rejection is an Error");
    return { name: error.name, message: error.message };
  }
  throw new Error("expected the constant-shape authority rejection");
};

interface Harness {
  server: PointReadServer;
  internals: ServerInternals;
  frames: CrossSpaceMessage[];
  adminClient: MemoryClient.Client;
  sponsorClient: MemoryClient.Client;
  aliceClient: MemoryClient.Client;
  otherClient: MemoryClient.Client;
  sponsor: ExecutionSession;
  alice: ExecutionSession;
  lease: ExecutionLeaseHandle;
  unbind: () => void;
  close(): Promise<void>;
}

/**
 * Enforcing-ACL two-space harness: HOME (sponsor WRITE, alice WRITE) and
 * READ_SPACE (per-fixture ACL; a seeded doc written by OTHER), plus the
 * executor plane on HOME — demand → lease → bound sponsor session.
 */
const setupHarness = async (
  name: string,
  options: {
    readAcl?: Record<string, "READ" | "WRITE" | "OWNER">;
    foreignPointReadTimeoutMs?: number;
  } = {},
): Promise<Harness> => {
  const server = createServer(name, {
    foreignPointReadTimeoutMs: options.foreignPointReadTimeoutMs,
  });
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const adminClient = await connectClient(server);
  const sponsorClient = await connectClient(server);
  const aliceClient = await connectClient(server);
  const otherClient = await connectClient(server);
  const adminHome = await mountAs(adminClient, HOME_SPACE, ADMIN);
  const adminRead = await mountAs(adminClient, READ_SPACE, ADMIN);
  await writeAcl(adminHome, 1, HOME_SPACE, {
    [ADMIN]: "OWNER",
    [SPONSOR]: "WRITE",
    [ALICE]: "WRITE",
  });
  await writeAcl(
    adminRead,
    2,
    READ_SPACE,
    options.readAcl ?? {
      [ADMIN]: "OWNER",
      [SPONSOR]: "READ",
      [ALICE]: "READ",
      [OTHER]: "WRITE",
    },
  );
  const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
  const alice = await mountAs(aliceClient, HOME_SPACE, ALICE);
  const reader = await mountAs(otherClient, READ_SPACE, OTHER);
  await writeDoc(reader, 1, FOREIGN_DOC, 41);
  await writeDoc(reader, 2, FOREIGN_DOC_B, 43);
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
    internals,
    frames,
    adminClient,
    sponsorClient,
    aliceClient,
    otherClient,
    sponsor,
    alice,
    lease,
    unbind,
    close: async () => {
      resetServerPrimaryExecutionClaimRankConfig();
      unbind();
      await otherClient.close();
      await aliceClient.close();
      await sponsorClient.close();
      await adminClient.close();
      await server.close();
    },
  };
};

Deno.test("C3.4 (a): a space-lane claimed attempt under the live lease reads a B doc — served with B's covering seq, B's default branch, and the acting principal's epoch stamp, over wire frames", async () => {
  const harness = await setupHarness("xsp-pread-served");
  try {
    const claim = await issueClaim(harness.server, harness.lease, "space");
    const outcome = await harness.server.executorForeignPointRead(
      harness.lease,
      {
        readSpace: READ_SPACE,
        claim: claimRefOf(claim),
        address: { id: FOREIGN_DOC },
      },
    );
    assertEquals(outcome.status, "served");
    assert(outcome.status === "served");
    assertEquals(outcome.space, READ_SPACE);
    assertEquals(
      (outcome.document as { value?: unknown } | null)?.value,
      41,
      "the B-space document rode the stamped response",
    );
    // Decision #4: the served branch is B's DEFAULT branch — the home
    // channel branch was never stamped onto the foreign read.
    assertEquals(outcome.branch, "");
    const readEngine = await harness.internals.openEngine(READ_SPACE);
    assertEquals(
      outcome.seq,
      Engine.serverSeq(readEngine),
      "the stamp is B's covering seq at the read",
    );
    assertEquals(outcome.authorizationEpoch, {
      space: READ_SPACE,
      principal: SPONSOR,
      epoch: Engine.effectiveAuthorizationEpoch(readEngine, SPONSOR),
    });

    // Module boundary: the exchange crossed the router as wire frames.
    const requests = pointReadFrames(harness.frames);
    const results = pointReadResultFrames(harness.frames);
    assertEquals(requests.length, 1, "one foreign-point-read frame");
    assertEquals(requests[0].fromSpace, HOME_SPACE);
    assertEquals(requests[0].toSpace, READ_SPACE);
    assertEquals(requests[0].actingPrincipal.principal, SPONSOR);
    assertEquals(requests[0].actingPrincipal.contextKey, "space");
    assertEquals(requests[0].actingPrincipal.claim?.pieceId, SCHEDULER_PIECE_ID);
    assertEquals(results.length, 1, "one foreign-point-read.result frame");
    assertEquals(results[0].requestId, requests[0].requestId);

    // An unwritten doc serves document: null at the same stamp shape —
    // "read answered: nothing there at seq S" is information.
    const absent = await harness.server.executorForeignPointRead(
      harness.lease,
      {
        readSpace: READ_SPACE,
        claim: claimRefOf(claim),
        address: { id: "of:xsp-pread:never-written" },
      },
    );
    assert(absent.status === "served");
    assertEquals(absent.document, null);
    assertEquals(absent.seq, Engine.serverSeq(readEngine));
  } finally {
    await harness.close();
  }
});

Deno.test("C3.4 (c)/C3A4: rotation, claim revocation, user-lane drain, and session-lane drain each reject home-side in ONE constant shape with zero foreign frames", async () => {
  const harness = await setupHarness("xsp-pread-liveness");
  try {
    const rejections: { name: string; message: string }[] = [];

    // -- session-lane drain (client disconnect) ------------------------
    setServerPrimaryExecutionClaimRankConfig("session");
    try {
      await harness.server.openSessionLaneGrant(
        HOME_SPACE,
        "",
        ALICE,
        harness.alice.sessionId,
      );
      const sessionClaim = await harness.server.setExecutionClaim(
        harness.lease,
        claimInput(
          Engine.sessionExecutionContextKey(
            ALICE,
            harness.alice.sessionId,
          ) as SchedulerExecutionContextKey,
        ),
      );
      // Pre-drain the read works (under ALICE, the lane principal).
      const preDrain = await harness.server.executorForeignPointRead(
        harness.lease,
        {
          readSpace: READ_SPACE,
          claim: claimRefOf(sessionClaim),
          address: { id: FOREIGN_DOC },
        },
      );
      assert(preDrain.status === "served");
      assertEquals(preDrain.authorizationEpoch.principal, ALICE);
      const framesBefore = harness.frames.length;
      // The lane's anchoring session disconnects: the drain fences the
      // generation and sweeps the lane's claims.
      await harness.aliceClient.close();
      rejections.push(
        await expectConstantRejection(
          harness.server.executorForeignPointRead(harness.lease, {
            readSpace: READ_SPACE,
            claim: claimRefOf(sessionClaim),
            address: { id: FOREIGN_DOC },
          }),
        ),
      );
      assertEquals(
        harness.frames.length,
        framesBefore,
        "no foreign request left the home host after the session drain",
      );
    } finally {
      resetServerPrimaryExecutionClaimRankConfig();
    }

    // -- user-lane drain ----------------------------------------------
    // (alice's client is gone; the user lane anchors on a fresh client.)
    const aliceClient2 = await connectClient(harness.server);
    try {
      await mountAs(aliceClient2, HOME_SPACE, ALICE);
      setServerPrimaryExecutionClaimRankConfig("user");
      let userClaim;
      let userGrant;
      try {
        userGrant = await harness.server.openUserLaneGrant(
          HOME_SPACE,
          "",
          ALICE,
        );
        userClaim = await harness.server.setExecutionClaim(
          harness.lease,
          claimInput(
            Engine.userExecutionContextKey(
              ALICE,
            ) as SchedulerExecutionContextKey,
          ),
        );
      } finally {
        resetServerPrimaryExecutionClaimRankConfig();
      }
      const preDrain = await harness.server.executorForeignPointRead(
        harness.lease,
        {
          readSpace: READ_SPACE,
          claim: claimRefOf(userClaim),
          address: { id: FOREIGN_DOC },
        },
      );
      assert(preDrain.status === "served");
      const framesBefore = harness.frames.length;
      assert(harness.server.closeUserLaneGrant(userGrant), "lane drained");
      rejections.push(
        await expectConstantRejection(
          harness.server.executorForeignPointRead(harness.lease, {
            readSpace: READ_SPACE,
            claim: claimRefOf(userClaim),
            address: { id: FOREIGN_DOC },
          }),
        ),
      );
      assertEquals(harness.frames.length, framesBefore, "no frame (user)");
    } finally {
      await aliceClient2.close();
    }

    // -- claim revocation ---------------------------------------------
    const spaceClaim = await issueClaim(harness.server, harness.lease, "space");
    assert(harness.server.revokeExecutionClaim(spaceClaim));
    {
      const framesBefore = harness.frames.length;
      rejections.push(
        await expectConstantRejection(
          harness.server.executorForeignPointRead(harness.lease, {
            readSpace: READ_SPACE,
            claim: claimRefOf(spaceClaim),
            address: { id: FOREIGN_DOC },
          }),
        ),
      );
      assertEquals(harness.frames.length, framesBefore, "no frame (revoke)");
    }

    // -- sponsor rotation (lease release + re-acquire) ----------------
    const preRotation = await issueClaim(harness.server, harness.lease, "space");
    const served = await harness.server.executorForeignPointRead(
      harness.lease,
      {
        readSpace: READ_SPACE,
        claim: claimRefOf(preRotation),
        address: { id: FOREIGN_DOC },
      },
    );
    assert(served.status === "served", "pre-rotation control read serves");
    const draining = await harness.server.beginExecutionLeaseDrain(
      harness.lease,
    );
    assertExists(draining);
    await harness.server.finishExecutionLeaseDrain(draining);
    const rotated = await harness.server.acquireExecutionLease(HOME_SPACE, "");
    assertExists(rotated, "re-acquired lease");
    assert(
      rotated.leaseGeneration > harness.lease.leaseGeneration,
      "rotation minted a new lease generation",
    );
    {
      const framesBefore = harness.frames.length;
      // The old handle + its claim: dead authority, constant shape.
      rejections.push(
        await expectConstantRejection(
          harness.server.executorForeignPointRead(harness.lease, {
            readSpace: READ_SPACE,
            claim: claimRefOf(preRotation),
            address: { id: FOREIGN_DOC },
          }),
        ),
      );
      assertEquals(harness.frames.length, framesBefore, "no frame (rotation)");
    }

    // ONE constant shape across all four modes — byte-identical, so the
    // rejection carries no which-authority-died oracle (C1.3).
    for (const rejection of rejections) {
      assertEquals(rejection, CONSTANT_REJECTION);
    }
  } finally {
    await harness.close();
  }
});

Deno.test("C3.4 (d): denial gates on the ACTING principal's B READ — sponsor without access is denied; a scoped lane gates on the LANE principal, both directions", async () => {
  // B's ACL: alice READ, sponsor NOT listed, OTHER writes the doc.
  const harness = await setupHarness("xsp-pread-denied", {
    readAcl: {
      [ADMIN]: "OWNER",
      [ALICE]: "READ",
      [OTHER]: "WRITE",
    },
  });
  try {
    // Space lane: the sponsor (acting principal) lacks READ on B.
    const spaceClaim = await issueClaim(harness.server, harness.lease, "space");
    const denied = await harness.server.executorForeignPointRead(
      harness.lease,
      {
        readSpace: READ_SPACE,
        claim: claimRefOf(spaceClaim),
        address: { id: FOREIGN_DOC },
      },
    );
    assertEquals(denied, {
      status: "denied",
      code: "foreign-read-access-denied",
    });
    // Fail-closed: no document rides a denial (the wire result carries
    // only the code — assert at the frame level).
    const deniedResults = pointReadResultFrames(harness.frames);
    assertEquals(deniedResults.length, 1);
    assert(!("document" in deniedResults[0].result));

    // Session lane: the LANE principal (alice) HOLDS B READ while the
    // sponsor does not — the read serves under alice. The converse of
    // the sponsor denial above: access follows the ACTING principal.
    // (Lane moves are revoke-published-before-issue: the live space
    // claim would be chain-compatible with the session claim.)
    assert(harness.server.revokeExecutionClaim(spaceClaim));
    setServerPrimaryExecutionClaimRankConfig("session");
    try {
      await harness.server.openSessionLaneGrant(
        HOME_SPACE,
        "",
        ALICE,
        harness.alice.sessionId,
      );
      const laneClaim = await harness.server.setExecutionClaim(
        harness.lease,
        claimInput(
          Engine.sessionExecutionContextKey(
            ALICE,
            harness.alice.sessionId,
          ) as SchedulerExecutionContextKey,
        ),
      );
      const servedAsAlice = await harness.server.executorForeignPointRead(
        harness.lease,
        {
          readSpace: READ_SPACE,
          claim: claimRefOf(laneClaim),
          address: { id: FOREIGN_DOC },
        },
      );
      assert(servedAsAlice.status === "served");
      assertEquals(servedAsAlice.authorizationEpoch.principal, ALICE);
    } finally {
      resetServerPrimaryExecutionClaimRankConfig();
    }
  } finally {
    await harness.close();
  }
});

Deno.test("C3.4 (d converse): a lane principal WITHOUT B READ is denied even while the sponsor holds it", async () => {
  // B's ACL: sponsor READ, alice NOT listed.
  const harness = await setupHarness("xsp-pread-denied-lane", {
    readAcl: {
      [ADMIN]: "OWNER",
      [SPONSOR]: "READ",
      [OTHER]: "WRITE",
    },
  });
  try {
    setServerPrimaryExecutionClaimRankConfig("user");
    let laneClaim;
    try {
      await harness.server.openUserLaneGrant(HOME_SPACE, "", ALICE);
      laneClaim = await harness.server.setExecutionClaim(
        harness.lease,
        claimInput(
          Engine.userExecutionContextKey(
            ALICE,
          ) as SchedulerExecutionContextKey,
        ),
      );
    } finally {
      resetServerPrimaryExecutionClaimRankConfig();
    }
    const denied = await harness.server.executorForeignPointRead(
      harness.lease,
      {
        readSpace: READ_SPACE,
        claim: claimRefOf(laneClaim),
        address: { id: FOREIGN_DOC },
      },
    );
    assertEquals(denied, {
      status: "denied",
      code: "foreign-read-access-denied",
    });
    // The sponsor's own space-lane read serves — the denial above was
    // the LANE principal's, not a channel property. (Revoke first: lane
    // moves are revoke-published-before-issue.)
    assert(harness.server.revokeExecutionClaim(laneClaim));
    const spaceClaim = await issueClaim(harness.server, harness.lease, "space");
    const servedAsSponsor = await harness.server.executorForeignPointRead(
      harness.lease,
      {
        readSpace: READ_SPACE,
        claim: claimRefOf(spaceClaim),
        address: { id: FOREIGN_DOC },
      },
    );
    assert(servedAsSponsor.status === "served");
    assertEquals(servedAsSponsor.authorizationEpoch.principal, SPONSOR);
  } finally {
    await harness.close();
  }
});

Deno.test("C3.4 (e): a scoped foreign address is refused with the named code at the send side (zero frames) AND the serve side (decision #3)", async () => {
  const harness = await setupHarness("xsp-pread-scoped");
  try {
    const claim = await issueClaim(harness.server, harness.lease, "space");
    // Send side: the host API refuses before ANY wire traffic.
    for (const scope of ["user", "session"] as const) {
      const framesBefore = harness.frames.length;
      const outcome = await harness.server.executorForeignPointRead(
        harness.lease,
        {
          readSpace: READ_SPACE,
          claim: claimRefOf(claim),
          address: { id: FOREIGN_DOC, scope },
        },
      );
      assertEquals(outcome, {
        status: "failed",
        code: "foreign-read-scoped-address",
      });
      assertEquals(
        harness.frames.length,
        framesBefore,
        `no frame for the ${scope}-scoped address`,
      );
    }
    // Serve side: a hand-sent wire request with a scoped address (as a
    // peer bypassing the send-side check would) answers the named code.
    harness.server.crossSpaceRouter().link(HOME_SPACE, READ_SPACE).send({
      type: "foreign-point-read",
      requestId: "e2e-scoped-serve-side",
      address: { id: FOREIGN_DOC, scope: "user", path: [] },
      actingPrincipal: { principal: SPONSOR, contextKey: "space" },
    });
    await internalsOf(harness.server).settleCrossSpaceDeliveries();
    await spinUntil(
      () =>
        pointReadResultFrames(harness.frames).some(
          (frame) => frame.requestId === "e2e-scoped-serve-side",
        ),
      "the serve-side scoped answer",
    );
    const answer = pointReadResultFrames(harness.frames).find(
      (frame) => frame.requestId === "e2e-scoped-serve-side",
    );
    assertEquals(answer?.result, {
      status: "failed",
      code: "foreign-read-scoped-address",
    });
  } finally {
    await harness.close();
  }
});

Deno.test("C3.4 (f): the served stamp is B's CURRENT effective epoch for the acting principal, and an ACL bump between reads yields a strictly higher stamp", async () => {
  const harness = await setupHarness("xsp-pread-epoch");
  try {
    const claim = await issueClaim(harness.server, harness.lease, "space");
    const read = () =>
      harness.server.executorForeignPointRead(harness.lease, {
        readSpace: READ_SPACE,
        claim: claimRefOf(claim),
        address: { id: FOREIGN_DOC },
      });
    const first = await read();
    assert(first.status === "served");
    const readEngine = await harness.internals.openEngine(READ_SPACE);
    assertEquals(
      first.authorizationEpoch.epoch,
      Engine.effectiveAuthorizationEpoch(readEngine, SPONSOR),
    );
    // Mutate B's ACL so the SPONSOR's capability changes (READ→WRITE):
    // the C3.2 bump rule bumps exactly that principal, transactionally
    // with the ACL apply.
    const adminRead = await mountAs(harness.adminClient, READ_SPACE, ADMIN);
    await writeAcl(adminRead, 7, READ_SPACE, {
      [ADMIN]: "OWNER",
      [SPONSOR]: "WRITE",
      [ALICE]: "READ",
      [OTHER]: "WRITE",
    });
    const second = await read();
    assert(second.status === "served");
    assert(
      second.authorizationEpoch.epoch > first.authorizationEpoch.epoch,
      "the bump between reads raised the stamp",
    );
    assertEquals(
      second.authorizationEpoch.epoch,
      Engine.effectiveAuthorizationEpoch(readEngine, SPONSOR),
      "the stamp is the CURRENT effective epoch (C3.8's seam)",
    );
    assert(
      second.seq > first.seq,
      "the ACL commit also advanced the covering seq",
    );
  } finally {
    await harness.close();
  }
});

Deno.test("C3.4 (h): requestId correlation under interleaving; an unanswered read times out fail-closed; a wrong-speaker result is dropped (C3A13 pending half)", async () => {
  const harness = await setupHarness("xsp-pread-correlation", {
    foreignPointReadTimeoutMs: 250,
  });
  try {
    const claim = await issueClaim(harness.server, harness.lease, "space");
    // Two in-flight reads answer their OWN documents.
    const [a, b] = await Promise.all([
      harness.server.executorForeignPointRead(harness.lease, {
        readSpace: READ_SPACE,
        claim: claimRefOf(claim),
        address: { id: FOREIGN_DOC },
      }),
      harness.server.executorForeignPointRead(harness.lease, {
        readSpace: READ_SPACE,
        claim: claimRefOf(claim),
        address: { id: FOREIGN_DOC_B },
      }),
    ]);
    assert(a.status === "served" && b.status === "served");
    assertEquals((a.document as { value?: unknown }).value, 41);
    assertEquals((b.document as { value?: unknown }).value, 43);
    assertEquals(
      new Set(
        pointReadFrames(harness.frames).map((frame) => frame.requestId),
      ).size,
      2,
      "two distinct requestIds crossed",
    );

    // A black-hole read space: registered inbox that never answers. The
    // pending read fails CLOSED on the timeout.
    harness.server.crossSpaceRouter().register(BLACKHOLE_SPACE, () => {});
    const pendingBlackhole = harness.server.executorForeignPointRead(
      harness.lease,
      {
        readSpace: BLACKHOLE_SPACE,
        claim: claimRefOf(claim),
        address: { id: FOREIGN_DOC },
      },
    );
    // While it pends: a THIRD space forges a served result with the
    // pending requestId. The pending-map binds the ANSWERING space to
    // the ASKED one, so the forgery drops and the read still times out
    // (were it accepted, the outcome would be "served").
    await spinUntil(
      () =>
        pointReadFrames(harness.frames).some(
          (frame) => frame.toSpace === BLACKHOLE_SPACE,
        ),
      "the black-hole request frame",
    );
    const stolen = pointReadFrames(harness.frames).find(
      (frame) => frame.toSpace === BLACKHOLE_SPACE,
    )!;
    harness.server.crossSpaceRouter().register(EVIL_SPACE, () => {});
    harness.server.crossSpaceRouter().link(EVIL_SPACE, HOME_SPACE).send({
      type: "foreign-point-read.result",
      requestId: stolen.requestId,
      result: {
        status: "served",
        seq: 999,
        branch: "",
        document: null,
        authorizationEpoch: {
          space: EVIL_SPACE,
          principal: SPONSOR,
          epoch: 0,
        },
      },
    });
    await internalsOf(harness.server).settleCrossSpaceDeliveries();
    assertEquals(await pendingBlackhole, {
      status: "failed",
      code: "foreign-read-timeout",
    });
  } finally {
    await harness.close();
  }
});

Deno.test("C3.4 (b): transport parity — the served flow crosses the C3.10a co-hosted link with the same stamp semantics", async () => {
  const HOST_A = "host:xsp-pread-a";
  const HOST_B = "host:xsp-pread-b";
  const pair = crossSpaceLinkSocketPair();
  const transportA = new CoHostedCrossSpaceTransport({
    hostId: HOST_A,
    hostedSpaces: [HOME_SPACE],
  });
  const transportB = new CoHostedCrossSpaceTransport({
    hostId: HOST_B,
    hostedSpaces: [READ_SPACE],
  });
  const serverOptions = {
    authorizeSessionOpen: (message: { authorization?: unknown }) => {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: AUDIENCE },
    protocolFlags: EXECUTION_FLAGS,
    acl: { mode: "off", serviceDids: [] },
  };
  const serverA = new Server(
    {
      ...serverOptions,
      store: new URL("memory://xsp-pread-link-a"),
      crossSpaceTransport: transportA,
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as PointReadServer;
  const serverB = new Server(
    {
      ...serverOptions,
      store: new URL("memory://xsp-pread-link-b"),
      crossSpaceTransport: transportB,
    } as unknown as ConstructorParameters<typeof Server>[0],
  ) as PointReadServer;
  const linkA = transportA.attachLink(pair.sockets[0]);
  const linkB = transportB.attachLink(pair.sockets[1]);
  await Promise.all([linkA.opened, linkB.opened]);
  const sponsorClient = await connectClient(serverA);
  let unbind = () => {};
  try {
    // B hosts the read space with a real document.
    await serverB.writeDocument(READ_SPACE, FOREIGN_DOC, { value: 47 });
    // A hosts the home space's executor plane. Seed the home space first:
    // with acl "off" the sponsor's WRITE capability still resolves via
    // the missing-ACL compatibility rule, which grants only READ on a
    // genesis-empty space — an unseeded home space would refuse the
    // lease's sponsor.
    await serverA.writeDocument(HOME_SPACE, "of:xsp-pread:home-seed", {
      seeded: true,
    });
    const sponsor = await mountAs(sponsorClient, HOME_SPACE, SPONSOR);
    await sponsor.setExecutionDemand("", [PIECE_ROOT]);
    const lease = await serverA.acquireExecutionLease(HOME_SPACE, "");
    assertExists(lease);
    unbind = serverA.bindExecutionSession(HOME_SPACE, sponsor.sessionId, lease);
    const claim = await issueClaim(serverA, lease, "space");
    const framesBefore = pair.framesTransferred();
    const outcome = await serverA.executorForeignPointRead(lease, {
      readSpace: READ_SPACE,
      claim: claimRefOf(claim),
      address: { id: FOREIGN_DOC },
    });
    assert(outcome.status === "served");
    assertEquals(outcome.space, READ_SPACE);
    assert(outcome.seq >= 1);
    assertEquals(outcome.branch, "");
    assertEquals(outcome.authorizationEpoch.space, READ_SPACE);
    assertEquals(outcome.authorizationEpoch.principal, SPONSOR);
    assertExists(outcome.document, "the remote document crossed the link");
    assert(
      pair.framesTransferred() >= framesBefore + 2,
      "request and result actually crossed the serializing duplex",
    );
  } finally {
    resetServerPrimaryExecutionClaimRankConfig();
    unbind();
    await sponsorClient.close();
    await serverA.close().catch(() => {});
    await serverB.close().catch(() => {});
  }
});

Deno.test("C3.4: a direct (home) docs.read carrying an executionClaim reference is rejected — the reference rides only the executor foreign arm", async () => {
  const harness = await setupHarness("xsp-pread-home-claim-reject");
  try {
    const response = await harness.server.docsRead({
      type: "docs.read",
      requestId: "home-claim-reject",
      space: HOME_SPACE,
      sessionId: harness.sponsor.sessionId,
      executionClaim: {
        contextKey: "space",
        pieceId: SCHEDULER_PIECE_ID,
        actionId: ACTION_ID,
        actionKind: "computation",
        implementationFingerprint: "impl:xsp-pread",
        runtimeFingerprint: "runtime:xsp-pread",
        leaseGeneration: 1,
        claimGeneration: 1,
      },
      query: { docs: [{ id: FOREIGN_DOC }] },
    });
    assertExists(response.error);
    assertEquals(response.error.name, "ProtocolError");
  } finally {
    await harness.close();
  }
});
