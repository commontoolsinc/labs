import { assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  type Engine,
  findSchedulerReadersForWrite,
  getLatestSchedulerActionSnapshot,
  getSchedulerActionState,
  headSeq,
  markSchedulerReadersDirtyForWrites,
  open as openEngine,
  type SchedulerActionObservation,
  upsertSchedulerObservation,
} from "../v2/engine.ts";
import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await openEngine({ url: toFileUrl(path) });
  return { engine, path };
};

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
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = new Server({ store });
  const client = await connect({ transport: loopback(server) });
  const ownerSpace = "did:key:scheduler-owner-space";
  const readSpace = "did:key:scheduler-read-space";
  const owner = await client.mount(ownerSpace);
  const reader = await client.mount(readSpace);
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
  }
});
