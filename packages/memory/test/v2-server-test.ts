import { assertEquals, assertExists } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { parseClientMessage, Server, SessionRegistry } from "../v2/server.ts";
import {
  encodeMemoryV2Boundary,
  getMemoryV2Flags,
  type GraphQueryResult,
  MEMORY_V2_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionSync,
} from "../v2.ts";
import { createGraphFixture } from "./v2-graph.fixture.ts";

const HELLO_FLAGS = getMemoryV2Flags();
const HELLO = {
  type: "hello",
  protocol: MEMORY_V2_PROTOCOL,
  flags: HELLO_FLAGS,
} as const;
const HELLO_OK = {
  type: "hello.ok",
  protocol: MEMORY_V2_PROTOCOL,
  flags: HELLO_FLAGS,
} as const;

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

Deno.test("memory v2 server parser ignores transact invocation and authorization payloads", () => {
  assertEquals(
    parseClientMessage(encodeMemoryV2Boundary({
      type: "transact",
      requestId: "tx-1",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { ok: true } },
        }],
      },
      invocation: { iss: "did:key:alice" },
      authorization: { signature: "sig:alice" },
    })),
    {
      type: "transact",
      requestId: "tx-1",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { ok: true } },
        }],
      },
    },
  );
});

Deno.test("memory v2 session registry scopes session ids by space", () => {
  const sessions = new SessionRegistry();
  const first = sessions.open(
    "did:key:z6Mk-space-one",
    { sessionId: "session:fixed" },
    0,
  );
  const second = sessions.open(
    "did:key:z6Mk-space-two",
    { sessionId: "session:fixed" },
    0,
  );

  assertEquals(first.sessionId, "session:fixed");
  assertEquals(first.serverSeq, 0);
  assertExists(first.sessionToken);
  assertEquals(second.sessionId, "session:fixed");
  assertEquals(second.serverSeq, 0);
  assertExists(second.sessionToken);
});

