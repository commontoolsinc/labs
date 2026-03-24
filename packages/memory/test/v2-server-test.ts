import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { Server, SessionRegistry } from "../v2/server.ts";
import {
  type GraphQueryResult,
  MEMORY_V2_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionSync,
} from "../v2.ts";
import { createGraphFixture } from "./v2-graph.fixture.ts";

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const assertResponse = <Result>(
  message: ServerMessage,
): ResponseMessage<Result> => {
  assertEquals(message.type, "response");
  return message as ResponseMessage<Result>;
};

const assertEffect = (
  message: ServerMessage,
): SessionEffectMessage & { effect: SessionSync } => {
  assertEquals(message.type, "session/effect");
  return message as SessionEffectMessage & { effect: SessionSync };
};

const createServer = (store: string, refreshDelayMs = 0) =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: refreshDelayMs,
  });

Deno.test("memory v2 session registry rejects reopening a session id on a different space", () => {
  const sessions = new SessionRegistry();
  sessions.open("did:key:z6Mk-space-one", { sessionId: "session:fixed" }, 0);

  assertThrows(
    () =>
      sessions.open(
        "did:key:z6Mk-space-two",
        { sessionId: "session:fixed" },
        0,
      ),
    Error,
    "session session:fixed is already bound to did:key:z6Mk-space-one",
  );
});

