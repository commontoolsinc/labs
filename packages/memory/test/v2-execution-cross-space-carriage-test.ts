// C3.1b — mirror/dirt protocol carriage (the C3A1 blocker's fix).
//
// Pins, over the in-process transport:
//  (a) mirror routing: a client observation with foreign-space reads
//      mirrors into the read space's engine VIA the transport — the
//      transcript carries `foreign-observation.mirror`, and the engine
//      rows land byte-identical to the pre-change direct-write shape
//      (PRE_CHANGE_ROWS below was captured by running the same scenario
//      against the pre-C3.1b tree, direct writes and all);
//  (b) dirt routing: the committing space's propagation lands
//      direct-dirty marks in the home engine via `foreign-dirty-mark`;
//  (c) the §4 parked-space obligation: dirt accumulates for a home space
//      with no live serve (not even opened this server lifetime — the
//      restart shape) and a later home session catches up by reading it;
//      the read host's own scheduler_action_state rows stay the durable
//      resync ledger and the per-link applied-dirt cursor advances
//      (C3.10b persists it);
//  (d) shadow-engine refusal: a crafted mirror/dirt message naming an
//      unhosted space drops with ZERO side effects (no engine, no
//      directory, no registration), `openHostedEngine` refuses an
//      unhosted name, and serving a brand-new space still works.
//
// Discrimination (verified during the C3.1b build, reverted): replacing
// the mirror send with the old direct `openEngine` write leaves every
// row assertion green and REDS the transcript assertions — the rows
// cannot see the C3A1 bypass, only the transcript can; disabling the
// `openHostedEngine` gate reds the refusal fixture in (d).
//
// NOTE on the row pin: PRE_CHANGE_ROWS asserts full scheduler-table
// dumps (all columns except created_at). An engine schema migration
// that adds a column will red this fixture — re-capture the expected
// shape deliberately when that happens; that is the pin working.
//
// Barrier-driven throughout: every await is a transact response or the
// server's own settle barrier — no sleeps.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  close as closeEngine,
  type Engine,
  open as openEngine,
  type SchedulerActionObservation,
} from "../v2/engine.ts";
import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
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
  type CrossSpaceMessage,
  CrossSpaceProtocolError,
  type ForeignDirtyMark,
  type ForeignObservationMirror,
  parseCrossSpaceMessage,
} from "../v2/cross-space.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const OWNER_SPACE = "did:key:xsp-carriage-owner";
const READ_SPACE = "did:key:xsp-carriage-read";
const OWNER_SESSION = "xsp-carriage-owner-session";
const READER_SESSION = "xsp-carriage-reader-session";

const sourceRead = {
  space: READ_SPACE,
  scope: "space" as const,
  id: "of:source",
  path: ["value", "count"],
};
const ownerWrite = {
  space: OWNER_SPACE,
  scope: "space" as const,
  id: "of:owner-output",
  path: ["value", "count"],
};

const observation = (
  reads: (typeof sourceRead)[],
): SchedulerActionObservation => ({
  version: 1,
  ownerSpace: OWNER_SPACE,
  branch: "",
  pieceId: "of:piece",
  processGeneration: 1,
  actionId: "pattern.tsx:computed:1",
  actionKind: "computation",
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:test",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads,
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [ownerWrite],
  declaredWrites: [],
  materializerWriteEnvelopes: [],
  status: "success",
});

const SCHEDULER_TABLES = [
  "scheduler_observation",
  "scheduler_action_snapshot",
  "scheduler_action_state",
  "scheduler_read_index",
  "scheduler_write_index",
  "scheduler_action_cause",
];

/** Full scheduler-table dump (every column except created_at), payloads
 * as their raw encoded strings — byte identity is the evidence. */
const dumpSchedulerTables = (
  engine: Engine,
): Record<string, Record<string, unknown>[]> => {
  const dump: Record<string, Record<string, unknown>[]> = {};
  for (const table of SCHEDULER_TABLES) {
    const columns = (engine.database.prepare(
      `PRAGMA table_info(${table})`,
    ).all() as { name: string }[])
      .map((column) => column.name)
      .filter((name) => name !== "created_at");
    dump[table] = engine.database.prepare(
      `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${
        columns.join(", ")
      }`,
    ).all() as Record<string, unknown>[];
  }
  return dump;
};

