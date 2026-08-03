// C2.7 (session lanes, wake/demand plane): the A4 accepted-commit wake
// widening at session rank — an accepted commit's lane lookups are
// [space] + open USER lane grants + open SESSION lane grants, each session
// lane paired with ITS OWNING session's demanded pieces only (design §2:
// "a session's demand implies demand for its own session-context lane";
// sibling sessions and the principal's aggregate never stand in). The
// parked-session skip is EMERGENT (CA13): session-end = lane-end (C2.3),
// so a disconnected session has no grant, contributes no wake pair, and
// its durable session-qualified rows accumulate dirt until the SAME
// session resumes and its lane re-opens — there is no parked-lane
// registry, and these fixtures assert the absence (the grant is simply
// gone) rather than any new state.
import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import type { AcceptedCommitEvent } from "../v2/server.ts";
import type {
  SchedulerActionObservation,
  SchedulerExecutionContextKey,
  SchedulerObservationAddress,
} from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-session-lane-lifecycle-space";
// Colon-bearing DIDs keep the canonical percent-encoded lane keys honest.
const ALICE = "did:key:z6Mk-session-lane-lifecycle-alice";
const BOB = "did:key:z6Mk-session-lane-lifecycle-bob";
const AUDIENCE = "did:key:z6Mk-session-lane-lifecycle-audience";

const PIECE_ROOT = "of:session-lane-lifecycle:demanded-piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const SESSION_ACTION_ID = "action:session-lane-lifecycle-session-reader";
const USER_ACTION_ID = "action:session-lane-lifecycle-user-reader";

const SOURCE: SchedulerObservationAddress = {
  space: SPACE,
  id: "of:session-lane-lifecycle:source",
  scope: "space",
  path: ["value"],
};
// A session-scoped output narrows the action's context floor to `session`,
// so the row materializes at the COMMITTING session's own context while
// still READING the shared space-scoped source — the design §2
// Bob-votes-Alice's-tally shape (a foreign principal's space commit
// invalidates a session-scoped derivation).
const SESSION_OUTPUT: SchedulerObservationAddress = {
  space: SPACE,
  id: "of:session-lane-lifecycle:session-output",
  scope: "session",
  path: ["value"],
};
const USER_OUTPUT: SchedulerObservationAddress = {
  space: SPACE,
  id: "of:session-lane-lifecycle:user-output",
  scope: "user",
  path: ["value"],
};

const ALICE_USER_CONTEXT_KEY = Engine.userExecutionContextKey(
  ALICE,
) as SchedulerExecutionContextKey;

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
};

type SessionGrant = Readonly<{
  contextKey: `session:${string}:${string}`;
  laneGeneration: number;
}>;

type LaneServer = Server & {
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
  ): Promise<SessionGrant>;
  sessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): SessionGrant | null;
};

/** Test-only reach into the host's per-space engine (declared private). */
const engineOf = (server: Server, space: string): Promise<Engine.Engine> =>
  (server as unknown as { openEngine(space: string): Promise<Engine.Engine> })
    .openEngine(space);

const createLaneServer = (name: string): LaneServer =>
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
  ) as LaneServer;

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
  options: MemoryClient.MountOptions = {},
): Promise<ExecutionSession> =>
  await client.mount(SPACE, options, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

/** Observation-only commit shaping a scoped reader row: a session- or
 * user-scoped output plus a space-scoped read of the shared source. The
 * committing session's own scope context floors the row's execution
 * context, so a session-output observation lands at that session's
 * `session:<principal>:<sessionId>` context. */
const scopedReaderObservation = (
  actionId: string,
  output: SchedulerObservationAddress,
): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: SPACE,
  branch: "",
  pieceId: SCHEDULER_PIECE_ID,
  processGeneration: 1,
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:session-lane-lifecycle",
  runtimeFingerprint: "runtime:session-lane-lifecycle",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [SOURCE],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [output],
  declaredWrites: [output],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: "impl:session-lane-lifecycle",
    runtimeFingerprint: "runtime:session-lane-lifecycle",
    piece: { ...SOURCE, id: PIECE_ROOT, path: [] },
    reads: [SOURCE],
    writes: [output],
    materializerWriteEnvelopes: [],
    directOutputs: [output],
  },
  status: "success",
});

