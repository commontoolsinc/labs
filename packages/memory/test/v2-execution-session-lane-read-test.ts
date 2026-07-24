// C2.4 (session lanes, read seam): a lease-bound executor session may name a
// SESSION acting context on every read surface graph.query / docs.read /
// session.watch.set / session.watch.add / scheduler.snapshot.list /
// scheduler.writer.list — validated against the LIVE session lane grant and
// resolved with the GRANT's session id, NEVER the requesting channel's
// base/sponsor session id (amendment CA8: through one sponsor-bound provider
// channel, a read under alice-session-1's grant must resolve s1's instances
// even though the channel's own session id differs, and alice-session-2's
// grant must never resolve s1's instances). Mirrors the C1.4b user-lane
// fixtures in v2-execution-lane-read-test.ts; the user seam and the F6
// cohort fixtures must stay byte-identical.
import { assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { toDirtyKey } from "../v2/query.ts";
import {
  type ExecutionLease,
  setServerPrimaryExecutionGraphRetirementConfig,
  toDocumentPath,
  type WatchSpec,
} from "../v2.ts";
import * as MemoryV2 from "../v2.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

// FW5 (FB9): admit every space to the doc-set surface for this file — same
// module-top pattern as v2-feed-cohort-test.ts; dial authority itself is
// pinned in v2-feed-retirement-test.ts.
setServerPrimaryExecutionGraphRetirementConfig(["*"]);

const SPACE = "did:key:z6Mk-session-lane-read-space";
// Colon-bearing DIDs exercise the canonical percent-encoded lane keys.
const SPONSOR = "did:key:z6Mk-session-lane-read-sponsor-bob";
const LANE_PRINCIPAL = "did:key:z6Mk-session-lane-read-alice";
const AUDIENCE = "did:key:z6Mk-session-lane-read-audience";

const SHARED_SESSION_DOC = "of:session-lane-read-doc";
const OBSERVED_SESSION_DOC = "of:session-lane-read-observed";

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(branch: string, pieces: readonly string[]): Promise<
    boolean
  >;
  watchSetSync(
    watches: WatchSpec[],
    options?: { actingContext?: SchedulerExecutionContextKey },
  ): Promise<unknown>;
};

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

type SessionGrant = Readonly<{
  contextKey: `session:${string}:${string}`;
  principal: string;
  sessionId: string;
  laneGeneration: number;
}>;

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
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<SessionGrant>;
  closeSessionLaneGrant(grant: SessionGrant): boolean;
};

const createServer = (name: string): LaneReadServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      // Waves are driven manually so every delivery is deterministic.
      subscriptionRefreshDelayMs: 3_600_000,
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
        serverPrimaryExecutionDocSetWatchV1: true,
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
      serverPrimaryExecutionDocSetWatchV1: true,
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
  setServerPrimaryExecutionClaimRankConfig(
    rank?: "space" | "user" | "session",
  ): void;
  resetServerPrimaryExecutionClaimRankConfig(): void;
};

/** Unclaimed alice observation with session-scoped surfaces: creates durable
 * scheduler rows (snapshot + write index) under HER OWN session context. */
