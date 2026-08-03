// C3.10a — two `Server` instances over the co-hosted link: the C3.1b
// carriage, the routing-table three-way split, the C3.2 epoch flows,
// and the C3.3a subscribe/ack/notice pipeline, all crossing a REAL
// serializing link (every frame is a string through the C3.1 codec —
// nothing structured crosses between the hosts).
//
// Fixture map (plan row C3.10a; amendments C3A1/C3A8/C3A13):
//  (a) carriage: a home observation on host A mirrors into host B's
//      engine OVER THE LINK (rows land in B's store); B's dirtying
//      commit lands durable dirt back in A's engine; the applied-dirt
//      cursor advances under the link's derived stable linkId (C3A12
//      keying); the retraction rides the same mirror message;
//  (b) the three-way split: locally-hosted = registered eagerly from
//      the deployment config and created on serve; peer-routed = NEVER
//      locally materialized (openEngine/openHostedEngine refuse loudly,
//      no store directory ever appears) while traffic for the space
//      rides the link; unknown = the C3.1b drop discipline (zero side
//      effects on either host, nothing crosses the link);
//  (c) C3A13 at the server level: a forged frame stamping an
//      undeclared fromSpace drops at A's link gate — counter up,
//      engine state byte-identical (zero side effects);
//  (d) C3.2: an ACL genesis on B pushes its epoch bump over the link
//      into A's remote cache (keyed by the stable linkId + fromSpace),
//      and the epoch query round-trips the link;
//  (e) C3.3a: the demand-joined subscribe crosses, the C3A10 ack
//      arrives AFTER pre-subscribe dirt on the same FIFO link (the
//      two-part barrier's ordering SURVIVES the real medium), the
//      post-ack scan replays pre-subscribe dirt as a wake, a
//      subsequent B commit wakes via the notice path exactly once, and
//      an unrelated B commit wakes nothing.
//
// RECORDED FOR C3.10b (observed leaks of same-host barrier
// assumptions — deliberately NOT fixed here; C3.10b owns the
// cross-host ack/barrier semantics, dated 2026-07-18):
//  (L1) `mirrorSchedulerObservation` awaits `settleCrossSpaceDeliveries`,
//       whose pending set is HOST-LOCAL — over the link the transact
//       response resolves while the mirror frame is still in flight
//       (pinned below with the delivery-hold seam: the frame is captive
//       in the duplex, the transact has resolved, and B's engine
//       provably lacks the row until release).
//  (L2) `queryForeignAuthorizationEpochs` settles same-host delivery
//       only — over the link it returns undefined while the query (and
//       its answer) are in flight; the caller needs C3.10b's response
//       barrier. Same for the C3.2 bump publication barrier on the
//       writing host (its writeDocument resolves with the bump frame
//       captive).
//  What SURVIVED without any cross-host barrier: the C3A10 ack
//  ordering (ack strictly after pre-subscribe dirt at A — per-link
//  FIFO + per-space inbound apply chains), dirt-before-notice for the
//  wake path, and `settleForeignReaderSubscriptions` (it awaits the
//  application-level ack, which is transport-agnostic by design).
//
// Barrier-driven throughout: every await is a transact response, a
// link `opened`, the pair's quiescence barrier, a server settle
// barrier, or an inbox waitFor — no sleeps.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import {
  aclDocId,
  close as closeEngine,
  open as openEngine,
  type SchedulerActionObservation,
  type SchedulerObservationAddress,
} from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import type { ForeignWakeEvent } from "../v2/server.ts";
import {
  resolveSpaceStoreDirUrl,
  resolveSpaceStoreUrl,
} from "../v2/storage-path.ts";
import {
  resetPersistentSchedulerStateConfig,
  sessionExecutionContextKey,
  setPersistentSchedulerStateConfig,
} from "../v2.ts";
import {
  CROSS_SPACE_PROTOCOL_VERSION,
  type CrossSpaceLaneDemand,
  type CrossSpaceMessage,
  CrossSpaceProtocolError,
  encodeCrossSpaceMessage,
  type ForeignDirtyMark,
  parseCrossSpaceMessage,
} from "../v2/cross-space.ts";
import {
  type CoHostedCrossSpaceLink,
  CoHostedCrossSpaceTransport,
  type CrossSpaceLinkSocketPair,
  crossSpaceLinkSocketPair,
} from "../v2/cross-space-link.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const HOST_A = "host:xsp-cohosted-a";
const HOST_B = "host:xsp-cohosted-b";
const HOME_SPACE = "did:key:z6Mk-xsp-cohosted-home";
const READ_SPACE = "did:key:z6Mk-xsp-cohosted-read";
const EVIL_SPACE = "did:key:z6Mk-xsp-cohosted-evil";
const ALICE = "did:key:z6Mk-xsp-cohosted-alice";
const AUDIENCE = "did:key:z6Mk-xsp-cohosted-audience";

