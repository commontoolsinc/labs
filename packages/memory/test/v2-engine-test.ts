import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  DEFAULT_BRANCH,
  encodeWireEntityDocument,
  toBlobMetadataId,
  toDocumentPath,
  toEntityDocument,
  toSourceLink,
  toWireEntityDocument,
} from "../v2.ts";
import {
  applyCommit,
  close,
  type Engine,
  getBlob,
  open,
  putBlob,
  read,
} from "../v2/engine.ts";

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

Deno.test("memory v2 engine bootstraps the spec-native schema", async () => {
  const { engine, path } = await createEngine();

  try {
    const schemaRows = engine.database.prepare(
      `SELECT name, type
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'view')
       ORDER BY type, name`,
    ).all() as Array<{ name: string; type: string }>;

    assertEquals(
      schemaRows,
      [
        { name: "authorization", type: "table" },
        { name: "blob_store", type: "table" },
        { name: "branch", type: "table" },
        { name: "commit", type: "table" },
        { name: "fact", type: "table" },
        { name: "head", type: "table" },
        { name: "invocation", type: "table" },
        { name: "snapshot", type: "table" },
        { name: "value", type: "table" },
        { name: "state", type: "view" },
      ],
    );

    const emptyValue = engine.database.prepare(
      "SELECT hash, data FROM value WHERE hash = '__empty__'",
    ).get() as { hash: string; data: null } | undefined;
    assertEquals(emptyValue, { hash: "__empty__", data: null });

    const defaultBranch = engine.database.prepare(
      "SELECT name, created_seq, head_seq, status FROM branch WHERE name = ''",
    ).get() as
      | {
        name: string;
        created_seq: number;
        head_seq: number;
        status: string;
      }
      | undefined;
    assertEquals(defaultBranch, {
      name: "",
      created_seq: 0,
      head_seq: 0,
      status: "active",
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine persists set and delete commits", async () => {
  const { engine, path } = await createEngine();

  try {
    const document = toEntityDocument(
      { hello: "world" },
      toSourceLink("origin"),
    );
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    const setResult = applyCommit(engine, {
      sessionId: "session:1",
      invocation,
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
      `SELECT seq, hash, branch, session_id, local_seq, invocation_ref,
              authorization_ref, original, resolution
       FROM "commit"
       WHERE seq = 1`,
    ).get() as
      | {
        seq: number;
        hash: string;
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
      operations: [{ op: "set", id: "entity:1", value: document }],
    });
    assertEquals(JSON.parse(commitRow.resolution), { seq: 1 });

    const factRow = engine.database.prepare(
      `SELECT hash, id, value_ref, parent, branch, seq, commit_seq, fact_type
       FROM fact
       WHERE seq = 1`,
    ).get() as
      | {
        hash: string;
        id: string;
        value_ref: string;
        parent: string | null;
        branch: string;
        seq: number;
        commit_seq: number;
        fact_type: string;
      }
      | undefined;
    assertExists(factRow);
    assertEquals(factRow.id, "entity:1");
    assertEquals(factRow.parent, null);
    assertEquals(factRow.branch, DEFAULT_BRANCH);
    assertEquals(factRow.seq, 1);
    assertEquals(factRow.commit_seq, 1);
    assertEquals(factRow.fact_type, "set");

    const invocationRow = engine.database.prepare(
      "SELECT ref, iss, aud, cmd, sub, invocation FROM invocation WHERE ref = ?",
    ).get([commitRow.invocation_ref]) as
      | {
        ref: string;
        iss: string;
        aud: string | null;
        cmd: string;
        sub: string;
        invocation: string;
      }
      | undefined;
    assertExists(invocationRow);
    assertEquals(invocationRow.iss, "did:key:alice");
    assertEquals(invocationRow.aud, "did:key:service");
    assertEquals(invocationRow.cmd, "/memory/transact");
    assertEquals(invocationRow.sub, "did:key:space");
    assertEquals(JSON.parse(invocationRow.invocation), invocation);

    const authorizationRow = engine.database.prepare(
      "SELECT ref, authorization FROM authorization WHERE ref = ?",
    ).get([commitRow.authorization_ref]) as
      | {
        ref: string;
        authorization: string;
      }
      | undefined;
    assertExists(authorizationRow);
    assertEquals(JSON.parse(authorizationRow.authorization), authorization);

    const deleteResult = applyCommit(engine, {
      sessionId: "session:1",
      invocation: {
        ...invocation,
        args: { localSeq: 2 },
      },
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:1" }],
      },
    });

    assertEquals(deleteResult.seq, 2);
    assertEquals(read(engine, { id: "entity:1" }), null);

    const deleteFact = engine.database.prepare(
      `SELECT hash, value_ref, parent, fact_type
       FROM fact
       WHERE seq = 2`,
    ).get() as
      | {
        hash: string;
        value_ref: string;
        parent: string | null;
        fact_type: string;
      }
      | undefined;
    assertExists(deleteFact);
    assertEquals(deleteFact.value_ref, "__empty__");
    assertEquals(deleteFact.parent, factRow.hash);
    assertEquals(deleteFact.fact_type, "delete");

    const headRow = engine.database.prepare(
      `SELECT branch, id, fact_hash, seq
       FROM head
       WHERE branch = '' AND id = 'entity:1'`,
    ).get() as
      | {
        branch: string;
        id: string;
        fact_hash: string;
        seq: number;
      }
      | undefined;
    assertEquals(headRow, {
      branch: "",
      id: "entity:1",
      fact_hash: deleteFact.hash,
      seq: 2,
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
      invocation: {
        iss: "did:key:alice",
        aud: "did:key:service",
        cmd: "/memory/transact",
        sub: "did:key:space",
      },
      authorization: {
        signature: "sig:alice",
        access: { "proof:1": {} },
      },
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

Deno.test("memory v2 engine allows multiple commits to reuse the same invocation", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    const first = applyCommit(engine, {
      sessionId: "session:1",
      invocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:1",
          value: toWireEntityDocument({ hello: "world" }),
        }],
      },
    });

    const second = applyCommit(engine, {
      sessionId: "session:2",
      invocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:2",
          value: toWireEntityDocument({ hello: "again" }),
        }],
      },
    });

    assertEquals(first.seq, 1);
    assertEquals(second.seq, 2);
    assertEquals(
      read(engine, { id: "entity:2" }),
      toEntityDocument({ hello: "again" }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine replays patch facts for current and point-in-time reads", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };
    const original = toEntityDocument(
      {
        profile: { name: "Alice" },
        tags: ["one"],
      },
      toSourceLink("origin"),
    );

    applyCommit(engine, {
      sessionId: "session:1",
      invocation,
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
      sessionId: "session:1",
      invocation: {
        ...invocation,
        args: { localSeq: 2 },
      },
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
        { "/": "origin" },
      ),
    );
    assertEquals(read(engine, { id: "entity:patch", seq: 1 }), original);

    const patchFact = engine.database.prepare(
      `SELECT fact_type, value_ref
       FROM fact
       WHERE id = 'entity:patch' AND seq = 2`,
    ).get() as
      | {
        fact_type: string;
        value_ref: string;
      }
      | undefined;
    assertEquals(patchFact?.fact_type, "patch");

    const patchValue = engine.database.prepare(
      "SELECT data FROM value WHERE hash = ?",
    ).get([patchFact?.value_ref]) as { data: string } | undefined;
    assertEquals(JSON.parse(patchValue?.data ?? "null"), [
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
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };
    const original = toEntityDocument({
      tags: ["one"],
    });

    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:snapshot",
          value: encodeWireEntityDocument(original),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation: {
        ...invocation,
        args: { localSeq: 2 },
      },
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:snapshot",
          patches: [{
            op: "splice",
            path: "/value/tags",
            index: 1,
            remove: 0,
            add: ["two"],
          }],
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation: {
        ...invocation,
        args: { localSeq: 3 },
      },
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:snapshot",
          patches: [{
            op: "splice",
            path: "/value/tags",
            index: 2,
            remove: 0,
            add: ["three"],
          }],
        }],
      },
    });

    const snapshotRow = engine.database.prepare(
      `SELECT seq, value_ref
       FROM snapshot
       WHERE branch = '' AND id = 'entity:snapshot'
       ORDER BY seq DESC
       LIMIT 1`,
    ).get() as
      | {
        seq: number;
        value_ref: string;
      }
      | undefined;
    assertExists(snapshotRow);
    assertEquals(snapshotRow.seq, 3);

    const snapshotValue = engine.database.prepare(
      "SELECT data FROM value WHERE hash = ?",
    ).get([snapshotRow.value_ref]) as { data: string } | undefined;
    assertEquals(
      JSON.parse(snapshotValue?.data ?? "null"),
      toEntityDocument({ tags: ["one", "two", "three"] }),
    );

    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation: {
        ...invocation,
        args: { localSeq: 4 },
      },
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
      "DELETE FROM fact WHERE id = 'entity:snapshot' AND seq = 2",
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
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    applyCommit(engine, {
      sessionId: "session:snapshot-retention",
      invocation,
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
        invocation: {
          ...invocation,
          args: { localSeq },
        },
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

Deno.test("memory v2 engine stores immutable blobs separately from entity facts", async () => {
  const { engine, path } = await createEngine();

  try {
    const payload = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const blob = putBlob(engine, {
      value: payload,
      contentType: "application/octet-stream",
    });

    assertEquals(blob.size, payload.byteLength);
    assertEquals(blob.contentType, "application/octet-stream");
    assertEquals(toBlobMetadataId(blob.hash), `urn:blob-meta:${blob.hash}`);

    const stored = getBlob(engine, blob.hash);
    assertEquals(stored, {
      hash: blob.hash,
      value: payload,
      contentType: "application/octet-stream",
      size: payload.byteLength,
    });

    const duplicate = putBlob(engine, {
      value: payload,
      contentType: "application/octet-stream",
    });
    assertEquals(duplicate.hash, blob.hash);

    const blobCount = engine.database.prepare(
      "SELECT COUNT(*) AS count FROM blob_store WHERE hash = ?",
    ).get([blob.hash]) as { count: number } | undefined;
    assertEquals(blobCount?.count, 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 blob metadata remains ordinary entity state separate from blob payloads", async () => {
  const { engine, path } = await createEngine();

  try {
    const payload = new Uint8Array([6, 5, 4, 3, 2, 1]);
    const blob = putBlob(engine, {
      value: payload,
      contentType: "application/octet-stream",
    });
    const metadataId = toBlobMetadataId(blob.hash);
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    applyCommit(engine, {
      sessionId: "session:blob-meta",
      invocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: metadataId,
          value: toWireEntityDocument({
            blob: blob.hash,
            label: "profile-photo",
          }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:blob-meta",
      invocation: {
        ...invocation,
        args: { localSeq: 2 },
      },
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:attachment",
          value: toWireEntityDocument({
            attachment: { "/": blob.hash },
          }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:blob-meta",
      invocation: {
        ...invocation,
        args: { localSeq: 3 },
      },
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "delete",
          id: "entity:attachment",
        }],
      },
    });

    assertEquals(
      read(engine, { id: metadataId }),
      toEntityDocument({
        blob: blob.hash,
        label: "profile-photo",
      }),
    );
    assertEquals(getBlob(engine, blob.hash), {
      hash: blob.hash,
      value: payload,
      contentType: "application/octet-stream",
      size: payload.byteLength,
    });

    applyCommit(engine, {
      sessionId: "session:blob-meta",
      invocation: {
        ...invocation,
        args: { localSeq: 4 },
      },
      authorization,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "delete",
          id: metadataId,
        }],
      },
    });

    assertEquals(read(engine, { id: metadataId }), null);
    assertEquals(getBlob(engine, blob.hash), {
      hash: blob.hash,
      value: payload,
      contentType: "application/octet-stream",
      size: payload.byteLength,
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine rejects commits with stale confirmed reads", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    applyCommit(engine, {
      sessionId: "session:1",
      invocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath([]),
            seq: 0,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toWireEntityDocument({ count: 1 }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:other",
      invocation: {
        ...invocation,
        args: { localSeq: 1, actor: "other" },
      },
      authorization,
      commit: {
        localSeq: 1,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath([]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toWireEntityDocument({ count: 2 }),
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: {
            ...invocation,
            args: { localSeq: 2 },
          },
          authorization,
          commit: {
            localSeq: 2,
            reads: {
              confirmed: [{
                id: "entity:source",
                path: toDocumentPath([]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:target",
              value: toWireEntityDocument({ copied: true }),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    const rejectedCommit = engine.database.prepare(
      `SELECT seq
       FROM "commit"
       WHERE session_id = 'session:1' AND local_seq = 2`,
    ).get() as { seq: number } | undefined;
    assertEquals(rejectedCommit, undefined);
    assertEquals(read(engine, { id: "entity:target" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine preserves root objects with value siblings", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    applyCommit(engine, {
      sessionId: "session:value-siblings",
      invocation,
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

Deno.test("memory v2 engine allows non-overlapping confirmed reads to commit", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    applyCommit(engine, {
      sessionId: "session:1",
      invocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath([]),
            seq: 0,
          }],
          pending: [],
        },
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
      invocation: {
        ...invocation,
        args: { localSeq: 1, actor: "other" },
      },
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

    const derived = applyCommit(engine, {
      sessionId: "session:1",
      invocation: {
        ...invocation,
        args: { localSeq: 2 },
      },
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
          id: "entity:target",
          value: toWireEntityDocument({ derivedFromName: true }),
        }],
      },
    });

    assertEquals(derived.seq, 3);
    assertEquals(
      read(engine, { id: "entity:target" }),
      toEntityDocument({ derivedFromName: true }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine resolves pending reads by session localSeq", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    const first = applyCommit(engine, {
      sessionId: "session:1",
      invocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toWireEntityDocument({ count: 1 }),
        }],
      },
    });

    const second = applyCommit(engine, {
      sessionId: "session:1",
      invocation: {
        ...invocation,
        args: { localSeq: 2 },
      },
      authorization,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:source",
            path: toDocumentPath([]),
            localSeq: 1,
          }],
        },
        operations: [{
          op: "set",
          id: "entity:target",
          value: toWireEntityDocument({ derived: true }),
        }],
      },
    });

    assertEquals(second.seq, 2);

    const secondCommit = engine.database.prepare(
      `SELECT resolution
       FROM "commit"
       WHERE seq = 2`,
    ).get() as { resolution: string } | undefined;
    assertEquals(JSON.parse(secondCommit?.resolution ?? "null"), {
      seq: 2,
      resolvedPendingReads: [{
        localSeq: 1,
        hash: first.hash,
        seq: 1,
      }],
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: {
            ...invocation,
            args: { localSeq: 3 },
          },
          authorization,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath([]),
                localSeq: 99,
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
      "pending dependency",
    );

    assertEquals(read(engine, { id: "entity:broken" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine rejects pending reads when later commits touch the read path", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    applyCommit(engine, {
      sessionId: "session:1",
      invocation,
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

    const localBase = applyCommit(engine, {
      sessionId: "session:1",
      invocation: {
        ...invocation,
        args: { localSeq: 2 },
      },
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
    assertEquals(localBase.seq, 2);

    const remote = applyCommit(engine, {
      sessionId: "session:2",
      invocation: {
        ...invocation,
        args: { localSeq: 1, actor: "other" },
      },
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
    assertEquals(remote.seq, 3);

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: {
            ...invocation,
            args: { localSeq: 3 },
          },
          authorization,
          commit: {
            localSeq: 3,
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
              id: "entity:target",
              value: toWireEntityDocument({ derived: true }),
            }],
          },
        }),
      Error,
      "stale pending read",
    );

    assertEquals(read(engine, { id: "entity:target" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine enforces the confirmed-read overlap matrix", async () => {
  const cases = [
    {
      name: "parent read conflicts with child replace",
      readPath: ["value", "profile"],
      remotePatches: [{
        op: "replace",
        path: "/value/profile/name",
        value: "Bob",
      }],
      expectConflict: true,
    },
    {
      name: "sibling read survives unrelated replace",
      readPath: ["value", "profile", "name"],
      remotePatches: [{
        op: "replace",
        path: "/value/settings/theme",
        value: "dark",
      }],
      expectConflict: false,
    },
    {
      name: "child read conflicts when parent is replaced",
      readPath: ["value", "profile", "name"],
      remotePatches: [{
        op: "replace",
        path: "/value/profile",
        value: { name: "Bob", title: "Dr" },
      }],
      expectConflict: true,
    },
    {
      name: "array element read conflicts with splice",
      readPath: ["value", "items", "0"],
      remotePatches: [{
        op: "splice",
        path: "/value/items",
        index: 0,
        remove: 0,
        add: ["zero"],
      }],
      expectConflict: true,
    },
    {
      name: "sibling branch read survives unrelated add",
      readPath: ["value", "settings"],
      remotePatches: [{
        op: "add",
        path: "/value/profile/title",
        value: "Dr",
      }],
      expectConflict: false,
    },
    {
      name: "escaped pointer read conflicts with matching replace",
      readPath: ["value", "a/b"],
      remotePatches: [{ op: "replace", path: "/value/a~1b", value: 2 }],
      expectConflict: true,
    },
  ] as const;

  for (const testCase of cases) {
    const { engine, path } = await createEngine();
    try {
      const invocation = {
        iss: "did:key:alice",
        aud: "did:key:service",
        cmd: "/memory/transact",
        sub: "did:key:space",
        args: { localSeq: 1, case: testCase.name },
      };
      const authorization = {
        signature: "sig:alice",
        access: { "proof:1": {} },
      };

      applyCommit(engine, {
        sessionId: "session:1",
        invocation,
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
              items: ["one"],
              "a/b": 1,
            }),
          }],
        },
      });

      applyCommit(engine, {
        sessionId: "session:other",
        invocation: {
          ...invocation,
          args: { localSeq: 1, actor: "other", case: testCase.name },
        },
        authorization,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "entity:source",
            patches: testCase.remotePatches as any,
          }],
        },
      });

      const commit = () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: {
            ...invocation,
            args: { localSeq: 2, case: testCase.name },
          },
          authorization,
          commit: {
            localSeq: 2,
            reads: {
              confirmed: [{
                id: "entity:source",
                path: toDocumentPath(testCase.readPath),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:derived",
              value: toWireEntityDocument({ case: testCase.name }),
            }],
          },
        });

      if (testCase.expectConflict) {
        assertThrows(commit, Error, "stale confirmed read");
        assertEquals(read(engine, { id: "entity:derived" }), null);
      } else {
        const applied = commit();
        assertEquals(applied.seq, 3);
        assertEquals(
          read(engine, { id: "entity:derived" }),
          toEntityDocument({ case: testCase.name }),
        );
      }
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  }
});

Deno.test("memory v2 engine reconstructs point-in-time state across delete boundaries", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation,
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
      invocation: { ...invocation, args: { localSeq: 2 } },
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
      invocation: { ...invocation, args: { localSeq: 3 } },
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:timeline" }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: { ...invocation, args: { localSeq: 4 } },
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

    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: { ...invocation, args: { localSeq: 5 } },
      authorization,
      commit: {
        localSeq: 5,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:timeline",
          patches: [{ op: "add", path: "/value/data/final", value: 5 }],
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
      read(engine, { id: "entity:timeline", seq: 4 }),
      toEntityDocument({ phase: "two", data: { restart: true } }),
    );
    assertEquals(
      read(engine, { id: "entity:timeline", seq: 5 }),
      toEntityDocument({ phase: "two", data: { restart: true, final: 5 } }),
    );
    assertEquals(
      read(engine, { id: "entity:timeline" }),
      toEntityDocument({ phase: "two", data: { restart: true, final: 5 } }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine snapshots do not leak pre-delete state into rebuilt documents", async () => {
  const { engine, path } = await createEngineWithOptions({
    snapshotInterval: 1,
  });

  try {
    const invocation = {
      iss: "did:key:alice",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
      args: { localSeq: 1 },
    };
    const authorization = {
      signature: "sig:alice",
      access: { "proof:1": {} },
    };

    applyCommit(engine, {
      sessionId: "session:snapshot-delete",
      invocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:snapshot-delete",
          value: toWireEntityDocument({ before: { kept: true } }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:snapshot-delete",
      invocation: { ...invocation, args: { localSeq: 2 } },
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:snapshot-delete",
          patches: [{ op: "add", path: "/value/before/count", value: 2 }],
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:snapshot-delete",
      invocation: { ...invocation, args: { localSeq: 3 } },
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:snapshot-delete" }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:snapshot-delete",
      invocation: { ...invocation, args: { localSeq: 4 } },
      authorization,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:snapshot-delete",
          value: toWireEntityDocument({ after: { rebuilt: true } }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:snapshot-delete",
      invocation: { ...invocation, args: { localSeq: 5 } },
      authorization,
      commit: {
        localSeq: 5,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:snapshot-delete",
          patches: [{ op: "add", path: "/value/after/final", value: 5 }],
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:snapshot-delete", seq: 2 }),
      toEntityDocument({ before: { kept: true, count: 2 } }),
    );
    assertEquals(read(engine, { id: "entity:snapshot-delete", seq: 3 }), null);
    assertEquals(
      read(engine, { id: "entity:snapshot-delete", seq: 5 }),
      toEntityDocument({ after: { rebuilt: true, final: 5 } }),
    );
    assertEquals(
      read(engine, { id: "entity:snapshot-delete" }),
      toEntityDocument({ after: { rebuilt: true, final: 5 } }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
