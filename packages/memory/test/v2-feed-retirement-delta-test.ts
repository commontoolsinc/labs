// F5 RETIREMENT DELTA MEASUREMENT (server-side traversal profile).
//
// WHY: the three server-primary integration gates (session-lane-latency,
// session-lane, lunch-poll-placement) never negotiate the doc-set-watch
// subcapability nor set the retirement dial, so they measure the F1/F2
// graph-traversal profile — NOT the F5-retired one. This measurement drives
// the SAME note-create-shaped surface two ways at the memory server and reads
// the traversal delta directly:
//
//   OFF   (baseline / non-retired): a schema-following GRAPH watch over an
//         index closure, dial OFF. Each note-create wave re-runs
//         `refreshTrackedGraph` — `session.watch.refresh` DAG traversal.
//   ON    (retired / fully-doc-set): a DOCS watch over the same closure as
//         explicit members, dial ON. The graph refresh path is structurally
//         excluded; members flow as zero-traversal point reads
//         (`session.docset.read`), `session.watch.refresh` never appears.
//   MIXED (fails open): the ON docs watch PLUS one residual graph watch, dial
//         ON. The residual watch keeps traversing and is COUNTED
//         (`refreshResidualGraphWatches` / ...Traversed), so retirement is
//         eligible-but-not-fully.
//
// This is the deterministic, barrier-driven server-side analog of the archived
// FA12 baseline pair (docs/history/development/performance/
// server-execution-feed-baseline-2026-07-16.md, `session.watch.refresh`
// 94,098 DAG flag-on) — at harness scale, not app scale. It EMITS the counts
// (console.log JSON, one line per leg + a DELTA summary) and ASSERTS the
// direction of the delta so a regression reds it.

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  resetServerPrimaryExecutionGraphRetirementConfig,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionSync,
  setServerPrimaryExecutionGraphRetirementConfig,
} from "../v2.ts";
import { Server } from "../v2/server.ts";

// The gate ALWAYS asserts the delta direction (regression protection). It only
// EMITS the measured counts when asked — `CF_EMIT_RETIREMENT_DELTA=1` — so the
// unit shard stays quiet by default (mirroring the integration gates' own
// `CF_VERIFY_SERVER_EXECUTION_PLACEMENT` emission gate).
const EMIT = Deno.env.get("CF_EMIT_RETIREMENT_DELTA") === "1";

const TEST_AUDIENCE = "did:key:z6Mk-feed-retire-delta-audience";
const SPONSOR = "did:key:z6Mk-feed-retire-delta-sponsor";

const DOCSET_SERVER_FLAGS = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionDocSetWatchV1: true,
} as const;

const DOCSET_HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: { ...getMemoryProtocolFlags(), ...DOCSET_SERVER_FLAGS },
} as const;

const createServer = (store: string): Server =>
  new Server(
    {
      store: new URL(store),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : SPONSOR;
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
      protocolFlags: { ...DOCSET_SERVER_FLAGS },
    } as unknown as ConstructorParameters<typeof Server>[0],
  );

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const drainEffects = (
  messages: ServerMessage[],
): (SessionEffectMessage & { effect: SessionSync })[] => {
  const effects: (SessionEffectMessage & { effect: SessionSync })[] = [];
  while (messages.length > 0) {
    const message = shiftMessage(messages);
    if (message.type === "session/effect") {
      effects.push(message as SessionEffectMessage & { effect: SessionSync });
    }
  }
  return effects;
};

type Harness = {
  server: Server;
  connection: ReturnType<Server["connect"]>;
  messages: ServerMessage[];
  sessionId: string;
};

const openSession = async (server: Server, space: string): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(DOCSET_HELLO));
  const hello = shiftMessage(messages);
  assertEquals(hello.type, "hello.ok");
  const sessionOpen = (hello as { sessionOpen?: unknown }).sessionOpen as {
    audience: string;
    challenge: { value: string };
  };
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "open-1",
    space,
    session: {},
    invocation: {
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
    authorization: { principal: SPONSOR },
  }));
  const opened = shiftMessage(messages) as ResponseMessage<{ sessionId: string }>;
  const sessionId = opened.ok!.sessionId;
  return { server, connection, messages, sessionId };
};

const watchSet = (
  harness: Harness,
  space: string,
  requestId: string,
  watches: unknown[],
) =>
  harness.connection.receive(encodeMemoryBoundary({
    type: "session.watch.set",
    requestId,
    space,
    sessionId: harness.sessionId,
    watches,
  }));

