// Server-execution v2 stage D: the engine surface of the wave commit step
// (docs/specs/server-side-execution/serving-loop.md §3b–§3d, protocol.md
// §1/§7). These tests pin:
//
// - the annotation carriage: derived-class commits carry the per-write
//   addressing/attribution pair; the ADDRESSING half keys scoped rows at
//   admission (fail-closed — a scoped write with no explicit scope_key is
//   rejected, never defaulted to the service session), the ATTRIBUTION
//   half is stored, and both are refused on any other class (the closed
//   metadata list);
// - consequenceOf storage, derived-only;
// - applyWaveCommit's per-doc re-verification: heads past the wave basis
//   throw the conflict error NAMING the moved docs (whole-wave CAS
//   failure is forbidden), the wave's already-resolved docs are excluded,
//   and nothing is applied on conflict;
// - the basis-index writer: rows land inside the wave's own transaction,
//   in-wave reads (seq null) share the wave's commit seq, and a later run
//   of the same (action, instance) REPLACES the rows as a set (§3b's
//   overwrite-in-place unit — appending is the evidence log's signature).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  applyCommit,
  applyWaveCommit,
  close,
  type Engine,
  open,
  ProtocolError,
  selectDocHead,
  selectWritePathsSince,
  WaveCommitConflictError,
} from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import {
  replaceSchedulerBasisRows,
  selectSchedulerBasisRows,
} from "../v2/scheduler-basis.ts";
import {
  type ClientCommit,
  decodeMemoryBoundary,
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-wave-test-space";
const SERVICE = `service:${SPACE}`;

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const setCommit = (
  localSeq: number,
  ops: Array<{ id: string; scope?: "user" | "session"; n?: number }>,
): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: ops.map((op) => ({
    op: "set" as const,
    id: op.id,
    ...(op.scope !== undefined ? { scope: op.scope } : {}),
    value: { value: { n: op.n ?? localSeq } },
  })),
});

const commitRow = (
  path: string,
  seq: number,
): { annotations: string | null; consequence_of: string | null } => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(
      `SELECT annotations, consequence_of FROM "commit" WHERE seq = :seq`,
    ).get({ seq }) as {
      annotations: string | null;
      consequence_of: string | null;
    };
  } finally {
    db.close();
  }
};

const revisionScopeKeys = (
  path: string,
  id: string,
): string[] => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(
      `SELECT scope_key FROM revision WHERE id = :id ORDER BY seq, op_index`,
    ).all({ id }) as { scope_key: string }[]).map((row) => row.scope_key);
  } finally {
    db.close();
  }
};

const withLiveLease = (engine: Engine): string => {
  const holder = executionLeaseHolder(SERVICE);
  assert(acquireExecutionLease(engine, { space: SPACE, holder }));
  return holder;
};

Deno.test("wave carriage: a derived commit stores annotations and consequenceOf; scoped ops key by the annotated scope_key", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const applied = applyWaveCommit(engine, {
      sessionId: "server:executor",
      space: SPACE,
      commit: setCommit(1, [
        { id: "of:plain" },
        { id: "of:scoped", scope: "user" },
      ]),
      commitClass: "derived",
      holder,
      annotations: [
        { op: 0, actingUser: "did:key:alice", actingSession: "s-1" },
        {
          op: 1,
          scopeKey: "user:did%3Akey%3Aalice",
          actingUser: "did:key:alice",
        },
      ],
      consequenceOf: ["e1", "e2"],
      waveBasis: { basisSeq: 0, resolvedConflicts: [] },
    });
    assertEquals(applied.seq, 1);
    const row = commitRow(path, 1);
    assertEquals(decodeMemoryBoundary(row.annotations!), [
      { op: 0, actingUser: "did:key:alice", actingSession: "s-1" },
      {
        op: 1,
        scopeKey: "user:did%3Akey%3Aalice",
        actingUser: "did:key:alice",
      },
    ]);
    assertEquals(decodeMemoryBoundary(row.consequence_of!), ["e1", "e2"]);
    // The ADDRESSING half was consumed: the scoped row is keyed by the
    // explicit instance, not by anything resolved from the service session.
    assertEquals(revisionScopeKeys(path, "of:scoped"), [
      "user:did%3Akey%3Aalice",
    ]);
    assertEquals(revisionScopeKeys(path, "of:plain"), ["space"]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave carriage: a scoped write with no explicit scope_key is rejected, never defaulted (the silent-empty-instance trap)", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:executor",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:scoped", scope: "user" }]),
          commitClass: "derived",
          holder,
          annotations: [{ op: 0, actingUser: "did:key:alice" }],
        }),
      ProtocolError,
      "no explicit scope_key",
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave carriage: an annotated scope_key must match the write's declared scope", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:executor",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:scoped", scope: "session" }]),
          commitClass: "derived",
          holder,
          annotations: [{ op: 0, scopeKey: "user:did%3Akey%3Aalice" }],
        }),
      ProtocolError,
      "does not match",
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave carriage: annotations and consequenceOf are refused on non-derived classes (closed metadata list)", async () => {
  const { engine } = await createEngine();
  try {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session-a",
          principal: "user:alice",
          commit: setCommit(1, [{ id: "of:doc" }]),
          annotations: [{ op: 0, actingUser: "did:key:alice" }],
        }),
      ProtocolError,
      "derived-commit carriage",
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:direct",
          commit: setCommit(1, [{ id: "of:doc" }]),
          commitClass: "system",
          consequenceOf: ["e1"],
        }),
      ProtocolError,
      "derived-commit carriage",
    );
  } finally {
    close(engine);
  }
});