const writeSource = async (
  session: ExecutionSession,
  localSeq: number,
  value: string,
): Promise<void> => {
  await session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: SOURCE.id,
      value: { value },
    }],
  });
};

const scopedStaleRows = (event: AcceptedCommitEvent) =>
  event.staleDemandedReaders
    .filter((reader) => reader.executionContextKey !== "space")
    .map((reader) => ({
      pieceId: reader.pieceId,
      actionId: reader.actionId,
      executionContextKey: reader.executionContextKey,
    }))
    .sort((left, right) =>
      left.executionContextKey.localeCompare(right.executionContextKey)
    );

Deno.test("A4 at session rank: a foreign space commit wakes the open session lane, paired with the OWNING session's demand only", async () => {
  const server = createLaneServer("memory-v2-session-lane-wake");
  const aliceClient = await connectClient(server);
  const bobClient = await connectClient(server);
  const events: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(SPACE, (event) => {
    events.push(event);
  });
  try {
    const alice = await mountAs(aliceClient, ALICE);
    const bob = await mountAs(bobClient, BOB);
    const sessionContextKey = Engine.sessionExecutionContextKey(
      ALICE,
      alice.sessionId,
    ) as SchedulerExecutionContextKey;
    // First write flips the pre-launch compatibility capability to WRITE.
    await writeSource(alice, 1, "seed");

    // Alice's SESSION-context reader row over the shared space source.
    await alice.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: scopedReaderObservation(
        SESSION_ACTION_ID,
        SESSION_OUTPUT,
      ),
    });
    const engine = await engineOf(server, SPACE);
    const planted = Engine.listSchedulerActionSnapshots(engine, {
      branch: "",
      ownerSpace: SPACE,
      pieceId: SCHEDULER_PIECE_ID,
      actionId: SESSION_ACTION_ID,
    }).snapshots;
    assertEquals(
      planted.map((snapshot) => snapshot.executionContextKey),
      [sessionContextKey],
      "row must land at alice's own session context",
    );

    await alice.setExecutionDemand("", [PIECE_ROOT]);

    // Parked (CA13, emergent): demand but NO session lane grant. Bob's
    // space write records dirt on the session row without waking anything —
    // no grant means no lane lookup pair, with no parked state consulted.
    await writeSource(bob, 1, "parked-write");
    const parkedEvent = events.at(-1)!;
    assertEquals(scopedStaleRows(parkedEvent), []);
    const parkedDirt = Engine.staleReadersForTargets(engine, {
      branch: "",
      ownerSpace: SPACE,
      targets: [SOURCE],
      demandedSchedulerPieceIds: [SCHEDULER_PIECE_ID],
      applicableExecutionContextKeys: [sessionContextKey],
      dirtySeq: parkedEvent.dataSeq,
    });
    assertEquals(
      parkedDirt.map((row) => row.executionContextKey),
      [sessionContextKey],
      "parked session rows still accumulate dirt",
    );

    // Open session lane: the same foreign space write now surfaces alice's
    // session-context reader in the accepted-commit wake lookup — the
    // Bob-votes-Alice's-tally case (design §2).
    await server.openSessionLaneGrant(SPACE, "", ALICE, alice.sessionId);
    await writeSource(bob, 2, "lane-open-write");
    assertEquals(scopedStaleRows(events.at(-1)!), [{
      pieceId: SCHEDULER_PIECE_ID,
      actionId: SESSION_ACTION_ID,
      executionContextKey: sessionContextKey,
    }]);

    // Owning-session pairing: a SIBLING session of the same principal
    // demanding the piece does NOT stand in for the lane-owning session.
    // With only the sibling's demand row present, the s1 lane's lookup has
    // no demanded pieces and stays silent.
    const sibling = await mountAs(aliceClient, ALICE);
    await sibling.setExecutionDemand("", [PIECE_ROOT]);
    await alice.setExecutionDemand("", []);
    await writeSource(bob, 3, "sibling-demand-write");
    assertEquals(scopedStaleRows(events.at(-1)!), []);
  } finally {
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});