const transact = (
  harness: Harness,
  space: string,
  requestId: string,
  commit: unknown,
) =>
  harness.connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId,
    space,
    sessionId: harness.sessionId,
    commit,
  }));

// --- The "note index" closure: an index doc linking to N pure-leaf notes. ---
const NOTES = 8;
const WAVES = 8;
const IDX = "of:idx";
const noteId = (i: number) => `of:note:${i + 1}`;
const memberIds = [IDX, ...Array.from({ length: NOTES }, (_, i) => noteId(i))];

const linkTo = (space: string, id: string) => ({
  "/": { "link@1": { id, path: [] as [], space } },
});

// Recursive node schema: `children` is an array of nodes, so a schema-following
// graph watch traverses idx -> every note child.
const nodeSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    metadata: {
      type: "object",
      properties: { tag: { type: "string" } },
      required: ["tag"],
      additionalProperties: false,
    },
    children: { type: "array", items: { $ref: "#/$defs/node" } },
  },
  required: ["name", "metadata"],
  additionalProperties: false,
} as const;
const graphSchema = { ...nodeSchema, $defs: { node: nodeSchema } };

const noteContent = (i: number, rev: number) => ({
  name: `Note ${i} r${rev}`,
  metadata: { tag: `note-${i}` },
});
const idxContent = (space: string) => ({
  name: "Index",
  metadata: { tag: "index" },
  children: Array.from({ length: NOTES }, (_, i) => linkTo(space, noteId(i))),
});

// Seed the whole closure from a writer session (rev 0).
const seedClosure = async (writer: Harness, space: string) => {
  await transact(writer, space, "seed", {
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [
      { op: "set", id: IDX, value: { value: idxContent(space) } },
      ...Array.from({ length: NOTES }, (_, i) => ({
        op: "set" as const,
        id: noteId(i),
        value: { value: noteContent(i, 0) },
      })),
    ],
  });
  while (writer.messages.length > 0) shiftMessage(writer.messages);
};

// The full traversal profile for one server operation, plus a single
// "traversal steps" roll-up = every counter that represents work the refresh
// path pays (manager reads + schema/pointer/array/object/DAG node visits +
// getDocAtPath calls). The app-scale FA12 baseline is dominated by
// `dagTraversals` (94,098); at this harness scale the per-wave refresh is
// schema/pointer-dominated, so the roll-up is the scale-independent headline.
type TraversalBucket = {
  calls: number;
  managerReads: number;
  schemaTraversals: number;
  pointerTraversals: number;
  arrayTraversals: number;
  objectTraversals: number;
  dagTraversals: number;
  getDocAtPathCalls: number;
  traversalSteps: number;
};
const ZERO_BUCKET: TraversalBucket = {
  calls: 0,
  managerReads: 0,
  schemaTraversals: 0,
  pointerTraversals: 0,
  arrayTraversals: 0,
  objectTraversals: 0,
  dagTraversals: 0,
  getDocAtPathCalls: 0,
  traversalSteps: 0,
};
const readBucket = (server: Server, op: string): TraversalBucket => {
  const b = server.feedStats.traversalByOperation[op];
  if (b === undefined) return { ...ZERO_BUCKET };
  return {
    calls: b.calls,
    managerReads: b.managerReads,
    schemaTraversals: b.schemaTraversals,
    pointerTraversals: b.pointerTraversals,
    arrayTraversals: b.arrayTraversals,
    objectTraversals: b.objectTraversals,
    dagTraversals: b.dagTraversals,
    getDocAtPathCalls: b.getDocAtPathCalls,
    traversalSteps: b.managerReads + b.schemaTraversals + b.pointerTraversals +
      b.arrayTraversals + b.objectTraversals + b.dagTraversals +
      b.getDocAtPathCalls,
  };
};
const diffBucket = (
  after: TraversalBucket,
  before: TraversalBucket,
): TraversalBucket => ({
  calls: after.calls - before.calls,
  managerReads: after.managerReads - before.managerReads,
  schemaTraversals: after.schemaTraversals - before.schemaTraversals,
  pointerTraversals: after.pointerTraversals - before.pointerTraversals,
  arrayTraversals: after.arrayTraversals - before.arrayTraversals,
  objectTraversals: after.objectTraversals - before.objectTraversals,
  dagTraversals: after.dagTraversals - before.dagTraversals,
  getDocAtPathCalls: after.getDocAtPathCalls - before.getDocAtPathCalls,
  traversalSteps: after.traversalSteps - before.traversalSteps,
});