const PIECE_ROOT = "of:xsp-cohosted:piece";
const SCHEDULER_PIECE_ID = `space:${PIECE_ROOT}`;
const ACTION_ID = "action:xsp-cohosted-reader";

const FOREIGN_SOURCE: SchedulerObservationAddress = {
  space: READ_SPACE,
  id: "of:xsp-cohosted:source",
  scope: "space",
  path: ["value"],
};
const HOME_OUTPUT: SchedulerObservationAddress = {
  space: HOME_SPACE,
  id: "of:xsp-cohosted:output",
  scope: "space",
  path: ["value"],
};

/** Soft-private server internals (the carriage/wake tests' convention). */
type ServerInternals = {
  settleCrossSpaceDeliveries(): Promise<void>;
  settleForeignReaderSubscriptions(): Promise<void>;
  openEngine(space: string): Promise<Engine.Engine>;
  openHostedEngine(space: string): Promise<unknown>;
  crossSpaceAppliedDirtCursors: Map<string, number>;
  foreignReaderSubscriptionsByReadSpace: Map<
    string,
    Map<
      string,
      { generation: number; laneDemands: readonly CrossSpaceLaneDemand[] }
    >
  >;
};

const internalsOf = (server: Server): ServerInternals =>
  server as unknown as ServerInternals;

interface LinkedServers {
  pair: CrossSpaceLinkSocketPair;
  serverA: Server;
  serverB: Server;
  transportA: CoHostedCrossSpaceTransport;
  transportB: CoHostedCrossSpaceTransport;
  linkA: CoHostedCrossSpaceLink;
  linkB: CoHostedCrossSpaceLink;
  linkId: string;
  close(): Promise<void>;
}

/**
 * Two Servers, each with its own store, session registry, and
 * co-hosted transport, joined by the serializing duplex — two genuine
 * hosts sharing nothing but the link. (The C3.3b mirror SEND gate is
 * a send-host-LOCAL ACL consult; for peer-routed read spaces the
 * mirror forwards and the read-host-side capability check is the
 * C3.10b transport-parity slot — see the gate's composition note in
 * server.ts.)
 */
const linkServers = async (
  options: {
    storeA?: URL;
    storeB?: URL;
    serverOptions?: Record<string, unknown>;
  } = {},
): Promise<LinkedServers> => {
  const pair = crossSpaceLinkSocketPair();
  const transportA = new CoHostedCrossSpaceTransport({
    hostId: HOST_A,
    hostedSpaces: [HOME_SPACE],
  });
  const transportB = new CoHostedCrossSpaceTransport({
    hostId: HOST_B,
    hostedSpaces: [READ_SPACE],
  });
  const base = options.serverOptions ?? testSessionOpenServerOptions;
  const serverA = new Server(
    {
      ...base,
      store: options.storeA ?? new URL("memory://xsp-cohosted-a"),
      crossSpaceTransport: transportA,
    } as unknown as ConstructorParameters<typeof Server>[0],
  );
  const serverB = new Server(
    {
      ...base,
      store: options.storeB ?? new URL("memory://xsp-cohosted-b"),
      crossSpaceTransport: transportB,
    } as unknown as ConstructorParameters<typeof Server>[0],
  );
  const linkA = transportA.attachLink(pair.sockets[0]);
  const linkB = transportB.attachLink(pair.sockets[1]);
  const [{ linkId }] = await Promise.all([linkA.opened, linkB.opened]);
  return {
    pair,
    serverA,
    serverB,
    transportA,
    transportB,
    linkA,
    linkB,
    linkId,
    close: async () => {
      await serverA.close().catch(() => {});
      await serverB.close().catch(() => {});
    },
  };
};

/**
 * Cross-host settle: loop (duplex quiescent → both hosts' delivery and
 * subscription barriers) until a full pass moves no frames. This is
 * the composed barrier the recorded L1/L2 leaks make necessary — no
 * single-host settle covers a frame in flight between the hosts.
 */