const aliceSessionObservation = (): SchedulerActionObservation => {
  const write: SchedulerObservationAddress = {
    space: SPACE,
    scope: "session",
    id: OBSERVED_SESSION_DOC,
    path: ["value"],
  };
  return {
    version: 2,
    ownerSpace: SPACE,
    branch: "",
    pieceId: "space:of:session-lane-read-piece",
    processGeneration: 1,
    actionId: "action:session-lane-read",
    actionKind: "computation",
    implementationFingerprint: "impl:session-lane-read",
    runtimeFingerprint: "runtime:session-lane-read",
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
      implementationFingerprint: "impl:session-lane-read",
      runtimeFingerprint: "runtime:session-lane-read",
      piece: {
        space: SPACE,
        scope: "space",
        id: "of:session-lane-read-piece",
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

type SessionLaneReadHarness = {
  server: LaneReadServer;
  bobClient: MemoryClient.Client;
  /** The sponsor-bound provider channel: bob's OWN session id deliberately
   * differs from both alice session lanes (the CA8 setup). */
  bobSession: ExecutionSession;
  alice1Client: MemoryClient.Client;
  alice1: ExecutionSession;
  alice2Client: MemoryClient.Client;
  alice2: ExecutionSession;
  s1Lane: SchedulerExecutionContextKey;
  s2Lane: SchedulerExecutionContextKey;
  s1Grant?: SessionGrant;
  s2Grant?: SessionGrant;
  close(): Promise<void>;
};

/** One sponsor-bound provider session (bob) plus TWO alice sessions holding
 * distinct instances of SHARED_SESSION_DOC (11 at s1, 22 at s2; bob's own
 * session instance holds 99), alice-s1's durable session-context observation
 * row, and bob's session lease-bound. */
const setupHarness = async (
  name: string,
  options: { grantS1?: boolean; grantS2?: boolean } = {},
): Promise<SessionLaneReadHarness> => {
  const server = createServer(name);
  rankDial.resetServerPrimaryExecutionClaimRankConfig();
  const bobClient = await connectClient(server);
  const bobSession = await mountAs(bobClient, SPONSOR);
  const alice1Client = await connectClient(server);
  const alice1 = await mountAs(alice1Client, LANE_PRINCIPAL);
  const alice2Client = await connectClient(server);
  const alice2 = await mountAs(alice2Client, LANE_PRINCIPAL);
  await bobSession.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:session-lane-read-seed",
      value: { value: "seed" },
    }],
  });
  await bobSession.transact({
    localSeq: 2,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: SHARED_SESSION_DOC,
      scope: "session",
      value: { value: 99 },
    }],
  });
  await alice1.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: SHARED_SESSION_DOC,
      scope: "session",
      value: { value: 11 },
    }],
  });
  await alice2.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: SHARED_SESSION_DOC,
      scope: "session",
      value: { value: 22 },
    }],
  });
  await alice1.transact({
    localSeq: 2,
    reads: { confirmed: [], pending: [] },
    operations: [],
    schedulerObservation: aliceSessionObservation(),
  });
  rankDial.setServerPrimaryExecutionClaimRankConfig("session");
  await bobSession.setExecutionDemand("", ["space:piece:session-lane-read"]);
  const lease = await server.acquireExecutionLease(SPACE, "");
  assertExists(lease);
  server.bindExecutionSession(SPACE, bobSession.sessionId, lease);
  const s1Grant = options.grantS1 !== false
    ? await server.openSessionLaneGrant(
      SPACE,
      "",
      LANE_PRINCIPAL,
      alice1.sessionId,
    )
    : undefined;
  const s2Grant = options.grantS2 !== false
    ? await server.openSessionLaneGrant(
      SPACE,
      "",
      LANE_PRINCIPAL,
      alice2.sessionId,
    )
    : undefined;
  return {
    server,
    bobClient,
    bobSession,
    alice1Client,
    alice1,
    alice2Client,
    alice2,
    s1Lane: Engine.sessionExecutionContextKey(
      LANE_PRINCIPAL,
      alice1.sessionId,
    ) as SchedulerExecutionContextKey,
    s2Lane: Engine.sessionExecutionContextKey(
      LANE_PRINCIPAL,
      alice2.sessionId,
    ) as SchedulerExecutionContextKey,
    s1Grant,
    s2Grant,
    close: async () => {
      rankDial.resetServerPrimaryExecutionClaimRankConfig();
      await alice2Client.close();
      await alice1Client.close();
      await bobClient.close();
      await server.close();
    },
  };
};

const sessionDocRoot = {
  id: SHARED_SESSION_DOC,
  scope: "session" as const,
  selector: { path: [], schema: false as const },
};

const graphQueryFor = (
  harness: SessionLaneReadHarness,
  actingContext?: SchedulerExecutionContextKey,
) =>
  harness.server.graphQuery({
    type: "graph.query",
    requestId: crypto.randomUUID(),
    space: SPACE,
    sessionId: harness.bobSession.sessionId,
    ...(actingContext !== undefined ? { actingContext } : {}),
    query: { roots: [sessionDocRoot] },
  });

const docsReadFor = (
  harness: SessionLaneReadHarness,
  actingContext?: SchedulerExecutionContextKey,
) =>
  harness.server.docsRead({
    type: "docs.read",
    requestId: crypto.randomUUID(),
    space: SPACE,
    sessionId: harness.bobSession.sessionId,
    ...(actingContext !== undefined ? { actingContext } : {}),
    query: { docs: [{ id: SHARED_SESSION_DOC, scope: "session" }] },
  });

/** Constant-shape lane-read rejection: the C1.3 fence-cause vocabulary,
 * byte-identical across absent grant, drained lane, and wrong session. */
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

