import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { parseClientMessage, Server } from "../v2/server.ts";
import type { AcceptedCommitEvent } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  type ExecutionLease,
  toDocumentPath,
} from "../v2.ts";
import * as MemoryV2 from "../v2.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-lane-read-space";
// Colon-bearing DIDs exercise the canonical percent-encoded lane keys.
const SPONSOR = "did:key:z6Mk-lane-read-sponsor-bob";
const LANE_PRINCIPAL = "did:key:z6Mk-lane-read-alice";
const OTHER_PRINCIPAL = "did:key:z6Mk-lane-read-carol";
const AUDIENCE = "did:key:z6Mk-lane-read-audience";

const ALICE_LANE = Engine.userExecutionContextKey(
  LANE_PRINCIPAL,
) as SchedulerExecutionContextKey;
const CAROL_LANE = Engine.userExecutionContextKey(
  OTHER_PRINCIPAL,
) as SchedulerExecutionContextKey;

const SHARED_USER_DOC = "of:lane-read-user-doc";
const OBSERVED_USER_DOC = "of:lane-read-observed";

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
};

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

type LaneReadServer = Server & {
  acquireExecutionLease(
    space: string,
    branch: string,
  ): Promise<ExecutionLeaseHandle | null>;
  bindExecutionSession(
    space: string,
    sessionId: string,
    lease: ExecutionLeaseHandle,
  ): () => void;
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<{ anchorSessionId: string; anchorConnectionId: string }>;
};

const createServer = (name: string): LaneReadServer =>
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
  ) as LaneReadServer;

const connectClient = async (
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

const rankDial = MemoryV2 as unknown as {
  setServerPrimaryExecutionClaimRankConfig(rank?: "space" | "user"): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

/** Unclaimed alice observation with user-scoped surfaces: creates durable
 * scheduler rows (snapshot + write index) under alice's user context. */
const aliceUserObservation = (): SchedulerActionObservation => {
  const write: SchedulerObservationAddress = {
    space: SPACE,
    scope: "user",
    id: OBSERVED_USER_DOC,
    path: ["value"],
  };
  return {
    version: 2,
    ownerSpace: SPACE,
    branch: "",
    pieceId: "space:of:lane-read-piece",
    processGeneration: 1,
    actionId: "action:lane-read",
    actionKind: "computation",
    implementationFingerprint: "impl:lane-read",
    runtimeFingerprint: "runtime:lane-read",
    observedAtSeq: 0,
    transactionKind: "action-run",
    reads: [],
    shallowReads: [],
    actualChangedWrites: [write],
    currentKnownWrites: [write],
    materializerWriteEnvelopes: [],
    completeActionScopeSummary: {
      version: 1,
      complete: true,
      implementationFingerprint: "impl:lane-read",
      runtimeFingerprint: "runtime:lane-read",
      piece: {
        space: SPACE,
        scope: "space",
        id: "of:lane-read-piece",
        path: [],
      },
      reads: [],
      writes: [write],
      materializerWriteEnvelopes: [],
      directOutputs: [write],
    },
    status: "success",
  };
};

type LaneReadHarness = {
  server: LaneReadServer;
  bobClient: MemoryClient.Client;
  bobSession: ExecutionSession;
  aliceClient: MemoryClient.Client;
  aliceSession: ExecutionSession;
  unbind: () => void;
  close(): Promise<void>;
};

/** One sponsor-bound provider session (bob) plus alice's own session; both
 * principals hold distinct instances of SHARED_USER_DOC, alice's durable
 * observation row exists, and bob's session is lease-bound. */
const setupHarness = async (
  name: string,
  options: { grantAlice?: boolean } = {},
): Promise<LaneReadHarness> => {
  const server = createServer(name);
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectClient(server);
  const bobSession = await mountAs(bobClient, SPONSOR);
  const aliceClient = await connectClient(server);
  const aliceSession = await mountAs(aliceClient, LANE_PRINCIPAL);
  await bobSession.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:lane-read-seed",
      value: { value: "seed" },
    }],
  });
  await bobSession.transact({
    localSeq: 2,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: SHARED_USER_DOC,
      scope: "user",
      value: { value: 22 },
    }],
  });
  await aliceSession.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: SHARED_USER_DOC,
      scope: "user",
      value: { value: 11 },
    }],
  });
  await aliceSession.transact({
    localSeq: 2,
    reads: { confirmed: [], pending: [] },
    operations: [],
    schedulerObservation: aliceUserObservation(),
  });
  rankDial.setServerPrimaryExecutionClaimRankConfig("user");
  await bobSession.setExecutionDemand("", ["space:piece:lane-read"]);
  const lease = await server.acquireExecutionLease(SPACE, "");
  assertExists(lease);
  const unbind = server.bindExecutionSession(
    SPACE,
    bobSession.sessionId,
    lease,
  );
  if (options.grantAlice !== false) {
    await server.openUserLaneGrant(SPACE, "", LANE_PRINCIPAL);
  }
  return {
    server,
    bobClient,
    bobSession,
    aliceClient,
    aliceSession,
    unbind,
    close: async () => {
      rankDial.resetServerPrimaryExecutionClaimRankConfig();
      unbind();
      await aliceClient.close();
      await bobClient.close();
      await server.close();
    },
  };
};