type Snapshot = {
  refresh: TraversalBucket;
  docsetRead: TraversalBucket;
  refreshRetirementEligibleSessions: number;
  refreshFullyDocSetSessions: number;
  refreshResidualGraphWatches: number;
  refreshResidualGraphWatchesTraversed: number;
  refreshResidualDagTraversalsBySpace: number;
  refreshGraphsRefreshed: number;
  docSetMemberDeliveries: number;
  refreshSessionsTouched: number;
};
const snapshot = (server: Server, space: string): Snapshot => ({
  refresh: readBucket(server, "session.watch.refresh"),
  docsetRead: readBucket(server, "session.docset.read"),
  refreshRetirementEligibleSessions:
    server.feedStats.refreshRetirementEligibleSessions,
  refreshFullyDocSetSessions: server.feedStats.refreshFullyDocSetSessions,
  refreshResidualGraphWatches: server.feedStats.refreshResidualGraphWatches,
  refreshResidualGraphWatchesTraversed:
    server.feedStats.refreshResidualGraphWatchesTraversed,
  refreshResidualDagTraversalsBySpace:
    server.feedStats.refreshResidualDagTraversalsBySpace[space] ?? 0,
  refreshGraphsRefreshed: server.feedStats.refreshGraphsRefreshed,
  docSetMemberDeliveries: server.feedStats.docSetMemberDeliveries,
  refreshSessionsTouched: server.feedStats.refreshSessionsTouched,
});

// Wave-scoped DELTA (after - before), isolating the note-create series from the
// one-time cold watch registration.
type LegReport = {
  leg: string;
  waves: number;
  membersInClosure: number;
  registrationRefresh: TraversalBucket; // one-time cold-walk cost
  waveRefresh: TraversalBucket; // the retired source, wave-scoped
  waveDocsetRead: TraversalBucket; // the replacing point reads, wave-scoped
  waveRetirementEligibleSessions: number;
  waveFullyDocSetSessions: number;
  waveResidualGraphWatches: number;
  waveResidualGraphWatchesTraversed: number;
  waveResidualDagTraversalsBySpace: number;
  waveGraphsRefreshed: number;
  waveDocSetMemberDeliveries: number;
  waveSessionsTouched: number;
};
const reportLeg = (
  leg: string,
  before: Snapshot,
  after: Snapshot,
): LegReport => ({
  leg,
  waves: WAVES,
  membersInClosure: NOTES + 1,
  registrationRefresh: before.refresh,
  waveRefresh: diffBucket(after.refresh, before.refresh),
  waveDocsetRead: diffBucket(after.docsetRead, before.docsetRead),
  waveRetirementEligibleSessions: after.refreshRetirementEligibleSessions -
    before.refreshRetirementEligibleSessions,
  waveFullyDocSetSessions: after.refreshFullyDocSetSessions -
    before.refreshFullyDocSetSessions,
  waveResidualGraphWatches: after.refreshResidualGraphWatches -
    before.refreshResidualGraphWatches,
  waveResidualGraphWatchesTraversed:
    after.refreshResidualGraphWatchesTraversed -
    before.refreshResidualGraphWatchesTraversed,
  waveResidualDagTraversalsBySpace: after.refreshResidualDagTraversalsBySpace -
    before.refreshResidualDagTraversalsBySpace,
  waveGraphsRefreshed: after.refreshGraphsRefreshed - before.refreshGraphsRefreshed,
  waveDocSetMemberDeliveries: after.docSetMemberDeliveries -
    before.docSetMemberDeliveries,
  waveSessionsTouched: after.refreshSessionsTouched - before.refreshSessionsTouched,
});

// Drive WAVES waves. Each wave updates note_i AND re-sets the index doc, so the
// graph legs re-walk idx -> children link structure every wave (the full
// re-traversal the app-scale baseline pays), delivering both docs.
const driveWaves = async (
  watcher: Harness,
  writer: Harness,
  server: Server,
  space: string,
) => {
  for (let w = 0; w < WAVES; w++) {
    const i = w % NOTES;
    await transact(writer, space, `wave-${w}`, {
      localSeq: 2 + w,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: noteId(i), value: { value: noteContent(i, w + 1) } },
        // Re-set the index (link topology unchanged) to force the graph
        // refresh to re-walk its child links each wave.
        { op: "set", id: IDX, value: { value: idxContent(space) } },
      ],
    });
    while (writer.messages.length > 0) shiftMessage(writer.messages);
    await server.flushSessions([space]);
    const effects = drainEffects(watcher.messages);
    const ids = effects.flatMap((e) => e.effect.upserts.map((u) => u.id));
    assert(
      ids.includes(noteId(i)),
      `wave ${w}: expected note ${noteId(i)} delivered, got ${
        JSON.stringify(ids)
      }`,
    );
  }
};