const dumpSpaceFromStore = async (
  store: URL,
  space: string,
): Promise<Record<string, Record<string, unknown>[]>> => {
  const engine = await openEngine({
    url: resolveSpaceStoreUrl(store, space as `did:${string}:${string}`),
  });
  try {
    return dumpSchedulerTables(engine);
  } finally {
    closeEngine(engine);
  }
};

/** Tap every frame crossing the server's in-process transport. The
 * loopback channel broadcasts to all onMessage handlers, so the tap
 * observes without disturbing the router's own dispatch. */
const tapCrossSpaceFrames = (server: Server): CrossSpaceMessage[] => {
  const frames: CrossSpaceMessage[] = [];
  server.crossSpaceRouter().transport.channelTo(OWNER_SPACE).onMessage(
    (wire) => {
      const parsed = parseCrossSpaceMessage(wire);
      if (parsed.ok) frames.push(parsed.message);
    },
  );
  return frames;
};

type ServerInternals = {
  settleCrossSpaceDeliveries(): Promise<void>;
  openHostedEngine(space: string): Promise<unknown>;
  crossSpaceAppliedDirtCursors: Map<string, number>;
};

// Captured from the pre-C3.1b tree (direct openEngine writes) by running
// exactly the scenario of the first test below; see the file header.
const PRE_CHANGE_ROWS: Record<
  string,
  Record<string, Record<string, unknown>[]>