Deno.test("memory v2 server reports cross-space session id conflicts as protocol errors", async () => {
  const server = createServer("memory://memory-v2-server-session-conflict");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    assertEquals(shiftMessage(messages), {
      type: "hello.ok",
      protocol: MEMORY_V2_PROTOCOL,
    });

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-1",
      ok: {
        sessionId: "session:fixed",
        serverSeq: 0,
      },
    });

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-2",
      space: "did:key:z6Mk-space-two",
      session: { sessionId: "session:fixed" },
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-2",
      error: {
        name: "ProtocolError",
        message:
          "session session:fixed is already bound to did:key:z6Mk-space-one",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server opens sessions, commits documents, and answers graph queries", async () => {
  const server = createServer("memory://memory-v2-server-basic");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server";

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    assertEquals(shiftMessage(messages), {
      type: "hello.ok",
      protocol: MEMORY_V2_PROTOCOL,
    });

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string; serverSeq: number }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: {
            value: {
              hello: "world",
            },
          },
        }],
      },
    }));

    const committed = assertResponse<any>(shiftMessage(messages));
    assertEquals(committed.requestId, "tx-1");
    assertEquals(committed.ok?.seq, 1);
    assertEquals(committed.ok?.revisions, [{
      id: "of:doc:1",
      branch: "",
      seq: 1,
      opIndex: 0,
      commitSeq: 1,
      op: "set",
      document: {
        value: {
          hello: "world",
        },
      },
    }]);

    await connection.receive(JSON.stringify({
      type: "graph.query",
      requestId: "query-1",
      space,
      sessionId,
      query: {
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }));

    const query = assertResponse<GraphQueryResult>(shiftMessage(messages));
    assertEquals(query.requestId, "query-1");
    assertEquals(query.ok, {
      serverSeq: 1,
      entities: [{
        branch: "",
        id: "of:doc:1",
        seq: 1,
        document: {
          value: {
            hello: "world",
          },
        },
      }],
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects legacy live graph.query subscriptions", async () => {
  const server = createServer("memory://memory-v2-server-subscribe-reject");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-subscribe-reject";

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    shiftMessage(messages);

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );

    await connection.receive(JSON.stringify({
      type: "graph.query",
      requestId: "query-1",
      space,
      sessionId: opened.ok!.sessionId,
      query: {
        subscribe: true,
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }));

    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "query-1",
      error: {
        name: "ProtocolError",
        message:
          "live graph.query subscriptions were removed; use session.watch.set",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server watch sets expand to previously hidden nodes after retargets", async () => {
  const server = createServer("memory://memory-v2-server-watch-expansion");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-expansion";
  const fixture = createGraphFixture(space);

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    shiftMessage(messages);

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: fixture.docs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "seed");

    await connection.receive(JSON.stringify({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: fixture.rootId,
            selector: {
              path: [],
              schema: fixture.schema,
            },
          }],
        },
      }],
    }));
    const watch = assertResponse<any>(shiftMessage(messages));
    assertEquals(
      watch.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      fixture.initialReachableIds,
    );
    assertEquals(watch.ok?.sync.removes, []);

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "expand",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: fixture.rootId,
          value: { value: fixture.expandedRootValue },
        }],
      },
    }));
    assertEquals(
      assertResponse<any>(shiftMessage(messages)).requestId,
      "expand",
    );

    await tick();
    const effect = assertEffect(shiftMessage(messages));
    const expectedUpdatedIds = [
      fixture.rootId,
      ...fixture.expandedReachableIds.filter((id) =>
        !fixture.initialReachableIds.includes(id)
      ),
    ].sort();
    assertEquals(
      effect.effect.upserts.map((entry) => entry.id),
      expectedUpdatedIds,
    );
    assertEquals(effect.effect.removes, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server does not emit delayed exact-reconcile removes after shrink retargets", async () => {
  const time = new FakeTime();
  const server = createServer(
    "memory://memory-v2-server-watch-shrink-no-reconcile",
    0,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-shrink-no-reconcile";
  const fixture = createGraphFixture(space);
  const expandedDocs = fixture.docs.map((doc) => ({
    ...doc,
    value: doc.id === fixture.rootId ? fixture.expandedRootValue : doc.value,
  }));
  const initialRoot = fixture.docs.find((doc) => doc.id === fixture.rootId)
    ?.value;
  assertExists(initialRoot);

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    shiftMessage(messages);

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: expandedDocs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "seed");

    await connection.receive(JSON.stringify({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: fixture.rootId,
            selector: {
              path: [],
              schema: fixture.schema,
            },
          }],
        },
      }],
    }));
    const watch = assertResponse<any>(shiftMessage(messages));
    assertEquals(
      watch.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      fixture.expandedReachableIds,
    );
    assertEquals(watch.ok?.sync.removes, []);

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "shrink",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: fixture.rootId,
          value: { value: initialRoot },
        }],
      },
    }));
    assertEquals(
      assertResponse<any>(shiftMessage(messages)).requestId,
      "shrink",
    );

    await time.tickAsync(0);
    await time.runMicrotasks();
    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.removes, []);

    await time.tickAsync(300);
    await time.runMicrotasks();
    assertEquals(messages, []);
  } finally {
    await server.close();
    time.restore();
  }
});