Deno.test("demand lifecycle: a session-demand shrink retires the session wake pairing without touching the user lane, and vice versa", async () => {
  const server = createLaneServer("memory-v2-session-lane-demand-shrink");
  const aliceClient = await connectClient(server);
  const bobClient = await connectClient(server);
  const events: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(SPACE, (event) => {
    events.push(event);
  });
  try {
    const alice = await mountAs(aliceClient, ALICE);
    const sibling = await mountAs(aliceClient, ALICE);
    const bob = await mountAs(bobClient, BOB);
    const sessionContextKey = Engine.sessionExecutionContextKey(
      ALICE,
      alice.sessionId,
    ) as SchedulerExecutionContextKey;
    await writeSource(alice, 1, "seed");

    // Two scoped reader rows over the same source: alice's SESSION-context
    // row and her USER-context row.
    await alice.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: scopedReaderObservation(
        SESSION_ACTION_ID,
        SESSION_OUTPUT,
      ),
    });
    await alice.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: scopedReaderObservation(
        USER_ACTION_ID,
        USER_OUTPUT,
      ),
    });

    // s1 and the sibling both demand; both lanes open.
    await alice.setExecutionDemand("", [PIECE_ROOT]);
    await sibling.setExecutionDemand("", [PIECE_ROOT]);
    await server.openUserLaneGrant(SPACE, "", ALICE);
    await server.openSessionLaneGrant(SPACE, "", ALICE, alice.sessionId);

    // Both lanes pair: the user lane against the principal's aggregated
    // demand, the session lane against the owning session's own demand.
    await writeSource(bob, 1, "both-lanes-write");
    assertEquals(scopedStaleRows(events.at(-1)!), [
      {
        pieceId: SCHEDULER_PIECE_ID,
        actionId: SESSION_ACTION_ID,
        executionContextKey: sessionContextKey,
      },
      {
        pieceId: SCHEDULER_PIECE_ID,
        actionId: USER_ACTION_ID,
        executionContextKey: ALICE_USER_CONTEXT_KEY,
      },
    ]);

    // Session-demand shrink: the session lane's pairing retires (its OWN
    // demand is gone) while the user lane keeps pairing through the
    // sibling's surviving demand row.
    await alice.setExecutionDemand("", []);
    await writeSource(bob, 2, "session-shrink-write");
    assertEquals(scopedStaleRows(events.at(-1)!), [{
      pieceId: SCHEDULER_PIECE_ID,
      actionId: USER_ACTION_ID,
      executionContextKey: ALICE_USER_CONTEXT_KEY,
    }]);

    // Vice versa: restore the session's demand and close the USER lane —
    // only the session pairing remains.
    await alice.setExecutionDemand("", [PIECE_ROOT]);
    const userGrant = (server as unknown as {
      userLaneGrant(
        space: string,
        branch: string,
        principal: string,
      ): unknown;
    }).userLaneGrant(SPACE, "", ALICE);
    assertExists(userGrant);
    assertEquals(server.closeUserLaneGrant(userGrant), true);
    await writeSource(bob, 3, "user-close-write");
    assertEquals(scopedStaleRows(events.at(-1)!), [{
      pieceId: SCHEDULER_PIECE_ID,
      actionId: SESSION_ACTION_ID,
      executionContextKey: sessionContextKey,
    }]);
  } finally {
    await aliceClient.close();
    await bobClient.close();
    await server.close();
  }
});

