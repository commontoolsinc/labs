import { assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { toDirtyKey } from "../v2/query.ts";
import {
  type ExecutionLease,
  setServerPrimaryExecutionGraphRetirementConfig,
  type WatchSpec,
} from "../v2.ts";
import type { SchedulerExecutionContextKey } from "../v2/engine.ts";

// --- F6: lane-correct scoped delivery (cohort filtering). A commit
// revision's delivery cohort derives from its RESOLVED scope key at the
// dirty-routing layer: `space` fans out to every capable session (unchanged),
// `user:<did>` reaches only that principal's interested sessions, and
// `session:<did>:<sid>` reaches exactly the one live session it names. The
// acceptance bar is ZERO B-side work — a session outside the cohort is never
// counted touched (feedStats.refreshSessionsTouched) and never point-reads —
// not merely zero delivered entities.
//
// FW5 (FB9): admit every space to the doc-set surface for this file; dial
// authority itself is pinned in v2-feed-retirement-test.ts.
setServerPrimaryExecutionGraphRetirementConfig(["*"]);

const SPACE = "did:key:z6Mk-feed-cohort-space";
const AUDIENCE = "did:key:z6Mk-feed-cohort-audience";
const ALICE = "did:key:z6Mk-feed-cohort-alice";
const BOB = "did:key:z6Mk-feed-cohort-bob";
// FB25 lane fixtures: the sponsor hosts the lease-bound executor session.
const SPONSOR = "did:key:z6Mk-feed-cohort-sponsor";

const ALICE_LANE = Engine.userExecutionContextKey(
  ALICE,
) as SchedulerExecutionContextKey;

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
};

type ExecutionLeaseHandle = ExecutionLease & { readonly __brand?: unknown };

type ExecutionServer = Server & {
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

const createServer = (name: string): ExecutionServer =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      // Waves are driven manually (syncSessionForConnection or an explicit
      // flushSessions) so every delivery is deterministic.
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
  ) as ExecutionServer;

const connectClient = (server: Server): Promise<MemoryClient.Client> =>
  MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionBuiltinPassivityV1: true,
      serverPrimaryExecutionContextLatticeClaimsV1: true,
      serverPrimaryExecutionDocSetWatchV1: true,
    },
  } as MemoryClient.ConnectOptions);

const mountAs = (
  client: MemoryClient.Client,
  principal: string,
  options: MemoryClient.MountOptions = {},
): Promise<ExecutionSession> =>
  client.mount(SPACE, options, (_space, _session, context) => ({
    invocation: { aud: context.audience, challenge: context.challenge.value },
    authorization: { principal },
  })) as Promise<ExecutionSession>;

const docsWatch = (
  id: string,
  docs: Array<{ id: string; scope?: "space" | "user" | "session" }>,
): WatchSpec => ({ id, kind: "docs", docs } as unknown as WatchSpec);

const graphWatch = (
  id: string,
  roots: Array<{ id: string; scope?: "space" | "user" | "session" }>,
): WatchSpec => ({
  id,
  kind: "graph",
  query: {
    roots: roots.map((root) => ({
      id: root.id,
      ...(root.scope !== undefined ? { scope: root.scope } : {}),
      selector: { path: [], schema: false },
    })),
  },
} as unknown as WatchSpec);

const setDoc = (
  session: MemoryClient.SpaceSession,
  localSeq: number,
  id: string,
  value: string,
  scope?: "user" | "session",
) =>
  session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id,
      ...(scope !== undefined ? { scope } : {}),
      value: { value },
    }],
  });

const effectUpserts = (
  message: { effect: { type: string } } | null,
): Array<{ id: string; doc?: unknown; scopeKey?: string }> => {
  if (message === null) return [];
  const effect = message.effect as {
    type: string;
    upserts?: Array<{ id: string; doc?: unknown; scopeKey?: string }>;
  };
  return effect.type === "sync" ? effect.upserts ?? [] : [];
};

const feedCounters = (server: Server) => ({
  touched: server.feedStats.refreshSessionsTouched,
  memberDeliveries: server.feedStats.docSetMemberDeliveries,
  upsertsPushed: server.feedStats.refreshUpsertsPushed,
  cohortSuppressed: server.feedStats.refreshCohortSuppressedSessions,
});