const settleLinked = async (fixture: LinkedServers): Promise<void> => {
  const a = internalsOf(fixture.serverA);
  const b = internalsOf(fixture.serverB);
  for (let i = 0; i < 100; i += 1) {
    const before = fixture.pair.framesTransferred();
    await fixture.pair.whenQuiet();
    await a.settleCrossSpaceDeliveries();
    await b.settleCrossSpaceDeliveries();
    await a.settleForeignReaderSubscriptions();
    await b.settleForeignReaderSubscriptions();
    await fixture.pair.whenQuiet();
    if (fixture.pair.framesTransferred() === before) return;
  }
  throw new Error("linked servers did not quiesce");
};

/**
 * C3.10b cross-host BARRIER plumbing — the link-sync flush the mirror path
 * awaits (L1 fix) and the reconnect dirt-resync pull. These are transport
 * barriers, not carriage/wake SEMANTICS, so the semantic-transcript taps
 * below exclude them (the L1/L2/reconnect fixtures assert their EFFECT —
 * the mirror lands, the query resolves after the answer, the reader wakes —
 * directly, not by counting the plumbing frames).
 */
const BARRIER_FRAME_TYPES = new Set([
  "foreign-link-sync",
  "foreign-link-sync.ack",
  "foreign-dirty-resync",
  "foreign-dirty-resync.result",
]);

/** Tap the INBOUND payload frames of one host's side of the link (the
 * link channel fans in only frames received from the socket), excluding the
 * C3.10b barrier plumbing (see {@link BARRIER_FRAME_TYPES}). */
const tapInbound = (
  transport: CoHostedCrossSpaceTransport,
  routedSpace: string,
): {
  messages: CrossSpaceMessage[];
  types(): string[];
} => {
  const messages: CrossSpaceMessage[] = [];
  transport.channelTo(routedSpace).onMessage((wire) => {
    const parsed = parseCrossSpaceMessage(wire);
    if (parsed.ok && !BARRIER_FRAME_TYPES.has(parsed.message.type)) {
      messages.push(parsed.message);
    }
  });
  return {
    messages,
    types: () => messages.map((message) => message.type),
  };
};

const observation = (
  reads: readonly SchedulerObservationAddress[],
): SchedulerActionObservation => ({
  version: 1,
  ownerSpace: HOME_SPACE,
  branch: "",
  pieceId: "of:piece",
  processGeneration: 1,
  actionId: "pattern.tsx:computed:1",
  actionKind: "computation",
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:test",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [...reads],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [HOME_OUTPUT],
  declaredWrites: [],
  materializerWriteEnvelopes: [],
  status: "success",
});

const storedSpaces = async (store: URL): Promise<string[]> => {
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(resolveSpaceStoreDirUrl(store))) {
      entries.push(entry.name);
    }
  } catch {
    // engine-v3/ not created yet
  }
  return entries.sort();
};

const dumpActionState = async (
  store: URL,
  space: string,
): Promise<Record<string, unknown>[]> => {
  const engine = await openEngine({
    url: resolveSpaceStoreUrl(store, space as `did:${string}:${string}`),
  });
  try {
    return engine.database.prepare(
      "SELECT branch, owner_space, piece_id, action_id, direct_dirty_seq " +
        "FROM scheduler_action_state ORDER BY owner_space, action_id",
    ).all() as Record<string, unknown>[];
  } finally {
    closeEngine(engine);
  }
};

const dumpReadIndexOwners = async (
  store: URL,
  space: string,
): Promise<Record<string, unknown>[]> => {
  const engine = await openEngine({
    url: resolveSpaceStoreUrl(store, space as `did:${string}:${string}`),
  });
  try {
    return engine.database.prepare(
      "SELECT owner_space, read_space, read_id FROM scheduler_read_index " +
        "ORDER BY owner_space, read_id",
    ).all() as Record<string, unknown>[];
  } finally {
    closeEngine(engine);
  }
};

// ---------------------------------------------------------------------------
// (a) + (b) + (c): carriage and the three-way split, file-backed.
// ---------------------------------------------------------------------------