// A leg runs the whole note-create series once, under one watch profile, on a
// fresh server. Each leg opens/seeds/registers/drives/reports and cleans up —
// self-contained, so the orchestrating test carries no cross-test state.
const withLeg = async (
  space: string,
  store: string,
  dialOn: boolean,
  register: (watcher: Harness) => Promise<void>,
  legName: string,
): Promise<LegReport> => {
  const server = createServer(store);
  if (dialOn) setServerPrimaryExecutionGraphRetirementConfig([space]);
  const watcher = await openSession(server, space);
  const writer = await openSession(server, space);
  try {
    await seedClosure(writer, space);
    await register(watcher);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);
    const before = snapshot(server, space);
    await driveWaves(watcher, writer, server, space);
    const report = reportLeg(legName, before, snapshot(server, space));
    if (EMIT) console.log("RETIREMENT-DELTA-LEG", JSON.stringify(report));
    return report;
  } finally {
    await watcher.connection.close();
    await writer.connection.close();
    await server.close();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
};

const graphRoot = {
  id: "root",
  kind: "graph",
  query: { roots: [{ id: IDX, selector: { path: [], schema: graphSchema } }] },
};

// OFF (baseline / non-retired): a schema-following graph watch, dial off.
const runOffLeg = () =>
  withLeg(
    "did:key:z6Mk-feed-retire-delta-off",
    "memory://feed-retire-delta-off",
    false,
    (watcher) =>
      watchSet(watcher, "did:key:z6Mk-feed-retire-delta-off", "w", [graphRoot]),
    "OFF (graph, dial off)",
  );

// ON (retired / fully-doc-set): a docs watch naming the closure, dial on.
const runOnLeg = () =>
  withLeg(
    "did:key:z6Mk-feed-retire-delta-on",
    "memory://feed-retire-delta-on",
    true,
    (watcher) =>
      watchSet(watcher, "did:key:z6Mk-feed-retire-delta-on", "w", [
        { id: "docs", kind: "docs", docs: memberIds.map((id) => ({ id })) },
      ]),
    "ON (docs, dial on, fully-doc-set)",
  );

// MIXED (fails open): the ON docs watch PLUS one residual graph watch, dial on.
const runMixedLeg = () =>
  withLeg(
    "did:key:z6Mk-feed-retire-delta-mixed",
    "memory://feed-retire-delta-mixed",
    true,
    (watcher) =>
      watchSet(watcher, "did:key:z6Mk-feed-retire-delta-mixed", "w", [
        { id: "docs", kind: "docs", docs: memberIds.map((id) => ({ id })) },
        { ...graphRoot, id: "residual" },
      ]),
    "MIXED (docs + 1 residual graph, dial on)",
  );