> = {
  "afterMirror": {
    "scheduler_observation": [
      {
        "observation_id": 1,
        "branch": "",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "commit_seq": null,
        "observed_at_seq": 0,
        "session_id":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "local_seq": null,
        "piece_id": "of:piece",
        "action_id": "pattern.tsx:computed:1",
        "process_generation": 1,
        "payload":
          'fvj1:{"actionId":"pattern.tsx:computed:1","actionKind":"computation","actualChangedWrites":[],"branch":"","currentKnownWrites":[{"id":"of:owner-output","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-owner"}],"declaredWrites":[],"implementationFingerprint":"impl:v1","inputBasisSeq":0,"materializerWriteEnvelopes":[],"observedAtSeq":0,"ownerSpace":"did:key:xsp-carriage-owner","pieceId":"of:piece","processGeneration":1,"reads":[{"id":"of:source","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-read"}],"runtimeFingerprint":"runtime:test","shallowReads":[],"status":"success","transactionKind":"action-run","version":1}',
      },
    ],
    "scheduler_action_snapshot": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "observation_id": 1,
        "commit_seq": null,
        "observed_at_seq": 0,
        "payload":
          'fvj1:{"actionId":"pattern.tsx:computed:1","actionKind":"computation","actualChangedWrites":[],"branch":"","currentKnownWrites":[{"id":"of:owner-output","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-owner"}],"declaredWrites":[],"implementationFingerprint":"impl:v1","inputBasisSeq":0,"materializerWriteEnvelopes":[],"observedAtSeq":0,"ownerSpace":"did:key:xsp-carriage-owner","pieceId":"of:piece","processGeneration":1,"reads":[{"id":"of:source","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-read"}],"runtimeFingerprint":"runtime:test","shallowReads":[],"status":"success","transactionKind":"action-run","version":1}',
      },
    ],
    "scheduler_action_state": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "latest_observation_id": 1,
        "direct_dirty_seq": null,
        "stale_seq": null,
        "unknown_reason": null,
      },
    ],
    "scheduler_read_index": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "read_space": "did:key:xsp-carriage-read",
        "read_id": "of:source",
        "read_scope": "space",
        "read_scope_key": "space",
        "read_path": 'fvj1:["value","count"]',
        "read_kind": "recursive",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "observation_id": 1,
      },
    ],
    "scheduler_write_index": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "write_space": "did:key:xsp-carriage-owner",
        "write_id": "of:owner-output",
        "write_scope": "space",
        "write_scope_key": "space",
        "write_path": 'fvj1:["value","count"]',
        "write_kind": "current-known",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "observation_id": 1,
      },
    ],
    "scheduler_action_cause": [],
  },
  "homeAfterDirt": {
    "scheduler_observation": [
      {
        "observation_id": 1,
        "branch": "",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "commit_seq": null,
        "observed_at_seq": 0,
        "session_id":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "local_seq": null,
        "piece_id": "of:piece",
        "action_id": "pattern.tsx:computed:1",
        "process_generation": 1,
        "payload":
          'fvj1:{"actionId":"pattern.tsx:computed:1","actionKind":"computation","actualChangedWrites":[],"branch":"","currentKnownWrites":[{"id":"of:owner-output","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-owner"}],"declaredWrites":[],"implementationFingerprint":"impl:v1","inputBasisSeq":0,"materializerWriteEnvelopes":[],"observedAtSeq":0,"ownerSpace":"did:key:xsp-carriage-owner","pieceId":"of:piece","processGeneration":1,"reads":[{"id":"of:source","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-read"}],"runtimeFingerprint":"runtime:test","shallowReads":[],"status":"success","transactionKind":"action-run","version":1}',
      },
    ],
    "scheduler_action_snapshot": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "observation_id": 1,
        "commit_seq": 1,
        "observed_at_seq": 0,
        "payload":
          'fvj1:{"actionId":"pattern.tsx:computed:1","actionKind":"computation","actualChangedWrites":[],"branch":"","currentKnownWrites":[{"id":"of:owner-output","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-owner"}],"declaredWrites":[],"implementationFingerprint":"impl:v1","inputBasisSeq":0,"materializerWriteEnvelopes":[],"observedAtSeq":0,"ownerSpace":"did:key:xsp-carriage-owner","pieceId":"of:piece","processGeneration":1,"reads":[{"id":"of:source","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-read"}],"runtimeFingerprint":"runtime:test","shallowReads":[],"status":"success","transactionKind":"action-run","version":1}',
      },
    ],
    "scheduler_action_state": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "latest_observation_id": 1,
        "direct_dirty_seq": 1,
        "stale_seq": null,
        "unknown_reason": null,
      },
    ],
    "scheduler_read_index": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "read_space": "did:key:xsp-carriage-read",
        "read_id": "of:source",
        "read_scope": "space",
        "read_scope_key": "space",
        "read_path": 'fvj1:["value","count"]',
        "read_kind": "recursive",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "observation_id": 1,
      },
    ],
    "scheduler_write_index": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "write_space": "did:key:xsp-carriage-owner",
        "write_id": "of:owner-output",
        "write_scope": "space",
        "write_scope_key": "space",
        "write_path": 'fvj1:["value","count"]',
        "write_kind": "current-known",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "observation_id": 1,
      },
    ],
    "scheduler_action_cause": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "source_seq": 1,
      },
    ],
  },
  "readAfterDrop": {
    "scheduler_observation": [
      {
        "observation_id": 1,
        "branch": "",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "commit_seq": null,
        "observed_at_seq": 0,
        "session_id":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "local_seq": null,
        "piece_id": "of:piece",
        "action_id": "pattern.tsx:computed:1",
        "process_generation": 1,
        "payload":
          'fvj1:{"actionId":"pattern.tsx:computed:1","actionKind":"computation","actualChangedWrites":[],"branch":"","currentKnownWrites":[{"id":"of:owner-output","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-owner"}],"declaredWrites":[],"implementationFingerprint":"impl:v1","inputBasisSeq":0,"materializerWriteEnvelopes":[],"observedAtSeq":0,"ownerSpace":"did:key:xsp-carriage-owner","pieceId":"of:piece","processGeneration":1,"reads":[],"runtimeFingerprint":"runtime:test","shallowReads":[],"status":"success","transactionKind":"action-run","version":1}',
      },
    ],
    "scheduler_action_snapshot": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "observation_id": 1,
        "commit_seq": null,
        "observed_at_seq": 0,
        "payload":
          'fvj1:{"actionId":"pattern.tsx:computed:1","actionKind":"computation","actualChangedWrites":[],"branch":"","currentKnownWrites":[{"id":"of:owner-output","path":["value","count"],"scope":"space","space":"did:key:xsp-carriage-owner"}],"declaredWrites":[],"implementationFingerprint":"impl:v1","inputBasisSeq":0,"materializerWriteEnvelopes":[],"observedAtSeq":0,"ownerSpace":"did:key:xsp-carriage-owner","pieceId":"of:piece","processGeneration":1,"reads":[],"runtimeFingerprint":"runtime:test","shallowReads":[],"status":"success","transactionKind":"action-run","version":1}',
      },
    ],
    "scheduler_action_state": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "latest_observation_id": 1,
        "direct_dirty_seq": null,
        "stale_seq": null,
        "unknown_reason": null,
      },
    ],
    "scheduler_read_index": [],
    "scheduler_write_index": [
      {
        "branch": "",
        "owner_space": "did:key:xsp-carriage-owner",
        "write_space": "did:key:xsp-carriage-owner",
        "write_id": "of:owner-output",
        "write_scope": "space",
        "write_scope_key": "space",
        "write_path": 'fvj1:["value","count"]',
        "write_kind": "current-known",
        "piece_id": "of:piece",
        "process_generation": 1,
        "action_id": "pattern.tsx:computed:1",
        "execution_context_key":
          "session:did%3Akey%3Az6Mk-memory-v2-test-principal:xsp-carriage-owner-session",
        "observation_id": 1,
      },
    ],
    "scheduler_action_cause": [],
  },
};

