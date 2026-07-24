import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, close, open, ProtocolError, read } from "../v2/engine.ts";

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
        "authorization_epoch",
        "blob_store",
        "branch",
        "commit",
        "execution_lease",
        "head",
        "invocation",
        "legacy_background_exclusion",
        "revision",
        "scheduler_action_cause",
        "scheduler_action_snapshot",
        "scheduler_action_state",
        "scheduler_context_floor",
        "scheduler_observation",
        "scheduler_observation_replay",
        "scheduler_read_index",
        "scheduler_write_index",
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

// ---------------------------------------------------------------------------
// Merge-rebased patch revisions carry the authoritative post-apply document
// (C2.10 defect-1 root fix). A patch landing on a head ANOTHER session
// authored is applied against a base the origin client may never have seen —
// its locally materialized post-commit value then diverges from the accepted
// head, and the FA14 echo suppression (a session never receives its own
// committed write back) makes that divergence PERMANENT unless the commit
// RESPONSE carries the truth. Same-session heads stay slim: the origin's
// local chain replay is byte-equal by induction. Found by the C2.10
// lunch-poll placement harness (the second concurrent voter's replica kept
// the pre-merge votes list forever).
Deno.test("memory v2 engine marks merge-rebased patch revisions with the post-apply document", async () => {
  const { engine, path } = await createEngine();
  const id = "of:merge-rebase:votes";

  try {
    // Session A seeds the doc and then patches its OWN head: both revisions
    // stay slim (set carries its own payload; the self-head patch must NOT
    // carry a document — the uncontended hot path).
    applyCommit(engine, {
      sessionId: "session:a",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set" as const,
          id,
          value: { value: { list: ["seed"] } },
        }],
      },
    });
    const selfPatch = applyCommit(engine, {
      sessionId: "session:a",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch" as const,
          id,
          patches: [{ op: "add", path: "/value/list/1", value: "A" }],
        }],
      },
    });
    assertEquals(selfPatch.revisions.length, 1);
    assertEquals(selfPatch.revisions[0].op, "patch");
    assertEquals(
      selfPatch.revisions[0].document,
      undefined,
      "a patch on the session's OWN head must stay slim (no document)",
    );

    // Session B patches the same doc without having seen session A's head:
    // the engine rebases the patch onto A's head, so B's local replay cannot
    // know the result — the revision must carry the authoritative document.
    const mergedPatch = applyCommit(engine, {
      sessionId: "session:b",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch" as const,
          id,
          patches: [{ op: "add", path: "/value/list/1", value: "B" }],
        }],
      },
    });
    assertEquals(mergedPatch.revisions.length, 1);
    assertEquals(mergedPatch.revisions[0].op, "patch");
    assertEquals(
      mergedPatch.revisions[0].document,
      { value: { list: ["seed", "B", "A"] } },
      "a merge-rebased patch revision must carry the post-apply document",
    );
    // The carried document IS the accepted head truth.
    assertEquals(read(engine, { id }), mergedPatch.revisions[0].document);

    // Replays cannot re-derive the original merge decision cheaply, so they
    // fail toward authority: the replayed revision carries the document too.
    const replay = applyCommit(engine, {
      sessionId: "session:b",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch" as const,
          id,
          patches: [{ op: "add", path: "/value/list/1", value: "B" }],
        }],
      },
    });
    assertEquals(replay.seq, mergedPatch.seq);
    assertEquals(
      replay.revisions[0].document,
      { value: { list: ["seed", "B", "A"] } },
      "a replayed patch revision must carry the post-apply document",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