const counterDelta = (
  before: ReturnType<typeof feedCounters>,
  after: ReturnType<typeof feedCounters>,
) => ({
  touched: after.touched - before.touched,
  memberDeliveries: after.memberDeliveries - before.memberDeliveries,
  upsertsPushed: after.upsertsPushed - before.upsertsPushed,
  cohortSuppressed: after.cohortSuppressed - before.cohortSuppressed,
});

const sessionScopeKey = (principal: string, sessionId: string): string =>
  Engine.resolveScopeKey("session", { principal, sessionId });

const userScopeKey = (principal: string): string =>
  Engine.resolveScopeKey("user", { principal });

const scopedWave = (
  entries: Array<[string, string[]]>,
): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(entries.map(([key, cohorts]) => [key, new Set(cohorts)]));

// (a) THE ACCEPTANCE PAIR, end to end through the REAL dirty pipeline
// (transact → markSpaceDirty → flushSessions): another session's
// session-scoped commit produces ZERO B-side work, and a user-scoped commit
// reaches only that principal's sessions — asserted via feedStats counters,
// with a space-scoped positive control proving broadcast is unchanged.
Deno.test("F6 acceptance: session-scoped commits produce zero B-side work; user-scoped commits reach only the principal's sessions; space broadcast unchanged", async () => {
  const server = createServer("memory-v2-feed-cohort-acceptance");
  const alice1Client = await connectClient(server);
  const alice2Client = await connectClient(server);
  const bobClient = await connectClient(server);
  try {
    const alice1 = await mountAs(alice1Client, ALICE);
    const alice2 = await mountAs(alice2Client, ALICE);
    const bob = await mountAs(bobClient, BOB);

    // Every session watches the same declared addresses: a session-scoped
    // doc, a user-scoped doc, and a space doc (the broadcast control).
    for (const session of [alice1, alice2, bob]) {
      await session.watchSet([
        docsWatch("cohort", [
          { id: "of:s", scope: "session" },
          { id: "of:u", scope: "user" },
          { id: "of:space" },
        ]),
      ]);
    }

    // Session-scoped commit from alice1: only alice1's own session is in the
    // cohort (and it is echo-suppressed), so exactly ONE session is touched
    // and nothing is delivered anywhere.
    let before = feedCounters(server);
    await setDoc(alice1, 1, "of:s", "S1", "session");
    await server.flushSessions();
    assertEquals(
      counterDelta(before, feedCounters(server)),
      {
        touched: 1, // alice1 only — the writer's own instance
        memberDeliveries: 0, // echo-suppressed for the writer
        upsertsPushed: 0,
        cohortSuppressed: 2, // alice2 + bob: not touched AT ALL
      },
      "another session's session-scoped commit must produce zero B-side work",
    );

    // User-scoped commit from alice1: both alice sessions are in the cohort
    // (alice1 echo-suppressed, alice2 delivered); bob does zero work.
    before = feedCounters(server);
    await setDoc(alice1, 2, "of:u", "U1", "user");
    await server.flushSessions();
    assertEquals(
      counterDelta(before, feedCounters(server)),
      {
        touched: 2, // alice1 (echo) + alice2 (delivered)
        memberDeliveries: 1, // alice2's copy of alice's user instance
        upsertsPushed: 1,
        cohortSuppressed: 1, // bob only
      },
      "a user-scoped commit must reach only the principal's sessions",
    );

    // alice2 genuinely received the user instance: an identical follow-up
    // wave owes nothing (per-member lastSentSeq advanced — FA15).
    const alice2Repeat = await server.syncSessionForConnection(
      SPACE,
      alice2.sessionId,
      new Set([toDirtyKey("of:u", "user")]),
      undefined,
      {
        dirtyScopeKeys: scopedWave([
          [toDirtyKey("of:u", "user"), [userScopeKey(ALICE)]],
        ]),
      },
    );
    assertEquals(
      effectUpserts(alice2Repeat),
      [],
      "the user-scoped delta must already have been delivered to alice2",
    );

    // Space-scoped positive control: byte-identical broadcast — every
    // session is touched and delivered.
    before = feedCounters(server);
    await setDoc(alice1, 3, "of:space", "SPACE1");
    await server.flushSessions();
    assertEquals(
      counterDelta(before, feedCounters(server)),
      {
        touched: 3,
        memberDeliveries: 2, // alice2 + bob (alice1 echo-suppressed)
        upsertsPushed: 2,
        cohortSuppressed: 0,
      },
      "space-scoped delivery must stay byte-identical broadcast",
    );
  } finally {
    await alice1Client.close();
    await alice2Client.close();
    await bobClient.close();
    await server.close();
  }
});

