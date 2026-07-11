import { assert, assertEquals, assertExists, assertMatch } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import { encodeMemoryBoundary } from "../v2.ts";
import {
  applyCommit,
  close,
  type Engine,
  getSchedulerActionState,
  listSchedulerActionSnapshots,
  markSchedulerReadersDirtyForWrites,
  open as openEngine,
  resolveScopeKey,
  type SchedulerActionObservation,
  type SchedulerExecutionContextKey,
  type SchedulerObservationAddress,
  schedulerObservationFromValue,
  type SchedulerScopeContext,
  upsertSchedulerObservation,
} from "../v2/engine.ts";

const OWNER_SPACE = "did:key:scheduler-context-owner";
const OTHER_SPACE = "did:key:scheduler-context-other";
const PIECE_ID = "space:piece";

const ALICE_A = {
  principal: "did:key:alice",
  sessionId: "alice-session-a",
} as const satisfies SchedulerScopeContext;
const ALICE_B = {
  principal: "did:key:alice",
  sessionId: "alice-session-b",
} as const satisfies SchedulerScopeContext;
const BOB = {
  principal: "did:key:bob",
  sessionId: "bob-session",
} as const satisfies SchedulerScopeContext;

const contextKey = (
  scope: "space" | "user" | "session",
  context: SchedulerScopeContext,
): SchedulerExecutionContextKey =>
  resolveScopeKey(scope, context) as SchedulerExecutionContextKey;

const SPACE_KEY = contextKey("space", ALICE_A);
const ALICE_USER_KEY = contextKey("user", ALICE_A);
const BOB_USER_KEY = contextKey("user", BOB);
const ALICE_A_SESSION_KEY = contextKey("session", ALICE_A);
const ALICE_B_SESSION_KEY = contextKey("session", ALICE_B);
const BOB_SESSION_KEY = contextKey("session", BOB);

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  return { engine: await openEngine({ url: toFileUrl(path) }), path };
};

const schedulerAddress = (
  id: string,
  scope: "space" | "user" | "session",
  space = OWNER_SPACE,
): SchedulerObservationAddress => ({
  space,
  id,
  scope,
  path: ["value"],
});

type ObservationOptions = {
  actionId: string;
  summaryScope?: "space" | "user" | "session";
  runtimeScope?: "space" | "user" | "session";
  runtimeSpace?: string;
  includeSummary?: boolean;
  implementationFingerprint?: string;
  runtimeFingerprint?: string;
};

const observationFor = (
  options: ObservationOptions,
): SchedulerActionObservation => {
  const summaryScope = options.summaryScope ?? "space";
  const runtimeScope = options.runtimeScope ?? summaryScope;
  const runtimeSpace = options.runtimeSpace ?? OWNER_SPACE;
  const implementationFingerprint = options.implementationFingerprint ??
    `impl:${options.actionId}`;
  const runtimeFingerprint = options.runtimeFingerprint ?? "runtime:v1";
  const summaryRead = schedulerAddress("input", summaryScope);
  const summaryWrite = schedulerAddress("output", summaryScope);
  const runtimeRead = schedulerAddress("input", runtimeScope, runtimeSpace);
  const runtimeWrite = schedulerAddress("output", runtimeScope, runtimeSpace);

  return {
    version: 2,
    ownerSpace: OWNER_SPACE,
    branch: "",
    pieceId: PIECE_ID,
    processGeneration: 1,
    actionId: options.actionId,
    actionKind: "computation",
    implementationFingerprint,
    runtimeFingerprint,
    ...((options.includeSummary ?? true)
      ? {
        completeActionScopeSummary: {
          version: 1,
          complete: true,
          implementationFingerprint,
          runtimeFingerprint,
          piece: {
            space: OWNER_SPACE,
            id: "piece",
            scope: "space",
            path: [],
          },
          reads: [summaryRead],
          writes: [summaryWrite],
          materializerWriteEnvelopes: [],
          directOutputs: [summaryWrite],
        },
      }
      : {}),
    observedAtSeq: 0,
    transactionKind: "action-run",
    reads: [runtimeRead],
    shallowReads: [],
    actualChangedWrites: [],
    currentKnownWrites: [runtimeWrite],
    materializerWriteEnvelopes: [],
    ignoredSchedulingWrites: [],
    actionOptions: {},
    status: "success",
  };
};