Deno.test("C3.10a carriage + three-way split: mirrors/dirt cross the link into the peer engine; peer-routed spaces never materialize locally; unknown spaces drop", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePathA = await Deno.makeTempDir();
  const storePathB = await Deno.makeTempDir();
  const storeA = toFileUrl(`${storePathA}/`);
  const storeB = toFileUrl(`${storePathB}/`);
  const fixture = await linkServers({ storeA, storeB });
  const { serverA, serverB, pair, linkId } = fixture;
  const atB = tapInbound(fixture.transportB, HOME_SPACE);
  const atA = tapInbound(fixture.transportA, READ_SPACE);
  const clientA = await MemoryClient.connect({
    transport: MemoryClient.loopback(serverA),
  });
  const clientB = await MemoryClient.connect({
    transport: MemoryClient.loopback(serverB),
  });
  try {
    // Three-way split, arm 1 (locally-hosted): deployment-configured
    // spaces are registered EAGERLY — the protocol inbox exists before
    // first serve on both hosts.
    assert(serverA.crossSpaceRouter().isHosted(HOME_SPACE));
    assert(serverB.crossSpaceRouter().isHosted(READ_SPACE));
    assert(!serverA.crossSpaceRouter().isHosted(READ_SPACE));

    const owner = await clientA.mount(
      HOME_SPACE,
      { sessionId: "xsp-cohosted-owner" },
      testSessionOpenAuthFactory,
    );
    const reader = await clientB.mount(
      READ_SPACE,
      { sessionId: "xsp-cohosted-reader" },
      testSessionOpenAuthFactory,
    );

    // (a) Mirror: A's accepted observation reads B's space — the mirror
    // crosses the LINK (B's inbound tap pins it) and lands in B's OWN
    // store's engine.
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observation([FOREIGN_SOURCE]),
    });
    await settleLinked(fixture);
    assertEquals(atB.types(), ["foreign-observation.mirror"]);
    assertEquals(atB.messages[0].fromSpace, HOME_SPACE);
    assertEquals(atB.messages[0].toSpace, READ_SPACE);
    assertEquals(atB.messages[0].linkId, linkId);
    assertEquals(await dumpReadIndexOwners(storeB, READ_SPACE), [{
      owner_space: HOME_SPACE,
      read_space: READ_SPACE,
      read_id: FOREIGN_SOURCE.id,
    }], "the mirrored read row landed in B's engine over the link");

    // (a) Dirt: B's commit dirtying the mirrored row propagates durable
    // dirt back into A's engine over the link.
    await reader.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: FOREIGN_SOURCE.id,
        scope: "space",
        value: { value: { count: 1 } },
      }],
    });
    await settleLinked(fixture);
    assertEquals(atA.types(), ["foreign-dirty-mark"]);
    assertEquals(
      await dumpActionState(storeA, HOME_SPACE),
      [{
        branch: "",
        owner_space: HOME_SPACE,
        piece_id: "of:piece",
        action_id: "pattern.tsx:computed:1",
        direct_dirty_seq: 1,
      }],
      "B's dirtying commit marked A's home row over the link",
    );
    // The read host's own owner_space-keyed rows remain the durable
    // resync ledger C3.10b's reconnect pull reads.
    assertEquals(
      (await dumpActionState(storeB, READ_SPACE)).filter(
        (row) => row.owner_space === HOME_SPACE,
      ).map((row) => [row.owner_space, row.direct_dirty_seq]),
      [[HOME_SPACE, 1]],
    );
    // The applied-dirt cursor advanced under the link's DERIVED stable
    // linkId (C3A12 keying survives reconnects by construction).
    assertEquals(
      [...internalsOf(serverA).crossSpaceAppliedDirtCursors.entries()],
      [[`${linkId}\0${READ_SPACE}\0${HOME_SPACE}`, 1]],
    );

    // (c) C3A13 at the server level: a forged frame on the link
    // stamping an UNDECLARED fromSpace drops at A's gate — counter up,
    // zero engine side effects (byte-identical action state).
    const before = await dumpActionState(storeA, HOME_SPACE);
    pair.sockets[1].send(encodeCrossSpaceMessage({
      type: "foreign-dirty-mark",
      branch: "",
      dirtySeq: 99,
      readers: [{
        branch: "",
        pieceId: "of:piece",
        processGeneration: 1,
        actionId: "pattern.tsx:computed:1",
        executionContextKey: "space",
      }],
      v: CROSS_SPACE_PROTOCOL_VERSION,
      linkId,
      fromSpace: EVIL_SPACE,
      toSpace: HOME_SPACE,
    } as ForeignDirtyMark));
    await settleLinked(fixture);
    assertEquals(fixture.linkA.diagnostics().fromSpaceViolationsDropped, 1);
    assertEquals(
      await dumpActionState(storeA, HOME_SPACE),
      before,
      "the forged frame produced zero engine side effects",
    );

    // (a) Retraction rides the same mirror message across the link.
    await owner.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observation([]),
    });
    await settleLinked(fixture);
    assertEquals(
      await dumpReadIndexOwners(storeB, READ_SPACE),
      [],
      "the narrowed observation retracted B's mirrored read rows",
    );

    // Three-way split, arm 2 (peer-routed): READ_SPACE is B's — host A
    // must NEVER materialize it, on any path, loudly.
    const refusal = await assertRejects(
      () => serverA.writeDocument(READ_SPACE, "of:doc", { hello: true }),
      CrossSpaceProtocolError,
      "peer host",
    );
    assertEquals(refusal.code, "space-not-hosted");
    await assertRejects(
      () => internalsOf(serverA).openEngine(READ_SPACE) as Promise<never>,
      CrossSpaceProtocolError,
    );
    await assertRejects(
      () => internalsOf(serverA).openHostedEngine(READ_SPACE) as Promise<never>,
      CrossSpaceProtocolError,
    );
    assert(!serverA.crossSpaceRouter().isHosted(READ_SPACE));
    assertEquals(
      (await storedSpaces(storeA)).filter((name) => name.includes("read")),
      [],
      "no engine for the peer-routed space ever materialized on A",
    );

    // Three-way split, arm 3 (unknown): neither local nor routed — the
    // send drops at A's own router (the C3.1b discipline), nothing
    // crosses the link, nothing materializes anywhere.
    const framesAtBBefore = atB.messages.length;
    serverA.crossSpaceRouter().link(HOME_SPACE, EVIL_SPACE).send({
      type: "foreign-dirty-mark",
      branch: "",
      dirtySeq: 1,
      readers: [],
    });
    await settleLinked(fixture);
    assertEquals(atB.messages.length, framesAtBBefore, "nothing crossed");
    assert(!serverA.crossSpaceRouter().isHosted(EVIL_SPACE));
    assert(!serverB.crossSpaceRouter().isHosted(EVIL_SPACE));
    assertEquals(
      (await storedSpaces(storeA)).concat(await storedSpaces(storeB))
        .filter((name) => name.includes("evil")),
      [],
    );
  } finally {
    await clientA.close().catch(() => {});
    await clientB.close().catch(() => {});
    await fixture.close();
    await Deno.remove(storePathA, { recursive: true }).catch(() => {});
    await Deno.remove(storePathB, { recursive: true }).catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

// ---------------------------------------------------------------------------
// (L1 FIXED, C3.10b) The mirror path awaits a cross-host apply barrier.
// ---------------------------------------------------------------------------

Deno.test("C3.10b (L1 fixed): the transact resolves only AFTER B applied its mirror row — the cross-host apply barrier closes the C3.10a leak", async () => {
  setPersistentSchedulerStateConfig(true);
  const fixture = await linkServers();
  const clientA = await MemoryClient.connect({
    transport: MemoryClient.loopback(fixture.serverA),
  });
  const clientB = await MemoryClient.connect({
    transport: MemoryClient.loopback(fixture.serverB),
  });
  try {
    const owner = await clientA.mount(
      HOME_SPACE,
      { sessionId: "xsp-cohosted-owner" },
      testSessionOpenAuthFactory,
    );
    await clientB.mount(
      READ_SPACE,
      { sessionId: "xsp-cohosted-reader" },
      testSessionOpenAuthFactory,
    );
    const readEngine = await internalsOf(fixture.serverB).openEngine(
      READ_SPACE,
    );
    const mirroredRows = () =>
      Engine.listSchedulerActionSnapshots(readEngine, {
        branch: "",
        ownerSpace: HOME_SPACE,
        pieceId: "of:piece",
        actionId: "pattern.tsx:computed:1",
      }).snapshots.length;

    // C3.10a recorded this transact resolving with the mirror frame CAPTIVE
    // in the duplex (B provably lacks the row). C3.10b closes it: the mirror
    // path flushes each PEER target with a cross-host apply barrier
    // (`foreign-link-sync` → the read host acks it only after draining the
    // mirror on its inbound apply chain), so the transact resolves ONLY after
    // B applied the row — no settle, no hold-release needed.
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observation([FOREIGN_SOURCE]),
    });
    assertEquals(
      mirroredRows(),
      1,
      "the transact awaited the peer applying its mirror (L1 barrier closed " +
        "the leak)",
    );
  } finally {
    await clientA.close().catch(() => {});
    await clientB.close().catch(() => {});
    await fixture.close();
    resetPersistentSchedulerStateConfig();
  }
});