const sharedDocOf = (
  response: {
    ok?: { entities: Array<{ id: string; document?: unknown; scopeKey?: string }> };
  },
): { document?: unknown; scopeKey?: string } | undefined =>
  response.ok?.entities.find((candidate) => candidate.id === SHARED_SESSION_DOC);

// --- (a) THE CA8 PAIR: one provider channel, two live alice session grants;
// each read resolves the GRANT's session instance, never the channel's own
// (base/sponsor) session and never the sibling's. ---

Deno.test("CA8: session-lane reads resolve the GRANT's session id, never base.sessionId and never a sibling's", async () => {
  const harness = await setupHarness("memory-v2-session-lane-read-pair");
  try {
    for (
      const readFor of [graphQueryFor, docsReadFor]
    ) {
      // Under s1's grant: s1's instance — although the requesting channel's
      // own session id (bob's) differs from both lane sessions.
      const s1 = sharedDocOf(await readFor(harness, harness.s1Lane));
      assertEquals(s1?.document, { value: 11 });
      assertEquals(s1?.scopeKey, harness.s1Lane);
      // Under s2's grant: s2's instance — never s1's.
      const s2 = sharedDocOf(await readFor(harness, harness.s2Lane));
      assertEquals(s2?.document, { value: 22 });
      assertEquals(s2?.scopeKey, harness.s2Lane);
      // Without an acting context the channel stays sponsor-resolved: bob's
      // own session instance, untouched by the open alice grants.
      const sponsor = sharedDocOf(await readFor(harness));
      assertEquals(sponsor?.document, { value: 99 });
    }
  } finally {
    await harness.close();
  }
});

// --- (b) Typed rejections: no live grant, a grant for a different session,
// a fenced (stale-generation) incarnation, malformed keys, unbound. ---

Deno.test("session-lane reads reject without a live grant for EXACTLY that session, constant shape", async () => {
  const harness = await setupHarness("memory-v2-session-lane-read-fence", {
    grantS2: false,
  });
  try {
    // A grant for a DIFFERENT session of the same principal never serves
    // this one: only s1's grant is live, s2's acting context rejects.
    const wrongSession = await graphQueryFor(harness, harness.s2Lane);
    assertLaneReadRejection(wrongSession.error);

    // Stale generation: fencing the live incarnation (drain) rejects reads
    // until a NEW incarnation opens, which serves again under a bumped
    // generation.
    assertExists(harness.s1Grant);
    assertEquals(harness.server.closeSessionLaneGrant(harness.s1Grant), true);
    const fenced = await graphQueryFor(harness, harness.s1Lane);
    assertLaneReadRejection(fenced.error);
    // Constant shape: byte-identical to the absent-grant rejection.
    assertEquals(fenced.error, wrongSession.error);
    const reopened = await harness.server.openSessionLaneGrant(
      SPACE,
      "",
      LANE_PRINCIPAL,
      harness.alice1.sessionId,
    );
    assertEquals(reopened.laneGeneration, harness.s1Grant.laneGeneration + 1);
    const served = sharedDocOf(await graphQueryFor(harness, harness.s1Lane));
    assertEquals(served?.document, { value: 11 });

    // Session-end = lane-end: the anchoring client's disconnect drains the
    // lane and the point-read path rejects identically.
    await harness.alice1Client.close();
    const dead = await docsReadFor(harness, harness.s1Lane);
    assertLaneReadRejection(dead.error);

    // Malformed session acting contexts stay a ProtocolError, never a lane
    // probe.
    const malformed = await graphQueryFor(
      harness,
      "session:a:b:c" as SchedulerExecutionContextKey,
    );
    assertExists(malformed.error);
    assertEquals(malformed.error.name, "ProtocolError");

    // A session acting context requires a lease-bound executor session.
    const unbound = await harness.server.docsRead({
      type: "docs.read",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.alice2.sessionId,
      actingContext: harness.s2Lane,
      query: { docs: [{ id: SHARED_SESSION_DOC, scope: "session" }] },
    });
    assertExists(unbound.error);
    assertEquals(unbound.error.name, "ProtocolError");
  } finally {
    await harness.close();
  }
});

// --- Watch registration: the acting lane sticks to the watch set — the
// full-re-evaluation refresh keeps resolving the GRANT's session (never
// silently flipping to the sponsor's instances), and session.watch.add
// requires the SAME session lane, not merely the same principal. ---