// (b) Session-scoped doc-set member, exact deltas: alice1 registers a
// session-scoped member; a wave scoped to alice1's session delivers the exact
// delta to alice1 (no origins — a served write, not a client echo), while
// alice2 and bob are not even touched.
Deno.test("F6 session-scoped member: exact delta to the named session, zero work for its siblings", async () => {
  const server = createServer("memory-v2-feed-cohort-session-member");
  const alice1Client = await connectClient(server);
  const alice2Client = await connectClient(server);
  const bobClient = await connectClient(server);
  try {
    const alice1 = await mountAs(alice1Client, ALICE);
    const alice2 = await mountAs(alice2Client, ALICE);
    const bob = await mountAs(bobClient, BOB);

    for (const session of [alice1, alice2, bob]) {
      await session.watchSet([
        docsWatch("m", [{ id: "of:s", scope: "session" }]),
      ]);
    }

    await setDoc(alice1, 1, "of:s", "S1", "session");
    const wave = {
      dirtyScopeKeys: scopedWave([
        [
          toDirtyKey("of:s", "session"),
          [sessionScopeKey(ALICE, alice1.sessionId)],
        ],
      ]),
    };

    // alice1 (the named session): exact delta, attributed to its instance.
    const before = feedCounters(server);
    const alice1Wave = await server.syncSessionForConnection(
      SPACE,
      alice1.sessionId,
      new Set([toDirtyKey("of:s", "session")]),
      undefined,
      wave,
    );
    assertEquals(
      effectUpserts(alice1Wave).map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
        scopeKey: upsert.scopeKey,
      })),
      [{
        id: "of:s",
        doc: { value: "S1" },
        scopeKey: sessionScopeKey(ALICE, alice1.sessionId),
      }],
    );

    // alice2 and bob: no frame, no touch, no member read.
    for (const other of [alice2, bob]) {
      const otherWave = await server.syncSessionForConnection(
        SPACE,
        other.sessionId,
        new Set([toDirtyKey("of:s", "session")]),
        undefined,
        wave,
      );
      assertEquals(otherWave, null, "no frame for a session outside the cohort");
    }
    assertEquals(
      counterDelta(before, feedCounters(server)),
      {
        touched: 1, // alice1 only
        memberDeliveries: 1, // alice1's delta only
        upsertsPushed: 1,
        cohortSuppressed: 2, // alice2 + bob
      },
    );
  } finally {
    await alice1Client.close();
    await alice2Client.close();
    await bobClient.close();
    await server.close();
  }
});