// ---------------------------------------------------------------------------
// (d) + (L2): the C3.2 epoch flows over the link.
// ---------------------------------------------------------------------------

Deno.test("C3.10a/b epoch flows: B's ACL bumps cross the link into A's remote cache; the epoch query round-trip resolves AFTER its answer (L2 response barrier)", async () => {
  setPersistentSchedulerStateConfig(true);
  const BOB = "did:key:z6Mk-xsp-cohosted-bob";
  const fixture = await linkServers();
  const { serverA, serverB, linkId } = fixture;
  const atA = tapInbound(fixture.transportA, READ_SPACE);
  const queryResultsAtA = () =>
    atA.types().filter(
      (type) => type === "foreign-authorization-epoch.query.result",
    ).length;
  try {
    // Nothing known about the peer space yet — the C3A3 fail-closed
    // unknown state.
    assertEquals(
      serverA.remoteAuthorizationEpochSnapshot(linkId, READ_SPACE),
      undefined,
    );

    // (L2a) The bump publication: B's ACL genesis (validity transition
    // ⇒ floor bump) fans over the link because the v1 relationship set
    // now includes link-routed spaces. B's own publication barrier is
    // HOST-LOCAL, pinned with the hold: the write resolves while the
    // bump frame is captive — A still knows nothing (the recorded L2
    // shape; C3.10b owns the cross-host equivalent).
    const releaseBump = fixture.pair.holdDelivery();
    await serverB.writeDocument(READ_SPACE, aclDocId(READ_SPACE), {
      [ALICE]: "OWNER",
    });
    assertEquals(
      serverA.remoteAuthorizationEpochSnapshot(linkId, READ_SPACE),
      undefined,
      "B's write resolved while its bump was still in flight (L2)",
    );
    releaseBump();
    await settleLinked(fixture);
    assertEquals(atA.types(), ["foreign-authorization-epoch.bump"]);
    const afterBump = serverA.remoteAuthorizationEpochSnapshot(
      linkId,
      READ_SPACE,
    );
    assert(afterBump !== undefined, "the bump crossed the link");
    assertEquals(afterBump.floor >= 1, true, "genesis bumped the floor");

    // A valid→valid entry change bumps exactly the affected principal;
    // the per-principal bump rides the link into A's cache too.
    await serverB.writeDocument(READ_SPACE, aclDocId(READ_SPACE), {
      [ALICE]: "OWNER",
      [BOB]: "WRITE",
    });
    await settleLinked(fixture);
    const afterEntryChange = serverA.remoteAuthorizationEpochSnapshot(
      linkId,
      READ_SPACE,
    );
    assert(afterEntryChange !== undefined);
    assertEquals(
      afterEntryChange.epochs.map((entry) => entry.principal).includes(BOB),
      true,
      "the per-principal bump crossed the link",
    );

    // (L2b FIXED, C3.10b) The query round-trip now awaits the CROSS-HOST
    // response barrier (correlated by requestId), not the same-host settle:
    // with delivery held, the call does NOT resolve; only once the answer
    // crosses does it return with the merged snapshot. Pinned by starting the
    // query WITHOUT awaiting, holding delivery, and proving it is still
    // pending.
    const resultsBefore = queryResultsAtA();
    const releaseQuery = fixture.pair.holdDelivery();
    let queryResolved = false;
    const queryDone = serverA.queryForeignAuthorizationEpochs(
      HOME_SPACE,
      READ_SPACE,
      [ALICE, BOB],
    ).then((value) => {
      queryResolved = true;
      return value;
    });
    // Drain the microtask/timer queues (a macrotask hop); delivery is HELD, so
    // the answer cannot cross and the query must still be pending. (Cannot use
    // whenQuiet here — it only resolves once the hold is released.)
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(
      queryResolved,
      false,
      "the query awaits its answer over the link (L2 response barrier) — it " +
        "does not resolve while delivery is held",
    );
    assertEquals(queryResultsAtA(), resultsBefore, "no answer crossed yet");
    releaseQuery();
    await queryDone;
    assertEquals(
      queryResolved,
      true,
      "the query resolved once its answer crossed the link",
    );
    await settleLinked(fixture);
    assertEquals(queryResultsAtA(), resultsBefore + 1);
    const answer = atA.messages.findLast(
      (message) => message.type === "foreign-authorization-epoch.query.result",
    );
    assert(
      answer !== undefined &&
        answer.type === "foreign-authorization-epoch.query.result",
    );
    assertEquals(answer.fromSpace, READ_SPACE);
    assertEquals(answer.epochFloor >= 1, true);
    assertEquals(
      answer.epochs.map((entry) => entry.principal),
      [BOB],
      "the answer carries the known per-principal row; ALICE (no row) " +
        "is reported floor-only per the C3A3 fail-closed reading",
    );
    // And the merged remote snapshot reflects the answer.
    const merged = serverA.remoteAuthorizationEpochSnapshot(
      linkId,
      READ_SPACE,
    );
    assert(merged !== undefined);
    assertEquals(
      merged.epochs.map((entry) => entry.principal).includes(BOB),
      true,
    );
  } finally {
    await fixture.close();
    resetPersistentSchedulerStateConfig();
  }
});