Deno.test("wave commit: re-verification throws NAMING docs whose head passed the basis, and applies nothing", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    // A rival authored commit moves of:x to seq 1 — past a wave whose
    // basis was 0.
    applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: setCommit(1, [{ id: "of:x", n: 99 }]),
    });
    assertEquals(selectDocHead(engine, { id: "of:x", scopeKey: "space" }), 1);
    const error = assertThrows(
      () =>
        applyWaveCommit(engine, {
          sessionId: "server:executor",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:x" }, { id: "of:y" }]),
          commitClass: "derived",
          holder,
          waveBasis: { basisSeq: 0, resolvedConflicts: [] },
        }),
      WaveCommitConflictError,
    );
    assertEquals(error.conflictedDocs, ["of:x space"]);
    // Nothing applied: of:y has no head, and the store seq is still the
    // rival's.
    assertEquals(selectDocHead(engine, { id: "of:y", scopeKey: "space" }), 0);
    const db = new Database(path, { readonly: true });
    try {
      assertEquals(
        db.prepare(`SELECT COUNT(*) AS n FROM "commit"`).get(),
        { n: 1 },
      );
    } finally {
      db.close();
    }
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave commit: a doc the wave already resolved is excluded from re-verification", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: setCommit(1, [{ id: "of:x", n: 99 }]),
    });
    // The wave resolved of:x per write class (say a rebase) — the batch
    // still writes it, and re-verification skips it.
    const applied = applyWaveCommit(engine, {
      sessionId: "server:executor",
      space: SPACE,
      commit: setCommit(1, [{ id: "of:x" }, { id: "of:y" }]),
      commitClass: "derived",
      holder,
      waveBasis: { basisSeq: 0, resolvedConflicts: ["of:x space"] },
    });
    assertEquals(applied.seq, 2);
    assertEquals(selectDocHead(engine, { id: "of:y", scopeKey: "space" }), 2);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave commit: basis rows land in the same transaction; in-wave reads share the wave's commit seq; a later run REPLACES the instance's rows", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const applied = applyWaveCommit(engine, {
      sessionId: "server:executor",
      space: SPACE,
      commit: setCommit(1, [{ id: "of:out" }]),
      commitClass: "derived",
      holder,
      waveBasis: { basisSeq: 0, resolvedConflicts: [] },
      basisInstances: [{
        action: "action-a",
        actionScopeKey: "space",
        rows: [
          {
            entitySpace: SPACE,
            entity: "of:in",
            entityScopeKey: "space",
            seq: 7,
          },
          // An in-wave read: seq null shares the wave's own commit seq.
          {
            entitySpace: SPACE,
            entity: "of:sealed",
            entityScopeKey: "space",
            seq: null,
          },
        ],
      }],
    });
    assertEquals(
      selectSchedulerBasisRows(engine, {
        branch: "",
        action: "action-a",
        actionScopeKey: "space",
      }),
      [
        {
          entitySpace: SPACE,
          entity: "of:in",
          entityScopeKey: "space",
          seq: 7,
        },
        {
          entitySpace: SPACE,
          entity: "of:sealed",
          entityScopeKey: "space",
          seq: applied.seq,
        },
      ],
    );
    // The next run of the same (action, instance) replaces the set —
    // overwrite in place, never append beside (§3b).
    replaceSchedulerBasisRows(engine, {
      branch: "",
      action: "action-a",
      actionScopeKey: "space",
      rows: [{
        entitySpace: SPACE,
        entity: "of:other",
        entityScopeKey: "space",
        seq: 9,
      }],
    });
    assertEquals(
      selectSchedulerBasisRows(engine, {
        branch: "",
        action: "action-a",
        actionScopeKey: "space",
      }),
      [{
        entitySpace: SPACE,
        entity: "of:other",
        entityScopeKey: "space",
        seq: 9,
      }],
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave rebase input: selectWritePathsSince reports whole-doc rewrites as the root path and patches as their pointer paths", async () => {
  const { engine } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, [{ id: "of:doc" }]),
    });
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:doc",
          patches: [{ op: "replace", path: "/value/a", value: 1 }],
        }],
      },
    });
    assertEquals(
      selectWritePathsSince(engine, {
        id: "of:doc",
        scopeKey: "space",
        sinceSeq: 0,
      }),
      [[], ["value", "a"]],
    );
    assertEquals(
      selectWritePathsSince(engine, {
        id: "of:doc",
        scopeKey: "space",
        sinceSeq: 1,
      }),
      [["value", "a"]],
    );
  } finally {
    close(engine);
  }
});