// (c) User-scoped member across two alice sessions + bob, INCLUDING the FB25
// lane family: a docs watch registered under a lane acting context receives
// the lane principal's user-scoped revisions (the cohort derives from the
// LANE's acting context, not the sponsor), and a sponsor-scoped wave does not
// even touch the lane-holding session.
Deno.test("F6 user-scoped member: both principal sessions and the lane-held watch deliver; bob and sponsor-instance waves do zero work", async () => {
  const server = createServer("memory-v2-feed-cohort-user-member");
  const alice1Client = await connectClient(server);
  const alice2Client = await connectClient(server);
  const bobClient = await connectClient(server);
  const workerClient = await connectClient(server);
  const sponsorWriterClient = await connectClient(server);
  try {
    const alice1 = await mountAs(alice1Client, ALICE);
    const alice2 = await mountAs(alice2Client, ALICE);
    const bob = await mountAs(bobClient, BOB);
    const worker = await mountAs(workerClient, SPONSOR);
    const sponsorWriter = await mountAs(sponsorWriterClient, SPONSOR);

    // Seed the branch (lease acquisition needs an existing commit history).
    await setDoc(sponsorWriter, 1, "of:seed", "seed");

    for (const session of [alice1, alice2, bob]) {
      await session.watchSet([docsWatch("u", [{ id: "of:u", scope: "user" }])]);
    }

    // The worker session is lease-bound and registers the SAME declared
    // address under alice's lane acting context (FB25 family).
    await worker.setExecutionDemand("", ["space:piece:feed-cohort"]);
    const lease = await server.acquireExecutionLease(SPACE, "");
    assertExists(lease);
    server.bindExecutionSession(SPACE, worker.sessionId, lease);
    await server.openUserLaneGrant(SPACE, "", ALICE);
    await (worker as unknown as {
      watchSetSync(
        watches: WatchSpec[],
        options: { actingContext: SchedulerExecutionContextKey },
      ): Promise<unknown>;
    }).watchSetSync(
      [docsWatch("lane-u", [{ id: "of:u", scope: "user" }])],
      { actingContext: ALICE_LANE },
    );

    // Alice writes her user instance.
    await setDoc(alice1, 1, "of:u", "ALICE-1", "user");
    const aliceWave = {
      dirtyScopeKeys: scopedWave([
        [toDirtyKey("of:u", "user"), [userScopeKey(ALICE)]],
      ]),
    };

    const before = feedCounters(server);
    // Both alice sessions deliver (no origins passed — the positive case
    // asserts DELIVERY, not echo bookkeeping).
    for (const session of [alice1, alice2]) {
      const delivered = await server.syncSessionForConnection(
        SPACE,
        session.sessionId,
        new Set([toDirtyKey("of:u", "user")]),
        undefined,
        aliceWave,
      );
      assertEquals(
        effectUpserts(delivered).map((upsert) => ({
          id: upsert.id,
          doc: upsert.doc,
          scopeKey: upsert.scopeKey,
        })),
        [{ id: "of:u", doc: { value: "ALICE-1" }, scopeKey: userScopeKey(ALICE) }],
      );
    }
    // The lane-held watch on the worker session delivers the SAME revision —
    // its cohort derives from the lane acting context, not the sponsor.
    const laneDelivered = await server.syncSessionForConnection(
      SPACE,
      worker.sessionId,
      new Set([toDirtyKey("of:u", "user")]),
      undefined,
      aliceWave,
    );
    assertEquals(
      effectUpserts(laneDelivered).map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
        scopeKey: upsert.scopeKey,
      })),
      [{ id: "of:u", doc: { value: "ALICE-1" }, scopeKey: userScopeKey(ALICE) }],
    );
    // Bob does zero work.
    const bobWave = await server.syncSessionForConnection(
      SPACE,
      bob.sessionId,
      new Set([toDirtyKey("of:u", "user")]),
      undefined,
      aliceWave,
    );
    assertEquals(bobWave, null);
    assertEquals(
      counterDelta(before, feedCounters(server)),
      {
        touched: 3, // alice1 + alice2 + worker(lane)
        memberDeliveries: 3,
        upsertsPushed: 3,
        cohortSuppressed: 1, // bob
      },
    );

    // The sponsor writes HIS user instance: the worker session's only member
    // for the address is the lane's (alice's), so the worker is not touched
    // at all — the pre-F6 behavior (touched, empty point read) is gone.
    await setDoc(sponsorWriter, 2, "of:u", "SPONSOR-2", "user");
    const sponsorBefore = feedCounters(server);
    const sponsorWave = await server.syncSessionForConnection(
      SPACE,
      worker.sessionId,
      new Set([toDirtyKey("of:u", "user")]),
      undefined,
      {
        dirtyScopeKeys: scopedWave([
          [toDirtyKey("of:u", "user"), [userScopeKey(SPONSOR)]],
        ]),
      },
    );
    assertEquals(sponsorWave, null);
    assertEquals(
      counterDelta(sponsorBefore, feedCounters(server)),
      {
        touched: 0,
        memberDeliveries: 0,
        upsertsPushed: 0,
        cohortSuppressed: 1,
      },
      "a sponsor-instance wave must not even touch the lane-holding session",
    );
  } finally {
    await alice1Client.close();
    await alice2Client.close();
    await bobClient.close();
    await workerClient.close();
    await sponsorWriterClient.close();
    await server.close();
  }
});