const userDocRoot = {
  id: SHARED_USER_DOC,
  scope: "user" as const,
  selector: { path: [], schema: false as const },
};

const graphQueryFor = (
  harness: LaneReadHarness,
  actingContext?: SchedulerExecutionContextKey,
) =>
  harness.server.graphQuery({
    type: "graph.query",
    requestId: crypto.randomUUID(),
    space: SPACE,
    sessionId: harness.bobSession.sessionId,
    ...(actingContext !== undefined ? { actingContext } : {}),
    query: { roots: [userDocRoot] },
  });

/** Constant-shape lane-read rejection: the C1.3 fence-cause vocabulary,
 * identical for a dead and an absent grant. */
const assertLaneReadRejection = (
  error: { name: string; message: string } | undefined,
): void => {
  assertExists(error);
  assertEquals(error.name, "ExecutionLeaseFenceError");
  assertEquals(
    error.message,
    "lane-generation-stale: execution lane grant is fenced or superseded",
  );
};

Deno.test("a lane read under a live grant returns the lane principal's instance", async () => {
  const harness = await setupHarness("memory-v2-lane-read-instance");
  try {
    const acting = await graphQueryFor(harness, ALICE_LANE);
    assertExists(acting.ok);
    const entity = acting.ok.entities.find(
      (candidate) => candidate.id === SHARED_USER_DOC,
    );
    assertEquals(entity?.document, { value: 11 });
    // EntitySnapshot carries the RESOLVED scope key so the re-keyed Worker
    // replica can attribute sync frames to lanes.
    assertEquals(entity?.scopeKey, ALICE_LANE);

    // The same request without an acting context stays sponsor-resolved.
    const sponsor = await graphQueryFor(harness);
    assertExists(sponsor.ok);
    assertEquals(
      sponsor.ok.entities.find((candidate) => candidate.id === SHARED_USER_DOC)
        ?.document,
      { value: 22 },
    );
  } finally {
    await harness.close();
  }
});

Deno.test("a lane read with an absent or dead grant rejects with the named cause", async () => {
  const harness = await setupHarness("memory-v2-lane-read-grant-fence");
  try {
    // Absent grant: carol never had a lane.
    const absent = await graphQueryFor(harness, CAROL_LANE);
    assertLaneReadRejection(absent.error);

    // Dead grant: alice's lane drains when her anchoring client disconnects.
    await harness.aliceClient.close();
    const dead = await graphQueryFor(harness, ALICE_LANE);
    assertLaneReadRejection(dead.error);
    // Constant shape: byte-identical to the absent-grant rejection.
    assertEquals(dead.error, absent.error);
  } finally {
    await harness.close();
  }
});

Deno.test("an acting context requires a lease-bound executor session", async () => {
  const harness = await setupHarness("memory-v2-lane-read-unbound");
  try {
    const response = await harness.server.graphQuery({
      type: "graph.query",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.aliceSession.sessionId,
      actingContext: ALICE_LANE,
      query: { roots: [userDocRoot] },
    });
    assertExists(response.error);
    assertEquals(response.error.name, "ProtocolError");
  } finally {
    await harness.close();
  }
});