Deno.test("memory v2 server refreshes watched docs without rerunning full graph queries", async () => {
  const server = createServer("memory://memory-v2-server-incremental-watch");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-incremental-watch";
  const originalEvaluateGraphQuery = server.evaluateGraphQuery.bind(server);
  const evaluatedRoots: string[][] = [];
  server.evaluateGraphQuery = (async (...args) => {
    evaluatedRoots.push(args[1].roots.map((root) => root.id));
    return await originalEvaluateGraphQuery(...args);
  }) as typeof server.evaluateGraphQuery;

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    shiftMessage(messages);

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { one: 1 } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 2 } },
        }],
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "seed");

    await connection.receive(JSON.stringify({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "first",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }, {
        id: "second",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    assertEquals(
      assertResponse<any>(shiftMessage(messages)).requestId,
      "watch-1",
    );
    evaluatedRoots.length = 0;

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "update",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { one: 2 } },
        }],
      },
    }));
    assertEquals(
      assertResponse<any>(shiftMessage(messages)).requestId,
      "update",
    );

    await tick();
    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.upserts.map((entry) => entry.id), ["of:doc:1"]);
    assertEquals(effect.effect.removes, []);
    assertEquals(evaluatedRoots, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server incrementally adds watches without rerunning full graph queries", async () => {
  const server = createServer("memory://memory-v2-server-watch-add");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-add";
  const originalEvaluateGraphQuery = server.evaluateGraphQuery.bind(server);
  const evaluatedRoots: string[][] = [];
  server.evaluateGraphQuery = (async (...args) => {
    evaluatedRoots.push(args[1].roots.map((root) => root.id));
    return await originalEvaluateGraphQuery(...args);
  }) as typeof server.evaluateGraphQuery;

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    shiftMessage(messages);

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { one: 1 } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 2 } },
        }],
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "seed");

    await connection.receive(JSON.stringify({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "first",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const first = assertResponse<any>(shiftMessage(messages));
    assertEquals(
      first.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      [
        "of:doc:1",
      ],
    );
    evaluatedRoots.length = 0;

    await connection.receive(JSON.stringify({
      type: "session.watch.add",
      requestId: "watch-2",
      space,
      sessionId,
      watches: [{
        id: "second",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const second = assertResponse<any>(shiftMessage(messages));
    assertEquals(
      second.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      [
        "of:doc:2",
      ],
    );
    assertEquals(second.ok?.sync.removes, []);
    assertEquals(evaluatedRoots, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server can bootstrap watches with session.watch.add", async () => {
  const server = createServer("memory://memory-v2-server-watch-add-bootstrap");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-add-bootstrap";

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    shiftMessage(messages);

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { hello: "watch-add" } },
        }],
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "seed");

    await connection.receive(JSON.stringify({
      type: "session.watch.add",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const watch = assertResponse<any>(shiftMessage(messages));
    assertEquals(
      watch.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      ["of:doc:1"],
    );
    assertEquals(watch.ok?.sync.removes, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server watch set replacement emits removes for entities that leave scope", async () => {
  const server = createServer("memory://memory-v2-server-watch-replace");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-replace";

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    shiftMessage(messages);

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { first: true } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { second: true } },
        }],
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "seed");

    await connection.receive(JSON.stringify({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "first",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const first = assertResponse<any>(shiftMessage(messages));
    assertEquals(
      first.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      [
        "of:doc:1",
      ],
    );
    assertEquals(first.ok?.sync.removes, []);

    await connection.receive(JSON.stringify({
      type: "session.watch.set",
      requestId: "watch-2",
      space,
      sessionId,
      watches: [{
        id: "second",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const second = assertResponse<any>(shiftMessage(messages));
    assertEquals(
      second.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      [
        "of:doc:2",
      ],
    );
    assertEquals(second.ok?.sync.removes, [{
      branch: "",
      id: "of:doc:1",
    }]);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server flushes session sync before returning conflicts", async () => {
  const server = createServer("memory://memory-v2-server-conflict-flush", 20);
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-conflict-flush";

  try {
    await connection.receive(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));
    shiftMessage(messages);

    await connection.receive(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(JSON.stringify({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).ok?.sync.upserts, [
      {
        branch: "",
        id: "of:doc:1",
        seq: 0,
        deleted: true,
      },
    ]);

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 1 } },
        }],
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "tx-1");

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 3 } },
        }],
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "tx-2");
    assertEquals(messages.length, 0);

    await connection.receive(JSON.stringify({
      type: "transact",
      requestId: "tx-3",
      space,
      sessionId,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [{
            id: "of:doc:1",
            path: [],
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 2 } },
        }],
      },
    }));

    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.toSeq, 2);
    assertEquals(effect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      seq: 2,
      doc: {
        value: { version: 3 },
      },
    }]);

    const rejected = assertResponse<any>(shiftMessage(messages));
    assertEquals(rejected.requestId, "tx-3");
    assertEquals(rejected.error, {
      name: "ConflictError",
      message: "stale confirmed read: of:doc:1 at seq 1 conflicted with seq 2",
    });
    assertEquals(messages.length, 0);
  } finally {
    await server.close();
  }
});