// The F5 retirement delta: one deterministic, barrier-driven run of the same
// note-create series under three watch profiles, emitting the traversal deltas
// and asserting the direction the W2.9 wall-time gate rests on — the retired
// `session.watch.refresh` source drops to zero on a fully-doc-set surface,
// while a residual graph watch fails open and keeps traversing (counted).
Deno.test("F5 retirement delta: a fully-doc-set surface zeroes session.watch.refresh; a residual watch fails open", async () => {
  const off = await runOffLeg();
  const on = await runOnLeg();
  const mixed = await runMixedLeg();

  // --- OFF (baseline): pays real graph-refresh traversal every wave. ---
  assert(
    off.waveRefresh.traversalSteps > 0,
    `OFF session.watch.refresh must do traversal work (got ${off.waveRefresh.traversalSteps})`,
  );
  assertEquals(off.waveGraphsRefreshed, WAVES, "one graph refresh per wave");
  assertEquals(off.waveFullyDocSetSessions, 0, "no retirement OFF");
  assertEquals(off.waveRetirementEligibleSessions, 0);
  assertEquals(off.waveDocsetRead.calls, 0, "no point reads OFF");

  // --- ON (fully-doc-set): the retired source did ZERO traversal. ---
  assertEquals(
    on.waveRefresh.traversalSteps,
    0,
    "ON must do zero session.watch.refresh traversal (retired)",
  );
  assertEquals(on.waveGraphsRefreshed, 0, "no graph refresh ran ON");
  assertEquals(on.waveResidualGraphWatches, 0, "fully doc-set");
  assertEquals(on.waveResidualGraphWatchesTraversed, 0);
  assertEquals(on.waveResidualDagTraversalsBySpace, 0, "FB11 budget 0");
  assertEquals(on.waveFullyDocSetSessions, WAVES);
  assertEquals(
    on.waveFullyDocSetSessions,
    on.waveRetirementEligibleSessions,
    "every eligible wave was fully doc-set",
  );
  // What REPLACES the refresh: member point reads with zero graph traversal.
  assert(on.waveDocsetRead.calls > 0, "ON must record session.docset.read");
  assertEquals(
    on.waveDocsetRead.traversalSteps - on.waveDocsetRead.managerReads,
    0,
    "point reads do zero graph/schema/DAG traversal (only manager reads)",
  );
  assertEquals(on.waveDocsetRead.dagTraversals, 0);
  assertEquals(on.waveDocSetMemberDeliveries, 2 * WAVES, "note_i + idx per wave");

  // --- MIXED (fails open): the residual graph watch keeps traversing. ---
  assertEquals(mixed.waveRetirementEligibleSessions, WAVES);
  assertEquals(mixed.waveFullyDocSetSessions, 0, "not fully doc-set");
  assertEquals(mixed.waveResidualGraphWatches, WAVES, "1 residual/wave");
  assertEquals(mixed.waveResidualGraphWatchesTraversed, WAVES);
  assert(
    mixed.waveRefresh.traversalSteps > 0,
    "MIXED still pays session.watch.refresh traversal",
  );
  assertEquals(
    mixed.waveResidualDagTraversalsBySpace,
    mixed.waveRefresh.dagTraversals,
    "all refresh DAG this leg is residual (member reads never land here)",
  );

  const summary = {
    workload: { notesInClosure: NOTES + 1, updateWaves: WAVES },
    // The retired source: session.watch.refresh traversal work per config.
    sessionWatchRefresh: {
      OFF: {
        calls: off.waveRefresh.calls,
        traversalSteps: off.waveRefresh.traversalSteps,
        dagTraversals: off.waveRefresh.dagTraversals,
        schemaTraversals: off.waveRefresh.schemaTraversals,
        pointerTraversals: off.waveRefresh.pointerTraversals,
      },
      ON: {
        calls: on.waveRefresh.calls,
        traversalSteps: on.waveRefresh.traversalSteps,
        dagTraversals: on.waveRefresh.dagTraversals,
      },
      MIXED: {
        calls: mixed.waveRefresh.calls,
        traversalSteps: mixed.waveRefresh.traversalSteps,
        dagTraversals: mixed.waveRefresh.dagTraversals,
      },
    },
    perWave: {
      OFF_refreshTraversalSteps: off.waveRefresh.traversalSteps / WAVES,
      ON_refreshTraversalSteps: on.waveRefresh.traversalSteps / WAVES,
    },
    netReductionTraversalSteps: off.waveRefresh.traversalSteps -
      on.waveRefresh.traversalSteps,
    replacedBy: {
      // What retirement runs INSTEAD: member point reads, zero graph traversal.
      docSetMemberDeliveries: on.waveDocSetMemberDeliveries,
      pointReadCalls: on.waveDocsetRead.calls,
      pointReadManagerReads: on.waveDocsetRead.managerReads,
      pointReadDagTraversals: on.waveDocsetRead.dagTraversals,
      pointReadSchemaTraversals: on.waveDocsetRead.schemaTraversals,
    },
    residualBudgetPerWave: {
      OFF: "n/a (not dialed)",
      ON_fullyDocSet: on.waveResidualDagTraversalsBySpace / WAVES,
      MIXED: mixed.waveResidualDagTraversalsBySpace / WAVES,
    },
    fullyDocSetVsMixed: {
      ON_fullyDocSetWaves: on.waveFullyDocSetSessions,
      ON_residualWatches: on.waveResidualGraphWatches,
      MIXED_fullyDocSetWaves: mixed.waveFullyDocSetSessions,
      MIXED_residualWatchesHeld: mixed.waveResidualGraphWatches,
      MIXED_residualWatchesTraversed: mixed.waveResidualGraphWatchesTraversed,
    },
  };
  if (EMIT) console.log("RETIREMENT-DELTA-SUMMARY", JSON.stringify(summary));
  // The headline: retirement removes ALL of the baseline refresh traversal.
  assert(off.waveRefresh.traversalSteps > 0, "baseline paid refresh traversal");
  assertEquals(
    on.waveRefresh.traversalSteps,
    0,
    "retirement drops refresh traversal to zero",
  );
});