Deno.test("watch registration accepts a validated acting context", async () => {
  const harness = await setupHarness("memory-v2-lane-read-watch");
  try {
    const registered = await harness.server.watchSet({
      type: "session.watch.set",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.bobSession.sessionId,
      actingContext: ALICE_LANE,
      watches: [{
        id: "lane-watch",
        kind: "graph",
        query: { roots: [userDocRoot] },
      }],
    });
    assertExists(registered.ok);
    const upsert = registered.ok.sync.upserts.find(
      (candidate) => candidate.id === SHARED_USER_DOC,
    );
    assertEquals(upsert?.doc, { value: 11 });
    // Sync frames attribute per lane via the resolved scope key.
    assertEquals(upsert?.scopeKey, ALICE_LANE);

    // A dead-grant registration rejects with the named cause.
    const rejected = await harness.server.watchSet({
      type: "session.watch.set",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.bobSession.sessionId,
      actingContext: CAROL_LANE,
      watches: [{
        id: "lane-watch",
        kind: "graph",
        query: { roots: [userDocRoot] },
      }],
    });
    assertLaneReadRejection(rejected.error);
  } finally {
    await harness.close();
  }
});

Deno.test("scheduler snapshots for a lease-bound session derive from open lane grants", async () => {
  const harness = await setupHarness("memory-v2-lane-read-snapshots", {
    grantAlice: false,
  });
  try {
    const list = (actingContext?: SchedulerExecutionContextKey) =>
      harness.server.listSchedulerActionSnapshots({
        type: "scheduler.snapshot.list",
        requestId: crypto.randomUUID(),
        space: SPACE,
        sessionId: harness.bobSession.sessionId,
        ...(actingContext !== undefined ? { actingContext } : {}),
        query: { branch: "" },
      });

    // No open grants: the lease-bound session's applicable keys are exactly
    // ["space"], never the sponsor's own user/session contexts — alice's
    // user-context row is invisible.
    const withoutGrant = await list();
    assertExists(withoutGrant.ok);
    assertEquals(withoutGrant.ok.snapshots.length, 0);
    // An acting-context list without a live grant rejects, constant shape.
    assertLaneReadRejection((await list(ALICE_LANE)).error);

    await harness.server.openUserLaneGrant(SPACE, "", LANE_PRINCIPAL);
    // Open grant: the lane's rows become applicable — with and without the
    // per-request acting context.
    const withGrant = await list();
    assertExists(withGrant.ok);
    assertEquals(
      withGrant.ok.snapshots.map((snapshot) => snapshot.executionContextKey),
      [ALICE_LANE],
    );
    const acting = await list(ALICE_LANE);
    assertExists(acting.ok);
    assertEquals(acting.ok.snapshots.length, 1);

    // An UNBOUND session keeps its principal-derived keys byte-identically:
    // alice still lists her own row with no acting context at all.
    const aliceList = await harness.server.listSchedulerActionSnapshots({
      type: "scheduler.snapshot.list",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.aliceSession.sessionId,
      query: { branch: "" },
    });
    assertExists(aliceList.ok);
    assertEquals(aliceList.ok.snapshots.length, 1);
  } finally {
    await harness.close();
  }
});

Deno.test("writer lookup resolves targets under the acting principal", async () => {
  const harness = await setupHarness("memory-v2-lane-read-writers");
  try {
    const lookup = (actingContext?: SchedulerExecutionContextKey) =>
      harness.server.writersForTargets({
        type: "scheduler.writer.list",
        requestId: crypto.randomUUID(),
        space: SPACE,
        sessionId: harness.bobSession.sessionId,
        ...(actingContext !== undefined ? { actingContext } : {}),
        query: {
          branch: "",
          targets: [{
            id: OBSERVED_USER_DOC,
            scope: "user",
            path: toDocumentPath(["value"]),
          }],
        },
      });

    // Acting as alice, the user-scoped target resolves HER scope key and
    // finds her durable writer row.
    const acting = await lookup(ALICE_LANE);
    assertExists(acting.ok);
    assertEquals(acting.ok.writers.length, 1);
    assertEquals(
      acting.ok.writers[0].matchedWrites[0]?.write.scopeKey,
      ALICE_LANE,
    );
    // Without an acting context the sponsor's instance matches nothing.
    const sponsor = await lookup();
    assertExists(sponsor.ok);
    assertEquals(sponsor.ok.writers.length, 0);
    // A dead/absent grant rejects with the named cause.
    assertLaneReadRejection((await lookup(CAROL_LANE)).error);
  } finally {
    await harness.close();
  }
});