// (d) Reconnect/resume: a session-scoped member catches up INCREMENTALLY on
// full re-evaluation (FA15 — exactly the latest owed delta, never a reseed),
// and a sibling session's resume delivers nothing for it.
Deno.test("F6 resume: session-scoped members catch up incrementally; a sibling's resume stays empty", async () => {
  const server = createServer("memory-v2-feed-cohort-resume");
  const alice1Client = await connectClient(server);
  const alice2Client = await connectClient(server);
  try {
    const alice1 = await mountAs(alice1Client, ALICE);
    const alice2 = await mountAs(alice2Client, ALICE);

    for (const session of [alice1, alice2]) {
      await session.watchSet([
        docsWatch("m", [{ id: "of:s", scope: "session" }]),
      ]);
    }

    // v1 delivered through a scoped wave.
    await setDoc(alice1, 1, "of:s", "S1", "session");
    const wave1 = await server.syncSessionForConnection(
      SPACE,
      alice1.sessionId,
      new Set([toDirtyKey("of:s", "session")]),
      undefined,
      {
        dirtyScopeKeys: scopedWave([
          [
            toDirtyKey("of:s", "session"),
            [sessionScopeKey(ALICE, alice1.sessionId)],
          ],
        ]),
      },
    );
    assertEquals(effectUpserts(wave1).map((upsert) => upsert.doc), [{
      value: "S1",
    }]);

    // v2 and v3 land with NO wave in between (the disconnect window).
    await setDoc(alice1, 2, "of:s", "S2", "session");
    await setDoc(alice1, 3, "of:s", "S3", "session");

    // Full re-evaluation (the resume path): exactly ONE incremental upsert —
    // the latest owed seq — never a reseed of already-sent state.
    const resumed = await server.syncSessionForConnection(
      SPACE,
      alice1.sessionId,
    );
    assertExists(resumed);
    assertEquals(
      effectUpserts(resumed).map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
        scopeKey: upsert.scopeKey,
      })),
      [{
        id: "of:s",
        doc: { value: "S3" },
        scopeKey: sessionScopeKey(ALICE, alice1.sessionId),
      }],
    );

    // Nothing further owed after the catch-up.
    const settled = await server.syncSessionForConnection(
      SPACE,
      alice1.sessionId,
      new Set([toDirtyKey("of:unrelated")]),
    );
    assertEquals(effectUpserts(settled), []);

    // The sibling's OWN resume delivers nothing for alice1's instance — its
    // member resolves alice2's (never-written) instance, and alice1's deltas
    // never corrupted its bookkeeping.
    const siblingResume = await server.syncSessionForConnection(
      SPACE,
      alice2.sessionId,
    );
    assertEquals(effectUpserts(siblingResume), []);
  } finally {
    await alice1Client.close();
    await alice2Client.close();
    await server.close();
  }
});

