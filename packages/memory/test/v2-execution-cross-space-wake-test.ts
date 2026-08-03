// C3.3a — the foreign wake pipeline (client-mirrored rows only):
// demand-joined `ForeignReadersSubscribe` registration, the read-host
// `ForeignStaleReaders` notice flow, and the home-side foreign-wake
// dispatch, over the in-process transport.
//
// Fixture map (plan row C3.3a; amendments C3A9/C3A10/C3A11/C3A17):
//  (a) e2e wake: two spaces in one Server — a home action with a
//      mirrored foreign read, demand joins, B's commit produces exactly
//      one notice-driven wake; an unrelated B commit produces none.
//  (b) the C3A10 two-part barrier, BOTH orders, driven by the injectable
//      barrier on the read host's side-effect queue: the ack is emitted
//      only after previously accepted commits' dirt drained (transcript
//      order pins dirt-mark-before-ack), and a commit whose dirt
//      predates the subscription is replayed by the post-ack
//      direct-dirty-∩-demand scan — the interleaving window loses no
//      wake in either order.
//  (c) the C3A9 read-to-mirror window: read accepted → B commits K
//      (mirror rows absent — NO notice for K's publish) → mirror lands →
//      the conservative window mark flows the same dirt-mark + notice
//      path and the home action still wakes, with the dirt durable in
//      the home engine.
//  (e) lane symmetry (C3A17): user AND session grants join the foreign
//      lookup at their own demand slices; a grant opened after initial
//      registration re-registers (generation bump on the wire) and both
//      the catch-up scan and subsequent commits wake the scoped lane.
//  (f) single-space regression: no foreign reads → zero cross-space
//      frames, zero subscriptions, home wake surface untouched.
//
// Barrier-driven throughout: every await is a transact response, the
// server's cross-space/subscription settle barriers, or a bounded
// microtask spin on synchronous engine state — no sleeps.
import { assert, assertEquals, assertExists } from "@std/assert";
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
  setPersistentSchedulerStateConfig,
} from "../v2.ts";
import {
  type CrossSpaceLaneDemand,
  type CrossSpaceMessage,
  type ForeignReadersSubscribe,
  parseCrossSpaceMessage,
} from "../v2/cross-space.ts";

const HOME_SPACE = "did:key:z6Mk-xsp-wake-home";
const READ_SPACE = "did:key:z6Mk-xsp-wake-read";
const ALICE = "did:key:z6Mk-xsp-wake-alice";
const AUDIENCE = "did:key:z6Mk-xsp-wake-audience";

const PIECE_ROOT = "of:xsp-wake:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:xsp-wake-reader";

const FOREIGN_SOURCE: SchedulerObservationAddress = {
  space: READ_SPACE,
  id: "of:xsp-wake:source",
  scope: "space",
  path: ["value"],
};
const HOME_OUTPUT: SchedulerObservationAddress = {
  space: HOME_SPACE,
  id: "of:xsp-wake:output",
  scope: "space",
  path: ["value"],
};
const SESSION_OUTPUT: SchedulerObservationAddress = {
  space: HOME_SPACE,
  id: "of:xsp-wake:session-output",
  scope: "session",
  path: ["value"],
};

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
};

type WakeServer = Server & {
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<{ contextKey: string; laneGeneration: number }>;
  openUserLaneGrant(
    space: string,
    branch: string,
    principal: string,
  ): Promise<{ contextKey: string; laneGeneration: number }>;
};

/** Test-only reach into declared-private server internals (the soft-
 * private convention the carriage test established). */
type WakeServerInternals = {
  settleForeignReaderSubscriptions(): Promise<void>;
  settleCrossSpaceDeliveries(): Promise<void>;
  holdPostCommitSchedulerSideEffects(
    space: string,
  ): { entered: Promise<void>; release: () => void };
  foreignReaderSubscriptionsByReadSpace: Map<
    string,
    Map<
      string,
      { generation: number; laneDemands: readonly CrossSpaceLaneDemand[] }
    >
  >;
  foreignReaderSubscriptionsByHomeSpace: Map<
    string,
    { liveGeneration?: number }
  >;
  openEngine(space: string): Promise<Engine.Engine>;
};

const internalsOf = (server: Server): WakeServerInternals =>
  server as unknown as WakeServerInternals;