Deno.test("accepted commits carry the resolved scope key per revision", async () => {
  const harness = await setupHarness("memory-v2-lane-read-notice");
  try {
    const events: AcceptedCommitEvent[] = [];
    const unsubscribe = harness.server.subscribeAcceptedCommits(
      SPACE,
      (event) => {
        events.push(event);
      },
    );
    await harness.aliceSession.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set",
          id: "of:lane-read-notice-user",
          scope: "user",
          value: { value: 1 },
        },
        {
          op: "set",
          id: "of:lane-read-notice-space",
          value: { value: 2 },
        },
      ],
    });
    unsubscribe();
    const event = events.find((candidate) =>
      candidate.revisions.some((revision) =>
        revision.id === "of:lane-read-notice-user"
      )
    );
    assertExists(event);
    const userRevision = event.revisions.find(
      (revision) => revision.id === "of:lane-read-notice-user",
    );
    const spaceRevision = event.revisions.find(
      (revision) => revision.id === "of:lane-read-notice-space",
    );
    assertEquals(userRevision?.scopeKey, ALICE_LANE);
    assertEquals(spaceRevision?.scopeKey, "space");
  } finally {
    await harness.close();
  }
});

Deno.test("the acting-context read parameter survives the wire parse", () => {
  const parsedQuery = parseClientMessage(encodeMemoryBoundary({
    type: "graph.query",
    requestId: "r1",
    space: SPACE,
    sessionId: "s1",
    actingContext: ALICE_LANE,
    query: { roots: [] },
  }));
  assert(parsedQuery?.type === "graph.query");
  assertEquals(parsedQuery.actingContext, ALICE_LANE);

  const parsedWatch = parseClientMessage(encodeMemoryBoundary({
    type: "session.watch.set",
    requestId: "r2",
    space: SPACE,
    sessionId: "s1",
    actingContext: ALICE_LANE,
    watches: [],
  }));
  assert(parsedWatch?.type === "session.watch.set");
  assertEquals(parsedWatch.actingContext, ALICE_LANE);

  const parsedSnapshots = parseClientMessage(encodeMemoryBoundary({
    type: "scheduler.snapshot.list",
    requestId: "r3",
    space: SPACE,
    sessionId: "s1",
    actingContext: ALICE_LANE,
    query: {},
  }));
  assert(parsedSnapshots?.type === "scheduler.snapshot.list");
  assertEquals(parsedSnapshots.actingContext, ALICE_LANE);

  const parsedWriters = parseClientMessage(encodeMemoryBoundary({
    type: "scheduler.writer.list",
    requestId: "r4",
    space: SPACE,
    sessionId: "s1",
    actingContext: ALICE_LANE,
    query: { branch: "", targets: [] },
  }));
  assert(parsedWriters?.type === "scheduler.writer.list");
  assertEquals(parsedWriters.actingContext, ALICE_LANE);

  // Requests WITHOUT the field parse exactly as before (additive shape).
  const bare = parseClientMessage(encodeMemoryBoundary({
    type: "graph.query",
    requestId: "r5",
    space: SPACE,
    sessionId: "s1",
    query: { roots: [] },
  }));
  assert(bare?.type === "graph.query");
  assertEquals(bare.actingContext, undefined);
});

// --- F2 point reads (FA5/FA6): the docs.read surface carries the same
// acting-context seam as every other read from day one. ---

const docsReadFor = (
  harness: LaneReadHarness,
  actingContext?: SchedulerExecutionContextKey,
  atSeq?: number,
) =>
  harness.server.docsRead({
    type: "docs.read",
    requestId: crypto.randomUUID(),
    space: SPACE,
    sessionId: harness.bobSession.sessionId,
    ...(actingContext !== undefined ? { actingContext } : {}),
    query: {
      docs: [{ id: SHARED_USER_DOC, scope: "user" }],
      ...(atSeq !== undefined ? { atSeq } : {}),
    },
  });