// (e) The graph-watch analog: scoped docs DO enter graph closures (graph
// roots carry declared scope and resolve under the session's read context),
// so the cohort filter must scope the graph path too — a user-scoped root's
// revision touches only the principal's sessions, and a session-scoped
// root's revision touches only the named session.
Deno.test("F6 graph path: scoped graph roots deliver only within the revision's cohort", async () => {
  const server = createServer("memory-v2-feed-cohort-graph");
  const alice1Client = await connectClient(server);
  const alice2Client = await connectClient(server);
  const bobClient = await connectClient(server);
  try {
    const alice1 = await mountAs(alice1Client, ALICE);
    const alice2 = await mountAs(alice2Client, ALICE);
    const bob = await mountAs(bobClient, BOB);

    for (const session of [alice1, alice2, bob]) {
      await session.watchSet([
        graphWatch("g", [
          { id: "of:gu", scope: "user" },
          { id: "of:gs", scope: "session" },
        ]),
      ]);
    }

    // Alice writes her user-scoped instance: alice2's graph is refreshed and
    // delivers; bob's graph is never touched.
    await setDoc(alice1, 1, "of:gu", "GU-1", "user");
    const userWave = {
      dirtyScopeKeys: scopedWave([
        [toDirtyKey("of:gu", "user"), [userScopeKey(ALICE)]],
      ]),
    };
    let before = feedCounters(server);
    const alice2Wave = await server.syncSessionForConnection(
      SPACE,
      alice2.sessionId,
      new Set([toDirtyKey("of:gu", "user")]),
      undefined,
      userWave,
    );
    assertEquals(
      effectUpserts(alice2Wave).map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
      })),
      [{ id: "of:gu", doc: { value: "GU-1" } }],
    );
    const bobUserWave = await server.syncSessionForConnection(
      SPACE,
      bob.sessionId,
      new Set([toDirtyKey("of:gu", "user")]),
      undefined,
      userWave,
    );
    assertEquals(bobUserWave, null);
    assertEquals(
      counterDelta(before, feedCounters(server)),
      {
        touched: 1, // alice2 only
        memberDeliveries: 0, // graph path, not a member point read
        upsertsPushed: 1,
        cohortSuppressed: 1, // bob
      },
    );

    // Alice1 writes her session-scoped instance: neither alice2 nor bob is
    // touched by the graph path.
    await setDoc(alice1, 2, "of:gs", "GS-1", "session");
    const sessionWave = {
      dirtyScopeKeys: scopedWave([
        [
          toDirtyKey("of:gs", "session"),
          [sessionScopeKey(ALICE, alice1.sessionId)],
        ],
      ]),
    };
    before = feedCounters(server);
    for (const other of [alice2, bob]) {
      const wave = await server.syncSessionForConnection(
        SPACE,
        other.sessionId,
        new Set([toDirtyKey("of:gs", "session")]),
        undefined,
        sessionWave,
      );
      assertEquals(wave, null);
    }
    assertEquals(
      counterDelta(before, feedCounters(server)),
      {
        touched: 0,
        memberDeliveries: 0,
        upsertsPushed: 0,
        cohortSuppressed: 2,
      },
    );
  } finally {
    await alice1Client.close();
    await alice2Client.close();
    await bobClient.close();
    await server.close();
  }
});

// (f) Regression guard: a wave with NO cohort metadata (an unattributed
// producer) keeps today's broadcast behavior for scoped keys — the filter
// fails open, never closed. (Space-scoped broadcast identity is additionally
// covered end-to-end by the acceptance control above and by the existing
// v2-docset-watch-test.ts / v2-server-test.ts wave fixtures, which drive
// syncSessionForConnection without cohort metadata throughout.)
Deno.test("F6 fail-open: waves without cohort metadata keep broadcast behavior for scoped keys", async () => {
  const server = createServer("memory-v2-feed-cohort-fail-open");
  const alice1Client = await connectClient(server);
  const alice2Client = await connectClient(server);
  try {
    const alice1 = await mountAs(alice1Client, ALICE);
    const alice2 = await mountAs(alice2Client, ALICE);

    for (const session of [alice1, alice2]) {
      await session.watchSet([
        docsWatch("m", [{ id: "of:u", scope: "user" }]),
      ]);
    }

    await setDoc(alice1, 1, "of:u", "U1", "user");
    // No dirtyScopeKeys: the pre-F6 wave shape. alice2 must still be touched
    // and delivered (the per-session point read resolves her principal's
    // instance exactly as before F6).
    const before = feedCounters(server);
    const delivered = await server.syncSessionForConnection(
      SPACE,
      alice2.sessionId,
      new Set([toDirtyKey("of:u", "user")]),
    );
    assertEquals(
      effectUpserts(delivered).map((upsert) => ({
        id: upsert.id,
        doc: upsert.doc,
      })),
      [{ id: "of:u", doc: { value: "U1" } }],
    );
    const delta = counterDelta(before, feedCounters(server));
    assertEquals(delta.touched, 1);
    assertEquals(delta.cohortSuppressed, 0);
  } finally {
    await alice1Client.close();
    await alice2Client.close();
    await server.close();
  }
});