Deno.test("memory v2 server allows the same session id in different spaces", async () => {
  const server = createServer("memory://memory-v2-server-session-scope");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    assertEquals(shiftMessage(messages), HELLO_OK);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
    }));
    const openedOne = assertResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
    }>(shiftMessage(messages));
    assertEquals(openedOne.requestId, "open-1");
    assertEquals(openedOne.ok?.sessionId, "session:fixed");
    assertEquals(openedOne.ok?.serverSeq, 0);
    assertExists(openedOne.ok?.sessionToken);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-2",
      space: "did:key:z6Mk-space-two",
      session: { sessionId: "session:fixed" },
    }));
    const openedTwo = assertResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
    }>(shiftMessage(messages));
    assertEquals(openedTwo.requestId, "open-2");
    assertEquals(openedTwo.ok?.sessionId, "session:fixed");
    assertEquals(openedTwo.ok?.serverSeq, 0);
    assertExists(openedTwo.ok?.sessionToken);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server binds resumed sessions to the original principal", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-server-session-principal"),
    authorizeSessionOpen(message) {
      return typeof (message.authorization as { principal?: unknown })
          ?.principal ===
          "string"
        ? (message.authorization as { principal: string }).principal
        : undefined;
    },
  });
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  const firstConnection = server.connect((message) =>
    firstMessages.push(message)
  );
  const secondConnection = server.connect((message) =>
    secondMessages.push(message)
  );

  try {
    await firstConnection.receive(encodeMemoryV2Boundary(HELLO));
    assertEquals(shiftMessage(firstMessages), HELLO_OK);

    await firstConnection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
      authorization: { principal: "did:key:z6Mk-alice" },
    }));
    const opened = assertResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
    }>(shiftMessage(firstMessages));
    assertEquals(opened.requestId, "open-1");
    assertEquals(opened.ok?.sessionId, "session:fixed");
    assertEquals(opened.ok?.serverSeq, 0);
    assertExists(opened.ok?.sessionToken);

    await secondConnection.receive(encodeMemoryV2Boundary(HELLO));
    assertEquals(shiftMessage(secondMessages), HELLO_OK);

    await secondConnection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-2",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
      authorization: { principal: "did:key:z6Mk-bob" },
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "open-2",
      error: {
        name: "AuthorizationError",
        message: "session session:fixed is already bound to did:key:z6Mk-alice",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server requires sessions to be opened on the current connection", async () => {
  const server = createServer("memory://memory-v2-server-connection-sessions");
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  const firstConnection = server.connect((message) =>
    firstMessages.push(message)
  );
  const secondConnection = server.connect((message) =>
    secondMessages.push(message)
  );
  const space = "did:key:z6Mk-space-current-connection";

  try {
    await firstConnection.receive(encodeMemoryV2Boundary(HELLO));
    assertEquals(shiftMessage(firstMessages), HELLO_OK);

    await firstConnection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: { sessionId: "session:fixed" },
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(firstMessages),
    );
    const sessionId = opened.ok!.sessionId;

    await secondConnection.receive(encodeMemoryV2Boundary(HELLO));
    assertEquals(shiftMessage(secondMessages), HELLO_OK);

    await secondConnection.receive(encodeMemoryV2Boundary({
      type: "graph.query",
      requestId: "query-1",
      space,
      sessionId,
      query: { roots: [] },
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "query-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await secondConnection.receive(encodeMemoryV2Boundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:foreign",
          value: { value: { hello: "world" } },
        }],
      },
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "tx-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await secondConnection.receive(encodeMemoryV2Boundary({
      type: "session.watch.set",
      requestId: "watch-set-1",
      space,
      sessionId,
      watches: [],
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "watch-set-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await secondConnection.receive(encodeMemoryV2Boundary({
      type: "session.watch.add",
      requestId: "watch-add-1",
      space,
      sessionId,
      watches: [],
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "watch-add-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await secondConnection.receive(encodeMemoryV2Boundary({
      type: "session.ack",
      requestId: "ack-1",
      space,
      sessionId,
      seenSeq: 0,
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "ack-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server transfers session ownership and rejects stale resume tokens", async () => {
  const server = createServer("memory://memory-v2-server-session-takeover");
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  const space = "did:key:z6Mk-space-session-takeover";
  const firstConnection = server.connect((message) =>
    firstMessages.push(message)
  );
  const secondConnection = server.connect((message) =>
    secondMessages.push(message)
  );

  try {
    await firstConnection.receive(encodeMemoryV2Boundary(HELLO));
    await secondConnection.receive(encodeMemoryV2Boundary(HELLO));
    assertEquals(shiftMessage(firstMessages), HELLO_OK);
    assertEquals(shiftMessage(secondMessages), HELLO_OK);

    await firstConnection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: { sessionId: "session:fixed" },
    }));
    const openedFirst = assertResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
    }>(shiftMessage(firstMessages));
    const initialToken = openedFirst.ok?.sessionToken;
    assertEquals(openedFirst.ok?.sessionId, "session:fixed");
    assertEquals(openedFirst.ok?.serverSeq, 0);
    assertExists(initialToken);

    await secondConnection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-2",
      space,
      session: {
        sessionId: "session:fixed",
        sessionToken: initialToken,
      },
    }));

    assertEquals(shiftMessage(firstMessages), {
      type: "session/revoked",
      space,
      sessionId: "session:fixed",
      reason: "taken-over",
    });

    const openedSecond = assertResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
      resumed?: boolean;
    }>(shiftMessage(secondMessages));
    assertEquals(openedSecond.ok?.sessionId, "session:fixed");
    assertEquals(openedSecond.ok?.serverSeq, 0);
    assertEquals(openedSecond.ok?.resumed, true);
    assertExists(openedSecond.ok?.sessionToken);
    assertEquals(openedSecond.ok?.sessionToken === initialToken, false);

    await firstConnection.receive(encodeMemoryV2Boundary({
      type: "graph.query",
      requestId: "query-1",
      space,
      sessionId: "session:fixed",
      query: { roots: [] },
    }));
    assertEquals(shiftMessage(firstMessages), {
      type: "response",
      requestId: "query-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await firstConnection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-3",
      space,
      session: {
        sessionId: "session:fixed",
        sessionToken: initialToken,
      },
    }));
    assertEquals(shiftMessage(firstMessages), {
      type: "response",
      requestId: "open-3",
      error: {
        name: "SessionRevokedError",
        message: "session session:fixed resume token is no longer valid",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects handshakes when flags disagree", async () => {
  const server = createServer("memory://memory-v2-server-handshake-flags");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryV2Boundary({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
      flags: {
        richStorableValues: !HELLO_FLAGS.richStorableValues,
        unifiedJsonEncoding: HELLO_FLAGS.unifiedJsonEncoding,
        canonicalHashing: HELLO_FLAGS.canonicalHashing,
        modernSchemaHash: HELLO_FLAGS.modernSchemaHash,
      },
    }));

    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "handshake",
      error: {
        name: "ProtocolError",
        message: `memory/v2 flag mismatch: client=${
          JSON.stringify({
            richStorableValues: !HELLO_FLAGS.richStorableValues,
            unifiedJsonEncoding: HELLO_FLAGS.unifiedJsonEncoding,
            canonicalHashing: HELLO_FLAGS.canonicalHashing,
            modernSchemaHash: HELLO_FLAGS.modernSchemaHash,
          })
        } server=${JSON.stringify(HELLO_FLAGS)}`,
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects unsafe spaces before opening a store", async () => {
  const server = createServer("memory://memory-v2-server-unsafe-space");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    assertEquals(shiftMessage(messages), HELLO_OK);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-unsafe",
      space: "../../evil",
      session: {},
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-unsafe",
      error: {
        name: "ProtocolError",
        message: "Invalid memory space identifier for store path: ../../evil",
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
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    assertEquals(shiftMessage(messages), HELLO_OK);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string; serverSeq: number }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );

    await connection.receive(encodeMemoryV2Boundary({
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
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

Deno.test("memory v2 server does not send watch effects after a connection closes mid-refresh", async () => {
  const server = createServer("memory://memory-v2-server-close-during-refresh");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-close-during-refresh";
  let releaseRefresh!: () => void;
  const waitForRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let sessionId = "";

  try {
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    sessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    ).ok!.sessionId;

    server.syncSessionForConnection = async (...args) => {
      await waitForRefresh;
      return {
        type: "session/effect",
        space: args[0],
        sessionId,
        effect: {
          type: "sync",
          serverSeq: 0,
          fromSeq: 0,
          toSeq: 0,
          upserts: [],
          removes: [],
        },
      };
    };

    const refreshPromise = connection.refreshDirty(space);
    await tick();
    connection.close();
    releaseRefresh();
    await refreshPromise;

    assertEquals(messages, []);
  } finally {
    await server.close();
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
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

Deno.test("memory v2 server treats duplicate watch ids in session.watch.add as no-op or protocol errors", async () => {
  const server = createServer("memory://memory-v2-server-watch-add-replace");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-add-replace";

  try {
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "shared",
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
    assertEquals(
      assertResponse<any>(shiftMessage(messages)).ok?.sync.upserts.map((
        entry: { id: string },
      ) => entry.id),
      ["of:doc:1"],
    );

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.watch.add",
      requestId: "watch-2",
      space,
      sessionId,
      watches: [{
        id: "shared",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }, {
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "watch-2",
      error: {
        name: "ProtocolError",
        message:
          "session.watch.add may not replace an existing watch id; use session.watch.set",
      },
    });

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.watch.add",
      requestId: "watch-3",
      space,
      sessionId,
      watches: [{
        id: "shared",
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
    const unchanged = assertResponse<any>(shiftMessage(messages));
    assertEquals(unchanged.ok?.sync.upserts, []);
    assertEquals(unchanged.ok?.sync.removes, []);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.watch.add",
      requestId: "watch-3b",
      space,
      sessionId,
      watches: [{
        id: "shared",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              schema: false,
              path: [],
            },
          }],
        },
      }],
    }));
    const reorderedEquivalent = assertResponse<any>(shiftMessage(messages));
    assertEquals(reorderedEquivalent.ok?.sync.upserts, []);
    assertEquals(reorderedEquivalent.ok?.sync.removes, []);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.watch.add",
      requestId: "watch-4",
      space,
      sessionId,
      watches: [{
        id: "shared",
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
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "watch-4",
      error: {
        name: "ProtocolError",
        message:
          "session.watch.add may not replace an existing watch id; use session.watch.set",
      },
    });

    await connection.receive(encodeMemoryV2Boundary({
      type: "transact",
      requestId: "update-doc-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 3 } },
        }],
      },
    }));
    assertEquals(
      assertResponse<any>(shiftMessage(messages)).requestId,
      "update-doc-2",
    );

    await tick();
    assertEquals(messages, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rolls back failed watch.add mutations", async () => {
  const server = createServer("memory://memory-v2-server-watch-add-rollback");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-add-rollback";

  try {
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    assertEquals(shiftMessage(messages), HELLO_OK);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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
    assertEquals(
      assertResponse<any>(shiftMessage(messages)).ok?.sync.upserts.map((
        entry: { id: string },
      ) => entry.id),
      ["of:doc:1"],
    );

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.watch.add",
      requestId: "watch-2",
      space,
      sessionId,
      watches: [{
        id: "extra",
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
      }, {
        id: "broken",
        kind: "graph",
        query: {
          branch: "branch:broken",
          roots: [{
            id: "of:doc:3",
          } as any],
        },
      }],
    } as any));
    const failed = assertResponse<any>(shiftMessage(messages));
    assertEquals(failed.requestId, "watch-2");
    assertEquals(failed.error?.name, "QueryError");

    await connection.receive(encodeMemoryV2Boundary({
      type: "transact",
      requestId: "update-doc-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 3 } },
        }],
      },
    }));
    assertEquals(
      assertResponse<any>(shiftMessage(messages)).requestId,
      "update-doc-2",
    );

    await tick();
    assertEquals(messages, []);
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
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

    await connection.receive(encodeMemoryV2Boundary({
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

Deno.test("memory v2 server processes back-to-back websocket messages in receive order before returning conflicts", async () => {
  const server = createServer(
    "memory://memory-v2-server-conflict-receive-order",
    20,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-conflict-receive-order";
  const originalTransact = server.transact.bind(server);
  const releaseTx2 = Promise.withResolvers<void>();

  (server as unknown as {
    transact(
      message: Parameters<Server["transact"]>[0],
    ): ReturnType<Server["transact"]>;
  }).transact = async (message) => {
    if (message.requestId === "tx-2") {
      await releaseTx2.promise;
    }
    return await originalTransact(message);
  };

  try {
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
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
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
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

    const tx2 = connection.receive(encodeMemoryV2Boundary({
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
    await tick();

    const tx3 = connection.receive(encodeMemoryV2Boundary({
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

    releaseTx2.resolve();
    await Promise.all([tx2, tx3]);

    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "tx-2");

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

Deno.test("memory v2 server waits for queued receives before rerunning scheduled watch refresh", async () => {
  const time = new FakeTime();
  const server = createServer(
    "memory://memory-v2-server-refresh-after-queue-drain",
    1,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-refresh-after-queue-drain";
  const originalSync = server.syncSessionForConnection.bind(server);
  const originalTransact = server.transact.bind(server);
  const releaseFirstRefresh = Promise.withResolvers<void>();
  const releaseTx3 = Promise.withResolvers<void>();
  let syncCalls = 0;

  (server as unknown as {
    syncSessionForConnection(
      ...args: Parameters<Server["syncSessionForConnection"]>
    ): ReturnType<Server["syncSessionForConnection"]>;
  }).syncSessionForConnection = async (...args) => {
    syncCalls += 1;
    if (syncCalls === 1) {
      await releaseFirstRefresh.promise;
    }
    return await originalSync(...args);
  };

  (server as unknown as {
    transact(
      message: Parameters<Server["transact"]>[0],
    ): ReturnType<Server["transact"]>;
  }).transact = async (message) => {
    if (message.requestId === "tx-3") {
      await releaseTx3.promise;
    }
    return await originalTransact(message);
  };

  try {
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [
        {
          id: "root-1",
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
        },
        {
          id: "root-2",
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
        },
      ],
    }));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
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

    await time.tickAsync(1);
    await time.tickAsync(0);

    await connection.receive(encodeMemoryV2Boundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:2",
          value: { value: { version: 2 } },
        }],
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "tx-2");

    const tx3 = connection.receive(encodeMemoryV2Boundary({
      type: "transact",
      requestId: "tx-3",
      space,
      sessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 3 } },
        }],
      },
    }));

    await time.tickAsync(0);
    releaseFirstRefresh.resolve();
    await time.tickAsync(0);

    const firstEffect = assertEffect(shiftMessage(messages));
    assertEquals(firstEffect.effect.toSeq, 2);
    assertEquals(firstEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      seq: 1,
      doc: {
        value: { version: 1 },
      },
    }]);
    assertEquals(messages, []);

    releaseTx3.resolve();
    await tx3;
    await time.tickAsync(0);

    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "tx-3");
    const secondEffect = assertEffect(shiftMessage(messages));
    assertEquals(secondEffect.effect.toSeq, 3);
    assertEquals(secondEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      seq: 3,
      doc: {
        value: { version: 3 },
      },
    }, {
      branch: "",
      id: "of:doc:2",
      seq: 2,
      doc: {
        value: { version: 2 },
      },
    }]);
    assertEquals(messages, []);
  } finally {
    await server.close();
    time.restore();
  }
});

