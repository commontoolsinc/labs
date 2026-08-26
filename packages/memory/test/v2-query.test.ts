import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { toFileUrl } from "@std/path";
import type { JSONSchema } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { encodeMemoryBoundary } from "../v2.ts";
import {
  applyCommit,
  close,
  createBranch,
  type Engine,
  open,
} from "../v2/engine.ts";
import {
  EngineObjectManager,
  extendTrackedGraph,
  fromDirtyKey,
  fromDocKey,
  isGraphQueryCoveredByState,
  queryGraph,
  refreshTrackedGraph,
  toDirtyKey,
  toDocKey,
  trackGraph,
} from "../v2/query.ts";
import { createGraphFixture } from "./v2-graph.fixture.ts";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const invocationFor = (localSeq: number) => ({
  iss: "did:key:alice",
  aud: "did:key:service",
  cmd: "/memory/transact",
  sub: "did:key:space",
  args: { localSeq },
});

const authorization = {
  signature: "sig:alice",
  access: { "proof:1": {} },
};

Deno.test("memory v2 query keys carry the scope INSTANCE (stage E)", () => {
  // The doc-key constructor builds the middle segment from the shared
  // scope_key vocabulary, resolved against the querying session's
  // identity; fromDocKey recovers the scope NAME from the instance key.
  const identity = { principal: "did:key:alice", sessionId: "sess-1" };
  assertEquals(
    toDocKey("did:key:space", "of:doc", "user", identity),
    "did:key:space/user:did%3Akey%3Aalice/of:doc",
  );
  assertEquals(
    fromDocKey(toDocKey("did:key:space", "of:doc", "user", identity)),
    {
      space: "did:key:space",
      scope: "user",
      scopeKey: "user:did%3Akey%3Aalice",
      id: "of:doc",
    },
  );
  assertEquals(
    fromDocKey(toDocKey("did:key:space", "of:doc", "session", identity)),
    {
      space: "did:key:space",
      scope: "session",
      scopeKey: "session:did%3Akey%3Aalice:sess-1",
      id: "of:doc",
    },
  );
  assertEquals(
    fromDocKey("did:key:space/space/of:doc"),
    {
      space: "did:key:space",
      scope: "space",
      scopeKey: "space",
      id: "of:doc",
    },
  );
  // Dirtiness keys by scope INSTANCE too (stage F's M4 re-key): the
  // dirty key's first segment is the shared scope_key vocabulary.
  assertEquals(fromDirtyKey("session:did%3Akey%3Aalice:sess-1\0of:doc"), {
    scopeKey: "session:did%3Akey%3Aalice:sess-1",
    scope: "session",
    id: "of:doc",
  });

  assertThrows(
    () => fromDocKey("did:key:space/of:doc" as never),
    Error,
    "invalid memory v2 query doc key",
  );
  // A scope NAME is not an instance key: the un-keyed user/session forms
  // are invalid once the vocabulary is per instance.
  assertThrows(
    () => fromDocKey("did:key:space/user/of:doc" as never),
    Error,
    "invalid memory v2 query doc key",
  );
  assertThrows(
    () => fromDirtyKey("session\0of:doc"),
    Error,
    "invalid memory v2 dirty key",
  );
  assertThrows(
    () => fromDirtyKey("of:doc"),
    Error,
    "invalid memory v2 dirty key",
  );
});

