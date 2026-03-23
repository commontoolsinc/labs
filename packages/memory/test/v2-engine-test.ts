import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  createBranch,
  deleteBranch,
  type Engine,
  listBranches,
  open,
  read,
} from "../v2/engine.ts";
import {
  DEFAULT_BRANCH,
  encodeWireEntityDocument,
  toDocumentPath,
  toEntityDocument,
  toSourceLink,
  toWireEntityDocument,
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

Deno.test("memory v2 engine persists set and delete commits as seq revisions", async () => {
  const { engine, path } = await createEngine();

  try {
    const document = toEntityDocument(
      { hello: "world" },
      toSourceLink("origin"),
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
          value: encodeWireEntityDocument(document),
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
        invocation_ref: string;
        authorization_ref: string;
        original: string;
        resolution: string;
      }
      | undefined;
    assertExists(commitRow);
    assertEquals(commitRow.seq, 1);
    assertEquals(commitRow.branch, DEFAULT_BRANCH);
    assertEquals(commitRow.session_id, "session:1");
    assertEquals(commitRow.local_seq, 1);
    assertEquals(JSON.parse(commitRow.original), {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:1",
        value: document,
      }],
    });
    assertEquals(JSON.parse(commitRow.resolution), { seq: 1 });

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
    assertEquals(JSON.parse(revisionRow.data), document);
    assertEquals(revisionRow.commit_seq, 1);

    const invocationRow = engine.database.prepare(
      "SELECT invocation FROM invocation WHERE ref = ?",
    ).get([commitRow.invocation_ref]) as
      | { invocation: string }
      | undefined;
    const authorizationRow = engine.database.prepare(
      "SELECT authorization FROM authorization WHERE ref = ?",
    ).get([commitRow.authorization_ref]) as
      | { authorization: string }
      | undefined;
    assertEquals(
      JSON.parse(invocationRow?.invocation ?? "null"),
      invocationFor(1),
    );
    assertEquals(
      JSON.parse(authorizationRow?.authorization ?? "null"),
      authorization,
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
          value: toWireEntityDocument(undefined, toSourceLink("process:1")),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "of:piece:1" }),
      toEntityDocument(undefined, toSourceLink("process:1")),
    );
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
          value: toWireEntityDocument("hello", undefined, {
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
      toSourceLink("origin"),
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
          value: encodeWireEntityDocument(original),
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
        toSourceLink("origin"),
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
    assertEquals(JSON.parse(patchRevision?.data ?? "null"), [
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
          value: toWireEntityDocument({ tags: ["one"] }),
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
    assertEquals(JSON.parse(snapshotRow?.value ?? "null"), {
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
          value: toWireEntityDocument({ tags: ["one"] }),
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
          value: toWireEntityDocument({
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
          value: toWireEntityDocument({ derivedFromName: true }),
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
              value: toWireEntityDocument({ ok: false }),
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
          value: toWireEntityDocument({ foo: 0, bar: 0 }),
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
          value: toWireEntityDocument({ derived: true }),
        }],
      },
    });
    assertEquals(derived.seq, 3);

    const resolutionRow = engine.database.prepare(
      `SELECT resolution
       FROM "commit"
       WHERE session_id = 'session:1' AND local_seq = 3`,
    ).get() as { resolution: string } | undefined;
    assertEquals(JSON.parse(resolutionRow?.resolution ?? "null"), {
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
              value: toWireEntityDocument({ ok: false }),
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
              value: toWireEntityDocument({ ok: false }),
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
          value: toWireEntityDocument({
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
          value: toWireEntityDocument({
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
          value: toWireEntityDocument({ count: 1 }),
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
          value: toWireEntityDocument({ count: 2 }),
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
          value: toWireEntityDocument({ count: 10 }),
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
              value: toWireEntityDocument({ count: 11 }),
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