const createWakeServer = (name: string): WakeServer =>
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
  ) as WakeServer;

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
  space: string,
  principal: string,
  options: MemoryClient.MountOptions = {},
): Promise<ExecutionSession> =>
  await client.mount(space, options, (_space, _session, context) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: { principal },
  })) as ExecutionSession;

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

/** A version-2 observation whose action reads the FOREIGN source(s) and
 * writes `output`. A cross-space summary floors the row at the
 * committing SESSION's context (`schedulerStaticContextFloor`'s
 * crossesSpace rule — the pre-C3.6 conservative posture), so the
 * wakeable lane for a client-mirrored foreign reader is its session
 * lane. */
const foreignReaderObservation = (
  output: SchedulerObservationAddress,
  actionId = ACTION_ID,
  reads: readonly SchedulerObservationAddress[] = [FOREIGN_SOURCE],
): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: HOME_SPACE,
  branch: "",
  pieceId: SCHEDULER_PIECE_ID,
  processGeneration: 1,
  actionId,
  actionKind: "computation",
  implementationFingerprint: "impl:xsp-wake",
  runtimeFingerprint: "runtime:xsp-wake",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [...reads],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [output],
  declaredWrites: [output],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1,
    complete: true,
    implementationFingerprint: "impl:xsp-wake",
    runtimeFingerprint: "runtime:xsp-wake",
    piece: { space: HOME_SPACE, id: PIECE_ROOT, scope: "space", path: [] },
    reads: [...reads],
    writes: [output],
    materializerWriteEnvelopes: [],
    directOutputs: [output],
  },
  status: "success",
});

const writeForeignSource = async (
  session: ExecutionSession,
  localSeq: number,
  value: string,
): Promise<void> => {
  await session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: FOREIGN_SOURCE.id,
      value: { value },
    }],
  });
};

/** Bounded microtask spin on synchronous engine state (no timers): the
 * observation transact is deliberately UNAWAITED while a side-effect
 * hold is in place, so its synchronous applyCommit half is awaited by
 * polling the durable state it wrote. */
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

const plantedContextKey = (
  engine: Engine.Engine,
  actionId = ACTION_ID,
): SchedulerExecutionContextKey => {
  const snapshots = Engine.listSchedulerActionSnapshots(engine, {
    branch: "",
    ownerSpace: HOME_SPACE,
    pieceId: SCHEDULER_PIECE_ID,
    actionId,
  }).snapshots;
  assertEquals(snapshots.length, 1, "exactly one planted reader row");
  return snapshots[0].executionContextKey;
};