Deno.test("memory v2 queryGraph reads the declared scoped root instance", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-scopes";

  try {
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:scoped-query-root",
          value: { value: { name: "space" } },
        }, {
          op: "set",
          id: "of:scoped-query-root",
          scope: "user",
          value: { value: { name: "alice" } },
        }],
      },
    });

    const result = queryGraph(
      space,
      engine,
      {
        roots: [{
          id: "of:scoped-query-root",
          scope: "user",
          selector: {
            path: [],
            schema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        }],
      },
      undefined,
      { principal: "did:key:alice", sessionId: "session:alice" },
    );

    assertEquals(result.entities, [{
      branch: "",
      id: "of:scoped-query-root",
      scope: "user",
      seq: 1,
      document: { value: { name: "alice" } },
    }]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query retains a persistent memo for incremental watch growth", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-watch-growth";
  const fixture = createGraphFixture(space);

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: fixture.docs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: fixture.rootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });

    assert(tracked.state.memo.size > 0);
    const memo = tracked.state.memo;
    const initialMemoSize = memo.size;

    const extended = extendTrackedGraph(space, engine, tracked.state, {
      roots: [{
        id: fixture.hiddenRootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });

    assertStrictEquals(tracked.state.memo, memo);
    assert(tracked.state.memo.size >= initialMemoSize);
    assert(
      [...extended.updates.values()].some((entity) =>
        entity.id === fixture.hiddenRootId
      ),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query reports read and traversal stats", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-stats";
  const fixture = createGraphFixture(space);

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: fixture.docs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: fixture.rootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });

    assertEquals(
      tracked.stats.managerReads,
      fixture.initialReachableIds.length,
    );
    assert(tracked.stats.schemaTraversals > 0);
    assertEquals(tracked.stats.coveredSelectorSkips, 0);

    const extended = extendTrackedGraph(space, engine, tracked.state, {
      roots: [{
        id: fixture.rootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });

    assertEquals(extended.stats.managerReads, 0);
    assertEquals(extended.stats.schemaTraversals, 0);
    assertEquals(extended.stats.coveredSelectorSkips, 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query does not include linked opaque cells in graph entities", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-opaque-link";
  const rootId = "of:opaque-link-root";
  const targetId = "of:opaque-link-target";

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: targetId,
            value: {
              value: {
                secret: "shh",
              },
            },
          },
          {
            op: "set",
            id: rootId,
            value: {
              value: {
                hidden: {
                  "/": {
                    "link@1": {
                      id: targetId,
                      path: [],
                      space,
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    const result = queryGraph(space, engine, {
      roots: [{
        id: rootId,
        selector: {
          path: [],
          schema: {
            type: "object",
            properties: {
              hidden: {
                type: "object",
                properties: {
                  secret: { type: "string" },
                },
                asCell: ["opaque"],
              },
            },
            required: ["hidden"],
          },
        },
      }],
    });

    assertEquals(result.entities, [{
      branch: "",
      id: rootId,
      seq: 1,
      document: {
        value: {
          hidden: {
            "/": {
              "link@1": {
                id: targetId,
                path: [],
                space,
              },
            },
          },
        },
      },
    }]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query does not walk nested links inside inline opaque cells", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-inline-opaque-link";
  const rootId = "of:inline-opaque-link-root";
  const targetId = "of:inline-opaque-link-target";

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: targetId,
            value: {
              value: {
                secret: "shh",
              },
            },
          },
          {
            op: "set",
            id: rootId,
            value: {
              value: {
                hidden: {
                  nested: {
                    "/": {
                      "link@1": {
                        id: targetId,
                        path: [],
                        space,
                      },
                    },
                  },
                  local: "still here",
                },
              },
            },
          },
        ],
      },
    });

    const result = queryGraph(space, engine, {
      roots: [{
        id: rootId,
        selector: {
          path: [],
          schema: {
            type: "object",
            properties: {
              hidden: {
                type: "object",
                properties: {
                  nested: {
                    type: "object",
                    properties: {
                      secret: { type: "string" },
                    },
                  },
                  local: { type: "string" },
                },
                asCell: ["opaque"],
              },
            },
            required: ["hidden"],
          },
        },
      }],
    });

    assertEquals(result.entities, [{
      branch: "",
      id: rootId,
      seq: 1,
      document: {
        value: {
          hidden: {
            nested: {
              "/": {
                "link@1": {
                  id: targetId,
                  path: [],
                  space,
                },
              },
            },
            local: "still here",
          },
        },
      },
    }]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query includes metadata links without traversing their values", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-meta-link-schema";
  const rootPiece = "of:root-piece";
  const argument = "of:argument";
  const childPiece = "of:child-piece";
  const childResult = "of:child-result";
  const argumentSchema = {
    type: "object",
    properties: {
      child: {
        type: "object",
        properties: {
          label: { type: "string" },
        },
        required: ["label"],
      },
    },
    required: ["child"],
  };

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: childResult,
          value: { value: { answer: 42 } },
        }, {
          op: "set",
          id: childPiece,
          value: {
            value: { label: "child" },
            argument: {
              "/": {
                "link@1": {
                  id: argument,
                  path: [],
                  schema: argumentSchema,
                },
              },
            },
            result: { "/": { "link@1": { id: childResult, path: [] } } },
          },
        }, {
          op: "set",
          id: argument,
          value: {
            value: {
              child: { "/": { "link@1": { id: childPiece, path: [] } } },
            },
          },
        }, {
          op: "set",
          id: rootPiece,
          value: {
            value: { title: "root" },
            argument: {
              "/": {
                "link@1": {
                  id: argument,
                  path: [],
                  schema: argumentSchema,
                },
              },
            },
          },
        }],
      },
    });

    const result = queryGraph(space, engine, {
      roots: [{
        id: rootPiece,
        selector: {
          path: [],
          schema: false,
        },
      }],
    });

    assertEquals(result.entities.map((entity) => entity.id), [
      argument,
      rootPiece,
    ]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query refresh follows changed metadata links", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-meta-link-refresh";
  const rootPiece = "of:root-piece";
  const argumentA = "of:argument-a";
  const argumentB = "of:argument-b";
  const argumentSchema = {
    type: "object",
    properties: {
      label: { type: "string" },
    },
    required: ["label"],
  };

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: argumentA,
          value: { value: { label: "first argument" } },
        }, {
          op: "set",
          id: rootPiece,
          value: {
            value: { title: "root" },
            argument: {
              "/": {
                "link@1": {
                  id: argumentA,
                  path: [],
                  schema: argumentSchema,
                },
              },
            },
          },
        }],
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: rootPiece,
        selector: {
          path: [],
          schema: false,
        },
      }],
    });

    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: argumentB,
          value: { value: { label: "second argument" } },
        }, {
          op: "set",
          id: rootPiece,
          value: {
            value: { title: "root" },
            argument: {
              "/": {
                "link@1": {
                  id: argumentB,
                  path: [],
                  schema: argumentSchema,
                },
              },
            },
          },
        }],
      },
    });

    const refreshed = refreshTrackedGraph(
      space,
      engine,
      tracked.state,
      new Set([toDirtyKey(rootPiece)]),
    );
    assertExists(refreshed);
    assertEquals(
      [...refreshed.updates.values()].map((entity) => entity.id).sort(),
      [argumentB, rootPiece],
    );

    const fresh = queryGraph(space, engine, {
      roots: [{
        id: rootPiece,
        selector: {
          path: [],
          schema: false,
        },
      }],
    });
    assertEquals(fresh.entities.map((entity) => entity.id), [
      argumentB,
      rootPiece,
    ]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query reuses a persistent manager cache for shared source growth", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-manager-growth";
  const pieceA = "of:piece-a";
  const pieceB = "of:piece-b";
  const result = "of:result";
  const base = "of:base";

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: base,
          value: { value: { label: "base" } },
        }, {
          op: "set",
          id: result,
          value: {
            result: { "/": { "link@1": { id: base, path: [] } } },
          },
        }, {
          op: "set",
          id: pieceA,
          value: {
            result: { "/": { "link@1": { id: result, path: [] } } },
          },
        }, {
          op: "set",
          id: pieceB,
          value: {
            result: { "/": { "link@1": { id: result, path: [] } } },
          },
        }],
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: pieceA,
        selector: {
          path: [],
          schema: false,
        },
      }],
    });

    assertEquals(tracked.state.manager.readCount, 3);

    extendTrackedGraph(space, engine, tracked.state, {
      roots: [{
        id: pieceB,
        selector: {
          path: [],
          schema: false,
        },
      }],
    });

    assertEquals(tracked.state.manager.readCount, 4);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query refresh skips already-covered stable linked docs", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-refresh-covered-links";
  const fixture = createGraphFixture(space);

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: fixture.docs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: fixture.rootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });

    const rootDoc = fixture.docs.find((doc) => doc.id === fixture.rootId);
    assertExists(rootDoc);
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: fixture.rootId,
          value: {
            value: {
              ...rootDoc.value,
              metadata: { tag: "updated-root" },
            },
          },
        }],
      },
    });

    const refreshed = refreshTrackedGraph(
      space,
      engine,
      tracked.state,
      new Set([toDirtyKey(fixture.rootId)]),
    );
    assertExists(refreshed);
    assertEquals(
      [...refreshed.updates.values()].map((entity) => entity.id).sort(),
      [fixture.rootId],
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query treats schema true as covering narrower selectors", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-true-covers-narrower";
  const rootId = "of:true-covers-narrower-root";

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: rootId,
          value: {
            value: {
              child: { label: "already covered" },
            },
          },
        }],
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: rootId,
        selector: {
          path: [],
          schema: true,
        },
      }],
    });
    const rootKey = `${space}/space/${rootId}`;
    assertEquals(tracked.state.tracker.get(rootKey)?.size, 1);

    extendTrackedGraph(space, engine, tracked.state, {
      roots: [{
        id: rootId,
        selector: {
          path: ["child"],
          schema: {
            type: "object",
            properties: {
              label: { type: "string" },
            },
            required: ["label"],
          },
        },
      }],
    });

    assertEquals(tracked.state.tracker.get(rootKey)?.size, 1);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query detects graph queries covered by tracked state", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-covered-graph";
  const rootId = "of:covered-graph-root";
  const otherId = "of:covered-graph-other";

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: rootId,
          value: {
            value: {
              child: { label: "already covered" },
            },
          },
        }, {
          op: "set",
          id: otherId,
          value: {
            value: {
              child: { label: "not covered" },
            },
          },
        }],
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: rootId,
        selector: {
          path: [],
          schema: true,
        },
      }],
    });

    assert(isGraphQueryCoveredByState(space, tracked.state, {
      roots: [{
        id: rootId,
        selector: {
          path: ["child"],
          schema: {
            type: "object",
            properties: {
              label: { type: "string" },
            },
            required: ["label"],
          },
        },
      }],
    }));

    assertEquals(
      isGraphQueryCoveredByState(space, tracked.state, {
        roots: [{
          id: otherId,
          selector: {
            path: [],
            schema: true,
          },
        }],
      }),
      false,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query uses a fresh memo for write-triggered refreshes", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-refresh";
  const fixture = createGraphFixture(space);

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: fixture.docs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: fixture.rootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });

    const growthMemo = tracked.state.memo;
    const growthMemoSize = growthMemo.size;

    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: fixture.rootId,
          value: { value: fixture.expandedRootValue },
        }],
      },
    });

    const refreshed = refreshTrackedGraph(
      space,
      engine,
      tracked.state,
      new Set([toDirtyKey(fixture.rootId)]),
    );
    assertExists(refreshed);
    assertStrictEquals(tracked.state.memo, growthMemo);
    assertEquals(tracked.state.memo.size, growthMemoSize);

    assertEquals(
      [...refreshed.updates.values()].map((entity) => entity.id).sort(),
      [
        fixture.rootId,
        ...fixture.expandedReachableIds.filter((id) =>
          !fixture.initialReachableIds.includes(id)
        ),
      ],
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 query refresh updates the growth manager cache for later watch adds", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-manager-refresh";
  const pieceA = "of:piece-a";
  const pieceB = "of:piece-b";
  const result = "of:result";
  const base1 = "of:base-1";
  const base2 = "of:base-2";

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: base1,
          value: { value: { label: "base-1" } },
        }, {
          op: "set",
          id: base2,
          value: { value: { label: "base-2" } },
        }, {
          op: "set",
          id: result,
          value: {
            result: { "/": { "link@1": { id: base1, path: [] } } },
          },
        }, {
          op: "set",
          id: pieceA,
          value: {
            result: { "/": { "link@1": { id: result, path: [] } } },
          },
        }, {
          op: "set",
          id: pieceB,
          value: {
            result: { "/": { "link@1": { id: result, path: [] } } },
          },
        }],
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{
        id: pieceA,
        selector: {
          path: [],
          schema: false,
        },
      }],
    });

    assertEquals(tracked.state.manager.readCount, 3);

    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: result,
          value: {
            result: { "/": { "link@1": { id: base2, path: [] } } },
          },
        }],
      },
    });

    const refreshed = refreshTrackedGraph(
      space,
      engine,
      tracked.state,
      new Set([toDirtyKey(result)]),
    );
    assertExists(refreshed);

    extendTrackedGraph(space, engine, tracked.state, {
      roots: [{
        id: pieceB,
        selector: {
          path: [],
          schema: false,
        },
      }],
    });

    assertEquals(tracked.state.manager.readCount, 4);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 queryGraph honors atSeq", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-history";
  const fixture = createGraphFixture(space);

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: fixture.docs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    });
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: fixture.rootId,
          value: { value: fixture.expandedRootValue },
        }],
      },
    });

    const historical = queryGraph(space, engine, {
      roots: [{
        id: fixture.rootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
      atSeq: 1,
    });
    assertEquals(
      historical.entities.map((entity) => entity.id),
      fixture.initialReachableIds,
    );

    const current = queryGraph(space, engine, {
      roots: [{
        id: fixture.rootId,
        selector: {
          path: [],
          schema: fixture.schema,
        },
      }],
    });
    assertEquals(
      current.entities.map((entity) => entity.id),
      fixture.expandedReachableIds,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 queryGraph supports branch-scoped atSeq reads", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-branch-history";
  const rootId = "of:branch-root";

  try {
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: rootId,
          value: { value: { version: "base" } },
        }],
      },
    });
    createBranch(engine, "feature");
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        branch: "feature",
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: rootId,
          value: { value: { version: "feature" } },
        }],
      },
    });

    const result = queryGraph(space, engine, {
      branch: "feature",
      atSeq: 1,
      roots: [{
        id: rootId,
        selector: {
          path: [],
          schema: false,
        },
      }],
    });

    assertEquals(result.entities, [{
      branch: "feature",
      id: rootId,
      seq: 1,
      document: {
        value: {
          version: "base",
        },
      },
    }]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("loadedAddresses preserves entity ids containing '/' (the cache key is scopeKey/id/type; only the scopeKey prefix is delimiter-safe)", async () => {
  const { engine, path } = await createEngine();
  try {
    // An id with '/' segments — URI-shaped ids carry them routinely.
    const id = "data:app/notes/2026";
    applyCommit(engine, {
      sessionId: "session:1",
      space: "did:key:space",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: { value: { n: 1 } },
        }],
      },
      invocation: invocationFor(1),
      authorization,
    });
    const manager = new EngineObjectManager(engine, "");
    const loaded = manager.load({ id });
    assertExists(loaded);
    const addresses = manager.loadedAddresses();
    assertEquals(addresses.length, 1);
    assertEquals(
      addresses[0],
      {
        id,
        type: "application/json",
        scope: "space",
        scopeKey: "space",
      },
      "a slash-bearing id must round-trip through loadedAddresses " +
        "unsplit (extension bookkeeping keys off these addresses)",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 schema-closure assembly fails loudly on a corrupted dependency", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-schema-corruption";
  try {
    const leafSchema = { type: "string", title: "corruption-leaf" } as const;
    const leafHash = internSchemaAsTaggedHashString(leafSchema);
    const rootSchema = {
      type: "object",
      properties: { x: { $ref: `cid:${leafHash}` } },
    } as const;
    const rootHash = internSchemaAsTaggedHashString(rootSchema);
    applyCommit(engine, {
      sessionId: "session:corruption-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: `cid:${leafHash}`, value: { value: leafSchema } },
          { op: "set", id: `cid:${rootHash}`, value: { value: rootSchema } },
          {
            op: "set",
            id: "of:corruption-carrier",
            value: {
              value: {
                linked: {
                  "/": {
                    "link@1": {
                      id: "of:corruption-target",
                      path: [],
                      schema: { $ref: `cid:${rootHash}` },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    const query = {
      roots: [{
        id: "of:corruption-carrier",
        selector: { path: [], schema: false },
      }],
    };
    const tracked = trackGraph(space, engine, query);
    assert(tracked.state.entities.has(`${space}/space/cid:${leafHash}`));

    // Out-of-band tampering: the leaf's stored content is swapped and its
    // version advanced. The commit API rejects every cid: mutation, so
    // direct database manipulation is the only door left — this models
    // genuine corruption.
    const forged = encodeMemoryBoundary({
      value: { type: "number", title: "forged" },
    });
    engine.database.prepare(
      `UPDATE revision SET data = :data, seq = seq + 1 WHERE id = :id`,
    ).run({ data: forged, id: `cid:${leafHash}` });
    engine.database.prepare(
      `UPDATE head SET seq = seq + 1 WHERE id = :id`,
    ).run({ id: `cid:${leafHash}` });

    // An established watch's refresh revalidates the whole delivered state
    // and fails loudly even though the referrer did not change.
    assertThrows(
      () =>
        refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey(`cid:${leafHash}`)]),
        ),
      Error,
      "did not verify in this space",
    );

    // An initial query over the corrupted closure fails the same way.
    assertThrows(
      () =>
        trackGraph(space, engine, query, undefined, {
          sessionId: "session:corruption-fresh",
        }),
      Error,
      "did not verify in this space",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 extendTrackedGraph delivers the schema closure a new root introduces", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-extend-closure";
  try {
    const schema = { type: "string", title: "extend-leaf" } as const;
    const hash = internSchemaAsTaggedHashString(schema);
    applyCommit(engine, {
      sessionId: "session:extend-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:extend-plain", value: { value: { n: 1 } } },
          { op: "set", id: `cid:${hash}`, value: { value: schema } },
          {
            op: "set",
            id: "of:extend-carrier",
            value: {
              value: {
                linked: {
                  "/": {
                    "link@1": {
                      id: "of:extend-target",
                      path: [],
                      schema: { $ref: `cid:${hash}` },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [{ id: "of:extend-plain", selector: { path: [], schema: false } }],
    });
    const docKey = `${space}/space/cid:${hash}` as const;
    assert(!tracked.state.entities.has(docKey));

    // Extension pulls the carrier in, and assembly joins the schema
    // document it references to the delivered set and the tracker.
    const extended = extendTrackedGraph(space, engine, tracked.state, {
      roots: [{
        id: "of:extend-carrier",
        selector: { path: [], schema: false },
      }],
    });
    assert(extended.updates.has(docKey));
    assert(tracked.state.entities.has(docKey));
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 refreshTrackedGraph delivers the schema closure a new document version introduces", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-refresh-closure";
  try {
    applyCommit(engine, {
      sessionId: "session:refresh-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:refresh-carrier", value: { value: { n: 1 } } },
        ],
      },
    });
    const tracked = trackGraph(space, engine, {
      roots: [{
        id: "of:refresh-carrier",
        selector: { path: [], schema: false },
      }],
    });
    const schema = { type: "string", title: "refresh-leaf" } as const;
    const hash = internSchemaAsTaggedHashString(schema);
    const docKey = `${space}/space/cid:${hash}` as const;
    assert(!tracked.state.entities.has(docKey));

    // The next version of the carrier references a schema document its
    // commit installs alongside it.
    applyCommit(engine, {
      sessionId: "session:refresh-writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: `cid:${hash}`, value: { value: schema } },
          {
            op: "set",
            id: "of:refresh-carrier",
            value: {
              value: {
                linked: {
                  "/": {
                    "link@1": {
                      id: "of:refresh-target",
                      path: [],
                      schema: { $ref: `cid:${hash}` },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    // The refresh delivers the new version AND the schema document its
    // reference requires, in the same frame.
    const refreshed = refreshTrackedGraph(
      space,
      engine,
      tracked.state,
      new Set([toDirtyKey("of:refresh-carrier")]),
    );
    assertExists(refreshed);
    assert(refreshed.updates.has(docKey));
    assert(tracked.state.entities.has(docKey));
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 assembly catches a reference patched inside an existing link schema", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-patch-gap";
  try {
    const schema = { type: "string", title: "patch-gap-leaf" } as const;
    const hash = internSchemaAsTaggedHashString(schema);
    const absentHash = internSchemaAsTaggedHashString({
      type: "null",
      title: "never-installed",
    });
    applyCommit(engine, {
      sessionId: "session:patch-gap-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: `cid:${hash}`, value: { value: schema } },
          {
            op: "set",
            id: "of:patch-gap-carrier",
            value: {
              value: {
                linked: {
                  "/": {
                    "link@1": {
                      id: "of:patch-gap-target",
                      path: [],
                      schema: { $ref: `cid:${hash}` },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });
    const query = {
      roots: [{
        id: "of:patch-gap-carrier",
        selector: { path: [], schema: false },
      }],
    };
    const tracked = trackGraph(space, engine, query);
    assert(tracked.state.entities.has(`${space}/space/cid:${hash}`));

    // The documented commit-validation gap: a patch that edits INSIDE an
    // existing link's schema introduces a reference no patch value carries
    // as a whole link, so the commit boundary accepts it. Read-side
    // assembly is the layer that catches it.
    applyCommit(engine, {
      sessionId: "session:patch-gap-writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:patch-gap-carrier",
          patches: [{
            op: "replace",
            path: "/value/linked/~1/link@1/schema/$ref",
            value: `cid:${absentHash}`,
          }],
        }],
      },
    });

    assertThrows(
      () =>
        refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey("of:patch-gap-carrier")]),
        ),
      Error,
      "is not stored in this space",
    );
    assertThrows(
      () =>
        trackGraph(space, engine, query, undefined, {
          sessionId: "session:patch-gap-fresh",
        }),
      Error,
      "is not stored in this space",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 schema scan and verification caches stay bounded at scale", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-cache-bounds";
  try {
    // One past each cache's 4096-entry bound, so the insert AT the bound
    // clears it and the passes both fill and evict. Three caches wrap in
    // this test: the commit boundary's per-engine verification cache (the
    // second commit re-verifies every stored document), and result
    // assembly's per-version scan and verification caches (the query
    // delivers every carrier and its schema document).
    const count = 4097;
    const schemas = Array.from(
      { length: count },
      (_, i) => ({ type: "string", title: `bounded-${i}` } as const),
    );
    const hashes = schemas.map((schema) =>
      internSchemaAsTaggedHashString(schema)
    );
    applyCommit(engine, {
      sessionId: "session:bounds-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: schemas.map((schema, i) => ({
          op: "set" as const,
          id: `cid:${hashes[i]}`,
          value: { value: schema },
        })),
      },
    });
    applyCommit(engine, {
      sessionId: "session:bounds-writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: hashes.map((hash, i) => ({
          op: "set" as const,
          id: `of:bounded-carrier-${i}`,
          value: {
            value: {
              linked: {
                "/": {
                  "link@1": {
                    id: `of:bounded-target-${i}`,
                    path: [],
                    schema: { $ref: `cid:${hash}` },
                  },
                },
              },
            },
          },
        })),
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: hashes.map((_, i) => ({
        id: `of:bounded-carrier-${i}`,
        selector: { path: [], schema: false as const },
      })),
    });
    // Every closure still delivers; the bound trades re-scans for memory,
    // never correctness.
    assert(tracked.state.entities.has(`${space}/space/cid:${hashes[0]}`));
    assert(
      tracked.state.entities.has(`${space}/space/cid:${hashes[count - 1]}`),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 delivers a meta-linked document that arrives after its referrer", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-meta-arrival";
  try {
    // The referrer's `pattern` meta link points at a document nothing has
    // written yet. The absent target must still enter the tracker — the
    // tracker is what makes the graph reactive — or its arrival would
    // never reach this watch.
    applyCommit(engine, {
      sessionId: "session:meta-arrival-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:meta-arrival-referrer",
          value: {
            value: { n: 1 },
            pattern: {
              "/": {
                "link@1": { id: "of:meta-arrival-target", path: [] },
              },
            },
          },
        }],
      },
    });
    const tracked = trackGraph(space, engine, {
      roots: [{
        id: "of:meta-arrival-referrer",
        selector: { path: [], schema: false },
      }],
    });
    const targetKey = `${space}/space/of:meta-arrival-target` as const;
    assert(tracked.state.tracker.has(targetKey));

    applyCommit(engine, {
      sessionId: "session:meta-arrival-writer",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:meta-arrival-target",
          value: { value: { arrived: true } },
        }],
      },
    });
    const refreshed = refreshTrackedGraph(
      space,
      engine,
      tracked.state,
      new Set([toDirtyKey("of:meta-arrival-target")]),
    );
    assertExists(refreshed);
    assert(refreshed.updates.has(targetKey));
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 resolves a selector schema reference against the stored closure", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-selector-ref";
  try {
    const leafSchema = {
      type: "object",
      properties: { selectorLeaf: { type: "string" } },
    } as const;
    const leafHash = internSchemaAsTaggedHashString(leafSchema);
    applyCommit(engine, {
      sessionId: "session:selector-ref-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: `cid:${leafHash}`, value: { value: leafSchema } },
          {
            op: "set",
            id: "of:selector-ref-doc",
            value: { value: { selectorLeaf: "present" } },
          },
        ],
      },
    });
    const tracked = trackGraph(space, engine, {
      roots: [{
        id: "of:selector-ref-doc",
        selector: { path: [], schema: { $ref: `cid:${leafHash}` } },
      }],
    });
    assert(
      tracked.state.entities.has(`${space}/space/of:selector-ref-doc`),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 rejects a selector referencing a schema document the space does not hold", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-selector-ref-absent";
  try {
    const absentHash = internSchemaAsTaggedHashString({
      type: "string",
      title: "selector-never-installed",
    });
    applyCommit(engine, {
      sessionId: "session:selector-absent-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:selector-absent-doc",
          value: { value: { n: 1 } },
        }],
      },
    });
    // A compliant client only sends a reference it verified persisted, so
    // an unresolvable selector reference is a protocol violation answered
    // loudly — not the lenient selects-nothing wait link schemas get.
    assertThrows(
      () =>
        trackGraph(space, engine, {
          roots: [{
            id: "of:selector-absent-doc",
            selector: { path: [], schema: { $ref: `cid:${absentHash}` } },
          }],
        }),
      Error,
      "A selector reference must name a persisted closure",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 treats an $alias-shaped record as plain data in delivery", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-alias-data";
  try {
    // The ref inside this record points at NOTHING — and the query must
    // not care: an alias is a binding only by context, and to result
    // assembly an $alias-shaped record is plain data, neither a delivery
    // obligation nor a failure.
    const absent = internSchemaAsTaggedHashString({
      type: "string",
      title: "alias-data-never-installed",
    });
    applyCommit(engine, {
      sessionId: "session:alias-data-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:alias-data-doc",
          value: {
            value: {
              bound: {
                $alias: {
                  cell: "argument",
                  path: ["field"],
                  schema: { $ref: `cid:${absent}` },
                },
              },
            },
          },
        }],
      },
    });
    const tracked = trackGraph(space, engine, {
      roots: [{
        id: "of:alias-data-doc",
        selector: { path: [], schema: false },
      }],
    });
    assert(tracked.state.entities.has(`${space}/space/of:alias-data-doc`));
    assert(!tracked.state.entities.has(`${space}/space/cid:${absent}`));
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 selector validation meets a shared dependency once and rejects forged storage", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-selector-diamond";
  try {
    const shared = {
      type: "string",
      title: "selector-diamond-shared",
    } as const;
    const sharedHash = internSchemaAsTaggedHashString(shared);
    const left = {
      type: "object",
      properties: { l: { $ref: `cid:${sharedHash}` } },
    } as const;
    const leftHash = internSchemaAsTaggedHashString(left);
    const right = {
      type: "object",
      properties: { r: { $ref: `cid:${sharedHash}` } },
    } as const;
    const rightHash = internSchemaAsTaggedHashString(right);
    const root = {
      type: "object",
      properties: {
        a: { $ref: `cid:${leftHash}` },
        b: { $ref: `cid:${rightHash}` },
      },
    } as const;
    const rootHash = internSchemaAsTaggedHashString(root);
    const forgedTarget = internSchemaAsTaggedHashString({
      type: "string",
      title: "selector-forged-claim",
    });
    applyCommit(engine, {
      sessionId: "session:selector-diamond-writer",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: `cid:${sharedHash}`, value: { value: shared } },
          { op: "set", id: `cid:${leftHash}`, value: { value: left } },
          { op: "set", id: `cid:${rightHash}`, value: { value: right } },
          { op: "set", id: `cid:${rootHash}`, value: { value: root } },
          {
            op: "set",
            id: "of:selector-diamond-doc",
            value: { value: { a: {}, b: {} } },
          },
          // An unreferenced forged install is admitted (the boundary cannot
          // name its class) — the selector validation below must still
          // reject a reference to it.
          {
            op: "set",
            id: `cid:${forgedTarget}`,
            value: { value: { type: "number", title: "not-the-claim" } },
          },
        ],
      },
    });
    // The diamond walk meets the shared dependency once and validates the
    // whole closure from the space's own storage.
    const tracked = trackGraph(space, engine, {
      roots: [{
        id: "of:selector-diamond-doc",
        selector: { path: [], schema: { $ref: `cid:${rootHash}` } },
      }],
    });
    assert(
      tracked.state.entities.has(`${space}/space/of:selector-diamond-doc`),
    );
    // A selector reference backed by stored content that does not hash to
    // its id fails loudly at validation, before any traversal.
    assertThrows(
      () =>
        trackGraph(space, engine, {
          roots: [{
            id: "of:selector-diamond-doc",
            selector: { path: [], schema: { $ref: `cid:${forgedTarget}` } },
          }],
        }),
      Error,
      "did not verify in this space",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 refreshTrackedGraph double-role retirement: a key that is both an absent watch ROOT and a link-hop MISS survives a flicker AS A MISS — the root's re-added seq-0 marker is no arrival witness — and its birth delivers the miss-walked closure (unit isolation: no sessions, no incidental full re-evaluation can mask this path; mutation: retiring on tracker membership reds both asserts)", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-double-role";
  const nodeSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      primary: { "$ref": "#/$defs/node" },
    },
    "$defs": {
      node: {
        type: "object",
        properties: {
          name: { type: "string" },
          primary: { "$ref": "#/$defs/node" },
        },
      },
    },
  } as const satisfies JSONSchema;
  const linkTo = (id: string) => ({
    "/": { "link@1": { id, path: [], space } },
  });

  try {
    // The grandchild exists but nothing links it yet; the referrer's
    // `primary` dead-ends on the absent double-role doc.
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:double-role-grandchild",
          value: { value: { name: "grandchild" } },
        }, {
          op: "set",
          id: "of:double-role-referrer",
          value: {
            value: {
              name: "referrer",
              primary: linkTo("of:double-role-doc"),
            },
          },
        }],
      },
    });

    const tracked = trackGraph(space, engine, {
      roots: [
        {
          id: "of:double-role-referrer",
          selector: { path: [], schema: nodeSchema },
        },
        { id: "of:double-role-doc", selector: { path: [], schema: false } },
      ],
    });
    const state = tracked.state;
    const missKey = toDocKey(space, "of:double-role-doc", "space", {});
    assert(
      state.missed.has(missKey),
      "the referrer's dead-end registers the miss beside the root marker",
    );

    // The flicker: created and deleted in ONE commit, so the refresh
    // re-evaluates while the doc is still absent. The ROOT selector
    // re-adds its marker; the MISS must survive it.
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:double-role-doc",
          value: { value: { name: "flicker" } },
        }, { op: "delete", id: "of:double-role-doc" }],
      },
    });
    const dirty = new Set([toDirtyKey("of:double-role-doc", "space")]);
    refreshTrackedGraph(space, engine, state, dirty);
    assert(
      state.missed.has(missKey),
      "a still-absent flicker keeps the miss: the root's re-added marker " +
        "is the root's, not an arrival",
    );

    // The birth links the grandchild. Only the miss's node-schema walk
    // reaches it — the root selector is schema-false and walks nothing.
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:double-role-doc",
          value: {
            value: {
              name: "born",
              primary: linkTo("of:double-role-grandchild"),
            },
          },
        }],
      },
    });
    const birth = refreshTrackedGraph(space, engine, state, dirty);
    assertExists(birth);
    const bornIds = [...birth.updates.keys()].map((key) => fromDocKey(key).id);
    assert(
      bornIds.includes("of:double-role-doc"),
      "the born document itself is delivered",
    );
    assert(
      bornIds.includes("of:double-role-grandchild"),
      "the miss's schema walk delivers the grandchild only it reaches",
    );
    assertEquals(state.missed.has(missKey), false);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