const storeObservation = (
  engine: Engine,
  observation: SchedulerActionObservation,
  scopeContext: SchedulerScopeContext,
) =>
  upsertSchedulerObservation(engine, {
    ownerSpace: OWNER_SPACE,
    observedAtSeq: 0,
    observation,
    scopeContext,
  });

const contextsForAction = (
  engine: Engine,
  table: string,
  actionId: string,
): SchedulerExecutionContextKey[] =>
  (engine.database.prepare(`
    SELECT DISTINCT execution_context_key
    FROM ${table}
    WHERE action_id = :action_id
    ORDER BY execution_context_key
  `).all({ action_id: actionId }) as Array<{
    execution_context_key: SchedulerExecutionContextKey;
  }>).map((row) => row.execution_context_key);

const assertOwnedContexts = (
  engine: Engine,
  actionId: string,
  expected: SchedulerExecutionContextKey[],
): void => {
  const sorted = expected.toSorted();
  for (
    const table of [
      "scheduler_action_snapshot",
      "scheduler_action_state",
      "scheduler_read_index",
      "scheduler_write_index",
    ]
  ) {
    assertEquals(contextsForAction(engine, table, actionId), sorted, table);
  }
};

const withEngine = async (
  run: (engine: Engine) => void | Promise<void>,
): Promise<void> => {
  const { engine, path } = await createEngine();
  try {
    await run(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

// The scheduler tables immediately before execution-context qualification.
// Keeping this fixture local makes the migration test independent of git
// history and exercises the actual open-time upgrade path.
const LEGACY_SCHEDULER_SCHEMA = `
  CREATE TABLE scheduler_observation (
    observation_id      INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    branch              TEXT    NOT NULL DEFAULT '',
    commit_seq          INTEGER,
    observed_at_seq     INTEGER NOT NULL,
    session_id          TEXT,
    local_seq           INTEGER,
    piece_id            TEXT    NOT NULL,
    action_id           TEXT    NOT NULL,
    process_generation  INTEGER NOT NULL,
    payload             JSON    NOT NULL,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE scheduler_action_snapshot (
    branch              TEXT    NOT NULL DEFAULT '',
    owner_space         TEXT    NOT NULL DEFAULT '',
    piece_id            TEXT    NOT NULL,
    process_generation  INTEGER NOT NULL,
    action_id           TEXT    NOT NULL,
    observation_id      INTEGER NOT NULL,
    commit_seq          INTEGER,
    observed_at_seq     INTEGER NOT NULL,
    payload             JSON    NOT NULL,
    PRIMARY KEY (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id
    )
  );
  CREATE TABLE scheduler_observation_replay (
    branch              TEXT    NOT NULL DEFAULT '',
    session_id          TEXT    NOT NULL,
    local_seq           INTEGER NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'kept',
    reason              TEXT,
    observation_id      INTEGER,
    observed_at_seq     INTEGER NOT NULL,
    payload             JSON    NOT NULL,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (branch, session_id, local_seq)
  );
  CREATE TABLE scheduler_read_index (
    branch              TEXT    NOT NULL DEFAULT '',
    owner_space         TEXT,
    read_space          TEXT    NOT NULL,
    read_id             TEXT    NOT NULL,
    read_scope          TEXT    NOT NULL,
    read_path           JSON    NOT NULL,
    read_kind           TEXT    NOT NULL,
    piece_id            TEXT    NOT NULL,
    process_generation  INTEGER NOT NULL,
    action_id           TEXT    NOT NULL,
    observation_id      INTEGER NOT NULL
  );
  CREATE TABLE scheduler_write_index (
    branch              TEXT    NOT NULL DEFAULT '',
    owner_space         TEXT    NOT NULL DEFAULT '',
    write_space         TEXT    NOT NULL,
    write_id            TEXT    NOT NULL,
    write_scope         TEXT    NOT NULL,
    write_path          JSON    NOT NULL,
    write_kind          TEXT    NOT NULL,
    piece_id            TEXT    NOT NULL,
    process_generation  INTEGER NOT NULL,
    action_id           TEXT    NOT NULL,
    observation_id      INTEGER NOT NULL
  );
  CREATE TABLE scheduler_action_state (
    branch                 TEXT    NOT NULL DEFAULT '',
    owner_space            TEXT    NOT NULL DEFAULT '',
    piece_id               TEXT    NOT NULL,
    process_generation     INTEGER NOT NULL,
    action_id               TEXT    NOT NULL,
    latest_observation_id  INTEGER,
    direct_dirty_seq       INTEGER,
    stale_seq              INTEGER,
    unknown_reason         TEXT,
    PRIMARY KEY (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id
    )
  );
`;

const insertLegacyActiveSchedulerRow = (
  database: Database,
  options: {
    observationId: number;
    actionId: string;
    payload: string;
    dirtySeq: number;
  },
): void => {
  database.prepare(`
    INSERT INTO scheduler_observation (
      observation_id,
      branch,
      observed_at_seq,
      piece_id,
      action_id,
      process_generation,
      payload
    ) VALUES (
      :observation_id,
      '',
      0,
      :piece_id,
      :action_id,
      1,
      :payload
    )
  `).run({
    observation_id: options.observationId,
    piece_id: PIECE_ID,
    action_id: options.actionId,
    payload: options.payload,
  });
  database.prepare(`
    INSERT INTO scheduler_action_snapshot (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      observation_id,
      observed_at_seq,
      payload
    ) VALUES (
      '',
      :owner_space,
      :piece_id,
      1,
      :action_id,
      :observation_id,
      0,
      :payload
    )
  `).run({
    owner_space: OWNER_SPACE,
    piece_id: PIECE_ID,
    action_id: options.actionId,
    observation_id: options.observationId,
    payload: options.payload,
  });
  database.prepare(`
    INSERT INTO scheduler_action_state (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      latest_observation_id,
      direct_dirty_seq
    ) VALUES (
      '',
      :owner_space,
      :piece_id,
      1,
      :action_id,
      :observation_id,
      :dirty_seq
    )
  `).run({
    owner_space: OWNER_SPACE,
    piece_id: PIECE_ID,
    action_id: options.actionId,
    observation_id: options.observationId,
    dirty_seq: options.dirtySeq,
  });
};

const insertLegacySnapshotAndState = (
  database: Database,
  options: {
    observationId: number;
    actionId: string;
    payload: string;
    dirtySeq: number;
  },
): void => {
  database.prepare(`
    INSERT INTO scheduler_action_snapshot (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      observation_id,
      observed_at_seq,
      payload
    ) VALUES (
      '',
      :owner_space,
      :piece_id,
      1,
      :action_id,
      :observation_id,
      0,
      :payload
    )
  `).run({
    owner_space: OWNER_SPACE,
    piece_id: PIECE_ID,
    action_id: options.actionId,
    observation_id: options.observationId,
    payload: options.payload,
  });
  database.prepare(`
    INSERT INTO scheduler_action_state (
      branch,
      owner_space,
      piece_id,
      process_generation,
      action_id,
      latest_observation_id,
      direct_dirty_seq
    ) VALUES (
      '',
      :owner_space,
      :piece_id,
      1,
      :action_id,
      :observation_id,
      :dirty_seq
    )
  `).run({
    owner_space: OWNER_SPACE,
    piece_id: PIECE_ID,
    action_id: options.actionId,
    observation_id: options.observationId,
    dirty_seq: options.dirtySeq,
  });
};

Deno.test("scheduler context keeps two PerSession rows for one principal", async () => {
  await withEngine((engine) => {
    const actionId = "context:two-alice-sessions";
    const observation = observationFor({
      actionId,
      summaryScope: "session",
    });

    assertEquals(
      storeObservation(engine, observation, ALICE_A).executionContextKey,
      ALICE_A_SESSION_KEY,
    );
    assertEquals(
      storeObservation(engine, observation, ALICE_B).executionContextKey,
      ALICE_B_SESSION_KEY,
    );
    assertOwnedContexts(engine, actionId, [
      ALICE_A_SESSION_KEY,
      ALICE_B_SESSION_KEY,
    ]);

    const readScopeKeys = engine.database.prepare(`
      SELECT read_scope_key
      FROM scheduler_read_index
      WHERE action_id = :action_id
      ORDER BY read_scope_key
    `).all({ action_id: actionId });
    assertEquals(readScopeKeys, [
      { read_scope_key: ALICE_A_SESSION_KEY },
      { read_scope_key: ALICE_B_SESSION_KEY },
    ]);
    const writeScopeKeys = engine.database.prepare(`
      SELECT write_scope_key
      FROM scheduler_write_index
      WHERE action_id = :action_id
      ORDER BY write_scope_key
    `).all({ action_id: actionId });
    assertEquals(writeScopeKeys, [
      { write_scope_key: ALICE_A_SESSION_KEY },
      { write_scope_key: ALICE_B_SESSION_KEY },
    ]);
  });
});

Deno.test("scheduler context listing returns shared, own-user, and exact-session rows", async () => {
  await withEngine((engine) => {
    const shared = observationFor({ actionId: "context:list:space" });
    const perUser = observationFor({
      actionId: "context:list:user",
      summaryScope: "user",
    });
    const perSession = observationFor({
      actionId: "context:list:session",
      summaryScope: "session",
    });

    storeObservation(engine, shared, ALICE_A);
    storeObservation(engine, perUser, ALICE_A);
    storeObservation(engine, perUser, ALICE_B);
    storeObservation(engine, perUser, BOB);
    storeObservation(engine, perSession, ALICE_A);
    storeObservation(engine, perSession, ALICE_B);
    storeObservation(engine, perSession, BOB);

    const applicable = listSchedulerActionSnapshots(engine, {
      applicableExecutionContextKeys: [
        SPACE_KEY,
        ALICE_USER_KEY,
        ALICE_A_SESSION_KEY,
      ],
    }).snapshots;
    assertEquals(
      applicable.map((snapshot) => [
        snapshot.observation.actionId,
        snapshot.executionContextKey,
      ]),
      [
        ["context:list:session", ALICE_A_SESSION_KEY],
        ["context:list:space", SPACE_KEY],
        ["context:list:user", ALICE_USER_KEY],
      ],
    );
    assert(
      applicable.every((snapshot) =>
        snapshot.executionContextKey !== BOB_USER_KEY &&
        snapshot.executionContextKey !== BOB_SESSION_KEY &&
        snapshot.executionContextKey !== ALICE_B_SESSION_KEY
      ),
    );
  });
});

Deno.test("scheduler context shares only certified implementation observations", async () => {
  await withEngine((engine) => {
    const provenAction = "context:proven-space";
    const observedAction = "context:observed-space";
    const fallbackAction = "context:fallback-fingerprint";
    const proven = observationFor({ actionId: provenAction });
    const observedOnly = observationFor({
      actionId: observedAction,
      includeSummary: false,
    });
    const fallback = observationFor({
      actionId: fallbackAction,
      implementationFingerprint: "action:fallback",
    });

    storeObservation(engine, proven, ALICE_A);
    storeObservation(engine, proven, BOB);
    storeObservation(engine, observedOnly, ALICE_A);
    storeObservation(engine, observedOnly, BOB);
    const fallbackResult = storeObservation(engine, fallback, ALICE_A);

    assertOwnedContexts(engine, provenAction, [SPACE_KEY]);
    assertOwnedContexts(engine, observedAction, [
      ALICE_A_SESSION_KEY,
      BOB_SESSION_KEY,
    ]);
    assertEquals(fallbackResult.executionContextKey, ALICE_A_SESSION_KEY);
  });
});

Deno.test("scheduler context accepts writes covered by a certified materializer envelope", async () => {
  await withEngine((engine) => {
    const actionId = "context:certified-materializer";
    const base = observationFor({ actionId });
    const envelope = schedulerAddress("materialized", "space");
    const materializerObservation: SchedulerActionObservation = {
      ...base,
      completeActionScopeSummary: {
        ...base.completeActionScopeSummary!,
        writes: [],
        directOutputs: [],
        materializerWriteEnvelopes: [envelope],
      },
      currentKnownWrites: [{ ...envelope, path: ["value", "child"] }],
      materializerWriteEnvelopes: [envelope],
    };

    const result = storeObservation(engine, materializerObservation, ALICE_A);
    assertEquals(result.executionContextKey, SPACE_KEY);
    assertOwnedContexts(engine, actionId, [SPACE_KEY]);
  });
});

Deno.test("scheduler context isolates effective-scope dirtying and clearing", async () => {
  await withEngine((engine) => {
    const userAction = "context:dirty:user";
    const userObservation = observationFor({
      actionId: userAction,
      summaryScope: "user",
    });
    storeObservation(engine, userObservation, ALICE_A);
    storeObservation(engine, userObservation, BOB);

    const userRead = userObservation.reads[0];
    const aliceWrite = applyCommit(engine, {
      space: OWNER_SPACE,
      principal: ALICE_A.principal,
      sessionId: ALICE_A.sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: userRead.id,
          scope: "user",
          value: { value: 1 },
        }],
      },
    });
    assertEquals(
      aliceWrite.schedulerDirtiedReaders?.map((entry) =>
        entry.executionContextKey
      ),
      [ALICE_USER_KEY],
    );
    assertEquals(
      getSchedulerActionState(engine, {
        ownerSpace: OWNER_SPACE,
        pieceId: PIECE_ID,
        processGeneration: 1,
        actionId: userAction,
        executionContextKey: ALICE_USER_KEY,
      })?.directDirtySeq,
      aliceWrite.seq,
    );
    assertEquals(
      getSchedulerActionState(engine, {
        ownerSpace: OWNER_SPACE,
        pieceId: PIECE_ID,
        processGeneration: 1,
        actionId: userAction,
        executionContextKey: BOB_USER_KEY,
      })?.directDirtySeq,
      null,
    );

    markSchedulerReadersDirtyForWrites(engine, {
      dirtySeq: 11,
      writes: [{ ...userRead, scopeKey: BOB_USER_KEY }],
    });
    // Re-running Alice clears only Alice's qualified action-state row.
    storeObservation(engine, userObservation, ALICE_A);
    assertEquals(
      getSchedulerActionState(engine, {
        ownerSpace: OWNER_SPACE,
        pieceId: PIECE_ID,
        processGeneration: 1,
        actionId: userAction,
        executionContextKey: ALICE_USER_KEY,
      })?.directDirtySeq,
      null,
    );
    assertEquals(
      getSchedulerActionState(engine, {
        ownerSpace: OWNER_SPACE,
        pieceId: PIECE_ID,
        processGeneration: 1,
        actionId: userAction,
        executionContextKey: BOB_USER_KEY,
      })?.directDirtySeq,
      11,
    );

    const sessionAction = "context:dirty:session";
    const sessionObservation = observationFor({
      actionId: sessionAction,
      summaryScope: "session",
    });
    storeObservation(engine, sessionObservation, ALICE_A);
    storeObservation(engine, sessionObservation, ALICE_B);
    const sessionWrite = applyCommit(engine, {
      space: OWNER_SPACE,
      principal: ALICE_A.principal,
      sessionId: ALICE_A.sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sessionObservation.reads[0].id,
          scope: "session",
          value: { value: 1 },
        }],
      },
    });
    assertEquals(
      sessionWrite.schedulerDirtiedReaders?.map((entry) =>
        entry.executionContextKey
      ),
      [ALICE_A_SESSION_KEY],
    );
    assertEquals(
      getSchedulerActionState(engine, {
        ownerSpace: OWNER_SPACE,
        pieceId: PIECE_ID,
        processGeneration: 1,
        actionId: sessionAction,
        executionContextKey: ALICE_B_SESSION_KEY,
      })?.directDirtySeq,
      null,
    );
  });
});