Deno.test("C3.1b carriage: mirrors and dirt route via the transport with engine rows identical to the pre-change direct-write shape", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({ ...testSessionOpenServerOptions, store });
  const frames = tapCrossSpaceFrames(server);
  const client = await connect({ transport: loopback(server) });
  try {
    const owner = await client.mount(
      OWNER_SPACE,
      { sessionId: OWNER_SESSION },
      testSessionOpenAuthFactory,
    );
    const reader = await client.mount(
      READ_SPACE,
      { sessionId: READER_SESSION },
      testSessionOpenAuthFactory,
    );
    const ownerContextKey = sessionExecutionContextKey(
      TEST_SESSION_OPEN_PRINCIPAL,
      OWNER_SESSION,
    );

    // (a) Mirror: an owner observation reading the read space. The
    // transact response resolves only after the routed mirror applied
    // (the same-host application barrier), so the dump is settled.
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observation([sourceRead]),
    });
    assertEquals(
      await dumpSpaceFromStore(store, READ_SPACE),
      PRE_CHANGE_ROWS.afterMirror,
      "read-engine rows after the routed mirror must be identical to " +
        "the pre-change direct-write shape",
    );
    assertEquals(frames.length, 1, "exactly one frame: the mirror");
    const mirror = frames[0] as ForeignObservationMirror;
    assertEquals(mirror.type, "foreign-observation.mirror");
    assertEquals(mirror.fromSpace, OWNER_SPACE);
    assertEquals(mirror.toSpace, READ_SPACE);
    assertEquals(mirror.branch, "");
    // An operations-empty commit carries seq 0 — and so does the mirror.
    assertEquals(mirror.observedAtSeq, 0);
    assertEquals(mirror.originExecutionContextKey, ownerContextKey);
    assertEquals(mirror.scopeContext, {
      principal: TEST_SESSION_OPEN_PRINCIPAL,
      sessionId: OWNER_SESSION,
    });
    assertEquals(mirror.writerSessionId, ownerContextKey);
    // Envelope addressing is the contract: the payload's ownerSpace is
    // pinned to fromSpace (send-side stamp + codec rule).
    assertEquals(mirror.observation.ownerSpace, OWNER_SPACE);
    assertEquals(
      (mirror.observation.reads as { space: string }[]).map((r) => r.space),
      [READ_SPACE],
    );

    // (b) Dirt: a read-space commit hitting the mirrored read address
    // propagates a dirty mark to the home (owner) space via the
    // transport.
    await reader.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: sourceRead.id,
        scope: sourceRead.scope,
        value: { value: { count: 1 } },
      }],
    });
    assertEquals(
      await dumpSpaceFromStore(store, OWNER_SPACE),
      PRE_CHANGE_ROWS.homeAfterDirt,
      "home-engine rows after the routed dirt must be identical to the " +
        "pre-change direct-write shape",
    );
    assertEquals(frames.length, 2, "the dirty mark crossed the transport");
    const dirty = frames[1] as ForeignDirtyMark;
    assertEquals(dirty.type, "foreign-dirty-mark");
    assertEquals(dirty.fromSpace, READ_SPACE);
    assertEquals(dirty.toSpace, OWNER_SPACE);
    assertEquals(dirty.branch, "");
    assertEquals(dirty.dirtySeq, 1);
    assertEquals(dirty.readers, [{
      branch: "",
      pieceId: "of:piece",
      processGeneration: 1,
      actionId: "pattern.tsx:computed:1",
      executionContextKey: ownerContextKey,
    }]);

    // (a, drop path) Retraction: the same action re-observes WITHOUT the
    // foreign read. Mirrors are upsert-only — the retraction rides the
    // SAME message carrying the narrowed observation, and the read
    // engine's reconciliation deletes the stale index rows.
    await owner.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observation([]),
    });
    assertEquals(
      await dumpSpaceFromStore(store, READ_SPACE),
      PRE_CHANGE_ROWS.readAfterDrop,
      "read-engine rows after the routed retraction must be identical " +
        "to the pre-change direct-write shape",
    );
    assertEquals(
      frames.map((frame) => frame.type),
      [
        "foreign-observation.mirror",
        "foreign-dirty-mark",
        "foreign-observation.mirror",
      ],
      "the whole exchange crossed the transport, in order",
    );
    const retraction = frames[2] as ForeignObservationMirror;
    assertEquals(retraction.toSpace, READ_SPACE);
    assertEquals(retraction.observation.reads, []);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true }).catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.1b carriage: a parked home space accumulates routed dirt across a restart and catches up on its next session (§4)", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  try {
    // Lifetime 1: serve both spaces; the mirror lands in the read space.
    {
      const server = new Server({ ...testSessionOpenServerOptions, store });
      const client = await connect({ transport: loopback(server) });
      const owner = await client.mount(
        OWNER_SPACE,
        { sessionId: OWNER_SESSION },
        testSessionOpenAuthFactory,
      );
      await client.mount(
        READ_SPACE,
        { sessionId: READER_SESSION },
        testSessionOpenAuthFactory,
      );
      await owner.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observation([sourceRead]),
      });
      await client.close();
      await server.close();
    }

    // Lifetime 2: serve ONLY the read space. The home space is parked in
    // the strongest sense — no session, no engine opened this lifetime.
    const server = new Server({ ...testSessionOpenServerOptions, store });
    const frames = tapCrossSpaceFrames(server);
    const client = await connect({ transport: loopback(server) });
    try {
      const reader = await client.mount(
        READ_SPACE,
        { sessionId: READER_SESSION },
        testSessionOpenAuthFactory,
      );
      assert(
        !server.crossSpaceRouter().isHosted(OWNER_SPACE),
        "the parked home space is not registered before the dirt flows",
      );

      await reader.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sourceRead.id,
          scope: sourceRead.scope,
          value: { value: { count: 1 } },
        }],
      });

      // The dirt crossed the transport to the store-rehosted home space.
      assertEquals(
        frames.filter((frame) => frame.type === "foreign-dirty-mark").length,
        1,
      );
      assert(
        server.crossSpaceRouter().isHosted(OWNER_SPACE),
        "a store-materialized home space re-registers lazily (the " +
          "in-process stand-in for the peer host's own hosting)",
      );

      // Owed dirt is durably in the home engine while the space is
      // still parked (option (b): carriage is subscription-independent —
      // this IS the §4 obligation under the in-process transport).
      const homeDump = await dumpSpaceFromStore(store, OWNER_SPACE);
      assertEquals(
        homeDump.scheduler_action_state.map((row) => [
          row.owner_space,
          row.direct_dirty_seq,
        ]),
        [[OWNER_SPACE, 1]],
      );
      assertEquals(homeDump.scheduler_action_cause.length, 1);

      // The read host's own owner_space-keyed rows remain the durable
      // resync ledger C3.10b's reconnect pull reads…
      const readDump = await dumpSpaceFromStore(store, READ_SPACE);
      assertEquals(
        readDump.scheduler_action_state.map((row) => [
          row.owner_space,
          row.direct_dirty_seq,
        ]),
        [[OWNER_SPACE, 1]],
      );
      // …and the per-link applied-dirt cursor advanced (C3.10b persists
      // it; C3A12 keying by stable linkId).
      const internals = server as unknown as ServerInternals;
      assertEquals(
        [...internals.crossSpaceAppliedDirtCursors.values()],
        [1],
      );

      // Catch-up: the home space's next session reads the owed dirt.
      const owner = await client.mount(
        OWNER_SPACE,
        { sessionId: OWNER_SESSION },
        testSessionOpenAuthFactory,
      );
      const snapshots = await owner.listSchedulerActionSnapshots({
        pieceId: "of:piece",
        processGeneration: 1,
        actionId: "pattern.tsx:computed:1",
      });
      assertEquals(
        snapshots.snapshots.map((snapshot) => snapshot.directDirtySeq),
        [1],
        "the parked space caught up on subscribe",
      );
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  } finally {
    await Deno.remove(storePath, { recursive: true }).catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("C3.1b hosted-space gate: crafted mirror/dirt for an unhosted space mints nothing; openHostedEngine refuses; serving a new space still works", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({ ...testSessionOpenServerOptions, store });
  const client = await connect({ transport: loopback(server) });
  const EVIL_SPACE = "did:key:xsp-carriage-evil";
  const storedSpaces = async (): Promise<string[]> => {
    const entries: string[] = [];
    try {
      for await (
        const entry of Deno.readDir(resolveSpaceStoreDirUrl(store))
      ) {
        entries.push(entry.name);
      }
    } catch {
      // engine-v3/ not created yet
    }
    return entries.sort();
  };
  try {
    await client.mount(
      OWNER_SPACE,
      { sessionId: OWNER_SESSION },
      testSessionOpenAuthFactory,
    );
    const internals = server as unknown as ServerInternals;

    // Crafted frames addressed to a space this host does not host: the
    // router drops them (C3.1's zero-side-effect discipline) and no
    // engine, directory, or registration materializes.
    const link = server.crossSpaceRouter().link(OWNER_SPACE, EVIL_SPACE);
    link.send({
      type: "foreign-observation.mirror",
      branch: "",
      observedAtSeq: 1,
      originExecutionContextKey: "space",
      scopeContext: { principal: "did:key:mallory", sessionId: "m" },
      writerSessionId: "m",
      observation: {
        version: 1,
        branch: "",
        pieceId: "of:piece",
        processGeneration: 1,
        actionId: "a",
        actionKind: "computation",
        implementationFingerprint: "impl",
        runtimeFingerprint: "runtime",
        observedAtSeq: 0,
        transactionKind: "action-run",
        reads: [],
        shallowReads: [],
        actualChangedWrites: [],
        currentKnownWrites: [],
        declaredWrites: [],
        materializerWriteEnvelopes: [],
        status: "success",
      },
    });
    link.send({
      type: "foreign-dirty-mark",
      branch: "",
      dirtySeq: 1,
      readers: [{
        branch: "",
        pieceId: "of:piece",
        processGeneration: 1,
        actionId: "a",
        executionContextKey: "space",
      }],
    });
    await internals.settleCrossSpaceDeliveries();

    assert(!server.crossSpaceRouter().isHosted(EVIL_SPACE));
    assertEquals(server.crossSpaceRouter().hostedSpaces(), [OWNER_SPACE]);
    assertEquals(
      (await storedSpaces()).filter((name) => name.includes("evil")),
      [],
      "no shadow engine materialized in the store",
    );

    // The peer-write engine entry refuses an unhosted name outright.
    const refusal = await assertRejects(
      () => internals.openHostedEngine(EVIL_SPACE) as Promise<never>,
      CrossSpaceProtocolError,
    );
    assertEquals(refusal.code, "space-not-hosted");
    assertEquals(
      (await storedSpaces()).filter((name) => name.includes("evil")),
      [],
      "the refused open minted nothing either",
    );

    // Serving a brand-new space still works — the gate distinguishes
    // "serve this space" (creates + registers as hosted) from "peer
    // write into some space name" (refuses).
    const NEW_SPACE = "did:key:xsp-carriage-fresh";
    await server.writeDocument(NEW_SPACE, "of:doc", { hello: true });
    assert(server.crossSpaceRouter().isHosted(NEW_SPACE));
    assertEquals(
      (await storedSpaces()).some((name) => name.includes("fresh")),
      true,
      "serving a new space's first write still creates its engine",
    );
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true }).catch(() => {});
    resetPersistentSchedulerStateConfig();
  }
});