Deno.test("memory v2 server reruns scheduled watch refresh after max deferral", async () => {
  const time = new FakeTime();
  const server = createServer(
    "memory://memory-v2-server-refresh-max-deferral",
    1,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-refresh-max-deferral";
  const originalSync = server.syncSessionForConnection.bind(server);
  const originalTransact = server.transact.bind(server);
  const releaseFirstRefresh = Promise.withResolvers<void>();
  const releaseTx3 = Promise.withResolvers<void>();
  let syncCalls = 0;

  (server as unknown as {
    syncSessionForConnection(
      ...args: Parameters<Server["syncSessionForConnection"]>
    ): ReturnType<Server["syncSessionForConnection"]>;
  }).syncSessionForConnection = async (...args) => {
    syncCalls += 1;
    if (syncCalls === 1) {
      await releaseFirstRefresh.promise;
    }
    return await originalSync(...args);
  };

  (server as unknown as {
    transact(
      message: Parameters<Server["transact"]>[0],
    ): ReturnType<Server["transact"]>;
  }).transact = async (message) => {
    if (message.requestId === "tx-3") {
      await releaseTx3.promise;
    }
    return await originalTransact(message);
  };

  try {
    await connection.receive(encodeMemoryV2Boundary(HELLO));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryV2Boundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [
        {
          id: "root-1",
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
        },
        {
          id: "root-2",
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
        },
      ],
    }));
    shiftMessage(messages);

    await connection.receive(encodeMemoryV2Boundary({
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

    await time.tickAsync(1);
    await time.tickAsync(0);

    await connection.receive(encodeMemoryV2Boundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:2",
          value: { value: { version: 2 } },
        }],
      },
    }));
    assertEquals(assertResponse<any>(shiftMessage(messages)).requestId, "tx-2");

    const tx3 = connection.receive(encodeMemoryV2Boundary({
      type: "transact",
      requestId: "tx-3",
      space,
      sessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 3 } },
        }],
      },
    }));

    await time.tickAsync(0);
    releaseFirstRefresh.resolve();
    await time.tickAsync(0);

    const firstEffect = assertEffect(shiftMessage(messages));
    assertEquals(firstEffect.effect.toSeq, 2);
    assertEquals(firstEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      seq: 1,
      doc: {
        value: { version: 1 },
      },
    }]);
    assertEquals(messages, []);

    await time.tickAsync(499);
    await time.tickAsync(0);
    assertEquals(messages, []);

    await time.tickAsync(1);
    await time.tickAsync(0);
    const secondEffect = assertEffect(shiftMessage(messages));
    assertEquals(secondEffect.effect.toSeq, 2);
    assertEquals(secondEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:2",
      seq: 2,
      doc: {
        value: { version: 2 },
      },
    }]);
    assertEquals(messages, []);

    releaseTx3.resolve();
    await tx3;
  } finally {
    await server.close();
    time.restore();
  }
});
