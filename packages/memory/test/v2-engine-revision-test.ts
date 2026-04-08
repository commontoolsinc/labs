import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  getBlob,
  open,
  ProtocolError,
  putBlob,
  read,
} from "../v2/engine.ts";

const createEngine = async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

Deno.test("memory v2 engine bootstraps the revision schema", async () => {
  const { engine, path } = await createEngine();

  try {
    const schemaRows = engine.database.prepare(
      `SELECT name, type
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND type = 'table'
       ORDER BY name`,
    ).all() as Array<{ name: string; type: string }>;

    assertEquals(
      schemaRows.map((row) => row.name),
      [
        "authorization",
        "blob_store",
        "branch",
        "commit",
        "head",
        "invocation",
        "revision",
        "snapshot",
      ],
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine replays identical (sessionId, localSeq) commits and rejects mismatched originals", async () => {
  const { engine, path } = await createEngine();

  try {
    const invocation = {
      iss: "did:key:test",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: "did:key:space",
    };
    const authorization = { proof: "ok" };
    const firstCommit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set" as const,
        id: "of:doc:1",
        value: {
          value: {
            hello: "world",
          },
        },
      }],
    };

    const first = applyCommit(engine, {
      sessionId: "session:test",
      invocation,
      authorization,
      commit: firstCommit,
    });
    const replay = applyCommit(engine, {
      sessionId: "session:test",
      invocation,
      authorization,
      commit: firstCommit,
    });

    assertEquals(replay.seq, first.seq);
    assertEquals(read(engine, { id: "of:doc:1" }), {
      value: { hello: "world" },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:test",
          invocation,
          authorization,
          commit: {
            ...firstCommit,
            operations: [{
              op: "set",
              id: "of:doc:1",
              value: {
                value: {
                  hello: "different",
                },
              },
            }],
          },
        }),
      ProtocolError,
      "commit replay mismatch",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine keeps blob payloads separate from JSON entity revisions", async () => {
  const { engine, path } = await createEngine();

  try {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const blob = putBlob(engine, {
      value: payload,
      contentType: "application/octet-stream",
    });

    assertEquals(blob.size, payload.byteLength);
    assertEquals(blob.contentType, "application/octet-stream");
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