Deno.test("a watch set under a session acting context registers, refreshes, and adds under the GRANT's session", async () => {
  const harness = await setupHarness("memory-v2-session-lane-read-watch");
  try {
    const registered = await harness.server.watchSet({
      type: "session.watch.set",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.bobSession.sessionId,
      actingContext: harness.s1Lane,
      watches: [{
        id: "session-lane-watch",
        kind: "graph",
        query: { roots: [sessionDocRoot] },
      }],
    });
    assertExists(registered.ok);
    const upsert = registered.ok.sync.upserts.find(
      (candidate) => candidate.id === SHARED_SESSION_DOC,
    );
    assertEquals(upsert?.doc, { value: 11 });
    assertEquals(upsert?.scopeKey, harness.s1Lane);

    // session.watch.add under the SIBLING session's live grant must reject:
    // same principal is NOT enough — the watch set belongs to s1's lane.
    const siblingAdd = await harness.server.watchAdd({
      type: "session.watch.add",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.bobSession.sessionId,
      actingContext: harness.s2Lane,
      watches: [{
        id: "session-lane-watch-2",
        kind: "graph",
        query: { roots: [sessionDocRoot] },
      }],
    });
    assertExists(siblingAdd.error);
    assertEquals(siblingAdd.error.name, "ProtocolError");

    // The SAME lane adds fine.
    const sameAdd = await harness.server.watchAdd({
      type: "session.watch.add",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.bobSession.sessionId,
      actingContext: harness.s1Lane,
      watches: [{
        id: "session-lane-watch-2",
        kind: "graph",
        query: { roots: [sessionDocRoot] },
      }],
    });
    assertExists(sameAdd.ok);

    // Full re-evaluation (resume catch-up) keeps resolving under the
    // GRANT's session id: alice-s1 advances her instance and the refresh
    // delivers HER new value — a refresh that fell back to the sponsor's
    // session would resolve a phantom instance instead.
    await harness.alice1.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SHARED_SESSION_DOC,
        scope: "session",
        value: { value: 111 },
      }],
    });
    const refreshed = await harness.server.syncSessionForConnection(
      SPACE,
      harness.bobSession.sessionId,
    );
    assertExists(refreshed);
    const effect = refreshed.effect as {
      type: string;
      upserts?: Array<{ id: string; doc?: unknown; scopeKey?: string }>;
    };
    assertEquals(effect.type, "sync");
    const refreshedUpsert = effect.upserts?.find(
      (candidate) => candidate.id === SHARED_SESSION_DOC,
    );
    assertEquals(refreshedUpsert?.doc, { value: 111 });
    assertEquals(refreshedUpsert?.scopeKey, harness.s1Lane);
  } finally {
    await harness.close();
  }
});

// --- Scheduler snapshots: session acting contexts narrow the applicable
// set to that one lane; the no-acting-context enumeration derives from open
// lane grants of BOTH ranks. ---

