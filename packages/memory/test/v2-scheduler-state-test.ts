import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  type AppliedCommit,
  applyCommit as applyCommitEngine,
  close,
  createBranch,
  type Engine,
  findSchedulerReadersForWrite,
  getLatestSchedulerActionSnapshot,
  getSchedulerActionState,
  headSeq,
  listSchedulerActionSnapshots,
  markSchedulerReadersDirtyForWrites,
  open as openEngine,
  principalOfSessionKey,
  resolveCommitSessionKey,
  type SchedulerActionObservation,
  serverSeq,
  upsertSchedulerObservation as upsertSchedulerObservationEngine,
  type UpsertSchedulerObservationOptions,
  writersForTargets,
} from "../v2/engine.ts";
import {
  connect,
  loopback,
  type SessionOpenAuthFactory,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import {
  encodeMemoryBoundary,
  resetPersistentSchedulerStateConfig,
  setPersistentSchedulerStateConfig,
  toDocumentPath,
} from "../v2.ts";
import {
  testSessionOpenAuth,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const DIRECT_TEST_SCOPE_CONTEXT = {
  principal: "did:key:scheduler-direct-test",
  sessionId: "scheduler-direct-test",
} as const;

const applyCommit: typeof applyCommitEngine = (engine, options) =>
  applyCommitEngine(engine, {
    ...options,
    principal: options.principal ?? DIRECT_TEST_SCOPE_CONTEXT.principal,
  });

const upsertSchedulerObservation = (
  engine: Engine,
  options:
    & Omit<UpsertSchedulerObservationOptions, "scopeContext">
    & Partial<Pick<UpsertSchedulerObservationOptions, "scopeContext">>,
) =>
  upsertSchedulerObservationEngine(engine, {
    ...options,
    scopeContext: options.scopeContext ?? DIRECT_TEST_SCOPE_CONTEXT,
  });

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await openEngine({ url: toFileUrl(path) });
  return { engine, path };
};

const countRows = (engine: Engine, table: string): number =>
  (engine.database.prepare(
    `SELECT count(*) AS count FROM ${table}`,
  ).get() as { count: number }).count;

const sourceRead = {
  space: "did:key:read-space",
  scope: "space" as const,
  id: "of:source",
  path: ["value", "count"],
};

const targetWrite = {
  space: "did:key:write-space",
  scope: "space" as const,
  id: "of:target",
  path: ["value", "count"],
};

const observation = {
  version: 1,
  branch: "",
  pieceId: "of:piece",
  processGeneration: 1,
  actionId: "pattern.tsx:computed:1",
  actionKind: "computation",
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:test",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [sourceRead],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [targetWrite],
  declaredWrites: [],
  materializerWriteEnvelopes: [],
  status: "success",
} satisfies SchedulerActionObservation;

const observationForAction = (
  actionId: string,
  overrides: Partial<SchedulerActionObservation> = {},
): SchedulerActionObservation => ({
  ...observation,
  actionId,
  ...overrides,
});

const schedulerAuthFactoryFor = (
  principal: string,
): SessionOpenAuthFactory =>
(_space, _session, context) => ({
  invocation: {
    aud: context.audience,
    challenge: context.challenge.value,
  },
  authorization: { principal },
});

Deno.test("memory v2 parses only well-formed principal session keys", () => {
  const principal = "did:key:alice/with spaces";
  const sessionId = "session:id/with spaces";
  assertEquals(
    principalOfSessionKey(resolveCommitSessionKey(sessionId, principal)),
    principal,
  );

  for (
    const malformed of [
      "bare-session-id",
      sessionId,
      "session:principal:session:extra",
      "session:%:session-id",
    ]
  ) {
    assertEquals(principalOfSessionKey(malformed), undefined);
  }
});

Deno.test("memory v2 does not broadly share fallback action fingerprints", async () => {
  const { engine, path } = await createEngine();
  const ownerSpace = "did:key:fallback-fingerprint-space";
  const piece = {
    space: ownerSpace,
    id: "of:piece",
    scope: "space" as const,
    path: [],
  };
  const address = {
    space: ownerSpace,
    id: "of:value",
    scope: "space" as const,
    path: ["value"],
  };
  const fallbackObservation = {
    ...observation,
    version: 2 as const,
    ownerSpace,
    pieceId: "space:of:piece",
    implementationFingerprint: "action:fallback",
    completeActionScopeSummary: {
      version: 1 as const,
      complete: true as const,
      implementationFingerprint: "action:fallback",
      runtimeFingerprint: observation.runtimeFingerprint,
      piece,
      reads: [address],
      writes: [address],
      materializerWriteEnvelopes: [],
      directOutputs: [address],
    },
    reads: [address],
    currentKnownWrites: [address],
  } satisfies SchedulerActionObservation;

  try {
    const result = upsertSchedulerObservation(engine, {
      ownerSpace,
      observedAtSeq: 0,
      observation: fallbackObservation,
    });
    assertEquals(
      result.executionContextKey,
      `session:${encodeURIComponent(DIRECT_TEST_SCOPE_CONTEXT.principal)}:${
        encodeURIComponent(DIRECT_TEST_SCOPE_CONTEXT.sessionId)
      }`,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 migrates scheduler read indexes to include owner space", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const legacyDb = new Database(path, { create: true });
  try {
    legacyDb.exec(`
      CREATE TABLE scheduler_read_index (
        branch              TEXT    NOT NULL DEFAULT '',
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
    `);
  } finally {
    legacyDb.close();
  }

  const engine = await openEngine({ url: toFileUrl(path) });
  try {
    const columns = engine.database.prepare(
      `PRAGMA table_info("scheduler_read_index")`,
    ).all() as Array<{ name: string }>;
    assertEquals(columns.some((column) => column.name === "owner_space"), true);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 migrates legacy scheduler write and snapshot metadata", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const legacyDb = new Database(path, { create: true });
  try {
    legacyDb.exec(`
      CREATE TABLE scheduler_write_index (
        branch              TEXT    NOT NULL DEFAULT '',
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
      CREATE TABLE scheduler_action_snapshot (
        branch              TEXT    NOT NULL DEFAULT '',
        owner_space         TEXT    NOT NULL DEFAULT '',
        piece_id            TEXT    NOT NULL,
        process_generation  INTEGER NOT NULL,
        action_id           TEXT    NOT NULL,
        observation_id      INTEGER NOT NULL,
        payload             JSON    NOT NULL,
        PRIMARY KEY (
          branch,
          owner_space,
          piece_id,
          process_generation,
          action_id
        )
      );
    `);
  } finally {
    legacyDb.close();
  }

  const engine = await openEngine({ url: toFileUrl(path) });
  try {
    const writeColumns = engine.database.prepare(
      `PRAGMA table_info("scheduler_write_index")`,
    ).all() as Array<{ name: string; dflt_value: string | null }>;
    assertEquals(
      writeColumns.find((column) => column.name === "owner_space")?.dflt_value,
      "''",
    );

    const snapshotColumns = engine.database.prepare(
      `PRAGMA table_info("scheduler_action_snapshot")`,
    ).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    assertEquals(
      snapshotColumns.filter((column) =>
        column.name === "commit_seq" || column.name === "observed_at_seq"
      ).map(({ name, notnull, dflt_value }) => ({
        name,
        notnull,
        dflt_value,
      })),
      [
        { name: "commit_seq", notnull: 0, dflt_value: null },
        { name: "observed_at_seq", notnull: 1, dflt_value: "0" },
      ],
    );

    const stored = upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: headSeq(engine),
      observation,
    });
    assertExists(stored.observationId);
    assertEquals(
      getLatestSchedulerActionSnapshot(engine, {
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: observation.actionId,
      })?.observation,
      observation,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 stores no-op scheduler observations without semantic commits", async () => {
  const { engine, path } = await createEngine();

  try {
    const beforeCommits = engine.database.prepare(
      `SELECT count(*) AS count FROM "commit"`,
    ).get() as { count: number };

    const result = upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: headSeq(engine),
      observation,
    });

    assertExists(result.observationId);
    assertEquals(result.commitSeq, null);
    const afterCommits = engine.database.prepare(
      `SELECT count(*) AS count FROM "commit"`,
    ).get() as { count: number };
    assertEquals(afterCommits.count, beforeCommits.count);

    const snapshot = getLatestSchedulerActionSnapshot(engine, {
      branch: "",
      pieceId: "of:piece",
      processGeneration: 1,
      actionId: "pattern.tsx:computed:1",
    });
    assertEquals(snapshot?.observation.actionId, observation.actionId);
    assertEquals(snapshot?.observation.reads, [sourceRead]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 rejects v2 scheduler observations without a write surface", async () => {
  const { engine, path } = await createEngine();

  try {
    const {
      currentKnownWrites: _currentKnownWrites,
      declaredWrites: _declaredWrites,
      ...slimObservation
    } = {
      ...observation,
      version: 2 as const,
      actionId: "pattern.tsx:computed:v2",
    };

    assertThrows(() =>
      upsertSchedulerObservation(engine, {
        branch: "",
        observedAtSeq: headSeq(engine),
        observation: slimObservation as unknown as SchedulerActionObservation,
      })
    );
    assertEquals(countRows(engine, "scheduler_write_index"), 0);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 indexes legacy declared writes and accepts their v2 omission", async () => {
  const { engine, path } = await createEngine();
  const declaredWrite = {
    ...targetWrite,
    id: "of:legacy-declared-write",
  };

  try {
    upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: headSeq(engine),
      observation: observationForAction("pattern.tsx:computed:legacy", {
        currentKnownWrites: [],
        declaredWrites: [declaredWrite],
      }),
    });

    const {
      declaredWrites: _declaredWrites,
      ...withoutDeclaredWrites
    } = observationForAction("pattern.tsx:computed:v2-omitted", {
      version: 2,
      currentKnownWrites: [targetWrite],
    });
    upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: headSeq(engine),
      observation: withoutDeclaredWrites,
    });

    const rows = engine.database.prepare(`
      SELECT action_id, write_id, write_kind
      FROM scheduler_write_index
      WHERE action_id IN (
        'pattern.tsx:computed:legacy',
        'pattern.tsx:computed:v2-omitted'
      )
      ORDER BY action_id
    `).all();
    assertEquals(rows, [{
      action_id: "pattern.tsx:computed:legacy",
      write_id: declaredWrite.id,
      write_kind: "declared",
    }, {
      action_id: "pattern.tsx:computed:v2-omitted",
      write_id: targetWrite.id,
      write_kind: "current-known",
    }]);
    assertEquals(
      getLatestSchedulerActionSnapshot(engine, {
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: "pattern.tsx:computed:v2-omitted",
      })?.observation.declaredWrites,
      undefined,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 paginates scheduler action snapshots", async () => {
  const { engine, path } = await createEngine();

  try {
    for (let index = 0; index < 5; index++) {
      upsertSchedulerObservation(engine, {
        branch: "",
        observedAtSeq: headSeq(engine),
        observation: observationForAction(
          `pattern.tsx:computed:${index}`,
          { currentKnownWrites: [] },
        ),
      });
    }

    const firstPage = listSchedulerActionSnapshots(engine, {
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      limit: 2,
    });
    assertEquals(
      firstPage.snapshots.map((snapshot) => snapshot.observation.actionId),
      ["pattern.tsx:computed:0", "pattern.tsx:computed:1"],
    );
    assertExists(firstPage.nextCursor);

    const secondPage = listSchedulerActionSnapshots(engine, {
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    assertEquals(
      secondPage.snapshots.map((snapshot) => snapshot.observation.actionId),
      ["pattern.tsx:computed:2", "pattern.tsx:computed:3"],
    );
    assertExists(secondPage.nextCursor);

    const finalPage = listSchedulerActionSnapshots(engine, {
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      limit: 2,
      cursor: secondPage.nextCursor,
    });
    assertEquals(
      finalPage.snapshots.map((snapshot) => snapshot.observation.actionId),
      ["pattern.tsx:computed:4"],
    );
    assertEquals(finalPage.nextCursor, undefined);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 accepts observation-only commits without semantic revisions", async () => {
  const { engine, path } = await createEngine();

  try {
    const beforeHead = headSeq(engine);
    const beforeCommits = engine.database.prepare(
      `SELECT count(*) AS count FROM "commit"`,
    ).get() as { count: number };

    const commit = {
      localSeq: 7,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observation,
    };
    const result = applyCommit(engine, {
      sessionId: "session:scheduler-observation",
      commit,
    });

    assertEquals(result.seq, beforeHead);
    assertEquals(result.revisions, []);
    assertExists(result.schedulerObservationId);
    assertEquals(headSeq(engine), beforeHead);
    const afterCommits = engine.database.prepare(
      `SELECT count(*) AS count FROM "commit"`,
    ).get() as { count: number };
    assertEquals(afterCommits.count, beforeCommits.count);

    const snapshot = getLatestSchedulerActionSnapshot(engine, {
      branch: "",
      pieceId: "of:piece",
      processGeneration: 1,
      actionId: "pattern.tsx:computed:1",
    });
    assertEquals(snapshot?.observedAtSeq, beforeHead);
    assertEquals(snapshot?.observation.observedAtSeq, beforeHead);
    assertEquals(snapshot?.commitSeq, beforeHead + 1);

    const replay = applyCommit(engine, {
      sessionId: "session:scheduler-observation",
      commit,
    });
    assertEquals(replay.schedulerObservationId, result.schedulerObservationId);
    const observationRows = engine.database.prepare(
      `SELECT count(*) AS count FROM scheduler_observation`,
    ).get() as { count: number };
    assertEquals(observationRows.count, 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 delivers first and changed no-op observations in the next commit window", async () => {
  const { engine, path } = await createEngine();

  try {
    const initialHead = headSeq(engine);
    for (
      const [index, actionId] of ["no-op:first", "no-op:concurrent"].entries()
    ) {
      applyCommit(engine, {
        sessionId: "session:no-op-writer",
        space: sourceRead.space,
        commit: {
          localSeq: index + 1,
          reads: { confirmed: [], pending: [] },
          operations: [],
          schedulerObservation: observationForAction(actionId),
        },
      });
    }

    // Both first-ever rows reserve the same next real seq, but neither leaks
    // into a window ending at the current head.
    assertEquals(
      listSchedulerActionSnapshots(engine, {
        sinceCommitSeq: 0,
        throughCommitSeq: initialHead,
      }).snapshots,
      [],
    );

    const carryingCommit = applyCommit(engine, {
      sessionId: "session:data-writer",
      space: sourceRead.space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sourceRead.id,
          scope: sourceRead.scope,
          value: { value: { count: 1 } },
        }],
      },
    });
    assertEquals(carryingCommit.seq, initialHead + 1);
    assertEquals(
      listSchedulerActionSnapshots(engine, {
        sinceCommitSeq: initialHead,
        throughCommitSeq: carryingCommit.seq,
      }).snapshots.map((row) => row.observation.actionId),
      ["no-op:concurrent", "no-op:first"],
    );

    // A payload change at the new head reserves the following slot. It no
    // longer appears in the earlier window, while the unrelated concurrent
    // row keeps its original slot.
    applyCommit(engine, {
      sessionId: "session:no-op-writer",
      space: sourceRead.space,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observationForAction("no-op:first", {
          implementationFingerprint: "impl:v2",
        }),
      },
    });
    assertEquals(
      listSchedulerActionSnapshots(engine, {
        sinceCommitSeq: initialHead,
        throughCommitSeq: carryingCommit.seq,
      }).snapshots.map((row) => row.observation.actionId),
      ["no-op:concurrent"],
    );

    const nextCarryingCommit = applyCommit(engine, {
      sessionId: "session:data-writer",
      space: sourceRead.space,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sourceRead.id,
          scope: sourceRead.scope,
          value: { value: { count: 2 } },
        }],
      },
    });
    const changed = listSchedulerActionSnapshots(engine, {
      sinceCommitSeq: carryingCommit.seq,
      throughCommitSeq: nextCarryingCommit.seq,
    }).snapshots;
    assertEquals(changed.map((row) => row.observation.actionId), [
      "no-op:first",
    ]);
    assertEquals(
      changed[0]?.observation.implementationFingerprint,
      "impl:v2",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 reserves no-op delivery after the global sequence when another branch is ahead", async () => {
  const { engine, path } = await createEngine();

  try {
    createBranch(engine, "feature");
    const featureCommit = applyCommit(engine, {
      sessionId: "session:feature-writer",
      space: sourceRead.space,
      commit: {
        localSeq: 1,
        branch: "feature",
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:feature-only",
          value: { value: { count: 1 } },
        }],
      },
    });
    assertEquals(headSeq(engine, ""), 0);
    assertEquals(serverSeq(engine), featureCommit.seq);

    applyCommit(engine, {
      sessionId: "session:default-observation-writer",
      space: sourceRead.space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observationForAction("no-op:after-feature"),
      },
    });

    const reserved = getLatestSchedulerActionSnapshot(engine, {
      branch: "",
      ownerSpace: sourceRead.space,
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      actionId: "no-op:after-feature",
    });
    assertEquals(reserved?.observedAtSeq, 0);
    assertEquals(reserved?.commitSeq, featureCommit.seq + 1);

    const carryingCommit = applyCommit(engine, {
      sessionId: "session:default-data-writer",
      space: sourceRead.space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sourceRead.id,
          scope: sourceRead.scope,
          value: { value: { count: 2 } },
        }],
      },
    });
    assertEquals(carryingCommit.seq, featureCommit.seq + 1);
    assertEquals(
      listSchedulerActionSnapshots(engine, {
        sinceCommitSeq: featureCommit.seq,
        throughCommitSeq: carryingCommit.seq,
      }).snapshots.map((row) => row.observation.actionId),
      ["no-op:after-feature"],
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 accepts batched no-op scheduler observations", async () => {
  const { engine, path } = await createEngine();

  try {
    const beforeHead = headSeq(engine);
    const commit = {
      localSeq: 100,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservationBatch: [
        {
          localSeq: 101,
          reads: { confirmed: [], pending: [] },
          schedulerObservation: observationForAction("pattern.tsx:computed:1"),
        },
        {
          localSeq: 102,
          reads: { confirmed: [], pending: [] },
          schedulerObservation: observationForAction("pattern.tsx:computed:2"),
        },
      ],
    };

    const result = applyCommit(engine, {
      sessionId: "session:scheduler-observation-batch",
      commit,
    });

    assertEquals(result.seq, beforeHead);
    assertEquals(result.revisions, []);
    assertEquals(headSeq(engine), beforeHead);
    assertEquals(
      result.schedulerObservationResults?.map((entry) => ({
        localSeq: entry.localSeq,
        status: entry.status,
      })),
      [
        { localSeq: 101, status: "kept" },
        { localSeq: 102, status: "kept" },
      ],
    );
    assertExists(
      result.schedulerObservationResults?.[0].schedulerObservationId,
    );
    assertExists(
      result.schedulerObservationResults?.[1].schedulerObservationId,
    );
    assertEquals(countRows(engine, "scheduler_observation"), 2);
    assertEquals(countRows(engine, "scheduler_observation_replay"), 2);
    assertEquals(countRows(engine, `"commit"`), 0);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 namespaces scheduler mirrors by owner space", async () => {
  const { engine, path } = await createEngine();
  const ownerA = "did:key:scheduler-owner-a";
  const ownerB = "did:key:scheduler-owner-b";
  const ownerAObservation = {
    ...observation,
    ownerSpace: ownerA,
  } satisfies SchedulerActionObservation;
  const ownerBObservation = {
    ...observation,
    ownerSpace: ownerB,
  } satisfies SchedulerActionObservation;

  try {
    upsertSchedulerObservation(engine, {
      branch: "",
      ownerSpace: ownerA,
      observedAtSeq: 1,
      observation: ownerAObservation,
    });
    upsertSchedulerObservation(engine, {
      branch: "",
      ownerSpace: ownerB,
      observedAtSeq: 1,
      observation: ownerBObservation,
    });

    assertEquals(
      getLatestSchedulerActionSnapshot(engine, {
        branch: "",
        ownerSpace: ownerA,
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: observation.actionId,
      })?.observation.ownerSpace,
      ownerA,
    );
    assertEquals(
      getLatestSchedulerActionSnapshot(engine, {
        branch: "",
        ownerSpace: ownerB,
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: observation.actionId,
      })?.observation.ownerSpace,
      ownerB,
    );

    const readers = findSchedulerReadersForWrite(engine, {
      branch: "",
      write: sourceRead,
    });
    assertEquals(
      readers.map((reader) => reader.ownerSpace).sort(),
      [ownerA, ownerB],
    );

    markSchedulerReadersDirtyForWrites(engine, {
      branch: "",
      dirtySeq: 7,
      writes: [sourceRead],
    });

    for (const ownerSpace of [ownerA, ownerB]) {
      assertEquals(
        getSchedulerActionState(engine, {
          branch: "",
          ownerSpace,
          pieceId: observation.pieceId,
          processGeneration: observation.processGeneration,
          actionId: observation.actionId,
        })?.directDirtySeq,
        7,
      );
    }
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 drops and replays observations whose pending read is missing", async () => {
  const { engine, path } = await createEngine();
  const commit = {
    localSeq: 1,
    reads: {
      confirmed: [],
      pending: [{
        id: sourceRead.id,
        scope: sourceRead.scope,
        path: toDocumentPath(sourceRead.path),
        localSeq: 404,
      }],
    },
    operations: [],
    schedulerObservation: observationForAction(
      "pattern.tsx:computed:missing-pending-read",
    ),
  };

  try {
    const first = applyCommit(engine, {
      sessionId: "session:scheduler-observation-pending-missing",
      commit,
    });
    assertEquals(first.schedulerObservationResults, [{
      localSeq: 1,
      status: "dropped",
      reason: "pending-read-missing",
    }]);
    assertEquals(
      getLatestSchedulerActionSnapshot(engine, {
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: "pattern.tsx:computed:missing-pending-read",
      }),
      undefined,
    );

    const replay = applyCommit(engine, {
      sessionId: "session:scheduler-observation-pending-missing",
      commit,
    });
    assertEquals(
      replay.schedulerObservationResults,
      first.schedulerObservationResults,
    );
    assertEquals(countRows(engine, "scheduler_observation_replay"), 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 drops stale batched no-op observations independently", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:scheduler-observation-batch-drop",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observationForAction("pattern.tsx:computed:1"),
      },
    });

    const dirtyCommit = applyCommit(engine, {
      sessionId: "session:external-dirty-writer",
      space: sourceRead.space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sourceRead.id,
          scope: sourceRead.scope,
          value: { value: { count: 1 } },
        }],
      },
    });
    markSchedulerReadersDirtyForWrites(engine, {
      branch: "",
      dirtySeq: dirtyCommit.seq,
      writes: [sourceRead],
    });

    const result = applyCommit(engine, {
      sessionId: "session:scheduler-observation-batch-drop",
      commit: {
        localSeq: 100,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservationBatch: [
          {
            localSeq: 101,
            reads: {
              confirmed: [{
                id: sourceRead.id,
                scope: sourceRead.scope,
                path: toDocumentPath(sourceRead.path),
                seq: 0,
              }],
              pending: [],
            },
            schedulerObservation: observationForAction(
              "pattern.tsx:computed:1",
              { observedAtLocalSeq: 101 },
            ),
          },
          {
            localSeq: 102,
            reads: { confirmed: [], pending: [] },
            schedulerObservation: observationForAction(
              "pattern.tsx:computed:2",
              { observedAtLocalSeq: 102 },
            ),
          },
        ],
      },
    });

    assertEquals(
      result.schedulerObservationResults?.map((entry) => ({
        localSeq: entry.localSeq,
        status: entry.status,
        reason: entry.reason,
      })),
      [
        {
          localSeq: 101,
          status: "dropped",
          reason: "stale-confirmed-read",
        },
        {
          localSeq: 102,
          status: "kept",
          reason: undefined,
        },
      ],
    );
    assertEquals(
      getSchedulerActionState(engine, {
        branch: "",
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: "pattern.tsx:computed:1",
      })?.directDirtySeq,
      dirtyCommit.seq,
    );
    assertExists(getLatestSchedulerActionSnapshot(engine, {
      branch: "",
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      actionId: "pattern.tsx:computed:2",
    }));
    assertEquals(countRows(engine, "scheduler_observation_replay"), 3);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 coalesces identical scheduler observations without leaving actions dirty", async () => {
  const { engine, path } = await createEngine();

  try {
    const first = applyCommit(engine, {
      sessionId: "session:scheduler-observation-coalesce",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observation,
      },
    });

    const dirtyCommit = applyCommit(engine, {
      sessionId: "session:external-dirty-writer",
      space: sourceRead.space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sourceRead.id,
          scope: sourceRead.scope,
          value: { value: { count: 1 } },
        }],
      },
    });
    markSchedulerReadersDirtyForWrites(engine, {
      branch: "",
      dirtySeq: dirtyCommit.seq,
      writes: [sourceRead],
    });
    assertEquals(
      getSchedulerActionState(engine, {
        branch: "",
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: observation.actionId,
      })?.directDirtySeq,
      dirtyCommit.seq,
    );

    const second = applyCommit(engine, {
      sessionId: "session:scheduler-observation-coalesce",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: {
          ...observation,
          observedAtLocalSeq: 2,
        },
      },
    });

    assertEquals(second.schedulerObservationId, first.schedulerObservationId);
    assertEquals(countRows(engine, "scheduler_observation"), 1);
    assertEquals(countRows(engine, "scheduler_observation_replay"), 2);
    assertEquals(
      getSchedulerActionState(engine, {
        branch: "",
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: observation.actionId,
      })?.directDirtySeq,
      null,
    );

    const supersededReplay = applyCommit(engine, {
      sessionId: "session:scheduler-observation-coalesce",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observation,
      },
    });
    assertEquals(
      supersededReplay.schedulerObservationResults?.[0]?.executionContextKey,
      undefined,
    );

    const replay = applyCommit(engine, {
      sessionId: "session:scheduler-observation-coalesce",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: {
          ...observation,
          observedAtLocalSeq: 2,
        },
      },
    });
    assertEquals(replay.schedulerObservationId, first.schedulerObservationId);
    assertExists(
      replay.schedulerObservationResults?.[0]?.executionContextKey,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 keeps writer provenance per execution context", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:writer-a:sess-a",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observation,
      },
    });
    const listWriters = () =>
      listSchedulerActionSnapshots(engine, {
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: observation.actionId,
      }).snapshots.map((snapshot) => snapshot.writerSessionId).toSorted();
    const writerA = resolveCommitSessionKey(
      "session:writer-a:sess-a",
      DIRECT_TEST_SCOPE_CONTEXT.principal,
    );
    assertEquals(listWriters(), [writerA]);

    // An incomplete observation is session-keyed, so a different session keeps
    // an independent row even when the payload is identical.
    applyCommit(engine, {
      sessionId: "session:writer-b:sess-b",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: { ...observation, observedAtLocalSeq: 2 },
      },
    });
    const writerB = resolveCommitSessionKey(
      "session:writer-b:sess-b",
      DIRECT_TEST_SCOPE_CONTEXT.principal,
    );
    assertEquals(countRows(engine, "scheduler_observation"), 2);
    assertEquals(listWriters(), [writerA, writerB].toSorted());
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 identical observation-only coalesce keeps the row in the adoption window", async () => {
  // Regression guard for the writer-session refresh. A semantic commit (data +
  // observation bundled) sets the row's commit_seq; a later IDENTICAL
  // observation-only re-run must not erase it or reserve a redundant future
  // delivery. Identical refreshes retain the snapshot's existing semantic
  // slot; first-ever and payload-changing no-ops are covered by the next-window
  // regression above.
  const { engine, path } = await createEngine();

  try {
    const semantic = applyCommit(engine, {
      sessionId: "session:writer-a:sess-a",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:adoption-window-doc",
          value: { value: { n: 1 } },
        }],
        schedulerObservation: observation,
      },
    });
    const window = () =>
      listSchedulerActionSnapshots(engine, {
        sinceCommitSeq: 0,
        throughCommitSeq: semantic.seq,
      }).snapshots;
    assertEquals(window().length, 1);

    // Identical observation-only re-run in the same execution context coalesces.
    applyCommit(engine, {
      sessionId: "session:writer-a:sess-a",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: { ...observation, observedAtLocalSeq: 2 },
      },
    });
    assertEquals(countRows(engine, "scheduler_observation"), 1);
    // Still window-visible via the preserved slot and writer provenance.
    const after = window();
    assertEquals(after.length, 1);
    assertEquals(
      after[0]?.writerSessionId,
      resolveCommitSessionKey(
        "session:writer-a:sess-a",
        DIRECT_TEST_SCOPE_CONTEXT.principal,
      ),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 rejects mismatched observation-only commit replay", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:scheduler-observation-replay-mismatch",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
        schedulerObservation: observation,
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:scheduler-observation-replay-mismatch",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [],
            schedulerObservation: {
              ...observation,
              reads: [{
                ...sourceRead,
                path: ["value", "different"],
              }],
            },
          },
        }),
      Error,
      "scheduler observation replay mismatch",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 retains actual changed writes in durable adoption snapshots", async () => {
  const { engine, path } = await createEngine();

  try {
    const first = upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: 1,
      observation,
    });
    const second = upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: 2,
      observation: {
        ...observation,
        observedAtSeq: 2,
        actualChangedWrites: [targetWrite],
      },
    });

    assertEquals(second.observationId, first.observationId);
    assertEquals(countRows(engine, "scheduler_observation"), 1);

    const snapshot = getLatestSchedulerActionSnapshot(engine, {
      branch: "",
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      actionId: observation.actionId,
    });
    assertEquals(snapshot?.observedAtSeq, 2);
    assertEquals(snapshot?.observation.observedAtSeq, 2);
    assertEquals(snapshot?.observation.actualChangedWrites, [targetWrite]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 updates scheduler index rows by diff instead of rewriting unchanged rows", async () => {
  const { engine, path } = await createEngine();

  try {
    const stableRead = {
      ...sourceRead,
      path: ["value", "stable"],
    };
    const removedRead = {
      ...sourceRead,
      path: ["value", "removed"],
    };
    const addedRead = {
      ...sourceRead,
      path: ["value", "added"],
    };
    const first = upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: 1,
      observation: {
        ...observation,
        reads: [stableRead, removedRead],
      },
    });
    const stableRowBefore = engine.database.prepare(`
      SELECT observation_id
      FROM scheduler_read_index
      WHERE read_path LIKE :read_path
    `).get({
      read_path: '%"stable"%',
    }) as { observation_id: number };

    const second = upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: 2,
      observation: {
        ...observation,
        observedAtSeq: 2,
        reads: [stableRead, addedRead],
      },
    });

    assertEquals(second.observationId, first.observationId);
    assertEquals(countRows(engine, "scheduler_read_index"), 2);
    const stableRowAfter = engine.database.prepare(`
      SELECT observation_id
      FROM scheduler_read_index
      WHERE read_path LIKE :read_path
    `).get({
      read_path: '%"stable"%',
    }) as { observation_id: number };
    assertEquals(stableRowAfter.observation_id, stableRowBefore.observation_id);
    assertEquals(
      findSchedulerReadersForWrite(engine, {
        branch: "",
        write: removedRead,
      }).length,
      0,
    );
    assertEquals(
      findSchedulerReadersForWrite(engine, {
        branch: "",
        write: addedRead,
      }).length,
      1,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 writer lookup matches direct, side, and materializer surfaces", async () => {
  const { engine, path } = await createEngine();
  const ownerSpace = "did:key:scheduler-writer-lookup";
  const directWrite = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:direct-output",
    path: ["value"],
  };
  const sideWrite = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:side-output",
    path: ["value", "summary"],
  };
  const materializerWrite = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:materialized-output",
    path: ["value", "items"],
  };

  try {
    const stored = upsertSchedulerObservation(engine, {
      branch: "",
      ownerSpace,
      observedAtSeq: 7,
      observation: observationForAction("writer-lookup:surfaces", {
        ownerSpace,
        pieceId: "space:of:writer-piece",
        currentKnownWrites: [directWrite, sideWrite],
        materializerWriteEnvelopes: [materializerWrite],
      }),
    });

    const direct = writersForTargets(engine, {
      branch: "",
      targets: [{
        ...directWrite,
        scopeKey: "space",
        path: ["value", "nested", "result"],
      }],
    });
    assertEquals(direct.length, 1);
    assertEquals(direct[0]?.actionId, "writer-lookup:surfaces");
    assertEquals(direct[0]?.pieceId, "space:of:writer-piece");
    assertEquals(direct[0]?.actionKind, "computation");
    assertEquals(direct[0]?.implementationFingerprint, "impl:v1");
    assertEquals(direct[0]?.runtimeFingerprint, "runtime:test");
    assertEquals(direct[0]?.status, "success");
    assertEquals(direct[0]?.executionContextKey, stored.executionContextKey);
    assertEquals(direct[0]?.matchedWrites, [{
      kind: "current-known",
      write: { ...directWrite, scopeKey: "space" },
    }]);

    const side = writersForTargets(engine, {
      branch: "",
      targets: [{ ...sideWrite, scopeKey: "space" }],
    });
    assertEquals(side.length, 1);
    assertEquals(side[0]?.actionId, "writer-lookup:surfaces");
    assertEquals(side[0]?.matchedWrites, [{
      kind: "current-known",
      write: { ...sideWrite, scopeKey: "space" },
    }]);

    const materializer = writersForTargets(engine, {
      branch: "",
      targets: [{
        ...materializerWrite,
        scopeKey: "space",
        path: ["value", "items", "0"],
      }],
    });
    assertEquals(materializer.length, 1);
    assertEquals(materializer[0]?.actionId, "writer-lookup:surfaces");
    assertEquals(materializer[0]?.matchedWrites, [{
      kind: "materializer",
      write: { ...materializerWrite, scopeKey: "space" },
    }]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 writer lookup returns every candidate deterministically", async () => {
  const { engine, path } = await createEngine();
  const ownerSpace = "did:key:scheduler-writer-candidates";
  const sharedTarget = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:shared-output",
    path: ["value"],
  };

  try {
    for (const actionId of ["writer:z-last", "writer:a-first"]) {
      upsertSchedulerObservation(engine, {
        branch: "",
        ownerSpace,
        observedAtSeq: 1,
        observation: observationForAction(actionId, {
          ownerSpace,
          pieceId: `space:of:${actionId}`,
          currentKnownWrites: [sharedTarget],
        }),
      });
    }

    const candidates = writersForTargets(engine, {
      branch: "",
      targets: [{ ...sharedTarget, scopeKey: "space" }],
    });
    assertEquals(candidates.length, 2);
    assertEquals(candidates[0]?.actionId, "writer:a-first");
    assertEquals(candidates[1]?.actionId, "writer:z-last");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 writer lookup replaces stale targets on re-observation", async () => {
  const { engine, path } = await createEngine();
  const ownerSpace = "did:key:scheduler-writer-reobservation";
  const retained = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:retained-output",
    path: ["value"],
  };
  const removed = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:removed-output",
    path: ["value"],
  };
  const actionId = "writer-lookup:reobserved";

  try {
    upsertSchedulerObservation(engine, {
      branch: "",
      ownerSpace,
      observedAtSeq: 1,
      observation: observationForAction(actionId, {
        ownerSpace,
        currentKnownWrites: [retained, removed],
      }),
    });
    assertEquals(
      writersForTargets(engine, {
        branch: "",
        targets: [{ ...removed, scopeKey: "space" }],
      }).length,
      1,
    );

    upsertSchedulerObservation(engine, {
      branch: "",
      ownerSpace,
      observedAtSeq: 2,
      observation: observationForAction(actionId, {
        ownerSpace,
        observedAtSeq: 2,
        currentKnownWrites: [retained],
      }),
    });

    assertEquals(
      writersForTargets(engine, {
        branch: "",
        targets: [{ ...removed, scopeKey: "space" }],
      }),
      [],
    );
    assertEquals(
      writersForTargets(engine, {
        branch: "",
        targets: [{ ...retained, scopeKey: "space" }],
      })[0]?.actionId,
      actionId,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 writer lookup ignores target creation provenance", async () => {
  const { engine, path } = await createEngine();
  const ownerSpace = "did:key:scheduler-writer-preexisting";
  const target = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:preexisting-output",
    path: ["value"],
  };

  try {
    applyCommit(engine, {
      sessionId: "session:unrelated-creator",
      space: ownerSpace,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: target.id,
          value: { value: { creator: "unrelated" } },
        }],
      },
    });
    upsertSchedulerObservation(engine, {
      branch: "",
      ownerSpace,
      observedAtSeq: headSeq(engine),
      observation: observationForAction("writer-lookup:current-producer", {
        ownerSpace,
        currentKnownWrites: [target],
      }),
    });

    const candidates = writersForTargets(engine, {
      branch: "",
      targets: [{ ...target, scopeKey: "space" }],
    });
    assertEquals(candidates.length, 1);
    assertEquals(candidates[0]?.actionId, "writer-lookup:current-producer");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 writer lookup reports the last failure fingerprint", async () => {
  const { engine, path } = await createEngine();
  const ownerSpace = "did:key:scheduler-writer-failure";
  const target = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:failed-output",
    path: ["value"],
  };

  try {
    upsertSchedulerObservation(engine, {
      branch: "",
      ownerSpace,
      observedAtSeq: 1,
      observation: observationForAction("writer-lookup:failed", {
        ownerSpace,
        currentKnownWrites: [target],
        status: "failed",
        errorFingerprint: "error:stable-fingerprint",
      }),
    });

    const candidate = writersForTargets(engine, {
      branch: "",
      targets: [{ ...target, scopeKey: "space" }],
    })[0];
    assertEquals(candidate?.status, "failed");
    assertEquals(candidate?.errorFingerprint, "error:stable-fingerprint");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 writer lookup fails open on corrupt projections", async () => {
  const { engine, path } = await createEngine();
  const ownerSpace = "did:key:scheduler-writer-corruption";
  const storeWriter = (actionId: string) => {
    const target = {
      space: ownerSpace,
      scope: "space" as const,
      id: `of:${actionId}`,
      path: ["value"],
    };
    const storedObservation = observationForAction(actionId, {
      ownerSpace,
      currentKnownWrites: [target],
    });
    upsertSchedulerObservation(engine, {
      branch: "",
      ownerSpace,
      observedAtSeq: 1,
      observation: storedObservation,
    });
    return { target, storedObservation };
  };
  const lookup = (
    target: SchedulerActionObservation["currentKnownWrites"][number],
  ) =>
    writersForTargets(engine, {
      branch: "",
      targets: [{ ...target, scopeKey: "space" }],
    });

  try {
    const missingState = storeWriter("writer-corrupt:missing-state");
    engine.database.prepare(`
      DELETE FROM scheduler_action_state
      WHERE action_id = 'writer-corrupt:missing-state'
    `).run();
    assertEquals(lookup(missingState.target), []);

    const missingSnapshot = storeWriter("writer-corrupt:missing-snapshot");
    engine.database.prepare(`
      DELETE FROM scheduler_action_snapshot
      WHERE action_id = 'writer-corrupt:missing-snapshot'
    `).run();
    assertEquals(lookup(missingSnapshot.target), []);

    const mismatchedPayload = storeWriter("writer-corrupt:mismatched-payload");
    engine.database.prepare(`
      UPDATE scheduler_action_snapshot
      SET payload = :payload
      WHERE action_id = 'writer-corrupt:mismatched-payload'
    `).run({
      payload: encodeMemoryBoundary({
        ...mismatchedPayload.storedObservation,
        actionId: "writer-corrupt:forged-action",
      }),
    });
    assertEquals(lookup(mismatchedPayload.target), []);

    const invalidPath = storeWriter("writer-corrupt:invalid-path");
    engine.database.prepare(`
      UPDATE scheduler_write_index
      SET write_path = :write_path
      WHERE action_id = 'writer-corrupt:invalid-path'
    `).run({ write_path: encodeMemoryBoundary([42]) });
    assertEquals(
      lookup({ ...invalidPath.target, path: ["42"] }),
      [],
    );

    const invalidKind = storeWriter("writer-corrupt:invalid-kind");
    engine.database.prepare(`
      UPDATE scheduler_write_index
      SET write_kind = 'forged-kind'
      WHERE action_id = 'writer-corrupt:invalid-kind'
    `).run();
    assertEquals(lookup(invalidKind.target), []);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 keeps one canonical scheduler observation row per action", async () => {
  const { engine, path } = await createEngine();

  try {
    const first = upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: 1,
      observation,
    });
    const changedRead = {
      ...sourceRead,
      path: ["value", "changed"],
    };
    const second = upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: 2,
      observation: {
        ...observation,
        observedAtSeq: 2,
        reads: [changedRead],
      },
    });

    assertEquals(second.observationId, first.observationId);
    assertEquals(countRows(engine, "scheduler_observation"), 1);
    assertEquals(
      findSchedulerReadersForWrite(engine, {
        branch: "",
        write: sourceRead,
      }).length,
      0,
    );
    assertEquals(
      findSchedulerReadersForWrite(engine, {
        branch: "",
        write: changedRead,
      }).length,
      1,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 indexes scheduler readers and marks them dirty from writes", async () => {
  const { engine, path } = await createEngine();

  try {
    upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: headSeq(engine),
      observation,
    });

    const readers = findSchedulerReadersForWrite(engine, {
      branch: "",
      write: sourceRead,
    });
    assertEquals(readers.map((reader) => reader.actionId), [
      "pattern.tsx:computed:1",
    ]);

    const commit = applyCommit(engine, {
      sessionId: "session:writer",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sourceRead.id,
          scope: sourceRead.scope,
          value: { value: { count: 1 } },
        }],
      },
    });

    markSchedulerReadersDirtyForWrites(engine, {
      branch: "",
      dirtySeq: commit.seq,
      writes: [sourceRead],
    });

    const state = getSchedulerActionState(engine, {
      branch: "",
      pieceId: "of:piece",
      processGeneration: 1,
      actionId: "pattern.tsx:computed:1",
    });
    assertEquals(state?.directDirtySeq, commit.seq);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 marks persisted readers dirty during semantic commits", async () => {
  const { engine, path } = await createEngine();

  try {
    upsertSchedulerObservation(engine, {
      branch: "",
      observedAtSeq: headSeq(engine),
      observation,
    });

    const commit = applyCommit(engine, {
      sessionId: "session:direct-writer",
      space: sourceRead.space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: sourceRead.id,
          scope: sourceRead.scope,
          value: { value: { count: 1 } },
        }],
      },
    });

    const state = getSchedulerActionState(engine, {
      branch: "",
      pieceId: "of:piece",
      processGeneration: 1,
      actionId: "pattern.tsx:computed:1",
    });
    assertEquals(state?.directDirtySeq, commit.seq);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 keeps scheduler state for two user contexts", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({
    store,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: testSessionOpenAuth,
  });
  const aliceClient = await connect({ transport: loopback(server) });
  const bobClient = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-context-owner";
  const alice = await aliceClient.mount(
    ownerSpace,
    {},
    schedulerAuthFactoryFor("did:key:scheduler-alice"),
  );
  const bob = await bobClient.mount(
    ownerSpace,
    {},
    schedulerAuthFactoryFor("did:key:scheduler-bob"),
  );
  const userRead = {
    ...sourceRead,
    space: ownerSpace,
    scope: "user" as const,
  };
  const userWrite = {
    ...targetWrite,
    space: ownerSpace,
    scope: "user" as const,
  };
  const userObservation = observationForAction(
    "pattern.tsx:computed:user-context",
    {
      ownerSpace,
      reads: [userRead],
      currentKnownWrites: [userWrite],
    },
  );

  try {
    await alice.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: userObservation,
    });
    await bob.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: userObservation,
    });

    const aliceSnapshots = await alice.listSchedulerActionSnapshots({
      actionId: userObservation.actionId,
    });
    const bobSnapshots = await bob.listSchedulerActionSnapshots({
      actionId: userObservation.actionId,
    });
    assertEquals(aliceSnapshots.snapshots.length, 1);
    assertEquals(bobSnapshots.snapshots.length, 1);

    const stored = await openEngine({
      url: resolveSpaceStoreUrl(store, ownerSpace),
    });
    try {
      for (
        const table of [
          "scheduler_action_snapshot",
          "scheduler_action_state",
          "scheduler_read_index",
          "scheduler_write_index",
        ]
      ) {
        assertEquals(countRows(stored, table), 2, table);
      }
      const contexts = stored.database.prepare(`
        SELECT execution_context_key
        FROM scheduler_action_snapshot
        ORDER BY execution_context_key
      `).all() as Array<{ execution_context_key: string }>;
      assertEquals(
        contexts.map((row) => row.execution_context_key),
        [
          "session:did%3Akey%3Ascheduler-alice:" +
          encodeURIComponent(alice.sessionId),
          "session:did%3Akey%3Ascheduler-bob:" +
          encodeURIComponent(bob.sessionId),
        ].toSorted(),
      );
    } finally {
      close(stored);
    }
  } finally {
    await aliceClient.close().catch(() => {});
    await bobClient.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 writer lookup derives authenticated action contexts", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({
    store,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: testSessionOpenAuth,
  });
  const aliceClient = await connect({ transport: loopback(server) });
  const bobClient = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-writer-protocol-owner";
  const alicePrincipal = "did:key:scheduler-writer-protocol-alice";
  const bobPrincipal = "did:key:scheduler-writer-protocol-bob";
  const alice = await aliceClient.mount(
    ownerSpace,
    {},
    schedulerAuthFactoryFor(alicePrincipal),
  );
  const bob = await bobClient.mount(
    ownerSpace,
    {},
    schedulerAuthFactoryFor(bobPrincipal),
  );
  const piece = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:piece",
    path: [],
  };
  const sharedTarget = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:shared-output",
    path: ["value"],
  };
  const userRead = {
    space: ownerSpace,
    scope: "user" as const,
    id: "of:user-input",
    path: ["value"],
  };
  const contextObservation = (
    actionId: string,
  ): SchedulerActionObservation => {
    const implementationFingerprint = `impl:${actionId}`;
    return observationForAction(actionId, {
      version: 2,
      ownerSpace,
      pieceId: "space:of:piece",
      implementationFingerprint,
      reads: [userRead],
      currentKnownWrites: [sharedTarget],
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        implementationFingerprint,
        runtimeFingerprint: observation.runtimeFingerprint,
        piece,
        reads: [userRead],
        writes: [sharedTarget],
        materializerWriteEnvelopes: [],
        directOutputs: [sharedTarget],
      },
    });
  };
  const aliceAction = "pattern.tsx:computed:writer-alice";
  const bobAction = "pattern.tsx:computed:writer-bob";

  try {
    await alice.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: contextObservation(aliceAction),
    });
    await bob.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: contextObservation(bobAction),
    });

    const query = {
      branch: "",
      targets: [{
        id: sharedTarget.id,
        scope: sharedTarget.scope,
        path: toDocumentPath(sharedTarget.path),
      }],
    };
    const aliceWriters = await alice.writersForTargets(query);
    const bobWriters = await bob.writersForTargets(query);
    assertEquals(
      aliceWriters.writers.map((writer: {
        actionId: string;
        executionContextKey: string;
      }) => ({
        actionId: writer.actionId,
        executionContextKey: writer.executionContextKey,
      })),
      [{
        actionId: aliceAction,
        executionContextKey: `user:${encodeURIComponent(alicePrincipal)}`,
      }],
    );
    assertEquals(
      bobWriters.writers.map((writer: {
        actionId: string;
        executionContextKey: string;
      }) => ({
        actionId: writer.actionId,
        executionContextKey: writer.executionContextKey,
      })),
      [{
        actionId: bobAction,
        executionContextKey: `user:${encodeURIComponent(bobPrincipal)}`,
      }],
    );
  } finally {
    await aliceClient.close().catch(() => {});
    await bobClient.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server lists only scheduler contexts applicable to the authenticated session", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({
    store,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: testSessionOpenAuth,
  });
  const aliceAClient = await connect({ transport: loopback(server) });
  const aliceBClient = await connect({ transport: loopback(server) });
  const bobClient = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-context-listing-owner";
  const alicePrincipal = "did:key:scheduler-context-listing-alice";
  const bobPrincipal = "did:key:scheduler-context-listing-bob";
  const aliceA = await aliceAClient.mount(
    ownerSpace,
    {},
    schedulerAuthFactoryFor(alicePrincipal),
  );
  const aliceB = await aliceBClient.mount(
    ownerSpace,
    {},
    schedulerAuthFactoryFor(alicePrincipal),
  );
  const bob = await bobClient.mount(
    ownerSpace,
    {},
    schedulerAuthFactoryFor(bobPrincipal),
  );
  const piece = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:piece",
    path: [],
  };
  const observationForScope = (
    actionId: string,
    scope: "space" | "user" | "session",
  ): SchedulerActionObservation => {
    const implementationFingerprint = `impl:${actionId}`;
    const address = {
      space: ownerSpace,
      scope,
      id: `of:${scope}-value`,
      path: ["value"],
    };
    return {
      ...observation,
      version: 2,
      ownerSpace,
      pieceId: "space:of:piece",
      actionId,
      implementationFingerprint,
      reads: [address],
      currentKnownWrites: [address],
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        implementationFingerprint,
        runtimeFingerprint: observation.runtimeFingerprint,
        piece,
        reads: [address],
        writes: [address],
        materializerWriteEnvelopes: [],
        directOutputs: [address],
      },
    };
  };
  const sharedAction = "pattern.tsx:computed:context-shared";
  const userAction = "pattern.tsx:computed:context-user";
  const sessionAction = "pattern.tsx:computed:context-session";
  const sharedObservation = observationForScope(sharedAction, "space");
  const userObservation = observationForScope(userAction, "user");
  const sessionObservation = observationForScope(sessionAction, "session");

  const transactObservation = async (
    session: typeof aliceA,
    localSeq: number,
    schedulerObservation: SchedulerActionObservation,
  ) => {
    await session.transact({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation,
    });
  };

  try {
    await transactObservation(aliceA, 1, sharedObservation);
    await transactObservation(aliceA, 2, userObservation);
    await transactObservation(aliceA, 3, sessionObservation);
    await transactObservation(aliceB, 1, sessionObservation);
    await transactObservation(bob, 1, userObservation);
    await transactObservation(bob, 2, sessionObservation);

    const listedContexts = async (session: typeof aliceA) =>
      (await session.listSchedulerActionSnapshots()).snapshots
        .map((snapshot) =>
          (snapshot.observation as SchedulerActionObservation).actionId +
          `@${snapshot.executionContextKey}`
        )
        .toSorted();
    const userKey = (principal: string) =>
      `user:${encodeURIComponent(principal)}`;
    const sessionKey = (principal: string, sessionId: string) =>
      `session:${encodeURIComponent(principal)}:${
        encodeURIComponent(sessionId)
      }`;
    const expectedContexts = (principal: string, sessionId: string) =>
      [
        `${sharedAction}@space`,
        `${userAction}@${userKey(principal)}`,
        `${sessionAction}@${sessionKey(principal, sessionId)}`,
      ].toSorted();

    assertEquals(
      await listedContexts(aliceA),
      expectedContexts(alicePrincipal, aliceA.sessionId),
    );
    assertEquals(
      await listedContexts(aliceB),
      expectedContexts(alicePrincipal, aliceB.sessionId),
    );
    assertEquals(
      await listedContexts(bob),
      expectedContexts(bobPrincipal, bob.sessionId),
    );
  } finally {
    await aliceAClient.close().catch(() => {});
    await aliceBClient.close().catch(() => {});
    await bobClient.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server mirrors scheduler read indexes into read spaces", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({
    store,
    authorizeSessionOpen: () => "did:key:test-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-owner-space";
  const readSpace = "did:key:scheduler-read-space";
  const owner = await client.mount(ownerSpace, {}, testSessionOpenAuthFactory);
  const reader = await client.mount(readSpace, {}, testSessionOpenAuthFactory);
  const mirroredRead = {
    ...sourceRead,
    space: readSpace,
  };
  const mirroredObservation = {
    ...observation,
    reads: [mirroredRead],
  } satisfies SchedulerActionObservation;

  try {
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: mirroredObservation,
    });
    await reader.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: mirroredRead.id,
        scope: mirroredRead.scope,
        value: { value: { count: 1 } },
      }],
    });
    const listed = await reader.listSchedulerActionSnapshots({
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      actionId: observation.actionId,
    });
    assertEquals(listed.snapshots, []);

    await client.close();
    await server.close();

    const readEngine = await openEngine({
      url: resolveSpaceStoreUrl(store, readSpace),
    });
    try {
      const snapshots = listSchedulerActionSnapshots(readEngine, {
        actionId: observation.actionId,
      });
      assertEquals(snapshots.snapshots.length, 1);
      assertEquals(snapshots.snapshots[0]?.directDirtySeq, 1);
      assertEquals(
        snapshots.snapshots[0]?.executionContextKey,
        `session:${encodeURIComponent("did:key:test-principal")}:` +
          encodeURIComponent(owner.sessionId),
      );
      const readers = findSchedulerReadersForWrite(readEngine, {
        branch: "",
        write: mirroredRead,
      });
      assertEquals(readers.map((reader) => reader.actionId), [
        observation.actionId,
      ]);
      const state = getSchedulerActionState(readEngine, {
        branch: "",
        ownerSpace,
        pieceId: observation.pieceId,
        processGeneration: observation.processGeneration,
        actionId: observation.actionId,
      });
      assertEquals(state?.directDirtySeq, 1);
    } finally {
      close(readEngine);
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server does not serve scheduler snapshots while persistent scheduler state is off", async () => {
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const ownerSpace = "did:key:scheduler-flag-off-owner-space";
  const ownerTarget = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:flag-off-output",
    path: ["value"],
  };
  const storedObservation = {
    ...observation,
    ownerSpace,
    currentKnownWrites: [ownerTarget],
  } satisfies SchedulerActionObservation;

  setPersistentSchedulerStateConfig(true);
  const setupServer = new Server({
    store,
    authorizeSessionOpen: () => "did:key:test-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const setupClient = await connect({ transport: loopback(setupServer) });
  const setupOwner = await setupClient.mount(
    ownerSpace,
    {},
    testSessionOpenAuthFactory,
  );
  try {
    await setupOwner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: storedObservation,
    });
  } finally {
    await setupClient.close().catch(() => {});
    await setupServer.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }

  setPersistentSchedulerStateConfig(false);
  const server = new Server({
    store,
    authorizeSessionOpen: () => "did:key:test-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await connect({ transport: loopback(server) });
  const owner = await client.mount(ownerSpace, {}, testSessionOpenAuthFactory);

  try {
    const listed = await owner.listSchedulerActionSnapshots({
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
      actionId: observation.actionId,
    });
    assertEquals(listed.snapshots, []);
    const writers = await owner.writersForTargets({
      branch: "",
      targets: [{
        id: ownerTarget.id,
        scope: ownerTarget.scope,
        path: toDocumentPath(ownerTarget.path),
      }],
    });
    assertEquals(writers.writers, []);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server mirrors batched scheduler observations into read spaces", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({
    store,
    authorizeSessionOpen: () => "did:key:test-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-batch-owner-space";
  const readSpace = "did:key:scheduler-batch-read-space";
  const owner = await client.mount(ownerSpace, {}, testSessionOpenAuthFactory);
  const reader = await client.mount(readSpace, {}, testSessionOpenAuthFactory);
  const mirroredRead = {
    ...sourceRead,
    space: readSpace,
  };
  const mirroredObservation = {
    ...observation,
    reads: [mirroredRead],
  } satisfies SchedulerActionObservation;
  const droppedActionId = "pattern.tsx:computed:mirror-dropped";
  const keptActionId = "pattern.tsx:computed:mirror-kept";

  try {
    const applied = await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservationBatch: [
        {
          localSeq: 2,
          reads: {
            confirmed: [],
            pending: [{
              id: mirroredRead.id,
              scope: mirroredRead.scope,
              path: toDocumentPath(mirroredRead.path),
              localSeq: 404,
            }],
          },
          schedulerObservation: {
            ...mirroredObservation,
            actionId: droppedActionId,
          },
        },
        {
          localSeq: 3,
          reads: { confirmed: [], pending: [] },
          schedulerObservation: {
            ...mirroredObservation,
            actionId: keptActionId,
          },
        },
      ],
    });
    assertEquals(
      applied.schedulerObservationResults?.map((entry) => ({
        localSeq: entry.localSeq,
        status: entry.status,
        reason: entry.reason,
      })),
      [{
        localSeq: 2,
        status: "dropped",
        reason: "pending-read-missing",
      }, {
        localSeq: 3,
        status: "kept",
        reason: undefined,
      }],
    );

    await reader.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: mirroredRead.id,
        scope: mirroredRead.scope,
        value: { value: { count: 1 } },
      }],
    });
    const listed = await reader.listSchedulerActionSnapshots({
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
    });
    assertEquals(listed.snapshots, []);

    await client.close();
    await server.close();
    const readEngine = await openEngine({
      url: resolveSpaceStoreUrl(store, readSpace),
    });
    try {
      const raw = listSchedulerActionSnapshots(readEngine, {
        actionId: keptActionId,
      });
      assertEquals(raw.snapshots.length, 1);
      assertEquals(raw.snapshots[0]?.directDirtySeq, 1);
      assertEquals(
        raw.snapshots[0]?.executionContextKey,
        `session:${encodeURIComponent("did:key:test-principal")}:` +
          encodeURIComponent(owner.sessionId),
      );
    } finally {
      close(readEngine);
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server preserves scoped mirror context and provenance", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({
    store,
    authorizeSessionOpen: () => "did:key:test-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-writerless-owner-space";
  const readSpace = "did:key:scheduler-writerless-read-space";
  const owner = await client.mount(ownerSpace, {}, testSessionOpenAuthFactory);
  const reader = await client.mount(readSpace, {}, testSessionOpenAuthFactory);
  const actionId = "pattern.tsx:computed:writerless-user-mirror";
  const userRead = {
    ...sourceRead,
    space: readSpace,
    scope: "user" as const,
  };

  try {
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: observationForAction(actionId, {
        reads: [userRead],
      }),
    });

    const listed = await reader.listSchedulerActionSnapshots({ actionId });
    assertEquals(listed.snapshots, []);

    await client.close();
    await server.close();
    const readEngine = await openEngine({
      url: resolveSpaceStoreUrl(store, readSpace),
    });
    try {
      const raw = listSchedulerActionSnapshots(readEngine, { actionId });
      assertEquals(raw.snapshots.length, 1);
      assertEquals(
        raw.snapshots[0]?.writerSessionId,
        resolveCommitSessionKey(
          owner.sessionId,
          "did:key:test-principal",
        ),
      );
      assertEquals(
        raw.snapshots[0]?.executionContextKey,
        `session:${encodeURIComponent("did:key:test-principal")}:` +
          encodeURIComponent(owner.sessionId),
      );
      assertEquals(raw.snapshots[0]?.observation.reads, [userRead]);
    } finally {
      close(readEngine);
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server preserves an origin-narrowed scheduler mirror context", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const principal = "did:key:scheduler-narrowed-mirror-principal";
  const server = new Server({
    store,
    authorizeSessionOpen(message) {
      const authorized = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof authorized === "string" ? authorized : undefined;
    },
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-narrowed-mirror-owner";
  const readSpace = "did:key:scheduler-narrowed-mirror-read";
  const owner = await client.mount(
    ownerSpace,
    {},
    schedulerAuthFactoryFor(principal),
  );
  await client.mount(readSpace, {}, schedulerAuthFactoryFor(principal));
  const actionId = "pattern.tsx:computed:narrowed-mirror";
  const implementationFingerprint = `impl:${actionId}`;
  const piece = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:piece",
    path: [],
  };
  const ownerSessionRead = {
    space: ownerSpace,
    scope: "session" as const,
    id: "of:session-input",
    path: ["value"],
  };
  const userRead = {
    space: readSpace,
    scope: "user" as const,
    id: "of:user-input",
    path: ["value"],
  };
  const userWrite = {
    space: ownerSpace,
    scope: "user" as const,
    id: "of:user-output",
    path: ["value"],
  };
  const firstObservation = {
    ...observation,
    version: 2 as const,
    ownerSpace,
    pieceId: "space:of:piece",
    actionId,
    implementationFingerprint,
    reads: [ownerSessionRead],
    currentKnownWrites: [],
  } satisfies SchedulerActionObservation;
  const provenUserObservation = {
    ...firstObservation,
    reads: [userRead],
    currentKnownWrites: [userWrite],
    completeActionScopeSummary: {
      version: 1 as const,
      complete: true as const,
      implementationFingerprint,
      runtimeFingerprint: firstObservation.runtimeFingerprint,
      piece,
      reads: [userRead],
      writes: [userWrite],
      materializerWriteEnvelopes: [],
      directOutputs: [userWrite],
    },
  } satisfies SchedulerActionObservation;
  const expectedContext = `session:${encodeURIComponent(principal)}:${
    encodeURIComponent(owner.sessionId)
  }`;

  try {
    // The first run establishes a monotonic PerSession floor only in the owner
    // database. The next, fully-certified PerUser run introduces the read-space
    // mirror for the first time; that mirror must inherit the owner's already-
    // narrowed effective context rather than independently broadening to user.
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: firstObservation,
    });
    await owner.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: provenUserObservation,
    });

    await client.close();
    await server.close();
    const readEngine = await openEngine({
      url: resolveSpaceStoreUrl(store, readSpace),
    });
    try {
      const mirrored = listSchedulerActionSnapshots(readEngine, { actionId });
      assertEquals(
        mirrored.snapshots.map((snapshot) => snapshot.executionContextKey),
        [expectedContext],
      );
      const readRow = readEngine.database.prepare(`
        SELECT read_scope_key
        FROM scheduler_read_index
        WHERE action_id = :action_id
      `).get({ action_id: actionId }) as { read_scope_key: string };
      const writeRow = readEngine.database.prepare(`
        SELECT write_scope_key
        FROM scheduler_write_index
        WHERE action_id = :action_id
      `).get({ action_id: actionId }) as { write_scope_key: string };
      assertEquals(
        readRow.read_scope_key,
        `user:${encodeURIComponent(principal)}`,
      );
      assertEquals(
        writeRow.write_scope_key,
        `user:${encodeURIComponent(principal)}`,
      );
    } finally {
      close(readEngine);
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server does not resurrect a broader scheduler mirror on replay", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const principal = "did:key:scheduler-replay-mirror-principal";
  const server = new Server({
    store,
    authorizeSessionOpen(message) {
      const authorized = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof authorized === "string" ? authorized : undefined;
    },
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-replay-mirror-owner";
  const readSpace = "did:key:scheduler-replay-mirror-read";
  const owner = await client.mount(
    ownerSpace,
    {},
    schedulerAuthFactoryFor(principal),
  );
  await client.mount(readSpace, {}, schedulerAuthFactoryFor(principal));
  const actionId = "pattern.tsx:computed:replay-mirror";
  const implementationFingerprint = `impl:${actionId}`;
  const piece = {
    space: ownerSpace,
    scope: "space" as const,
    id: "of:piece",
    path: [],
  };
  const userRead = {
    space: readSpace,
    scope: "user" as const,
    id: "of:user-input",
    path: ["value"],
  };
  const userWrite = {
    space: ownerSpace,
    scope: "user" as const,
    id: "of:user-output",
    path: ["value"],
  };
  const sessionRead = {
    space: ownerSpace,
    scope: "session" as const,
    id: "of:session-input",
    path: ["value"],
  };
  const changedSessionRead = {
    ...sessionRead,
    path: ["changed-value"],
  };
  const userObservation = {
    ...observation,
    version: 2 as const,
    ownerSpace,
    pieceId: "space:of:piece",
    actionId,
    implementationFingerprint,
    reads: [userRead],
    currentKnownWrites: [userWrite],
    completeActionScopeSummary: {
      version: 1 as const,
      complete: true as const,
      implementationFingerprint,
      runtimeFingerprint: observation.runtimeFingerprint,
      piece,
      reads: [userRead],
      writes: [userWrite],
      materializerWriteEnvelopes: [],
      directOutputs: [userWrite],
    },
  } satisfies SchedulerActionObservation;
  const sessionObservation = {
    ...userObservation,
    reads: [userRead, sessionRead],
    currentKnownWrites: [],
  } satisfies SchedulerActionObservation;
  const changedSessionObservation = {
    ...sessionObservation,
    reads: [userRead, changedSessionRead],
  } satisfies SchedulerActionObservation;
  const initialCommit = {
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set" as const,
      id: "of:semantic-write",
      value: { value: { initialized: true } },
    }],
    schedulerObservation: userObservation,
  };
  const sessionCommit = {
    localSeq: 2,
    reads: { confirmed: [], pending: [] },
    operations: [],
    schedulerObservation: sessionObservation,
  };
  const expectedSessionContext = `session:${encodeURIComponent(principal)}:${
    encodeURIComponent(owner.sessionId)
  }`;

  try {
    await owner.transact(initialCommit);
    const sessionResult = await owner.transact(sessionCommit);
    const changedSessionResult = await owner.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: changedSessionObservation,
    });
    assertEquals(
      changedSessionResult.schedulerObservationId,
      sessionResult.schedulerObservationId,
    );

    const sessionReplay = await owner.transact(sessionCommit);
    assertEquals(
      sessionReplay.schedulerObservationResults?.[0]?.executionContextKey,
      undefined,
    );

    const userReplay = await owner.transact(initialCommit);
    assertEquals(
      userReplay.schedulerObservationResults?.[0]?.executionContextKey,
      undefined,
    );

    await client.close();
    await server.close();
    const readEngine = await openEngine({
      url: resolveSpaceStoreUrl(store, readSpace),
    });
    try {
      const snapshots = listSchedulerActionSnapshots(readEngine, { actionId })
        .snapshots;
      assertEquals(
        snapshots.map(
          (snapshot) => snapshot.executionContextKey,
        ),
        [expectedSessionContext],
      );
      assertEquals(snapshots[0]?.observation.reads, [
        userRead,
        changedSessionRead,
      ]);
    } finally {
      close(readEngine);
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server isolates PerSession scheduler mirrors and dirty state", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const principal = "did:key:scheduler-session-mirror-principal";
  const server = new Server({
    store,
    authorizeSessionOpen(message) {
      const authorized = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof authorized === "string" ? authorized : undefined;
    },
    sessionOpenAuth: testSessionOpenAuth,
  });
  const clientA = await connect({ transport: loopback(server) });
  const clientB = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-session-mirror-owner";
  const readSpace = "did:key:scheduler-session-mirror-read";
  const sessionA = "scheduler-session-mirror-a";
  const sessionB = "scheduler-session-mirror-b";
  const ownerA = await clientA.mount(
    ownerSpace,
    { sessionId: sessionA },
    schedulerAuthFactoryFor(principal),
  );
  const readerA = await clientA.mount(
    readSpace,
    { sessionId: sessionA },
    schedulerAuthFactoryFor(principal),
  );
  const ownerB = await clientB.mount(
    ownerSpace,
    { sessionId: sessionB },
    schedulerAuthFactoryFor(principal),
  );
  await clientB.mount(
    readSpace,
    { sessionId: sessionB },
    schedulerAuthFactoryFor(principal),
  );
  const actionId = "pattern.tsx:computed:session-mirror-isolation";
  const implementationFingerprint = `impl:${actionId}`;
  const sessionRead = {
    space: readSpace,
    scope: "session" as const,
    id: "of:session-input",
    path: ["value"],
  };
  const sessionWrite = {
    space: ownerSpace,
    scope: "session" as const,
    id: "of:session-output",
    path: ["value"],
  };
  const sessionObservation = {
    ...observation,
    version: 2 as const,
    ownerSpace,
    pieceId: "space:of:piece",
    actionId,
    implementationFingerprint,
    reads: [sessionRead],
    currentKnownWrites: [sessionWrite],
    completeActionScopeSummary: {
      version: 1 as const,
      complete: true as const,
      implementationFingerprint,
      runtimeFingerprint: observation.runtimeFingerprint,
      piece: {
        space: ownerSpace,
        scope: "space" as const,
        id: "of:piece",
        path: [],
      },
      reads: [sessionRead],
      writes: [sessionWrite],
      materializerWriteEnvelopes: [],
      directOutputs: [sessionWrite],
    },
  } satisfies SchedulerActionObservation;
  const contextFor = (sessionId: string) =>
    `session:${encodeURIComponent(principal)}:${encodeURIComponent(sessionId)}`;

  try {
    await ownerA.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: sessionObservation,
    });
    await ownerB.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: sessionObservation,
    });

    const readEngine = await openEngine({
      url: resolveSpaceStoreUrl(store, readSpace),
    });
    try {
      const rows = readEngine.database.prepare(`
        SELECT execution_context_key, read_scope_key, write_scope_key
        FROM scheduler_read_index
        JOIN scheduler_write_index USING (
          branch,
          owner_space,
          piece_id,
          process_generation,
          action_id,
          execution_context_key,
          observation_id
        )
        WHERE action_id = :action_id
        ORDER BY execution_context_key
      `).all({ action_id: actionId }) as Array<{
        execution_context_key: string;
        read_scope_key: string;
        write_scope_key: string;
      }>;
      const expected = [
        contextFor(ownerA.sessionId),
        contextFor(ownerB.sessionId),
      ].toSorted();
      assertEquals(
        rows.map((row) => row.execution_context_key),
        expected,
      );
      assertEquals(rows.map((row) => row.read_scope_key), expected);
      assertEquals(rows.map((row) => row.write_scope_key), expected);
    } finally {
      close(readEngine);
    }

    await readerA.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: sessionRead.id,
        scope: sessionRead.scope,
        value: { value: 1 },
      }],
    });

    const snapshotsA = await ownerA.listSchedulerActionSnapshots({ actionId });
    const snapshotsB = await ownerB.listSchedulerActionSnapshots({ actionId });
    assertEquals(snapshotsA.snapshots.length, 1);
    assertEquals(
      snapshotsA.snapshots[0]?.executionContextKey,
      contextFor(ownerA.sessionId),
    );
    assertEquals(snapshotsA.snapshots[0]?.directDirtySeq, 1);
    assertEquals(snapshotsB.snapshots.length, 1);
    assertEquals(
      snapshotsB.snapshots[0]?.executionContextKey,
      contextFor(ownerB.sessionId),
    );
    assertEquals(snapshotsB.snapshots[0]?.directDirtySeq, undefined);
  } finally {
    await clientA.close().catch(() => {});
    await clientB.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server skips scheduler mirrors for unmounted read spaces", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({
    store,
    authorizeSessionOpen: () => "did:key:test-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-owner-authorized-space";
  const readSpace = "did:key:scheduler-unmounted-read-space";
  const owner = await client.mount(ownerSpace, {}, testSessionOpenAuthFactory);
  const mirroredRead = {
    ...sourceRead,
    space: readSpace,
  };
  const mirroredObservation = {
    ...observation,
    reads: [mirroredRead],
  } satisfies SchedulerActionObservation;

  try {
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: mirroredObservation,
    });

    await client.close();
    await server.close();

    const readEngine = await openEngine({
      url: resolveSpaceStoreUrl(store, readSpace),
    });
    try {
      const readers = findSchedulerReadersForWrite(readEngine, {
        branch: "",
        write: mirroredRead,
      });
      assertEquals(readers, []);
    } finally {
      close(readEngine);
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 anonymous sessions do not persist scheduler observations", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({
    store,
    authorizeSessionOpen: () => undefined,
    sessionOpenAuth: testSessionOpenAuth,
  });
  const client = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-anonymous-owner";
  const readSpace = "did:key:scheduler-anonymous-read";
  const owner = await client.mount(ownerSpace, {}, testSessionOpenAuthFactory);
  await client.mount(readSpace, {}, testSessionOpenAuthFactory);
  const anonymousObservation = observationForAction(
    "pattern.tsx:computed:anonymous-space-scope",
    {
      ownerSpace,
      reads: [{ ...sourceRead, space: readSpace }],
    },
  );

  try {
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:scheduler-anonymous-owner-value",
        value: { value: 1 },
      }],
      schedulerObservation: anonymousObservation,
    });

    const listed = await owner.listSchedulerActionSnapshots({
      actionId: anonymousObservation.actionId,
    });
    assertEquals(listed.snapshots, []);

    await client.close();
    await server.close();
    const readEngine = await openEngine({
      url: resolveSpaceStoreUrl(store, readSpace),
    });
    try {
      assertEquals(
        listSchedulerActionSnapshots(readEngine, {
          actionId: anonymousObservation.actionId,
        }).snapshots,
        [],
      );
    } finally {
      close(readEngine);
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server contains incomplete scheduler replay metadata", async () => {
  setPersistentSchedulerStateConfig(true);
  const server = new Server({
    store: new URL("memory://scheduler-incomplete-replay"),
    authorizeSessionOpen: () => "did:key:test-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const runSideEffects = (server as unknown as {
    runPostCommitSchedulerSideEffects: (
      ownerSpace: string,
      commit: AppliedCommit,
      observations: readonly {
        localSeq: number;
        observation: SchedulerActionObservation;
      }[],
      previousReadSpaces: ReadonlyMap<number, ReadonlySet<string>>,
      session: undefined,
    ) => Promise<void>;
  }).runPostCommitSchedulerSideEffects.bind(server);
  const baseCommit = {
    seq: 1,
    branch: "",
    revisions: [],
  } as unknown as AppliedCommit;
  const observations = [{ localSeq: 1, observation }];

  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    // A replay whose durable owner observation was narrowed away has no result
    // array and must quietly skip its stale mirror payload.
    await runSideEffects(
      "did:key:scheduler-incomplete-replay-owner",
      baseCommit,
      observations,
      new Map(),
      undefined,
    );
    assertEquals(warnings, []);

    // A malformed partial result array is contained as a post-commit side
    // effect failure: the cell commit itself has already succeeded.
    await runSideEffects(
      "did:key:scheduler-incomplete-replay-owner",
      {
        ...baseCommit,
        schedulerObservationResults: [{
          localSeq: 2,
          status: "dropped",
        }],
      } as AppliedCommit,
      observations,
      new Map(),
      undefined,
    );
    assertEquals(warnings.length, 1);
    assertEquals(
      warnings[0]?.[0],
      "Post-commit scheduler state update failed after semantic commit:",
    );
  } finally {
    console.warn = originalWarn;
    await server.close();
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 server propagates cross-space dirty state back to the owner space", async () => {
  setPersistentSchedulerStateConfig(true);
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({ ...testSessionOpenServerOptions, store });
  const client = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-owner-dirty-space";
  const readSpace = "did:key:scheduler-owner-read-space";
  const owner = await client.mount(ownerSpace, {}, testSessionOpenAuthFactory);
  const reader = await client.mount(readSpace, {}, testSessionOpenAuthFactory);
  const mirroredRead = {
    ...sourceRead,
    space: readSpace,
  };
  const ownerWrite = {
    ...targetWrite,
    space: ownerSpace,
    id: "of:owner-output",
  };
  const ownerObservation = {
    ...observation,
    ownerSpace,
    reads: [mirroredRead],
    currentKnownWrites: [ownerWrite],
  } as SchedulerActionObservation & { ownerSpace: string };
  const downstreamObservation = {
    ...observation,
    ownerSpace,
    actionId: "pattern.tsx:downstream:1",
    reads: [ownerWrite],
    currentKnownWrites: [],
  } as SchedulerActionObservation & { ownerSpace: string };

  try {
    await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: ownerObservation,
    });
    await owner.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation: downstreamObservation,
    });

    await reader.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: mirroredRead.id,
        scope: mirroredRead.scope,
        value: { value: { count: 1 } },
      }],
    });

    const ownerSnapshots = await owner.listSchedulerActionSnapshots({
      pieceId: observation.pieceId,
      processGeneration: observation.processGeneration,
    });
    const ownerAction = ownerSnapshots.snapshots.find((snapshot) =>
      (snapshot.observation as SchedulerActionObservation).actionId ===
        ownerObservation.actionId
    );
    const downstreamAction = ownerSnapshots.snapshots.find((snapshot) =>
      (snapshot.observation as SchedulerActionObservation).actionId ===
        downstreamObservation.actionId
    );

    assertEquals(ownerAction?.directDirtySeq, 1);
    assertEquals(downstreamAction?.staleSeq, 1);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
    resetPersistentSchedulerStateConfig();
  }
});