Deno.test("C3.3a (a): demand join subscribes, B's commit produces exactly one notice-driven foreign wake, unrelated commits none", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createWakeServer("xsp-wake-e2e");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const client = await connectClient(server);
  const wakes: ForeignWakeEvent[] = [];
  server.subscribeForeignWakes(HOME_SPACE, (event) => {
    wakes.push(event);
  });
  try {
    const home = await mountAs(client, HOME_SPACE, ALICE);
    const reader = await mountAs(client, READ_SPACE, ALICE);
    const sessionContextKey = Engine.sessionExecutionContextKey(
      ALICE,
      home.sessionId,
    ) as SchedulerExecutionContextKey;
    await home.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:xsp-wake:seed", value: { value: 1 } }],
    });

    // The home action's accepted observation reads the foreign source —
    // the mirror lands in the read space's engine (C3.1b), and the home
    // read-index row is the subscription source. A cross-space summary
    // floors the row at SESSION context (schedulerStaticContextFloor's
    // crossesSpace rule — the pre-C3.6 conservative posture), so the
    // wakeable lane is the committing session's own lane.
    await home.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: foreignReaderObservation(HOME_OUTPUT),
    });
    const homeEngine = await internals.openEngine(HOME_SPACE);
    assertEquals(
      plantedContextKey(homeEngine),
      sessionContextKey,
      "a cross-space reader floors at the committing session's context",
    );

    // The session lane opens, then demand joins → the reconciler
    // subscribes under generation 1 with the space pair PLUS the session
    // pair, and the read host acks (the C3A10 barrier's first pass).
    await server.openSessionLaneGrant(HOME_SPACE, "", ALICE, home.sessionId);
    await home.setExecutionDemand("", [PIECE_ROOT]);
    await internals.settleForeignReaderSubscriptions();
    const subscribes = frames.filter(
      (frame): frame is ForeignReadersSubscribe =>
        frame.type === "foreign-readers.subscribe",
    );
    assertEquals(subscribes.length, 1, "exactly one subscribe");
    assertEquals(subscribes[0].fromSpace, HOME_SPACE);
    assertEquals(subscribes[0].toSpace, READ_SPACE);
    assertEquals(subscribes[0].subscriptionGeneration, 1);
    assertEquals(subscribes[0].laneDemands, [
      { contextKey: "space", pieces: [SCHEDULER_PIECE_ID] },
      { contextKey: sessionContextKey, pieces: [SCHEDULER_PIECE_ID] },
    ]);
    assertEquals(
      frames.filter((frame) =>
        frame.type === "foreign-readers.subscribe-applied"
      ).length,
      1,
      "the read host acked the registration",
    );
    const readRegistry = internals.foreignReaderSubscriptionsByReadSpace.get(
      READ_SPACE,
    );
    assertExists(readRegistry, "read-host registry entry");
    assertEquals(readRegistry.get(`${HOME_SPACE}\0`)?.generation, 1);
    assertEquals(wakes.length, 0, "no dirt yet — the post-ack scan is quiet");

    // B's commit against the mirrored read → notice → exactly one wake.
    await writeForeignSource(reader, 1, "b-commit");
    await internals.settleForeignReaderSubscriptions();
    assertEquals(wakes.length, 1, "exactly one foreign wake");
    assertEquals(wakes[0].space, HOME_SPACE);
    assertEquals(wakes[0].branch, "");
    assertEquals(wakes[0].readSpace, READ_SPACE);
    assertEquals(wakes[0].origin, "notice");
    assertEquals(wakes[0].readSeq, 1, "B's commit seq, B's clock");
    assertEquals(wakes[0].staleForeignReaders, [{
      branch: "",
      pieceId: SCHEDULER_PIECE_ID,
      processGeneration: 1,
      actionId: ACTION_ID,
      executionContextKey: sessionContextKey,
    }]);
    // The notice matched the dirt mark that preceded it on the FIFO link:
    // the home engine already carries the durable dirt.
    const dirty = Engine.dirtyDemandedSchedulerActions(homeEngine, {
      branch: "",
      ownerSpace: HOME_SPACE,
      demandedSchedulerPieceIds: [SCHEDULER_PIECE_ID],
      applicableExecutionContextKeys: [sessionContextKey],
    });
    assertEquals(dirty.map((row) => row.directDirtySeq), [1]);
    const dirtIndex = frames.findIndex((frame) =>
      frame.type === "foreign-dirty-mark"
    );
    const noticeIndex = frames.findIndex((frame) =>
      frame.type === "foreign-stale-readers"
    );
    assert(
      dirtIndex >= 0 && noticeIndex > dirtIndex,
      "the durable dirt mark precedes the notice on the link",
    );

    // An unrelated B commit (different doc) wakes nothing.
    await reader.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:xsp-wake:unrelated",
        value: { value: 2 },
      }],
    });
    await internals.settleForeignReaderSubscriptions();
    assertEquals(wakes.length, 1, "unrelated commits stay silent");
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.3a (b): the C3A10 barrier — the ack drains behind pre-subscribe side effects, and neither interleaving order loses the wake", async () => {
  setPersistentSchedulerStateConfig(true);

  // Order 1 (the V10 race, held open by the injectable barrier): B
  // accepts K, K's dirt propagation is HELD, the subscription registers
  // against that stale state — the ack must not overtake K's queued
  // propagation, and K's wake must survive.
  {
    const server = createWakeServer("xsp-wake-barrier-1");
    const internals = internalsOf(server);
    const frames = tapCrossSpaceFrames(server);
    const client = await connectClient(server);
    // Separate connection for the read-space writer: its held transact
    // response must not serialize behind the home connection's requests.
    const readerClient = await connectClient(server);
    const wakes: ForeignWakeEvent[] = [];
    server.subscribeForeignWakes(HOME_SPACE, (event) => {
      wakes.push(event);
    });
    try {
      const home = await mountAs(client, HOME_SPACE, ALICE);
      const reader = await mountAs(readerClient, READ_SPACE, ALICE);
      await home.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:xsp-wake:seed",
          value: { value: 1 },
        }],
      });
      await home.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: foreignReaderObservation(HOME_OUTPUT),
      });

      // The session lane (the wakeable lane for a cross-space reader row)
      // opens before the interleaving begins.
      await server.openSessionLaneGrant(
        HOME_SPACE,
        "",
        ALICE,
        home.sessionId,
      );
      // Injectable barrier on the READ host's side-effect queue.
      const hold = internals.holdPostCommitSchedulerSideEffects(READ_SPACE);
      await hold.entered;
      // B accepts commit K; its transact response is gated on the held
      // side effects, so K's ForeignDirtyMark is queued but NOT sent.
      const commitK = writeForeignSource(reader, 1, "k");
      const readEngine = await internals.openEngine(READ_SPACE);
      await spinUntil(
        () => Engine.serverSeq(readEngine) >= 1,
        "B accepted K",
      );
      assertEquals(
        frames.filter((frame) => frame.type === "foreign-dirty-mark").length,
        0,
        "K's dirt propagation is held",
      );

      // The subscription registers against the stale state.
      await home.setExecutionDemand("", [PIECE_ROOT]);
      // Drain deliveries only (NOT the subscription barrier — the ack is
      // legitimately pending behind the hold).
      await internals.settleCrossSpaceDeliveries();
      await internals.settleCrossSpaceDeliveries();
      assert(
        frames.some((frame) => frame.type === "foreign-readers.subscribe"),
        "the subscribe crossed the link",
      );
      assertEquals(
        frames.filter((frame) =>
          frame.type === "foreign-readers.subscribe-applied"
        ).length,
        0,
        "the ack is barred until the read host drains K's side effects",
      );
      assertEquals(
        internals.foreignReaderSubscriptionsByHomeSpace.get(
          `${HOME_SPACE}\0\0${READ_SPACE}`,
        )?.liveGeneration,
        undefined,
        "the home barrier is still open",
      );
      assertEquals(wakes.length, 0, "no wake before the barrier resolves");

      // Release: K's dirt drains, THEN the ack, then the post-ack scan.
      hold.release();
      await commitK;
      await internals.settleForeignReaderSubscriptions();
      const dirtIndex = frames.findIndex((frame) =>
        frame.type === "foreign-dirty-mark"
      );
      const ackIndex = frames.findIndex((frame) =>
        frame.type === "foreign-readers.subscribe-applied"
      );
      assert(
        dirtIndex >= 0 && ackIndex > dirtIndex,
        "C3A10: the ack is emitted after the read host drained the " +
          "side effects of previously accepted commits",
      );
      assert(wakes.length >= 1, "K's wake is not lost");
      for (const wake of wakes) {
        assertEquals(wake.staleForeignReaders.map((r) => r.actionId), [
          ACTION_ID,
        ]);
      }
      assert(
        wakes.some((wake) => wake.origin === "resubscribe-scan"),
        "the post-ack direct-dirty-∩-demand scan replayed K's dirt",
      );
      assertEquals(
        internals.foreignReaderSubscriptionsByHomeSpace.get(
          `${HOME_SPACE}\0\0${READ_SPACE}`,
        )?.liveGeneration,
        1,
        "the barrier completed",
      );
    } finally {
      await client.close().catch(() => {});
      await readerClient.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }

  // Order 2: K fully lands BEFORE any subscription exists (no notice was
  // possible); the later demand join replays the durable dirt through
  // the post-ack scan — the parked-space catch-up leg.
  {
    const server = createWakeServer("xsp-wake-barrier-2");
    const internals = internalsOf(server);
    const client = await connectClient(server);
    const wakes: ForeignWakeEvent[] = [];
    server.subscribeForeignWakes(HOME_SPACE, (event) => {
      wakes.push(event);
    });
    try {
      const home = await mountAs(client, HOME_SPACE, ALICE);
      const reader = await mountAs(client, READ_SPACE, ALICE);
      await home.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:xsp-wake:seed",
          value: { value: 1 },
        }],
      });
      await home.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: foreignReaderObservation(HOME_OUTPUT),
      });
      // K lands with no subscription anywhere.
      await writeForeignSource(reader, 1, "k");
      await internals.settleCrossSpaceDeliveries();
      assertEquals(wakes.length, 0, "no subscription — no wake yet");

      await server.openSessionLaneGrant(
        HOME_SPACE,
        "",
        ALICE,
        home.sessionId,
      );
      await home.setExecutionDemand("", [PIECE_ROOT]);
      await internals.settleForeignReaderSubscriptions();
      assertEquals(wakes.length, 1, "the post-ack scan wakes exactly once");
      assertEquals(wakes[0].origin, "resubscribe-scan");
      assertEquals(wakes[0].staleForeignReaders.map((r) => r.actionId), [
        ACTION_ID,
      ]);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }
  resetPersistentSchedulerStateConfig();
});

