import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  applyCommit,
  close,
  type Engine,
  findSchedulerReadersForWrite,
  getLatestSchedulerActionSnapshot,
  getSchedulerActionState,
  headSeq,
  listSchedulerActionSnapshots,
  markSchedulerReadersDirtyForWrites,
  open as openEngine,
  type SchedulerActionObservation,
  upsertSchedulerObservation,
} from "../v2/engine.ts";
import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import {
  resetPersistentSchedulerStateConfig,
  setPersistentSchedulerStateConfig,
  toDocumentPath,
} from "../v2.ts";
import {
  testSessionOpenAuth,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

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

Deno.test("memory v2 keeps actual changed writes out of durable dependency snapshots", async () => {
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
    assertEquals(snapshot?.observation.actualChangedWrites, []);
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
    assertEquals(listed.snapshots.length, 1);
    assertEquals(listed.snapshots[0]?.directDirtySeq, 1);

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
      schedulerObservation: { ...observation, ownerSpace },
    });
  } finally {
    await setupClient.close().catch(() => {});
    await setupServer.close().catch(() => {});
    resetPersistentSchedulerStateConfig();
  }

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
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true });
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

  try {
    const applied = await owner.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservationBatch: [{
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        schedulerObservation: mirroredObservation,
      }],
    });
    assertEquals(
      applied.schedulerObservationResults?.map((entry) => ({
        localSeq: entry.localSeq,
        status: entry.status,
      })),
      [{ localSeq: 2, status: "kept" }],
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
      actionId: observation.actionId,
    });
    assertEquals(listed.snapshots.length, 1);
    assertEquals(listed.snapshots[0]?.directDirtySeq, 1);
  } finally {
    await client.close().catch(() => {});
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