Deno.test("a lane point read under a live grant returns the lane principal's instance", async () => {
  const harness = await setupHarness("memory-v2-lane-point-read-instance");
  try {
    const acting = await docsReadFor(harness, ALICE_LANE);
    assertExists(acting.ok);
    const entity = acting.ok.entities.find(
      (candidate) => candidate.id === SHARED_USER_DOC,
    );
    assertEquals(entity?.document, { value: 11 });
    // The RESOLVED scope key rides the snapshot (FA6 matching input).
    assertEquals(entity?.scopeKey, ALICE_LANE);

    // The same point read without an acting context stays sponsor-resolved.
    const sponsor = await docsReadFor(harness);
    assertExists(sponsor.ok);
    assertEquals(
      sponsor.ok.entities.find((candidate) => candidate.id === SHARED_USER_DOC)
        ?.document,
      { value: 22 },
    );
  } finally {
    await harness.close();
  }
});

Deno.test("a lane point read with an absent or dead grant rejects with the named cause", async () => {
  const harness = await setupHarness("memory-v2-lane-point-read-fence");
  try {
    const absent = await docsReadFor(harness, CAROL_LANE);
    assertLaneReadRejection(absent.error);

    await harness.aliceClient.close();
    const dead = await docsReadFor(harness, ALICE_LANE);
    assertLaneReadRejection(dead.error);
    assertEquals(dead.error, absent.error);
  } finally {
    await harness.close();
  }
});

Deno.test("a point read acting context requires a lease-bound executor session", async () => {
  const harness = await setupHarness("memory-v2-lane-point-read-unbound");
  try {
    const response = await harness.server.docsRead({
      type: "docs.read",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.aliceSession.sessionId,
      actingContext: ALICE_LANE,
      query: { docs: [{ id: SHARED_USER_DOC, scope: "user" }] },
    });
    assertExists(response.error);
    assertEquals(response.error.name, "ProtocolError");
  } finally {
    await harness.close();
  }
});

Deno.test("point reads evaluate at the requested sequence bound and omit never-written docs", async () => {
  const harness = await setupHarness("memory-v2-lane-point-read-atseq");
  try {
    const head = await docsReadFor(harness, ALICE_LANE);
    assertExists(head.ok);
    const headSeq = head.ok.entities.find(
      (candidate) => candidate.id === SHARED_USER_DOC,
    )?.seq;
    assertExists(headSeq);

    // Advance alice's instance; a read pinned below the new write must
    // still see the old value (single-snapshot batch evaluation).
    await harness.aliceSession.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SHARED_USER_DOC,
        scope: "user",
        value: { value: 111 },
      }],
    });
    const pinned = await docsReadFor(harness, ALICE_LANE, headSeq);
    assertExists(pinned.ok);
    assertEquals(
      pinned.ok.entities.find((candidate) => candidate.id === SHARED_USER_DOC)
        ?.document,
      { value: 11 },
    );
    const current = await docsReadFor(harness, ALICE_LANE);
    assertExists(current.ok);
    assertEquals(
      current.ok.entities.find((candidate) => candidate.id === SHARED_USER_DOC)
        ?.document,
      { value: 111 },
    );

    // Never-written docs are omitted, not surfaced as tombstones.
    const missing = await harness.server.docsRead({
      type: "docs.read",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.bobSession.sessionId,
      query: { docs: [{ id: "of:lane-read-never-written" }] },
    });
    assertExists(missing.ok);
    assertEquals(missing.ok.entities, []);
  } finally {
    await harness.close();
  }
});

Deno.test("the acting-context point-read parameter survives the wire parse", () => {
  const parsed = parseClientMessage(encodeMemoryBoundary({
    type: "docs.read",
    requestId: "r6",
    space: SPACE,
    sessionId: "s1",
    actingContext: ALICE_LANE,
    query: { docs: [{ id: SHARED_USER_DOC, scope: "user" }], atSeq: 7 },
  }));
  assert(parsed?.type === "docs.read");
  assertEquals(parsed.actingContext, ALICE_LANE);
  assertEquals(parsed.query.atSeq, 7);
  assertEquals(parsed.query.docs, [{ id: SHARED_USER_DOC, scope: "user" }]);

  const bare = parseClientMessage(encodeMemoryBoundary({
    type: "docs.read",
    requestId: "r7",
    space: SPACE,
    sessionId: "s1",
    query: { docs: [] },
  }));
  assert(bare?.type === "docs.read");
  assertEquals(bare.actingContext, undefined);
});
