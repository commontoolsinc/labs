import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
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
  queryGraph,
  refreshTrackedGraph,
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

Deno.test("memory v2 query reuses a persistent manager cache for shared source growth", async () => {
  const { engine, path } = await createEngine();
  const space = "did:key:z6Mk-memory-v2-query-manager-growth";
  const pieceA = "of:piece-a";
  const pieceB = "of:piece-b";
  const process = "of:process";
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
          id: process,
          value: {
            source: { "/": "base" },
          },
        }, {
          op: "set",
          id: pieceA,
          value: {
            source: { "/": "process" },
          },
        }, {
          op: "set",
          id: pieceB,
          value: {
            source: { "/": "process" },
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
      new Set([fixture.rootId]),
    );
    assertExists(refreshed);
    assertStrictEquals(tracked.state.memo, growthMemo);
    assertEquals(tracked.state.memo.size, growthMemoSize);

    assertEquals(
      [...refreshed.updates.values()].map((entity) => entity.id).sort(),
      fixture.expandedReachableIds,
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
  const process = "of:process";
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
          id: process,
          value: {
            source: { "/": "base-1" },
          },
        }, {
          op: "set",
          id: pieceA,
          value: {
            source: { "/": "process" },
          },
        }, {
          op: "set",
          id: pieceB,
          value: {
            source: { "/": "process" },
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
          id: process,
          value: {
            source: { "/": "base-2" },
          },
        }],
      },
    });

    const refreshed = refreshTrackedGraph(
      space,
      engine,
      tracked.state,
      new Set([process]),
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