// ---------------------------------------------------------------------------
// (e) The C3.3a pipeline over the link.
// ---------------------------------------------------------------------------

const executionServerOptions = {
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
};

type ExecutionSession = MemoryClient.SpaceSession & {
  setExecutionDemand(
    branch: string,
    pieces: readonly string[],
  ): Promise<boolean>;
};

type ExecutionServer = Server & {
  openSessionLaneGrant(
    space: string,
    branch: string,
    principal: string,
    sessionId: string,
  ): Promise<{ contextKey: string; laneGeneration: number }>;
};

const connectExecutionClient = async (
  server: Server,
): Promise<MemoryClient.Client> =>
  await MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: executionServerOptions.protocolFlags,
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

/** The wake test's version-2 observation: the action reads the foreign
 * source; a cross-space summary floors the row at the committing
 * SESSION's context (the pre-C3.6 conservative posture). */
const foreignReaderObservation = (): SchedulerActionObservation => ({
  version: 2,
  ownerSpace: HOME_SPACE,
  branch: "",
  pieceId: SCHEDULER_PIECE_ID,
  processGeneration: 1,
  actionId: ACTION_ID,
  actionKind: "computation",
  implementationFingerprint: "impl:xsp-cohosted",
  runtimeFingerprint: "runtime:xsp-cohosted",
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
    implementationFingerprint: "impl:xsp-cohosted",
    runtimeFingerprint: "runtime:xsp-cohosted",
    piece: { space: HOME_SPACE, id: PIECE_ROOT, scope: "space", path: [] },
    reads: [FOREIGN_SOURCE],
    writes: [HOME_OUTPUT],
    materializerWriteEnvelopes: [],
    directOutputs: [HOME_OUTPUT],
  },
  status: "success",
});