Deno.test("C3.3a (c): the C3A9 read-to-mirror window — B commits between the accepted read and its mirror upsert; the transactional window mark still wakes", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createWakeServer("xsp-wake-window");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const client = await connectClient(server);
  // Separate connection for the read-space writer: the home connection's
  // held transact response must not serialize its requests.
  const readerClient = await connectClient(server);
  const wakes: ForeignWakeEvent[] = [];
  server.subscribeForeignWakes(HOME_SPACE, (event) => {
    wakes.push(event);
  });
  const SECOND_SOURCE: SchedulerObservationAddress = {
    space: READ_SPACE,
    id: "of:xsp-wake:second-source",
    scope: "space",
    path: ["value"],
  };
  try {
    const home = await mountAs(client, HOME_SPACE, ALICE);
    const reader = await mountAs(readerClient, READ_SPACE, ALICE);
    const sessionContextKey = Engine.sessionExecutionContextKey(
      ALICE,
      home.sessionId,
    ) as SchedulerExecutionContextKey;
    await home.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:xsp-wake:seed", value: { value: 1 } }],
    });
    // v1 of the read establishes the mirror and the LIVE subscription.
    await home.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: foreignReaderObservation(HOME_OUTPUT),
    });
    await server.openSessionLaneGrant(HOME_SPACE, "", ALICE, home.sessionId);
    await home.setExecutionDemand("", [PIECE_ROOT]);
    await internals.settleForeignReaderSubscriptions();
    assertEquals(
      frames.filter((frame) =>
        frame.type === "foreign-readers.subscribe-applied"
      ).length,
      1,
      "the subscription is live before the window opens",
    );
    assertEquals(wakes.length, 0);

    // Hold the HOME side-effect chain and RE-TARGET the read onto the
    // second source: the accept applies synchronously (the home
    // read-index now names the second source) while its mirror upsert is
    // parked — the C3A9 window is open for that read.
    const hold = internals.holdPostCommitSchedulerSideEffects(HOME_SPACE);
    await hold.entered;
    const homeEngine = await internals.openEngine(HOME_SPACE);
    const retargeted = home.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: foreignReaderObservation(
        HOME_OUTPUT,
        ACTION_ID,
        [SECOND_SOURCE],
      ),
    });
    await spinUntil(
      () =>
        Engine.listSchedulerActionSnapshots(homeEngine, {
          branch: "",
          ownerSpace: HOME_SPACE,
          pieceId: SCHEDULER_PIECE_ID,
          actionId: ACTION_ID,
        }).snapshots.some((snapshot) =>
          snapshot.observation.reads.some((read) =>
            read.id === SECOND_SOURCE.id
          )
        ),
      "the retargeted read was accepted",
    );

    // B commits K against the SECOND source strictly inside the window:
    // the read space has no mirrored row for it, so K's publish emits NO
    // notice and no commit-time dirt mark flows — the missed-wake shape.
    await reader.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SECOND_SOURCE.id,
        value: { value: "k-in-window" },
      }],
    });
    await internals.settleCrossSpaceDeliveries();
    assertEquals(
      frames.filter((frame) => frame.type === "foreign-stale-readers").length,
      0,
      "K's publish consulted mirrors that do not exist yet — no notice",
    );
    assertEquals(
      frames.filter((frame) => frame.type === "foreign-dirty-mark").length,
      0,
      "no mirrored row for the new read — no commit-time dirt mark",
    );
    assertEquals(wakes.length, 0, "the window is open: nothing woke");

    // The mirror lands: the upsert's IN-TRANSACTION window mark (the
    // changed read-row set against the hosting space, at its current
    // seq ≥ K) closes the gap — conservative dirt flows the dirt-mark +
    // notice path and the home action wakes under the live subscription.
    hold.release();
    await retargeted;
    await internals.settleForeignReaderSubscriptions();
    assertEquals(wakes.length, 1, "the window closure woke the action");
    assertEquals(wakes[0].origin, "notice");
    assertEquals(wakes[0].readSpace, READ_SPACE);
    assertEquals(wakes[0].readSeq, 1, "the window mark carries B's seq");
    assertEquals(wakes[0].staleForeignReaders, [{
      branch: "",
      pieceId: SCHEDULER_PIECE_ID,
      processGeneration: 1,
      actionId: ACTION_ID,
      executionContextKey: sessionContextKey,
    }]);
    assertEquals(
      frames.filter((frame) => frame.type === "foreign-dirty-mark").length,
      1,
      "the window mark flowed as durable dirt carriage (the ledger leg)",
    );
    const dirty = Engine.dirtyDemandedSchedulerActions(homeEngine, {
      branch: "",
      ownerSpace: HOME_SPACE,
      demandedSchedulerPieceIds: [SCHEDULER_PIECE_ID],
      applicableExecutionContextKeys: [sessionContextKey],
    });
    assertEquals(
      dirty.map((row) => row.directDirtySeq),
      [1],
      "the dirt is durable in the home engine",
    );

    // Steady state after the window: the mirrored row now exists, so a
    // subsequent B commit takes the ordinary notice path (and the
    // identical-payload re-mirror rule means the closure cannot loop).
    await reader.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SECOND_SOURCE.id,
        value: { value: "post-window" },
      }],
    });
    await internals.settleForeignReaderSubscriptions();
    assertEquals(wakes.length, 2, "the ordinary path resumed");
    assertEquals(wakes[1].origin, "notice");
    assertEquals(wakes[1].readSeq, 2);
  } finally {
    await client.close().catch(() => {});
    await readerClient.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.3a (e): lane symmetry — a session lane opened after registration re-registers, its dirt catches up, and later commits wake the scoped lane (C3A17)", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createWakeServer("xsp-wake-lanes");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const client = await connectClient(server);
  const wakes: ForeignWakeEvent[] = [];
  server.subscribeForeignWakes(HOME_SPACE, (event) => {
    wakes.push(event);
  });
  try {
    const home = await mountAs(client, HOME_SPACE, ALICE);
    const reader = await mountAs(client, READ_SPACE, ALICE);
    const sessionContextKey = Engine.sessionExecutionContextKey(
      ALICE,
      home.sessionId,
    ) as SchedulerExecutionContextKey;
    await home.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:xsp-wake:seed", value: { value: 1 } }],
    });
    // A SESSION-context reader row over the foreign source (the session-
    // scoped output floors the row at the committing session's context).
    await home.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: foreignReaderObservation(SESSION_OUTPUT),
    });
    const homeEngine = await internals.openEngine(HOME_SPACE);
    assertEquals(plantedContextKey(homeEngine), sessionContextKey);

    // Demand joins with NO session lane open: the subscription carries
    // the space pair only, so a B commit dirties the session row (C3.1b
    // carriage is subscription-independent) without waking it — the
    // scoped parked skip.
    await home.setExecutionDemand("", [PIECE_ROOT]);
    await internals.settleForeignReaderSubscriptions();
    const gen1 = frames.filter(
      (frame): frame is ForeignReadersSubscribe =>
        frame.type === "foreign-readers.subscribe",
    );
    assertEquals(gen1.length, 1);
    assertEquals(gen1[0].laneDemands.map((lane) => lane.contextKey), [
      "space",
    ]);
    await writeForeignSource(reader, 1, "parked-scoped");
    await internals.settleForeignReaderSubscriptions();
    assertEquals(
      wakes.length,
      0,
      "a session-context row without its lane grant accumulates dirt " +
        "without waking (grant-keyed pairing, no parked-lane state)",
    );
    assertEquals(
      Engine.dirtyDemandedSchedulerActions(homeEngine, {
        branch: "",
        ownerSpace: HOME_SPACE,
        demandedSchedulerPieceIds: [SCHEDULER_PIECE_ID],
        applicableExecutionContextKeys: [sessionContextKey],
      }).map((row) => row.directDirtySeq),
      [1],
      "the dirt accumulated on the session row",
    );

    // The session lane opens AFTER initial registration: lane churn
    // re-registers under a new generation whose laneDemands include the
    // session pair, and the post-ack scan replays the accumulated dirt
    // into a session-lane wake.
    await server.openSessionLaneGrant(HOME_SPACE, "", ALICE, home.sessionId);
    await internals.settleForeignReaderSubscriptions();
    const subscribesAfterGrant = frames.filter(
      (frame): frame is ForeignReadersSubscribe =>
        frame.type === "foreign-readers.subscribe",
    );
    assertEquals(
      subscribesAfterGrant.length,
      2,
      "lane churn re-registered the subscription",
    );
    assertEquals(subscribesAfterGrant[1].subscriptionGeneration, 2);
    assertEquals(
      subscribesAfterGrant[1].laneDemands.map((lane) => lane.contextKey),
      ["space", sessionContextKey],
      "the post-C2.7 shape: the session grant joins the foreign lookup",
    );
    assert(
      frames.some((frame) =>
        frame.type === "foreign-readers.unsubscribe" &&
        frame.subscriptionGeneration === 1
      ),
      "the superseded generation retired AFTER the new one acked",
    );
    assertEquals(wakes.length, 1, "the scan replayed the scoped dirt");
    assertEquals(wakes[0].origin, "resubscribe-scan");
    assertEquals(
      wakes[0].staleForeignReaders.map((r) => r.executionContextKey),
      [sessionContextKey],
    );

    // A subsequent B commit wakes the session lane via the notice path.
    await writeForeignSource(reader, 2, "lane-open");
    await internals.settleForeignReaderSubscriptions();
    assertEquals(wakes.length, 2);
    assertEquals(wakes[1].origin, "notice");
    assertEquals(
      wakes[1].staleForeignReaders.map((r) => r.executionContextKey),
      [sessionContextKey],
      "a session lane's demanded foreign-read action wakes on a B commit",
    );

    // User-lane symmetry over the same wire: the user grant re-registers
    // with its own pair. (The user slice equals the principal's demand.)
    await server.openUserLaneGrant(HOME_SPACE, "", ALICE);
    await internals.settleForeignReaderSubscriptions();
    const finalSubscribe = frames.filter(
      (frame): frame is ForeignReadersSubscribe =>
        frame.type === "foreign-readers.subscribe",
    ).at(-1)!;
    assertEquals(
      finalSubscribe.laneDemands.map((lane) => lane.contextKey),
      [
        "space",
        Engine.userExecutionContextKey(ALICE),
        sessionContextKey,
      ],
      "user AND session grants join the foreign lookup (C3A17)",
    );
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.3a (f): single-space regression — no foreign reads means zero subscriptions, zero cross-space frames, and the home wake surface untouched", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = createWakeServer("xsp-wake-single");
  const internals = internalsOf(server);
  const frames = tapCrossSpaceFrames(server);
  const client = await connectClient(server);
  const wakes: ForeignWakeEvent[] = [];
  server.subscribeForeignWakes(HOME_SPACE, (event) => {
    wakes.push(event);
  });
  try {
    const home = await mountAs(client, HOME_SPACE, ALICE);
    const events: { staleDemandedReaders: readonly unknown[] }[] = [];
    server.subscribeAcceptedCommits(HOME_SPACE, (event) => {
      events.push(event);
    });
    await home.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:xsp-wake:seed", value: { value: 1 } }],
    });
    // A HOME-only reader (reads its own space's source).
    const observation = foreignReaderObservation(HOME_OUTPUT);
    const homeSource = { ...FOREIGN_SOURCE, space: HOME_SPACE };
    await home.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: {
        ...observation,
        reads: [homeSource],
        completeActionScopeSummary: {
          ...observation.completeActionScopeSummary!,
          reads: [homeSource],
        },
      },
    });
    await home.setExecutionDemand("", [PIECE_ROOT]);
    await internals.settleForeignReaderSubscriptions();
    await home.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: FOREIGN_SOURCE.id,
        value: { value: "home-write" },
      }],
    });
    await internals.settleForeignReaderSubscriptions();

    assertEquals(frames, [], "zero cross-space frames for single-space use");
    assertEquals(
      internals.foreignReaderSubscriptionsByHomeSpace.size,
      0,
      "zero home-side subscriptions",
    );
    assertEquals(
      internals.foreignReaderSubscriptionsByReadSpace.size,
      0,
      "zero read-side registrations",
    );
    assertEquals(wakes.length, 0, "no foreign wakes");
    // The home A4 wake surface still fired for the demanded stale reader.
    assert(
      events.some((event) => event.staleDemandedReaders.length > 0),
      "the home accepted-commit wake surface is untouched",
    );
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});
