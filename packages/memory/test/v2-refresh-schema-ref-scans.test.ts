// A refresh re-validates the schema-document closure over everything the
// graph has delivered, and must not re-scan what did not change. The
// engine-wide scan cache covers only canonical space-scoped versions and
// clears when it overflows, so a session whose delivered set is large or
// per-user was scanned whole on every commit; the graph state's own record
// (`TrackedGraphState.schemaRefs`) answers the established set instead.

import { assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, close, open } from "../v2/engine.ts";
import { refreshTrackedGraph, toDirtyKey, trackGraph } from "../v2/query.ts";

const identity = { principal: "did:key:alice", sessionId: "session:alice" };

Deno.test("refresh scans only the changed documents, per-user ones included", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  const space = "did:key:z6Mk-memory-v2-refresh-scans";
  const root = "of:refresh-scans-root";
  const argument = "of:refresh-scans-argument";
  const profile = "of:refresh-scans-profile";
  const argumentSchema = {
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
  };
  const rootWith = (title: string) => ({
    value: { title },
    argument: {
      "/": { "link@1": { id: argument, path: [], schema: argumentSchema } },
    },
  });
  const query = {
    roots: [
      { id: root, selector: { path: [], schema: false as const } },
      {
        id: profile,
        scope: "user" as const,
        selector: { path: [], schema: false as const },
      },
    ],
  };
  try {
    applyCommit(engine, {
      sessionId: identity.sessionId,
      principal: identity.principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: argument, value: { value: { label: "shared" } } },
          { op: "set", id: root, value: rootWith("first") },
          {
            op: "set",
            id: profile,
            scope: "user",
            value: { value: { name: "alice" } },
          },
        ],
      },
    });

    const tracked = trackGraph(space, engine, query, undefined, identity);
    // Every delivered document is scanned once on the first evaluation,
    // and the state records each version it scanned.
    assertEquals(tracked.state.entities.size, 3);
    assertEquals(tracked.stats.schemaRefScans, 3);
    assertEquals(tracked.state.schemaRefs.size, 3);

    applyCommit(engine, {
      sessionId: identity.sessionId,
      principal: identity.principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: root, value: rootWith("second") }],
      },
    });

    const refreshed = refreshTrackedGraph(
      space,
      engine,
      tracked.state,
      new Set([toDirtyKey(root)]),
    );
    assertExists(refreshed);
    assertEquals([...refreshed.updates.values()].map((e) => e.id), [root]);
    // The closure was re-validated over all three delivered documents,
    // but only the one that changed was scanned again: the unchanged
    // space-scoped argument and the per-user profile — which no
    // engine-wide cache may hold — were answered from the state's record.
    assertEquals(refreshed.stats.schemaRefScans, 1);
    assertEquals(tracked.state.schemaRefs.size, 3);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