Deno.test("C3.10a C3.3a-over-the-link: subscribe/ack survive per-link FIFO (ack after pre-subscribe dirt), the post-ack scan and the notice each wake exactly once, unrelated commits none", async () => {
  setPersistentSchedulerStateConfig(true);
  const fixture = await linkServers({ serverOptions: executionServerOptions });
  const { serverA, serverB, linkId } = fixture;
  const internalsA = internalsOf(serverA);
  const internalsB = internalsOf(serverB);
  const atA = tapInbound(fixture.transportA, READ_SPACE);
  const atB = tapInbound(fixture.transportB, HOME_SPACE);
  const clientA = await connectExecutionClient(serverA);
  const clientB = await connectExecutionClient(serverB);
  const wakes: ForeignWakeEvent[] = [];
  serverA.subscribeForeignWakes(HOME_SPACE, (event) => {
    wakes.push(event);
  });
  try {
    const home = await mountAs(clientA, HOME_SPACE, ALICE);
    const reader = await mountAs(clientB, READ_SPACE, ALICE);
    const sessionContextKey = sessionExecutionContextKey(
      ALICE,
      home.sessionId,
    );

    await home.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:xsp-cohosted:seed",
        value: { value: 1 },
      }],
    });
    // The mirror crosses the link and lands in B's engine (session-
    // floored — the wakeable lane is the committing session's).
    await home.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: foreignReaderObservation(),
    });
    await settleLinked(fixture);
    const readEngine = await internalsB.openEngine(READ_SPACE);
    const mirrored = Engine.listSchedulerActionSnapshots(readEngine, {
      branch: "",
      ownerSpace: HOME_SPACE,
      pieceId: SCHEDULER_PIECE_ID,
      actionId: ACTION_ID,
    }).snapshots;
    assertEquals(mirrored.length, 1, "the mirror landed in B's engine");
    assertEquals(mirrored[0].executionContextKey, sessionContextKey);

    // PRE-SUBSCRIBE dirt: B commits against the mirrored read while NO
    // subscription exists. The dirt mark crosses (C3.1b carriage is
    // subscription-independent — the §4 parked obligation), no notice,
    // no wake yet.
    await reader.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: FOREIGN_SOURCE.id,
        value: { value: "pre-subscribe" },
      }],
    });
    await settleLinked(fixture);
    assertEquals(atA.types(), ["foreign-dirty-mark"]);
    assertEquals(wakes.length, 0, "dirt without demand wakes nothing");

    // Demand joins: session lane opens, demand publishes, the
    // reconciler subscribes OVER THE LINK and awaits the C3A10 ack.
    // `settleForeignReaderSubscriptions` resolving at all is the
    // "survived" evidence: the barrier is application-level (the ack
    // message), so it is transport-agnostic by design.
    await (serverA as ExecutionServer).openSessionLaneGrant(
      HOME_SPACE,
      "",
      ALICE,
      home.sessionId,
    );
    await home.setExecutionDemand("", [PIECE_ROOT]);
    await internalsA.settleForeignReaderSubscriptions();
    await settleLinked(fixture);

    // The subscription is live on B under generation 1 with the space
    // pair plus the session pair.
    const subscription = internalsB.foreignReaderSubscriptionsByReadSpace
      .get(READ_SPACE)?.get(`${HOME_SPACE}\0`);
    assert(subscription !== undefined, "B holds the subscription");
    assertEquals(subscription.generation, 1);
    assertEquals(
      subscription.laneDemands.map((lane) => lane.contextKey),
      ["space", sessionContextKey],
    );
    assertEquals(
      atB.types().filter((type) => type === "foreign-readers.subscribe"),
      ["foreign-readers.subscribe"],
      "exactly one subscribe crossed",
    );

    // THE C3A10 ordering evidence over the real medium: at A's inbox
    // the ack arrived strictly AFTER the pre-subscribe dirt mark —
    // per-link FIFO plus the per-space inbound apply chain are what
    // ordered the home host's post-ack scan behind the durable dirt.
    const types = atA.types();
    const dirtIndex = types.indexOf("foreign-dirty-mark");
    const ackIndex = types.indexOf("foreign-readers.subscribe-applied");
    assert(dirtIndex !== -1 && ackIndex !== -1);
    assert(
      dirtIndex < ackIndex,
      "the ack rode the FIFO link behind the pre-subscribe dirt",
    );

    // And the post-ack direct-dirty-∩-demand scan replayed that dirt as
    // exactly one wake (origin "resubscribe-scan"): no notice existed
    // for it, yet no wake was lost — the two-part barrier SURVIVES the
    // real link.
    assertEquals(wakes.length, 1, "the pre-subscribe dirt woke via the scan");
    assertEquals(wakes[0].origin, "resubscribe-scan");
    assertEquals(wakes[0].space, HOME_SPACE);
    assertEquals(wakes[0].readSpace, READ_SPACE);
    assertEquals(
      internalsA.crossSpaceAppliedDirtCursors.get(
        `${linkId}\0${READ_SPACE}\0${HOME_SPACE}`,
      ),
      1,
    );

    // A post-subscribe commit on B wakes via the NOTICE path — dirt
    // mark before notice on the same FIFO link, exactly one wake.
    await reader.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: FOREIGN_SOURCE.id,
        value: { value: "post-subscribe" },
      }],
    });
    await settleLinked(fixture);
    assertEquals(wakes.length, 2, "the demanded commit woke exactly once");
    assertEquals(wakes[1].origin, "notice");
    assertEquals(wakes[1].readSeq, 2);
    assertEquals(
      wakes[1].staleForeignReaders.map((reader) => reader.actionId),
      [ACTION_ID],
    );
    const afterNotice = atA.types();
    assert(
      afterNotice.lastIndexOf("foreign-dirty-mark") <
        afterNotice.lastIndexOf("foreign-stale-readers"),
      "dirt-before-notice held over the real link",
    );

    // An unrelated B commit produces no wake (and no notice).
    await reader.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:xsp-cohosted:unrelated",
        value: { value: true },
      }],
    });
    await settleLinked(fixture);
    assertEquals(wakes.length, 2, "unrelated commits wake nothing");
  } finally {
    await clientA.close().catch(() => {});
    await clientB.close().catch(() => {});
    await fixture.close();
    resetPersistentSchedulerStateConfig();
  }
});
