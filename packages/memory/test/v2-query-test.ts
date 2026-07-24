import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  close,
  createBranch,
  type Engine,
  open,
} from "../v2/engine.ts";
import {
  extendTrackedGraph,
  fromDirtyKey,
  fromDocKey,
  isGraphQueryCoveredByState,
  queryGraph,
  refreshTrackedGraph,
  toDirtyKey,
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

Deno.test("memory v2 query keys require explicit scope", () => {
  assertEquals(
    fromDocKey("did:key:space/user/of:doc"),
    {
      space: "did:key:space",
      scope: "user",
      id: "of:doc",
    },
  );
  assertEquals(fromDirtyKey("session\0of:doc"), {
    scope: "session",
    id: "of:doc",
  });

  assertThrows(
    () => fromDocKey("did:key:space/of:doc" as never),
    Error,
    "invalid memory v2 query doc key",
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
      scopeKey: "user:did%3Akey%3Aalice",
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
      scopeKey: "space",
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
      scopeKey: "space",
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
      scopeKey: "space",
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
