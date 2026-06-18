import { assertEquals, assertExists, assertThrows } from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  type EntityRef,
  entityRefFromString,
} from "@commonfabric/data-model/cell-rep";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  applyCommit,
  close,
  createBranch,
  deleteBranch,
  type Engine,
  listBranches,
  open,
  ProtocolError,
  read,
} from "../v2/engine.ts";
import {
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  type EntityDocument,
  toDocumentPath,
} from "../v2.ts";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const createEngineWithOptions = async (
  options: Omit<Parameters<typeof open>[0], "url">,
): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path), ...options });
  return { engine, path };
};

const invocationFor = (
  localSeq: number,
  extra: Record<string, unknown> = {},
) => ({
  iss: "did:key:alice",
  aud: "did:key:service",
  cmd: "/memory/transact",
  sub: "did:key:space",
  args: { localSeq, ...extra },
});

const authorization = {
  signature: "sig:alice",
  access: { "proof:1": {} },
};

const decodeStored = <Value extends FabricValue>(
  source: string | null | undefined,
): Value => decodeMemoryBoundary<Value>(source ?? "null");

const toEntityDocument = (
  value: unknown,
  source?: EntityRef,
  metadata: Record<string, unknown> = {},
): EntityDocument => {
  const document: Record<string, unknown> = {
    ...metadata,
    ...(source !== undefined ? { source } : {}),
  };
  if (value !== undefined) {
    document.value = value;
  }
  return document as EntityDocument;
};