Deno.test("scheduler context narrows monotonically without deleting Bob", async () => {
  await withEngine((engine) => {
    const spaceToUserAction = "context:narrow:space-user";
    const spaceProof = observationFor({ actionId: spaceToUserAction });
    storeObservation(engine, spaceProof, ALICE_A);
    const spaceToUser = storeObservation(
      engine,
      observationFor({
        actionId: spaceToUserAction,
        summaryScope: "user",
      }),
      ALICE_A,
    );
    assertEquals(spaceToUser.executionContextKey, ALICE_USER_KEY);
    assertEquals(spaceToUser.invalidatedExecutionContextKeys, [SPACE_KEY]);
    assertOwnedContexts(engine, spaceToUserAction, [ALICE_USER_KEY]);
    storeObservation(
      engine,
      observationFor({
        actionId: spaceToUserAction,
        summaryScope: "user",
      }),
      BOB,
    );
    assertOwnedContexts(engine, spaceToUserAction, [
      ALICE_USER_KEY,
      BOB_USER_KEY,
    ]);

    const spaceToSessionAction = "context:narrow:space-session";
    storeObservation(
      engine,
      observationFor({ actionId: spaceToSessionAction }),
      ALICE_A,
    );
    const spaceToSession = storeObservation(
      engine,
      observationFor({
        actionId: spaceToSessionAction,
        summaryScope: "session",
      }),
      ALICE_A,
    );
    assertEquals(spaceToSession.executionContextKey, ALICE_A_SESSION_KEY);
    assertEquals(spaceToSession.invalidatedExecutionContextKeys, [SPACE_KEY]);
    assertOwnedContexts(engine, spaceToSessionAction, [ALICE_A_SESSION_KEY]);

    const userToSessionAction = "context:narrow:user-session";
    const userProof = observationFor({
      actionId: userToSessionAction,
      summaryScope: "user",
    });
    storeObservation(engine, userProof, ALICE_A);
    storeObservation(engine, userProof, BOB);
    const userToSession = storeObservation(
      engine,
      observationFor({
        actionId: userToSessionAction,
        summaryScope: "user",
        runtimeScope: "session",
      }),
      ALICE_A,
    );
    assertEquals(userToSession.executionContextKey, ALICE_A_SESSION_KEY);
    assertEquals(userToSession.invalidatedExecutionContextKeys, [
      ALICE_USER_KEY,
    ]);
    assertOwnedContexts(engine, userToSessionAction, [
      BOB_USER_KEY,
      ALICE_A_SESSION_KEY,
    ]);

    // A later no-op that again looks PerUser cannot broaden Alice's durable
    // floor for the same implementation/runtime fingerprint.
    const noBroadening = storeObservation(engine, userProof, ALICE_A);
    assertEquals(noBroadening.executionContextKey, ALICE_A_SESSION_KEY);
    assertOwnedContexts(engine, userToSessionAction, [
      BOB_USER_KEY,
      ALICE_A_SESSION_KEY,
    ]);

    const crossSpaceAction = "context:narrow:cross-space";
    const crossSpaceProof = observationFor({
      actionId: crossSpaceAction,
      summaryScope: "user",
    });
    storeObservation(engine, crossSpaceProof, ALICE_A);
    storeObservation(engine, crossSpaceProof, BOB);
    const crossSpace = storeObservation(
      engine,
      observationFor({
        actionId: crossSpaceAction,
        summaryScope: "user",
        runtimeScope: "user",
        runtimeSpace: OTHER_SPACE,
      }),
      ALICE_A,
    );
    assertEquals(crossSpace.executionContextKey, ALICE_A_SESSION_KEY);
    assertEquals(crossSpace.invalidatedExecutionContextKeys, [
      ALICE_USER_KEY,
    ]);
    assertOwnedContexts(engine, crossSpaceAction, [
      BOB_USER_KEY,
      ALICE_A_SESSION_KEY,
    ]);
  });
});