Deno.test("scheduler snapshots derive session lanes from open grants and the acting context", async () => {
  const harness = await setupHarness("memory-v2-session-lane-read-snapshots", {
    grantS1: false,
    grantS2: false,
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
    // ["space"] — alice-s1's session-context row is invisible.
    const withoutGrant = await list();
    assertExists(withoutGrant.ok);
    assertEquals(withoutGrant.ok.snapshots.length, 0);
    // An acting-context list without a live grant rejects, constant shape.
    assertLaneReadRejection((await list(harness.s1Lane)).error);

    await harness.server.openSessionLaneGrant(
      SPACE,
      "",
      LANE_PRINCIPAL,
      harness.alice1.sessionId,
    );
    await harness.server.openSessionLaneGrant(
      SPACE,
      "",
      LANE_PRINCIPAL,
      harness.alice2.sessionId,
    );
    // Open grants: s1's lane row becomes applicable — with and without the
    // per-request acting context.
    const withGrant = await list();
    assertExists(withGrant.ok);
    assertEquals(
      withGrant.ok.snapshots.map((snapshot) => snapshot.executionContextKey),
      [harness.s1Lane],
    );
    const acting = await list(harness.s1Lane);
    assertExists(acting.ok);
    assertEquals(acting.ok.snapshots.length, 1);
    // The SIBLING lane's acting context sees no s1 rows: the applicable set
    // is that one lane plus space.
    const sibling = await list(harness.s2Lane);
    assertExists(sibling.ok);
    assertEquals(sibling.ok.snapshots.length, 0);

    // An UNBOUND session keeps its principal-derived chain byte-identically:
    // alice-s1 lists her own row with no acting context at all.
    const aliceList = await harness.server.listSchedulerActionSnapshots({
      type: "scheduler.snapshot.list",
      requestId: crypto.randomUUID(),
      space: SPACE,
      sessionId: harness.alice1.sessionId,
      query: { branch: "" },
    });
    assertExists(aliceList.ok);
    assertEquals(aliceList.ok.snapshots.length, 1);
  } finally {
    await harness.close();
  }
});

// --- Writer lookup: a session-scoped target resolves the GRANT's session
// scope key (the CA8 kill on this surface: base.sessionId would resolve a
// phantom `session:alice:<sponsor-session>` instance and find nothing). ---

Deno.test("writer lookup resolves session targets under the grant's session id", async () => {
  const harness = await setupHarness("memory-v2-session-lane-read-writers");
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
            id: OBSERVED_SESSION_DOC,
            scope: "session",
            path: toDocumentPath(["value"]),
          }],
        },
      });

    // Acting under s1's grant, the session-scoped target resolves s1's
    // scope key and finds alice-s1's durable writer row.
    const acting = await lookup(harness.s1Lane);
    assertExists(acting.ok);
    assertEquals(acting.ok.writers.length, 1);
    assertEquals(
      acting.ok.writers[0].matchedWrites[0]?.write.scopeKey,
      harness.s1Lane,
    );
    // The sibling lane resolves ITS instance and finds nothing.
    const sibling = await lookup(harness.s2Lane);
    assertExists(sibling.ok);
    assertEquals(sibling.ok.writers.length, 0);
    // Without an acting context the sponsor's instance matches nothing.
    const sponsor = await lookup();
    assertExists(sponsor.ok);
    assertEquals(sponsor.ok.writers.length, 0);
  } finally {
    await harness.close();
  }
});

// --- (e) F6 interplay: a docs watch registered under a SESSION acting
// context is cohort-keyed to the LANE's session instance — the FB25 family
// extended to session rank. A wave scoped to the sibling session's instance
// must not even touch the lane-holding session. ---

Deno.test("F6 session-lane docs watch: the cohort derives from the GRANT's session, sibling-instance waves do zero work", async () => {
  const harness = await setupHarness("memory-v2-session-lane-read-cohort");
  try {
    await harness.bobSession.watchSetSync(
      [
        {
          id: "session-lane-docs",
          kind: "docs",
          docs: [{ id: SHARED_SESSION_DOC, scope: "session" }],
        } as unknown as WatchSpec,
      ],
      { actingContext: harness.s1Lane },
    );

    // alice-s1 advances her instance; the wave's cohort names HER resolved
    // scope key.
    await harness.alice1.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SHARED_SESSION_DOC,
        scope: "session",
        value: { value: 111 },
      }],
    });
    const dirtyKey = toDirtyKey(SHARED_SESSION_DOC, "session");
    const before = harness.server.feedStats.refreshCohortSuppressedSessions;
    const delivered = await harness.server.syncSessionForConnection(
      SPACE,
      harness.bobSession.sessionId,
      new Set([dirtyKey]),
      undefined,
      { dirtyScopeKeys: new Map([[dirtyKey, new Set([harness.s1Lane])]]) },
    );
    assertExists(delivered);
    const effect = delivered.effect as {
      type: string;
      upserts?: Array<{ id: string; doc?: unknown; scopeKey?: string }>;
    };
    assertEquals(
      effect.upserts?.map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
        scopeKey: upsert.scopeKey,
      })),
      [{
        id: SHARED_SESSION_DOC,
        doc: { value: 111 },
        scopeKey: harness.s1Lane,
      }],
    );

    // A wave scoped to the SIBLING session's instance must not even touch
    // the lane-holding session (zero B-side work, not just zero delivery).
    await harness.alice2.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SHARED_SESSION_DOC,
        scope: "session",
        value: { value: 222 },
      }],
    });
    const siblingWave = await harness.server.syncSessionForConnection(
      SPACE,
      harness.bobSession.sessionId,
      new Set([dirtyKey]),
      undefined,
      { dirtyScopeKeys: new Map([[dirtyKey, new Set([harness.s2Lane])]]) },
    );
    assertEquals(
      siblingWave,
      null,
      "a sibling-instance wave must not touch the lane-holding session",
    );
    assertEquals(
      harness.server.feedStats.refreshCohortSuppressedSessions,
      before + 1,
    );
  } finally {
    await harness.close();
  }
});