Deno.test("memory v2 engine stores independent scoped instances for the same id", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped",
          value: toEntityDocument({ scope: "space" }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped",
          scope: "user",
          value: toEntityDocument({ scope: "alice" }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped",
          scope: "session",
          value: toEntityDocument({ scope: "alice-session" }),
        }],
      },
    });

    assertEquals(read(engine, { id: "entity:scoped" }), {
      value: { scope: "space" },
    });
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "user",
        principal: "did:key:alice",
        sessionId: "session:alice",
      }),
      { value: { scope: "alice" } },
    );
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "session",
        principal: "did:key:alice",
        sessionId: "session:alice",
      }),
      { value: { scope: "alice-session" } },
    );
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "user",
        principal: "did:key:bob",
        sessionId: "session:bob",
      }),
      null,
    );
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "session",
        principal: "did:key:alice",
        sessionId: "session:other",
      }),
      null,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine binds session scoped instances to the principal", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:shared",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:session-principal",
          scope: "session",
          value: toEntityDocument({ owner: "alice" }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:shared",
      principal: "did:key:bob",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:session-principal",
          scope: "session",
          value: toEntityDocument({ owner: "bob" }),
        }],
      },
    });

    assertEquals(
      read(engine, {
        id: "entity:session-principal",
        scope: "session",
        principal: "did:key:alice",
        sessionId: "session:shared",
      }),
      { value: { owner: "alice" } },
    );
    assertEquals(
      read(engine, {
        id: "entity:session-principal",
        scope: "session",
        principal: "did:key:bob",
        sessionId: "session:shared",
      }),
      { value: { owner: "bob" } },
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine encodes user and session scoped principal keys symmetrically", async () => {
  const { engine, path } = await createEngine();

  try {
    const principals = ["did:key:foo", "did:key:bar"];
    for (const [index, principal] of principals.entries()) {
      applyCommit(engine, {
        sessionId: "session:shared",
        principal,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            {
              op: "set",
              id: "entity:encoded-user",
              scope: "user",
              value: toEntityDocument({ owner: principal }),
            },
            {
              op: "set",
              id: "entity:encoded-session",
              scope: "session",
              value: toEntityDocument({ owner: principal }),
            },
          ],
        },
      });

      assertEquals(
        read(engine, {
          id: "entity:encoded-user",
          scope: "user",
          principal,
          sessionId: "session:shared",
        }),
        { value: { owner: principal } },
      );
      assertEquals(
        read(engine, {
          id: "entity:encoded-session",
          scope: "session",
          principal,
          sessionId: "session:shared",
        }),
        { value: { owner: principal } },
      );
      assertEquals(
        read(engine, {
          id: "entity:encoded-user",
          scope: "user",
          principal: principals[1 - index],
          sessionId: "session:shared",
        }),
        index === 0 ? null : { value: { owner: principals[0] } },
      );
    }

    const scopeKeys = (
      engine.database.prepare(
        `SELECT DISTINCT scope_key FROM revision WHERE id IN ('entity:encoded-user', 'entity:encoded-session') ORDER BY scope_key`,
      ).all() as Array<{ scope_key: string }>
    ).map((row) => row.scope_key);
    assertEquals(scopeKeys, [
      "session:did%3Akey%3Abar:session%3Ashared",
      "session:did%3Akey%3Afoo:session%3Ashared",
      "user:did%3Akey%3Abar",
      "user:did%3Akey%3Afoo",
    ]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine requires principal context for user and session scoped reads", async () => {
  const { engine, path } = await createEngine();

  try {
    assertThrows(
      () => read(engine, { id: "entity:principal-required", scope: "user" }),
      ProtocolError,
      "user scoped memory operations require a principal",
    );
    assertThrows(
      () =>
        read(engine, {
          id: "entity:principal-required",
          scope: "session",
          sessionId: "session:present",
        }),
      ProtocolError,
      "session scoped memory operations require a principal",
    );
    assertThrows(
      () =>
        read(engine, {
          id: "entity:principal-required",
          scope: "session",
          principal: "did:key:foo",
        }),
      ProtocolError,
      "session scoped memory operations require a session id",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine migrates pre-scope entity tables to space scope", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  const legacyDb = new Database(path, { create: true });
  try {
    legacyDb.exec(`
      CREATE TABLE "commit" (
        seq                INTEGER NOT NULL PRIMARY KEY,
        branch             TEXT    NOT NULL DEFAULT '',
        session_id         TEXT    NOT NULL,
        local_seq          INTEGER NOT NULL,
        invocation_ref     TEXT,
        authorization_ref  TEXT,
        original           JSON    NOT NULL,
        resolution         JSON    NOT NULL,
        created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_commit_session_local_seq
        ON "commit" (session_id, local_seq);
      CREATE TABLE revision (
        branch      TEXT    NOT NULL DEFAULT '',
        id          TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        op_index    INTEGER NOT NULL,
        op          TEXT    NOT NULL,
        data        JSON,
        commit_seq  INTEGER NOT NULL,
        PRIMARY KEY (branch, id, seq, op_index)
      );
      CREATE INDEX idx_revision_branch_id_seq
        ON revision (branch, id, seq, op_index);
      CREATE INDEX idx_revision_commit ON revision (commit_seq);
      CREATE INDEX idx_revision_branch ON revision (branch, seq);
      CREATE TABLE head (
        branch    TEXT    NOT NULL,
        id        TEXT    NOT NULL,
        seq       INTEGER NOT NULL,
        op_index  INTEGER NOT NULL,
        PRIMARY KEY (branch, id)
      );
      CREATE INDEX idx_head_branch ON head (branch);
      CREATE TABLE snapshot (
        branch  TEXT    NOT NULL DEFAULT '',
        id      TEXT    NOT NULL,
        seq     INTEGER NOT NULL,
        value   JSON    NOT NULL,
        PRIMARY KEY (branch, id, seq)
      );
      CREATE INDEX idx_snapshot_lookup ON snapshot (branch, id, seq);
      CREATE TABLE branch (
        name           TEXT    NOT NULL PRIMARY KEY,
        parent_branch  TEXT,
        fork_seq       INTEGER,
        created_seq    INTEGER NOT NULL DEFAULT 0,
        head_seq       INTEGER NOT NULL DEFAULT 0,
        status         TEXT    NOT NULL DEFAULT 'active',
        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        deleted_at     TEXT
      );
      INSERT INTO branch (name, created_seq, head_seq, status)
      VALUES ('', 0, 1, 'active');
      INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution)
      VALUES (1, '', 'legacy-session', 1, '{}', '{}');
    `);
    legacyDb.prepare(
      `INSERT INTO revision (branch, id, seq, op_index, op, data, commit_seq)
       VALUES ('', 'entity:legacy', 1, 0, 'set', ?, 1)`,
    ).run(encodeMemoryBoundary(toEntityDocument({ migrated: true })));
    legacyDb.prepare(
      `INSERT INTO head (branch, id, seq, op_index)
       VALUES ('', 'entity:legacy', 1, 0)`,
    ).run();
    legacyDb.prepare(
      `INSERT INTO snapshot (branch, id, seq, value)
       VALUES ('', 'entity:legacy', 1, ?)`,
    ).run(encodeMemoryBoundary(toEntityDocument({ migrated: true })));
  } finally {
    legacyDb.close();
  }

  let engine = await open({ url });
  try {
    assertEquals(read(engine, { id: "entity:legacy", scope: "space" }), {
      value: { migrated: true },
    });
    applyCommit(engine, {
      sessionId: "session:scoped",
      principal: "did:key:scoped",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:legacy",
          scope: "user",
          value: toEntityDocument({ migrated: false, scoped: true }),
        }],
      },
    });
    assertEquals(read(engine, { id: "entity:legacy", scope: "space" }), {
      value: { migrated: true },
    });
    assertEquals(
      read(engine, {
        id: "entity:legacy",
        scope: "user",
        principal: "did:key:scoped",
        sessionId: "session:scoped",
      }),
      { value: { migrated: false, scoped: true } },
    );
  } finally {
    close(engine);
  }

  engine = await open({ url });
  try {
    assertEquals(read(engine, { id: "entity:legacy", scope: "space" }), {
      value: { migrated: true },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine conflicts are scoped by declared scope", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:conflict",
          scope: "user",
          value: toEntityDocument({ count: 1 }),
        }],
      },
    });

    const spaceWrite = applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:conflict",
            path: toDocumentPath(["value"]),
            seq: 0,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:space-only",
          value: toEntityDocument("ok"),
        }],
      },
    });
    assertEquals(spaceWrite.seq, 2);

    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:conflict",
          scope: "user",
          value: toEntityDocument({ count: 2 }),
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:alice",
          principal: "did:key:alice",
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [{
                id: "entity:conflict",
                scope: "user",
                path: toDocumentPath(["value"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:conflict-result",
              scope: "user",
              value: toEntityDocument("stale"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: leaf-only commit conflict — disjoint-key writers merge, same-key/container readers still conflict", async () => {
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:map";
  const scope = "space" as const;

  try {
    // seq 1: establish a map with keys a, b.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          scope,
          value: toEntityDocument({ a: "1", b: "2" }),
        }],
      },
    });

    // seq 2: a concurrent writer ADDS a new key `c`. An add/remove patch is the
    // case where `touchedPathsForPatch` used to inject the parent ["value"].
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "add", path: "/value/c", value: "3" }],
        }],
      },
    });

    // DISTINCT-KEY: a writer whose conflict read is only the SIBLING key `a`
    // (as a keyed `.set()`'s own-key/diff read is) must NOT conflict with the
    // seq-2 add of `c`. Leaf-only: ["value","c"] does not overlap ["value","a"].
    // Pre-fix (parent-injected ["value"]) this collided — the write-contention bug.
    const merged = applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [{
            id,
            scope,
            path: toDocumentPath(["value", "a"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "add", path: "/value/d", value: "4" }],
        }],
      },
    });
    assertEquals(merged.seq, 3);

    // SAME-KEY: a writer that read `c` (the key the seq-2 add created) MUST still
    // conflict — genuine read-modify-write is preserved (leaf exactly matches).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value", "c"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sink",
              scope,
              value: toEntityDocument("x"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // CONTAINER READER: a writer that read the whole container ["value"] MUST
    // still conflict with a key add (the container's value changed) — caught via
    // the bidirectional overlap (the container read is a prefix of the leaf add).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sink2",
              scope,
              value: toEntityDocument("y"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: nonRecursive shape read conflicts with key add but not a disjoint deep-value write", async () => {
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:shape";
  const scope = "space" as const;

  try {
    // seq 1: container with a value at key x.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          scope,
          value: toEntityDocument({ x: "1" }),
        }],
      },
    });
    // seq 2: a key ADD (changes the container's key-set).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "add", path: "/value/y", value: "3" }],
        }],
      },
    });
    // seq 3: a disjoint DEEP-VALUE replace strictly below the container.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "replace", path: "/value/x", value: "2" }],
        }],
      },
    });

    // A: a SHAPE (nonRecursive) reader of the container observed at seq 2 must
    // NOT conflict with the seq-3 deep-value replace — it never depended on x's
    // value, only the container's shape.
    const ok = applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 4,
        reads: {
          confirmed: [{
            id,
            scope,
            path: toDocumentPath(["value"]),
            seq: 2,
            nonRecursive: true,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:sinkA",
          scope,
          value: toEntityDocument("ok"),
        }],
      },
    });
    assertEquals(ok.seq, 4);

    // B: a RECURSIVE reader of the same container observed at seq 2 MUST conflict
    // with the seq-3 deep-value replace (its read covered x).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value"]),
                seq: 2,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkB",
              scope,
              value: toEntityDocument("x"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // C: a SHAPE reader observed at seq 1 MUST still conflict with the seq-2 key
    // ADD — adding a key changes the key-set the shape read observed.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 6,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value"]),
                seq: 1,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkC",
              scope,
              value: toEntityDocument("y"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine persists set and delete commits as seq revisions", async () => {
  const { engine, path } = await createEngine();

  try {
    const document = toEntityDocument(
      { hello: "world" },
      entityRefFromString("origin"),
    );

    const setResult = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:1",
          value: document,
        }],
      },
    });

    assertEquals(setResult.seq, 1);
    assertEquals(setResult.branch, DEFAULT_BRANCH);
    assertEquals(read(engine, { id: "entity:1" }), document);

    const commitRow = engine.database.prepare(
      `SELECT seq, branch, session_id, local_seq, invocation_ref,
              authorization_ref, original, resolution
       FROM "commit"
       WHERE seq = 1`,
    ).get() as
      | {
        seq: number;
        branch: string;
        session_id: string;
        local_seq: number;
        invocation_ref: string | null;
        authorization_ref: string | null;
        original: string;
        resolution: string;
      }
      | undefined;
    assertExists(commitRow);
    assertEquals(commitRow.seq, 1);
    assertEquals(commitRow.branch, DEFAULT_BRANCH);
    assertEquals(commitRow.session_id, "session:1");
    assertEquals(commitRow.local_seq, 1);
    assertEquals(commitRow.invocation_ref, null);
    assertEquals(commitRow.authorization_ref, null);
    assertEquals(decodeStored(commitRow.original), {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:1",
        value: document,
      }],
    });
    assertEquals(decodeStored(commitRow.resolution), { seq: 1 });

    const revisionRow = engine.database.prepare(
      `SELECT branch, id, seq, op_index, op, data, commit_seq
       FROM revision
       WHERE id = 'entity:1' AND seq = 1`,
    ).get() as
      | {
        branch: string;
        id: string;
        seq: number;
        op_index: number;
        op: string;
        data: string;
        commit_seq: number;
      }
      | undefined;
    assertExists(revisionRow);
    assertEquals(revisionRow.branch, DEFAULT_BRANCH);
    assertEquals(revisionRow.id, "entity:1");
    assertEquals(revisionRow.seq, 1);
    assertEquals(revisionRow.op_index, 0);
    assertEquals(revisionRow.op, "set");
    assertEquals(decodeStored(revisionRow.data), document);
    assertEquals(revisionRow.commit_seq, 1);
    assertEquals(
      engine.database.prepare(
        "SELECT COUNT(*) AS count FROM invocation",
      ).get() as { count: number },
      { count: 0 },
    );
    assertEquals(
      engine.database.prepare(
        "SELECT COUNT(*) AS count FROM authorization",
      ).get() as { count: number },
      { count: 0 },
    );

    const deleteResult = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:1" }],
      },
    });

    assertEquals(deleteResult.seq, 2);
    assertEquals(read(engine, { id: "entity:1" }), null);

    const deleteRevision = engine.database.prepare(
      `SELECT op, data
       FROM revision
       WHERE id = 'entity:1' AND seq = 2`,
    ).get() as
      | {
        op: string;
        data: string | null;
      }
      | undefined;
    assertEquals(deleteRevision, { op: "delete", data: null });

    const headRow = engine.database.prepare(
      `SELECT branch, id, seq, op_index
       FROM head
       WHERE branch = '' AND id = 'entity:1'`,
    ).get() as
      | {
        branch: string;
        id: string;
        seq: number;
        op_index: number;
      }
      | undefined;
    assertEquals(headRow, {
      branch: "",
      id: "entity:1",
      seq: 2,
      op_index: 0,
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine preserves source-only entity documents", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:source-only",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:piece:1",
          value: toEntityDocument(undefined, entityRefFromString("process:1")),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "of:piece:1" }),
      toEntityDocument(undefined, entityRefFromString("process:1")),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine ignores supplied transact invocation metadata", async () => {
  const { engine, path } = await createEngine();

  try {
    const rawInvocation = {
      iss: 42,
      aud: { unexpected: true },
      cmd: ["not", "a", "string"],
      sub: null,
      args: {
        localSeq: 1,
      },
      note: "untrusted transport payload",
    };

    applyCommit(engine, {
      sessionId: "session:raw-invocation",
      invocation: {
        iss: "did:key:space",
        aud: null,
        cmd: "/memory/transact",
        sub: "did:key:space",
        args: {
          localSeq: 1,
        },
      },
      invocationPayload: rawInvocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:raw-invocation",
          value: toEntityDocument({ ok: true }),
        }],
      },
    });

    const row = engine.database.prepare(
      `SELECT invocation_ref, authorization_ref
       FROM "commit"
       WHERE session_id = ? AND local_seq = ?`,
    ).get(["session:raw-invocation", 1]) as
      | {
        invocation_ref: string | null;
        authorization_ref: string | null;
      }
      | undefined;
    assertExists(row);
    assertEquals(row.invocation_ref, null);
    assertEquals(row.authorization_ref, null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine preserves root objects whose data includes value siblings", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:value-siblings",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:value-siblings",
          value: toEntityDocument("hello", undefined, {
            other: "data",
          }),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:value-siblings" }),
      toEntityDocument("hello", undefined, {
        other: "data",
      }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine replays patch revisions for current and point-in-time reads", async () => {
  const { engine, path } = await createEngine();

  try {
    const original = toEntityDocument(
      {
        profile: { name: "Alice" },
        tags: ["one"],
      },
      entityRefFromString("origin"),
    );

    applyCommit(engine, {
      sessionId: "session:patch",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:patch",
          value: original,
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:patch",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:patch",
          patches: [
            { op: "replace", path: "/value/profile/name", value: "Bob" },
            { op: "add", path: "/value/profile/title", value: "Dr" },
            {
              op: "splice",
              path: "/value/tags",
              index: 1,
              remove: 0,
              add: ["two", "three"],
            },
          ],
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:patch" }),
      toEntityDocument(
        {
          profile: { name: "Bob", title: "Dr" },
          tags: ["one", "two", "three"],
        },
        entityRefFromString("origin"),
      ),
    );
    assertEquals(read(engine, { id: "entity:patch", seq: 1 }), original);

    const patchRevision = engine.database.prepare(
      `SELECT op, data
       FROM revision
       WHERE id = 'entity:patch' AND seq = 2`,
    ).get() as
      | {
        op: string;
        data: string;
      }
      | undefined;
    assertEquals(patchRevision?.op, "patch");
    assertEquals(decodeStored(patchRevision?.data), [
      { op: "replace", path: "/value/profile/name", value: "Bob" },
      { op: "add", path: "/value/profile/title", value: "Dr" },
      {
        op: "splice",
        path: "/value/tags",
        index: 1,
        remove: 0,
        add: ["two", "three"],
      },
    ]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine materializes snapshots and reuses them for later reads", async () => {
  const { engine, path } = await createEngineWithOptions({
    snapshotInterval: 2,
  });

  try {
    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:snapshot",
          value: toEntityDocument({ tags: ["one"] }),
        }],
      },
    });

    for (const [localSeq, value] of [[2, "two"], [3, "three"]] as const) {
      applyCommit(engine, {
        sessionId: "session:snapshot",
        invocation: invocationFor(localSeq),
        authorization,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "entity:snapshot",
            patches: [{
              op: "splice",
              path: "/value/tags",
              index: localSeq - 1,
              remove: 0,
              add: [value],
            }],
          }],
        },
      });
    }

    const snapshotRow = engine.database.prepare(
      `SELECT seq, value
       FROM snapshot
       WHERE branch = '' AND id = 'entity:snapshot'
       ORDER BY seq DESC
       LIMIT 1`,
    ).get() as
      | {
        seq: number;
        value: string;
      }
      | undefined;
    assertEquals(snapshotRow?.seq, 3);
    assertEquals(decodeStored(snapshotRow?.value), {
      value: { tags: ["one", "two", "three"] },
    });

    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation: invocationFor(4),
      authorization,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:snapshot",
          patches: [{
            op: "splice",
            path: "/value/tags",
            index: 3,
            remove: 0,
            add: ["four"],
          }],
        }],
      },
    });

    engine.database.prepare(
      "DELETE FROM revision WHERE id = 'entity:snapshot' AND seq = 2",
    ).run();

    assertEquals(
      read(engine, { id: "entity:snapshot", seq: 3 }),
      toEntityDocument({ tags: ["one", "two", "three"] }),
    );
    assertEquals(
      read(engine, { id: "entity:snapshot" }),
      toEntityDocument({ tags: ["one", "two", "three", "four"] }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine compacts old snapshots beyond retention", async () => {
  const { engine, path } = await createEngineWithOptions({
    snapshotInterval: 1,
    snapshotRetention: 2,
  });

  try {
    applyCommit(engine, {
      sessionId: "session:snapshot-retention",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:snapshot-retention",
          value: toEntityDocument({ tags: ["one"] }),
        }],
      },
    });

    for (
      const [localSeq, value] of [[2, "two"], [3, "three"], [
        4,
        "four",
      ]] as const
    ) {
      applyCommit(engine, {
        sessionId: "session:snapshot-retention",
        invocation: invocationFor(localSeq),
        authorization,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "entity:snapshot-retention",
            patches: [{
              op: "splice",
              path: "/value/tags",
              index: localSeq - 1,
              remove: 0,
              add: [value],
            }],
          }],
        },
      });
    }

    const snapshotRows = engine.database.prepare(
      `SELECT seq
       FROM snapshot
       WHERE branch = '' AND id = 'entity:snapshot-retention'
       ORDER BY seq ASC`,
    ).all() as Array<{ seq: number }>;
    assertEquals(snapshotRows, [{ seq: 3 }, { seq: 4 }]);
    assertEquals(
      read(engine, { id: "entity:snapshot-retention", seq: 2 }),
      toEntityDocument({ tags: ["one", "two"] }),
    );
    assertEquals(
      read(engine, { id: "entity:snapshot-retention" }),
      toEntityDocument({ tags: ["one", "two", "three", "four"] }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine rejects stale confirmed reads and allows non-overlapping ones", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toEntityDocument({
            profile: { name: "Alice" },
            settings: { theme: "light" },
          }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath(["value", "settings"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{
            op: "replace",
            path: "/value/settings/theme",
            value: "dark",
          }],
        }],
      },
    });

    const allowed = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath(["value", "profile", "name"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: toEntityDocument({ derivedFromName: true }),
        }],
      },
    });
    assertEquals(allowed.seq, 3);

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(3),
          authorization,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [{
                id: "entity:source",
                path: toDocumentPath(["value", "settings"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:rejected",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    assertEquals(read(engine, { id: "entity:derived" }), {
      value: { derivedFromName: true },
    });
    assertEquals(read(engine, { id: "entity:rejected" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine resolves pending reads and rejects stale pending reads", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toEntityDocument({ foo: 0, bar: 0 }),
        }],
      },
    });

    const base = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath(["value", "foo"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{ op: "replace", path: "/value/foo", value: 1 }],
        }],
      },
    });
    assertEquals(base.seq, 2);

    const derived = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:source",
            path: toDocumentPath(["value", "foo"]),
            localSeq: 2,
          }],
        },
        operations: [{
          op: "set",
          id: "entity:target",
          value: toEntityDocument({ derived: true }),
        }],
      },
    });
    assertEquals(derived.seq, 3);

    const resolutionRow = engine.database.prepare(
      `SELECT resolution
       FROM "commit"
       WHERE session_id = 'session:1' AND local_seq = 3`,
    ).get() as { resolution: string } | undefined;
    assertEquals(decodeStored(resolutionRow?.resolution), {
      seq: 3,
      resolvedPendingReads: [{
        localSeq: 2,
        seq: 2,
      }],
    });

    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{ op: "replace", path: "/value/bar", value: 1 }],
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(4),
          authorization,
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath(["value", "bar"]),
                localSeq: 2,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:broken",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      Error,
      "stale pending read",
    );

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(5),
          authorization,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath(["value"]),
                localSeq: 99,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:missing",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      Error,
      "pending dependency",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine reconstructs state across delete boundaries", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:timeline",
          value: toEntityDocument({
            phase: "one",
            data: { start: true },
          }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:timeline",
          patches: [{ op: "add", path: "/value/data/step", value: 2 }],
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:timeline" }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(4),
      authorization,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:timeline",
          value: toEntityDocument({
            phase: "two",
            data: { restart: true },
          }),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:timeline", seq: 1 }),
      toEntityDocument({ phase: "one", data: { start: true } }),
    );
    assertEquals(
      read(engine, { id: "entity:timeline", seq: 2 }),
      toEntityDocument({ phase: "one", data: { start: true, step: 2 } }),
    );
    assertEquals(read(engine, { id: "entity:timeline", seq: 3 }), null);
    assertEquals(
      read(engine, { id: "entity:timeline" }),
      toEntityDocument({ phase: "two", data: { restart: true } }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine supports branch inheritance, divergence, and deletion", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:branch",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-doc",
          value: toEntityDocument({ count: 1 }),
        }],
      },
    });

    assertEquals(
      createBranch(engine, "feature"),
      {
        name: "feature",
        parentBranch: DEFAULT_BRANCH,
        forkSeq: 1,
        createdSeq: 1,
        headSeq: 1,
        status: "active",
      },
    );
    assertEquals(
      read(engine, { id: "entity:branch-doc", branch: "feature" }),
      toEntityDocument({ count: 1 }),
    );

    applyCommit(engine, {
      sessionId: "session:branch",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-doc",
          value: toEntityDocument({ count: 2 }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:branch",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        branch: "feature",
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-doc",
          value: toEntityDocument({ count: 10 }),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:branch-doc" }),
      toEntityDocument({ count: 2 }),
    );
    assertEquals(
      read(engine, { id: "entity:branch-doc", branch: "feature" }),
      toEntityDocument({ count: 10 }),
    );
    assertEquals(
      listBranches(engine),
      [{
        name: "",
        parentBranch: null,
        forkSeq: null,
        createdSeq: 0,
        headSeq: 2,
        status: "active",
      }, {
        name: "feature",
        parentBranch: "",
        forkSeq: 1,
        createdSeq: 1,
        headSeq: 3,
        status: "active",
      }],
    );

    deleteBranch(engine, "feature");
    assertEquals(
      listBranches(engine).find((branch) => branch.name === "feature"),
      {
        name: "feature",
        parentBranch: "",
        forkSeq: 1,
        createdSeq: 1,
        headSeq: 3,
        status: "deleted",
      },
    );
    assertEquals(
      read(engine, { id: "entity:branch-doc", branch: "feature" }),
      toEntityDocument({ count: 10 }),
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:branch",
          invocation: invocationFor(4),
          authorization,
          commit: {
            localSeq: 4,
            branch: "feature",
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:branch-doc",
              value: toEntityDocument({ count: 11 }),
            }],
          },
        }),
      Error,
      "branch is not active",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine rejects branch reads before createdSeq", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:branch-bounds",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-bounds-doc",
          value: toEntityDocument({ count: 1 }),
        }],
      },
    });
    createBranch(engine, "feature");

    assertThrows(
      () =>
        read(engine, {
          id: "entity:branch-bounds-doc",
          branch: "feature",
          seq: 0,
        }),
      Error,
      "seq 0 is out of range for branch feature",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine persists fabric patch values at the storage boundary", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:rich-patch",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:rich-patch",
          value: toEntityDocument({ counter: 1n }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:rich-patch",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:rich-patch",
          patches: [{
            op: "replace",
            path: "/value/counter",
            value: 2n,
          }],
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:rich-patch" }),
      toEntityDocument({ counter: 2n }),
    );

    const patchRow = engine.database.prepare(
      `SELECT data
         FROM revision
         WHERE id = 'entity:rich-patch' AND seq = 2`,
    ).get() as { data: string } | undefined;
    assertEquals(decodeStored(patchRow?.data), [{
      op: "replace",
      path: "/value/counter",
      value: 2n,
    }]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