Deno.test("scheduler context pagination advances through tied action keys", async () => {
  await withEngine((engine) => {
    const actionId = "context:pagination:tied";
    const observedOnly = observationFor({ actionId, includeSummary: false });
    for (const context of [ALICE_A, ALICE_B, BOB]) {
      storeObservation(engine, observedOnly, context);
    }

    const expected = [
      ALICE_A_SESSION_KEY,
      ALICE_B_SESSION_KEY,
      BOB_SESSION_KEY,
    ].toSorted();
    const actual: SchedulerExecutionContextKey[] = [];
    let cursor: ReturnType<typeof listSchedulerActionSnapshots>["nextCursor"];
    do {
      const page = listSchedulerActionSnapshots(engine, {
        ownerSpace: OWNER_SPACE,
        pieceId: PIECE_ID,
        processGeneration: 1,
        actionId,
        applicableExecutionContextKeys: expected,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      assertEquals(page.snapshots.length, 1);
      actual.push(page.snapshots[0].executionContextKey);
      cursor = page.nextCursor;
      if (cursor) {
        assertEquals(cursor.executionContextKey, actual.at(-1));
      }
    } while (cursor);

    assertEquals(actual, expected);
  });
});

Deno.test("scheduler context migration preserves only provable space state and is idempotent", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const legacy = new Database(path, { create: true });
  const spaceAction = "context:migration:space";
  const userAction = "context:migration:user";
  const malformedAction = "context:migration:malformed";
  const payloadMismatchAction = "context:migration:payload-mismatch";
  const identityMismatchAction = "context:migration:identity-mismatch";
  const orphanSnapshotAction = "context:migration:orphan-snapshot";
  const orphanStateAction = "context:migration:orphan-state";
  const staleStateAction = "context:migration:stale-state";
  const ambiguousActionA = "context:migration:ambiguous-a";
  const ambiguousActionB = "context:migration:ambiguous-b";
  try {
    legacy.exec(LEGACY_SCHEDULER_SCHEMA);
    insertLegacyActiveSchedulerRow(legacy, {
      observationId: 1,
      actionId: spaceAction,
      payload: encodeMemoryBoundary(
        observationFor({ actionId: spaceAction }) as never,
      ),
      dirtySeq: 7,
    });
    insertLegacyActiveSchedulerRow(legacy, {
      observationId: 2,
      actionId: userAction,
      payload: encodeMemoryBoundary(
        observationFor({
          actionId: userAction,
          summaryScope: "user",
        }) as never,
      ),
      dirtySeq: 8,
    });
    insertLegacyActiveSchedulerRow(legacy, {
      observationId: 3,
      actionId: malformedAction,
      payload: encodeMemoryBoundary({
        version: 2,
        actionId: malformedAction,
      }),
      dirtySeq: 9,
    });
    insertLegacyActiveSchedulerRow(legacy, {
      observationId: 4,
      actionId: payloadMismatchAction,
      payload: encodeMemoryBoundary(
        observationFor({ actionId: payloadMismatchAction }) as never,
      ),
      dirtySeq: 10,
    });
    legacy.prepare(`
      UPDATE scheduler_observation
      SET payload = :payload
      WHERE observation_id = 4
    `).run({
      payload: encodeMemoryBoundary({
        ...observationFor({ actionId: payloadMismatchAction }),
        status: "failed",
        errorFingerprint: "different-payload",
      } as never),
    });
    insertLegacyActiveSchedulerRow(legacy, {
      observationId: 5,
      actionId: identityMismatchAction,
      payload: encodeMemoryBoundary(
        observationFor({ actionId: identityMismatchAction }) as never,
      ),
      dirtySeq: 11,
    });
    legacy.prepare(`
      UPDATE scheduler_observation
      SET action_id = :action_id
      WHERE observation_id = 5
    `).run({ action_id: `${identityMismatchAction}:other` });
    insertLegacyActiveSchedulerRow(legacy, {
      observationId: 6,
      actionId: orphanSnapshotAction,
      payload: encodeMemoryBoundary(
        observationFor({ actionId: orphanSnapshotAction }) as never,
      ),
      dirtySeq: 12,
    });
    legacy.prepare(`
      DELETE FROM scheduler_action_state
      WHERE action_id = :action_id
    `).run({ action_id: orphanSnapshotAction });
    insertLegacyActiveSchedulerRow(legacy, {
      observationId: 7,
      actionId: orphanStateAction,
      payload: encodeMemoryBoundary(
        observationFor({ actionId: orphanStateAction }) as never,
      ),
      dirtySeq: 13,
    });
    legacy.prepare(`
      DELETE FROM scheduler_action_snapshot
      WHERE action_id = :action_id
    `).run({ action_id: orphanStateAction });
    insertLegacyActiveSchedulerRow(legacy, {
      observationId: 8,
      actionId: staleStateAction,
      payload: encodeMemoryBoundary(
        observationFor({ actionId: staleStateAction }) as never,
      ),
      dirtySeq: 14,
    });
    legacy.prepare(`
      UPDATE scheduler_action_state
      SET latest_observation_id = 999
      WHERE action_id = :action_id
    `).run({ action_id: staleStateAction });
    insertLegacyActiveSchedulerRow(legacy, {
      observationId: 9,
      actionId: ambiguousActionA,
      payload: encodeMemoryBoundary(
        observationFor({ actionId: ambiguousActionA }) as never,
      ),
      dirtySeq: 15,
    });
    insertLegacySnapshotAndState(legacy, {
      observationId: 9,
      actionId: ambiguousActionB,
      payload: encodeMemoryBoundary(
        observationFor({ actionId: ambiguousActionB }) as never,
      ),
      dirtySeq: 16,
    });
  } finally {
    legacy.close();
  }

  const assertMigrated = (engine: Engine): void => {
    const snapshots = listSchedulerActionSnapshots(engine).snapshots;
    assertEquals(
      snapshots.map((snapshot) => [
        snapshot.observation.actionId,
        snapshot.executionContextKey,
        snapshot.directDirtySeq,
      ]),
      [[spaceAction, SPACE_KEY, 7]],
    );
    assertOwnedContexts(engine, spaceAction, [SPACE_KEY]);
    assertOwnedContexts(engine, userAction, []);
    assertOwnedContexts(engine, malformedAction, []);
    for (
      const discardedAction of [
        payloadMismatchAction,
        identityMismatchAction,
        orphanSnapshotAction,
        orphanStateAction,
        staleStateAction,
        ambiguousActionA,
        ambiguousActionB,
      ]
    ) {
      assertOwnedContexts(engine, discardedAction, []);
    }
    assertEquals(
      engine.database.prepare(`
        SELECT count(*) AS count
        FROM scheduler_observation
      `).get(),
      { count: 1 },
    );
    assertEquals(
      engine.database.prepare(`
        SELECT read_scope_key
        FROM scheduler_read_index
        WHERE action_id = :action_id
      `).all({ action_id: spaceAction }),
      [{ read_scope_key: SPACE_KEY }],
    );
    assertEquals(
      engine.database.prepare(`
        SELECT write_scope_key
        FROM scheduler_write_index
        WHERE action_id = :action_id
      `).all({ action_id: spaceAction }),
      [{ write_scope_key: SPACE_KEY }],
    );
    assertEquals(engine.database.prepare(`PRAGMA foreign_key_check`).all(), []);
    assertEquals(
      engine.database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE name LIKE '%_context_migration'
      `).all(),
      [],
    );
  };

  let engine: Engine | undefined;
  try {
    engine = await openEngine({ url: toFileUrl(path) });
    assertMigrated(engine);
    close(engine);
    engine = undefined;

    // A second open must be a no-op over the already-qualified schema.
    engine = await openEngine({ url: toFileUrl(path) });
    assertMigrated(engine);
  } finally {
    if (engine) close(engine);
    await Deno.remove(path);
  }
});

Deno.test("scheduler context read lookup keeps its target index at 10k rows", async () => {
  await withEngine((engine) => {
    const actionId = "context:index-plan";
    const stored = storeObservation(
      engine,
      observationFor({ actionId, summaryScope: "user" }),
      ALICE_A,
    );
    engine.database.prepare(`
      DELETE FROM scheduler_read_index
      WHERE action_id = :action_id
    `).run({ action_id: actionId });

    const insert = engine.database.prepare(`
      INSERT INTO scheduler_read_index (
        branch,
        owner_space,
        read_space,
        read_id,
        read_scope,
        read_scope_key,
        read_path,
        read_kind,
        piece_id,
        process_generation,
        action_id,
        execution_context_key,
        observation_id
      ) VALUES (
        '',
        :owner_space,
        :read_space,
        :read_id,
        'user',
        :read_scope_key,
        :read_path,
        'recursive',
        :piece_id,
        1,
        :action_id,
        :execution_context_key,
        :observation_id
      )
    `);
    engine.database.transaction(() => {
      for (let index = 0; index < 10_000; index++) {
        insert.run({
          owner_space: OWNER_SPACE,
          read_space: OWNER_SPACE,
          read_id: `input-${index.toString().padStart(5, "0")}`,
          read_scope_key: ALICE_USER_KEY,
          read_path: JSON.stringify(["value"]),
          piece_id: PIECE_ID,
          action_id: actionId,
          execution_context_key: stored.executionContextKey,
          observation_id: stored.observationId,
        });
      }
    }).immediate();

    assertEquals(
      engine.database.prepare(`
        SELECT count(*) AS count
        FROM scheduler_read_index
        WHERE action_id = :action_id
      `).get({ action_id: actionId }),
      { count: 10_000 },
    );
    const plan = engine.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT *
      FROM scheduler_read_index
      WHERE branch = ''
        AND read_space = :read_space
        AND read_id = :read_id
        AND read_scope_key = :read_scope_key
    `).all({
      read_space: OWNER_SPACE,
      read_id: "input-09999",
      read_scope_key: ALICE_USER_KEY,
    }) as Array<{ detail: string }>;
    assert(
      plan.some((row) =>
        row.detail.includes("USING INDEX idx_scheduler_read_index_lookup")
      ),
      `expected indexed target lookup, got ${JSON.stringify(plan)}`,
    );
    assertMatch(plan.map((row) => row.detail).join("\n"), /read_scope_key/);
  });
});

Deno.test("scheduler observation parser rejects caller-selected context fields", () => {
  const observation = observationFor({ actionId: "context:parser" });
  assertExists(schedulerObservationFromValue(observation));

  for (
    const forged of [
      { ...observation, executionContextKey: "space" },
      { ...observation, execution_context_key: "space" },
      {
        ...observation,
        reads: [{ ...observation.reads[0], scopeKey: "space" }],
      },
      {
        ...observation,
        completeActionScopeSummary: {
          ...observation.completeActionScopeSummary!,
          implementationFingerprint: "impl:other",
        },
      },
      {
        ...observation,
        version: 1,
        declaredWrites: [],
        completeActionScopeSummary: observation.completeActionScopeSummary,
      },
    ]
  ) {
    assertEquals(schedulerObservationFromValue(forged), undefined);
  }
});