Deno.test("CA13: disconnect drains the session lane — no wake pair forms, dirt accumulates; resume re-opens the lane and catches up", async () => {
  const server = createLaneServer("memory-v2-session-lane-parked-emergence");
  const bobClient = await connectClient(server);
  const events: AcceptedCommitEvent[] = [];
  server.subscribeAcceptedCommits(SPACE, (event) => {
    events.push(event);
  });
  let aliceClient: MemoryClient.Client | null = await connectClient(server);
  let resumedClient: MemoryClient.Client | null = null;
  try {
    const alice = await mountAs(aliceClient, ALICE);
    const bob = await mountAs(bobClient, BOB);
    const sessionId = alice.sessionId;
    const sessionContextKey = Engine.sessionExecutionContextKey(
      ALICE,
      sessionId,
    ) as SchedulerExecutionContextKey;
    await writeSource(alice, 1, "seed");
    await alice.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: scopedReaderObservation(
        SESSION_ACTION_ID,
        SESSION_OUTPUT,
      ),
    });
    await alice.setExecutionDemand("", [PIECE_ROOT]);
    const grant = await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      sessionId,
    );

    // Sanity: while the owning session is connected, the pair forms.
    await writeSource(bob, 1, "connected-write");
    assertEquals(scopedStaleRows(events.at(-1)!), [{
      pieceId: SCHEDULER_PIECE_ID,
      actionId: SESSION_ACTION_ID,
      executionContextKey: sessionContextKey,
    }]);

    // Disconnect the owning session. Session-end = lane-end (C2.3): the
    // grant is simply GONE — the emergent CA13 shape. There is no parked
    // grant, no retained wake registration, no new state to inspect.
    const sessionToken = alice.sessionToken;
    await aliceClient.close();
    aliceClient = null;
    assertEquals(server.sessionLaneGrant(SPACE, "", ALICE, sessionId), null);

    // A foreign commit while disconnected: NO wake pair forms (the lane
    // lookup set has no entry to pair), while the durable session-qualified
    // row accumulates dirt in-commit regardless of lane openness.
    await writeSource(bob, 2, "disconnected-write");
    const parkedEvent = events.at(-1)!;
    assertEquals(scopedStaleRows(parkedEvent), []);
    const engine = await engineOf(server, SPACE);
    const accumulated = Engine.staleReadersForTargets(engine, {
      branch: "",
      ownerSpace: SPACE,
      targets: [SOURCE],
      demandedSchedulerPieceIds: [SCHEDULER_PIECE_ID],
      applicableExecutionContextKeys: [sessionContextKey],
      dirtySeq: parkedEvent.dataSeq,
    });
    assertEquals(
      accumulated.map((row) => row.executionContextKey),
      [sessionContextKey],
      "dirt accumulates on the drained session's durable row",
    );

    // Resume the SAME session (id + token) on a fresh connection: demand
    // re-publishes, the lane re-opens under a bumped generation, and the
    // catch-up read sees the accumulated dirt — design §4's
    // rehydrate-correct-on-reconnect.
    resumedClient = await connectClient(server);
    const resumed = await mountAs(resumedClient, ALICE, {
      sessionId,
      sessionToken,
    });
    assertEquals(resumed.sessionId, sessionId);
    await resumed.setExecutionDemand("", [PIECE_ROOT]);
    const reopened = await server.openSessionLaneGrant(
      SPACE,
      "",
      ALICE,
      sessionId,
    );
    assert(reopened.laneGeneration > grant.laneGeneration);
    const catchUp = Engine.staleReadersForTargets(engine, {
      branch: "",
      ownerSpace: SPACE,
      targets: [SOURCE],
      demandedSchedulerPieceIds: [SCHEDULER_PIECE_ID],
      applicableExecutionContextKeys: [sessionContextKey],
      dirtySeq: parkedEvent.dataSeq,
    });
    assertEquals(catchUp.length, 1, "the reopened lane catches up on dirt");

    // And the wake pair forms again for the reopened lane.
    await writeSource(bob, 3, "resumed-write");
    assertEquals(scopedStaleRows(events.at(-1)!), [{
      pieceId: SCHEDULER_PIECE_ID,
      actionId: SESSION_ACTION_ID,
      executionContextKey: sessionContextKey,
    }]);
  } finally {
    await aliceClient?.close();
    await resumedClient?.close();
    await bobClient.close();
    await server.close();
  }
});
