import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { INVALID_SPAN_CONTEXT, trace, type Tracer } from "@opentelemetry/api";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { parseClientMessage, Server, SessionRegistry } from "../v2/server.ts";
import {
  type ClientCommit,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  toDocumentPath,
} from "../v2.ts";
import { createGraphFixture } from "./v2-graph.fixture.ts";

const HELLO_FLAGS = getMemoryProtocolFlags();
const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: HELLO_FLAGS,
} as const;
const TEST_AUDIENCE = "did:key:z6Mk-memory-v2-server-test-audience";

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const assertHelloOk = (message: ServerMessage): HelloOkMessage => {
  assertEquals(message.type, "hello.ok");
  const hello = message as HelloOkMessage;
  assertExists(hello.sessionOpen);
  return hello;
};

const expectHelloOk = (messages: ServerMessage[]): SessionOpenAuthMetadata =>
  assertHelloOk(shiftMessage(messages)).sessionOpen!;

const authInvocation = (sessionOpen: SessionOpenAuthMetadata) => ({
  aud: sessionOpen.audience,
  challenge: sessionOpen.challenge.value,
});

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

const createServer = (
  store: string,
  refreshDelayMs = 0,
  commitTelemetry = false,
  diagnosticsOptions: {
    aggregateOnlyDiagnostics?: boolean;
    diagnosticsTracer?: Tracer;
  } = {},
) =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: refreshDelayMs,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string"
        ? principal
        : "did:key:z6Mk-memory-v2-server-principal";
    },
    sessionOpenAuth: {
      audience: TEST_AUDIENCE,
    },
    commitTelemetry,
    ...diagnosticsOptions,
  });

const recordingTracer = (names: string[]): Tracer =>
  ({
    startActiveSpan(name: string, ...args: unknown[]) {
      const callback = args.at(-1);
      if (typeof callback !== "function") {
        throw new Error("recording tracer requires a span callback");
      }
      names.push(name);
      return callback(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
    },
  }) as unknown as Tracer;

const encodedByteLength = (
  value: Parameters<typeof encodeMemoryBoundary>[0],
): number => new TextEncoder().encode(encodeMemoryBoundary(value)).byteLength;

Deno.test("memory v2 server stateless respond does not issue hello.ok", async () => {
  const server = createServer("memory://memory-v2-server-stateless-respond");
  try {
    const payload = await server.respond(encodeMemoryBoundary(HELLO));
    assertExists(payload);
    const response = assertResponse<unknown>(
      decodeMemoryBoundary(payload) as ServerMessage,
    );
    assertEquals(response.requestId, "handshake");
    assertEquals(response.error?.name, "ProtocolError");
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server parser ignores transact invocation and authorization payloads", () => {
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
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

Deno.test("memory v2 scheduler listing rejects arbitrary context selectors", () => {
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "scheduler.snapshot.list",
      requestId: "scheduler-list-context",
      space: "did:key:z6Mk-space",
      sessionId: "session:alice",
      query: { executionContextKey: "user:did%3Akey%3Abob" },
    })),
    null,
  );

  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "scheduler.snapshot.list",
      requestId: "scheduler-list-cursor",
      space: "did:key:z6Mk-space",
      sessionId: "session:alice",
      query: {
        branch: "feature",
        ownerSpace: "did:key:z6Mk-owner",
        pieceId: "space:of:piece",
        processGeneration: 0,
        actionId: "pattern.tsx:computed:1",
        sinceCommitSeq: 1,
        throughCommitSeq: 2,
        limit: 10,
        cursor: {
          ownerSpace: "did:key:z6Mk-owner",
          pieceId: "space:of:piece",
          processGeneration: 0,
          actionId: "pattern.tsx:computed:1",
          executionContextKey: "session:did%3Akey%3Aalice:session%3Aalice",
        },
      },
    })),
    {
      type: "scheduler.snapshot.list",
      requestId: "scheduler-list-cursor",
      space: "did:key:z6Mk-space",
      sessionId: "session:alice",
      query: {
        branch: "feature",
        ownerSpace: "did:key:z6Mk-owner",
        pieceId: "space:of:piece",
        processGeneration: 0,
        actionId: "pattern.tsx:computed:1",
        sinceCommitSeq: 1,
        throughCommitSeq: 2,
        limit: 10,
        cursor: {
          ownerSpace: "did:key:z6Mk-owner",
          pieceId: "space:of:piece",
          processGeneration: 0,
          actionId: "pattern.tsx:computed:1",
          executionContextKey: "session:did%3Akey%3Aalice:session%3Aalice",
        },
      },
    },
  );

  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "scheduler.snapshot.list",
      requestId: "scheduler-list-invalid-cursor",
      space: "did:key:z6Mk-space",
      sessionId: "session:alice",
      query: {
        cursor: {
          pieceId: "space:of:piece",
          processGeneration: -1,
          actionId: "pattern.tsx:computed:1",
          executionContextKey: "space",
        },
      },
    })),
    null,
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

Deno.test("memory v2 server consumes a challenged session open", async () => {
  const audience = "did:key:z6Mk-memory-v2-server-audience";
  let now = 1_000_000;
  const server = new Server({
    store: new URL("memory://memory-v2-server-challenge-reuse"),
    authorizeSessionOpen: () => "did:key:z6Mk-memory-v2-server-principal",
    sessionOpenAuth: {
      audience,
      challengeTtlSeconds: 60,
      nowSeconds: () => now,
    },
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const hello = shiftMessage(messages) as HelloOkMessage;
    assertEquals(hello.type, "hello.ok");
    assertEquals(hello.sessionOpen?.audience, audience);
    const challenge = hello.sessionOpen?.challenge;
    assertExists(challenge);
    assertEquals(challenge.expiresAt, now + 60);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-memory-v2-server-challenge-space",
      session: {},
      invocation: {
        aud: audience,
        challenge: challenge.value,
      },
    }));
    const opened = assertResponse<{
      sessionId: string;
      sessionOpen?: { challenge?: { value: string; expiresAt: number } };
    }>(
      shiftMessage(messages),
    );
    assertEquals(opened.requestId, "open-1");
    assertExists(opened.ok?.sessionId);
    const nextChallenge = opened.ok?.sessionOpen?.challenge;
    assertExists(nextChallenge);
    assertEquals(nextChallenge.expiresAt, now + 60);

    now += 1;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space: "did:key:z6Mk-memory-v2-server-challenge-space",
      session: {},
      invocation: {
        aud: audience,
        challenge: challenge.value,
      },
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-2",
      error: {
        name: "AuthorizationError",
        message: "memory session.open challenge mismatch",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects an expired session open challenge", async () => {
  const audience = "did:key:z6Mk-memory-v2-server-expired-audience";
  let now = 1_000_000;
  const server = new Server({
    store: new URL("memory://memory-v2-server-challenge-expired"),
    authorizeSessionOpen: () => "did:key:z6Mk-memory-v2-server-principal",
    sessionOpenAuth: {
      audience,
      challengeTtlSeconds: 60,
      nowSeconds: () => now,
    },
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const hello = shiftMessage(messages) as HelloOkMessage;
    assertEquals(hello.type, "hello.ok");
    const challenge = hello.sessionOpen?.challenge;
    assertExists(challenge);

    now = challenge.expiresAt;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-memory-v2-server-expired-space",
      session: {},
      invocation: {
        aud: audience,
        challenge: challenge.value,
      },
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-1",
      error: {
        name: "AuthorizationError",
        message: "memory session.open challenge expired",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects invalid session open auth metadata", async () => {
  const server = createServer(
    "memory://memory-v2-server-invalid-session-open-auth",
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);
    const cases = [
      {
        requestId: "missing-audience",
        invocation: {
          challenge: sessionOpen.challenge.value,
        },
        message: "memory session.open requires audience",
      },
      {
        requestId: "wrong-audience",
        invocation: {
          aud: "did:key:z6Mk-memory-v2-server-wrong-audience",
          challenge: sessionOpen.challenge.value,
        },
        message: "memory session.open audience mismatch",
      },
      {
        requestId: "missing-challenge",
        invocation: {
          aud: sessionOpen.audience,
        },
        message: "memory session.open requires challenge",
      },
      {
        requestId: "wrong-challenge",
        invocation: {
          aud: sessionOpen.audience,
          challenge: "challenge:wrong",
        },
        message: "memory session.open challenge mismatch",
      },
    ];

    for (const testCase of cases) {
      await connection.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: testCase.requestId,
        space: "did:key:z6Mk-memory-v2-server-invalid-auth-space",
        session: {},
        invocation: testCase.invocation,
      }));
      assertEquals(shiftMessage(messages), {
        type: "response",
        requestId: testCase.requestId,
        error: {
          name: "AuthorizationError",
          message: testCase.message,
        },
      });
    }
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects session open before issuing challenge", async () => {
  const server = createServer(
    "memory://memory-v2-server-session-open-before-challenge",
  );
  const connection = server.connect(() => {});

  try {
    const response = await server.openSession({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-memory-v2-server-before-challenge-space",
      session: {},
      invocation: {
        aud: TEST_AUDIENCE,
        challenge: "challenge:missing",
      },
    }, connection);
    assertEquals(response, {
      type: "response",
      requestId: "open-1",
      error: {
        name: "AuthorizationError",
        message: "memory session.open challenge unavailable",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server consumes challenge before denied session open", async () => {
  const audience = "did:key:z6Mk-memory-v2-server-denied-audience";
  const space = "did:key:z6Mk-memory-v2-server-denied-space";
  const server = new Server({
    store: new URL("memory://memory-v2-server-denied-consumes-challenge"),
    authorizeSessionOpen: () => undefined,
    sessionOpenAuth: {
      audience,
    },
    acl: {
      mode: "enforce",
    },
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-1",
      error: {
        name: "AuthorizationError",
        message: `Principal <anonymous> lacks READ on space ${space}`,
      },
    });

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-2",
      error: {
        name: "AuthorizationError",
        message: "memory session.open challenge already used",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server allows the same session id in different spaces", async () => {
  const server = createServer("memory://memory-v2-server-session-scope");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    let sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(sessionOpen),
    }));
    const openedOne = assertResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
      sessionOpen: SessionOpenAuthMetadata;
    }>(shiftMessage(messages));
    assertEquals(openedOne.requestId, "open-1");
    assertEquals(openedOne.ok?.sessionId, "session:fixed");
    assertEquals(openedOne.ok?.serverSeq, 0);
    assertExists(openedOne.ok?.sessionToken);
    assertExists(openedOne.ok?.sessionOpen);
    sessionOpen = openedOne.ok.sessionOpen;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space: "did:key:z6Mk-space-two",
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(sessionOpen),
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

Deno.test("memory v2 dirty refresh stays on the connection's mounted space", async () => {
  const server = createServer("memory://memory-v2-server-refresh-space-scope");
  const first = server.connect(() => {});
  const second = server.connect(() => {});
  const firstSpace = "did:key:z6Mk-refresh-space-one";
  const secondSpace = "did:key:z6Mk-refresh-space-two";
  const sessionId = "session:shared-across-spaces";

  try {
    first.addSession(firstSpace, sessionId);
    second.addSession(secondSpace, sessionId);

    const syncCalls: Array<{ space: string; sessionId: string }> = [];
    server.syncSessionForConnection = (space, mountedSessionId) => {
      syncCalls.push({ space, sessionId: mountedSessionId });
      return Promise.resolve(null);
    };

    // The server fans a dirty-space refresh to every connection. A connection
    // mounted only in another space must not consume this session's cursor,
    // even when both mounts intentionally share one execution-context id.
    await Promise.all([
      first.refreshDirty(secondSpace),
      second.refreshDirty(secondSpace),
    ]);

    assertEquals(syncCalls, [{ space: secondSpace, sessionId }]);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server direct writes schedule dirty refreshes without connections", async () => {
  const time = new FakeTime();
  const server = createServer(
    "memory://memory-v2-server-direct-write-no-connections",
    1,
  );
  const space = "did:key:z6Mk-memory-v2-server-direct-write-no-connections";
  const id = "cid:fid1:direct-write-no-connections";
  const originalFlush = server.flushSessions.bind(server);
  let flushCalls = 0;

  (server as unknown as {
    flushSessions(
      ...args: Parameters<Server["flushSessions"]>
    ): ReturnType<Server["flushSessions"]>;
  }).flushSessions = async (...args) => {
    flushCalls += 1;
    return await originalFlush(...args);
  };

  try {
    await server.writeDocument(space, id, {
      type: "text/plain",
      body: "hello",
    });
    assertEquals(flushCalls, 0);

    await time.tickAsync(1);
    await time.tickAsync(0);

    assertEquals(flushCalls, 1);
    assertEquals(await server.readDocument(space, id), {
      value: {
        type: "text/plain",
        body: "hello",
      },
    });
  } finally {
    await server.close();
    time.restore();
  }
});

Deno.test("memory v2 server direct document helpers round-trip values", async () => {
  const server = createServer("memory://memory-v2-server-direct-documents");
  const space = "did:key:z6Mk-memory-v2-server-direct-documents";
  const id = "cid:fid1:direct-document";
  const contents = {
    type: "image/png",
    body: new FabricBytes(new Uint8Array([1, 2, 3, 4])),
  };

  try {
    await server.writeDocument(space, id, contents);

    assertEquals(await server.readDocument(space, id), {
      value: contents,
    });
    assertEquals(
      await server.readDocument(space, "cid:fid1:missing-document"),
      null,
    );
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
    sessionOpenAuth: {
      audience: TEST_AUDIENCE,
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
    await firstConnection.receive(encodeMemoryBoundary(HELLO));
    const firstSessionOpen = expectHelloOk(firstMessages);

    await firstConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(firstSessionOpen),
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

    await secondConnection.receive(encodeMemoryBoundary(HELLO));
    const secondSessionOpen = expectHelloOk(secondMessages);

    await secondConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(secondSessionOpen),
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
    await firstConnection.receive(encodeMemoryBoundary(HELLO));
    const firstSessionOpen = expectHelloOk(firstMessages);

    await firstConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(firstSessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(firstMessages),
    );
    const sessionId = opened.ok!.sessionId;

    await secondConnection.receive(encodeMemoryBoundary(HELLO));
    expectHelloOk(secondMessages);

    await secondConnection.receive(encodeMemoryBoundary({
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

    await secondConnection.receive(encodeMemoryBoundary({
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

    await secondConnection.receive(encodeMemoryBoundary({
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

    await secondConnection.receive(encodeMemoryBoundary({
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

    await secondConnection.receive(encodeMemoryBoundary({
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
    await firstConnection.receive(encodeMemoryBoundary(HELLO));
    await secondConnection.receive(encodeMemoryBoundary(HELLO));
    let firstSessionOpen = expectHelloOk(firstMessages);
    const secondSessionOpen = expectHelloOk(secondMessages);

    await firstConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(firstSessionOpen),
    }));
    const openedFirst = assertResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
      sessionOpen: SessionOpenAuthMetadata;
    }>(shiftMessage(firstMessages));
    const initialToken = openedFirst.ok?.sessionToken;
    assertEquals(openedFirst.ok?.sessionId, "session:fixed");
    assertEquals(openedFirst.ok?.serverSeq, 0);
    assertExists(initialToken);
    assertExists(openedFirst.ok?.sessionOpen);
    firstSessionOpen = openedFirst.ok.sessionOpen;

    await secondConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space,
      session: {
        sessionId: "session:fixed",
        sessionToken: initialToken,
      },
      invocation: authInvocation(secondSessionOpen),
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

    await firstConnection.receive(encodeMemoryBoundary({
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

    await firstConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-3",
      space,
      session: {
        sessionId: "session:fixed",
        sessionToken: initialToken,
      },
      invocation: authInvocation(firstSessionOpen),
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

Deno.test("memory v2 server rejects handshakes when modernCellRep flags disagree", async () => {
  const server = createServer("memory://memory-v2-server-handshake-flags");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: {
        modernCellRep: !HELLO_FLAGS.modernCellRep,
      },
    }));

    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "handshake",
      error: {
        name: "ProtocolError",
        message: `memory flag mismatch: client=${
          JSON.stringify({
            modernCellRep: !HELLO_FLAGS.modernCellRep,
          })
        } server=${JSON.stringify(HELLO_FLAGS)}`,
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server accepts scheduler-state flag mismatch", async () => {
  const server = createServer(
    "memory://memory-v2-server-handshake-scheduler-flag",
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: {
        ...HELLO_FLAGS,
        persistentSchedulerState: !HELLO_FLAGS.persistentSchedulerState,
      },
    }));

    expectHelloOk(messages);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects unsafe spaces before opening a store", async () => {
  const server = createServer("memory://memory-v2-server-unsafe-space");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-unsafe",
      space: "../../evil",
      session: {},
      invocation: authInvocation(sessionOpen),
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
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string; serverSeq: number }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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
      scopeKey: "space",
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

    await connection.receive(encodeMemoryBoundary({
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

Deno.test("memory v2 server commit telemetry records received transact aggregates", async () => {
  const server = createServer(
    "memory://memory-v2-server-commit-telemetry",
    0,
    true,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-commit-telemetry";
  const initialCommit = {
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:doc:1",
      value: { value: { version: 1, links: [] } },
    }],
  };
  const conflictingRead = { id: "of:doc:1", path: [], seq: 0 };
  const patchCommit = {
    localSeq: 2,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "patch",
      id: "of:doc:1",
      patches: [
        { op: "replace", path: "/value", value: { version: 2, links: [] } },
        {
          op: "add",
          path: "/value/did:key:z6MkTelemetrySecret/content-shaped-key",
          value: true,
        },
        {
          op: "append",
          path: "/value/links",
          values: ["private-link-value"],
        },
      ],
    }],
  };
  const conflictingCommit = {
    localSeq: 3,
    reads: { confirmed: [conflictingRead], pending: [] },
    operations: [{
      op: "set",
      id: "of:doc:1",
      value: { value: { version: 2 } },
    }],
  };
  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-telemetry",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    for (
      const [requestId, commit] of [
        ["tx-1", initialCommit],
        ["tx-replay", initialCommit],
        ["tx-patch", patchCommit],
        ["tx-patch-replay", patchCommit],
        ["tx-conflict", conflictingCommit],
      ] as const
    ) {
      await connection.receive(encodeMemoryBoundary({
        type: "transact",
        requestId,
        space,
        sessionId,
        commit,
      }));
      shiftMessage(messages);
    }

    const initialCommitBytes = encodedByteLength(initialCommit);
    const conflictingCommitBytes = encodedByteLength(conflictingCommit);
    const patchCommitBytes = encodedByteLength(patchCommit);
    const initialOperationBytes = encodedByteLength(
      initialCommit.operations[0],
    );
    const conflictingOperationBytes = encodedByteLength(
      conflictingCommit.operations[0],
    );
    const patchOperationBytes = encodedByteLength(patchCommit.operations[0]);
    const emptyConfirmedReadsBytes = encodedByteLength(
      initialCommit.reads.confirmed,
    );
    const conflictingConfirmedReadsBytes = encodedByteLength(
      conflictingCommit.reads.confirmed,
    );
    const telemetry = server.commitTelemetry();
    assertEquals(telemetry, {
      transactCount: 5,
      acceptedCount: 4,
      rejectedCount: 1,
      conflictCount: 1,
      replayCount: 2,
      receivedCommitBytes: {
        total: initialCommitBytes * 2 + patchCommitBytes * 2 +
          conflictingCommitBytes,
        max: Math.max(
          initialCommitBytes,
          patchCommitBytes,
          conflictingCommitBytes,
        ),
      },
      confirmedReadEntries: { total: 1, max: 1 },
      confirmedReadBytes: {
        total: emptyConfirmedReadsBytes * 4 + conflictingConfirmedReadsBytes,
        max: Math.max(emptyConfirmedReadsBytes, conflictingConfirmedReadsBytes),
      },
      operationEntries: { total: 5, max: 1 },
      operationBytes: {
        total: initialOperationBytes * 2 + patchOperationBytes * 2 +
          conflictingOperationBytes,
        max: Math.max(
          initialOperationBytes,
          patchOperationBytes,
          conflictingOperationBytes,
        ),
      },
      newlyPersistedRevisions: { total: 2, max: 1 },
      operationsByType: { set: 3, patch: 2, delete: 0, sqlite: 0 },
      receivedPatchOperationsByType: {
        replace: 2,
        add: 2,
        remove: 0,
        move: 0,
        splice: 0,
        append: 2,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      newlyAppliedPatchOperationsByType: {
        replace: 1,
        add: 1,
        remove: 0,
        move: 0,
        splice: 0,
        append: 1,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      patchesByPathShape: { "value-root": 2, "value/*/*": 2, "value/*": 2 },
      rejectedByName: { ConflictError: 1 },
    });
    const serializedTelemetry = encodeMemoryBoundary(telemetry);
    assertEquals(
      serializedTelemetry.includes("did:key:z6MkTelemetrySecret"),
      false,
    );
    assertEquals(serializedTelemetry.includes("content-shaped-key"), false);
    assertEquals(serializedTelemetry.includes("private-link-value"), false);
    telemetry.operationsByType.set = 999;
    telemetry.receivedPatchOperationsByType.append = 999;
    telemetry.newlyAppliedPatchOperationsByType.append = 999;
    telemetry.patchesByPathShape["value-root"] = 999;
    assertEquals(server.commitTelemetry(), {
      transactCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      conflictCount: 0,
      replayCount: 0,
      receivedCommitBytes: { total: 0, max: 0 },
      confirmedReadEntries: { total: 0, max: 0 },
      confirmedReadBytes: { total: 0, max: 0 },
      operationEntries: { total: 0, max: 0 },
      operationBytes: { total: 0, max: 0 },
      newlyPersistedRevisions: { total: 0, max: 0 },
      operationsByType: { set: 0, patch: 0, delete: 0, sqlite: 0 },
      receivedPatchOperationsByType: {
        replace: 0,
        add: 0,
        remove: 0,
        move: 0,
        splice: 0,
        append: 0,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      newlyAppliedPatchOperationsByType: {
        replace: 0,
        add: 0,
        remove: 0,
        move: 0,
        splice: 0,
        append: 0,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      patchesByPathShape: {},
      rejectedByName: {},
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects telemetry snapshots when disabled", async () => {
  const server = createServer("memory://memory-v2-server-telemetry-disabled");
  try {
    assertThrows(
      () => server.commitTelemetry(),
      Error,
      "commit telemetry is disabled",
    );
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server aggregate diagnostics bypass exported spans", async () => {
  const ordinarySpanNames: string[] = [];
  const ordinary = createServer(
    "memory://memory-v2-server-ordinary-spans",
    0,
    false,
    { diagnosticsTracer: recordingTracer(ordinarySpanNames) },
  );
  const aggregateSpanNames: string[] = [];
  const aggregate = createServer(
    "memory://memory-v2-server-aggregate-spans",
    0,
    true,
    {
      aggregateOnlyDiagnostics: true,
      diagnosticsTracer: recordingTracer(aggregateSpanNames),
    },
  );

  try {
    await Promise.all([
      ordinary.flushSessions(["did:key:z6Mk-ordinary-span"]),
      aggregate.flushSessions(["did:key:z6Mk-private-aggregate-span"]),
    ]);

    assertEquals(ordinarySpanNames, ["memory.fanout"]);
    assertEquals(aggregateSpanNames, []);
  } finally {
    await Promise.all([ordinary.close(), aggregate.close()]);
  }
});

Deno.test("memory v2 server telemetry accounts for unknown-session attempts", async () => {
  const server = createServer(
    "memory://memory-v2-server-telemetry-unknown-session",
    0,
    true,
  );
  const commit: ClientCommit = {
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:telemetry-unknown-session",
      value: { value: { ignored: true } },
    }],
  };

  try {
    const response = await server.transact({
      type: "transact",
      requestId: "unknown-session",
      space: "did:key:z6Mk-memory-v2-server-telemetry-unknown-session",
      sessionId: "session:unknown",
      commit,
    });
    assertEquals(response.error?.name, "SessionError");
    assertEquals(server.commitTelemetry(), {
      transactCount: 1,
      acceptedCount: 0,
      rejectedCount: 1,
      conflictCount: 0,
      replayCount: 0,
      receivedCommitBytes: {
        total: encodedByteLength(commit),
        max: encodedByteLength(commit),
      },
      confirmedReadEntries: { total: 0, max: 0 },
      confirmedReadBytes: {
        total: encodedByteLength(commit.reads.confirmed),
        max: encodedByteLength(commit.reads.confirmed),
      },
      operationEntries: { total: 1, max: 1 },
      operationBytes: {
        total: encodedByteLength(commit.operations[0]),
        max: encodedByteLength(commit.operations[0]),
      },
      newlyPersistedRevisions: { total: 0, max: 0 },
      operationsByType: { set: 1, patch: 0, delete: 0, sqlite: 0 },
      receivedPatchOperationsByType: {
        replace: 0,
        add: 0,
        remove: 0,
        move: 0,
        splice: 0,
        append: 0,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      newlyAppliedPatchOperationsByType: {
        replace: 0,
        add: 0,
        remove: 0,
        move: 0,
        splice: 0,
        append: 0,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      patchesByPathShape: {},
      rejectedByName: { SessionError: 1 },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server telemetry accounts for transacts rejected by a connection session gate", async () => {
  const server = createServer(
    "memory://memory-v2-server-telemetry-connection-session",
    0,
    true,
  );
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  const firstConnection = server.connect((message) =>
    firstMessages.push(message)
  );
  const secondConnection = server.connect((message) =>
    secondMessages.push(message)
  );
  const space = "did:key:z6Mk-memory-v2-server-telemetry-connection-session";
  const commit: ClientCommit = {
    localSeq: 1,
    reads: {
      confirmed: [{
        id: "of:telemetry-connection-session",
        path: toDocumentPath([]),
        seq: 0,
      }],
      pending: [],
    },
    operations: [{
      op: "patch",
      id: "of:telemetry-connection-session",
      patches: [
        { op: "replace", path: "/value", value: { ignored: true } },
        { op: "append", path: "/value/items", values: ["ignored"] },
      ],
    }],
  };

  try {
    await firstConnection.receive(encodeMemoryBoundary(HELLO));
    const firstSessionOpen = expectHelloOk(firstMessages);
    await firstConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-first",
      space,
      session: { sessionId: "session:first" },
      invocation: authInvocation(firstSessionOpen),
    }));
    assertEquals(
      assertResponse<{ sessionId: string }>(shiftMessage(firstMessages)).ok
        ?.sessionId,
      "session:first",
    );

    await secondConnection.receive(encodeMemoryBoundary(HELLO));
    expectHelloOk(secondMessages);
    await secondConnection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "rejected-connection-transaction",
      space,
      sessionId: "session:first",
      commit,
    }));

    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "rejected-connection-transaction",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });
    assertEquals(
      await server.readDocument(space, "of:telemetry-connection-session"),
      null,
    );
    assertEquals(server.diagnosticsActivityGeneration(), 1);
    assertEquals(server.commitTelemetry(), {
      transactCount: 1,
      acceptedCount: 0,
      rejectedCount: 1,
      conflictCount: 0,
      replayCount: 0,
      receivedCommitBytes: {
        total: encodedByteLength(commit),
        max: encodedByteLength(commit),
      },
      confirmedReadEntries: { total: 1, max: 1 },
      confirmedReadBytes: {
        total: encodedByteLength(commit.reads.confirmed),
        max: encodedByteLength(commit.reads.confirmed),
      },
      operationEntries: { total: 1, max: 1 },
      operationBytes: {
        total: encodedByteLength(commit.operations[0]),
        max: encodedByteLength(commit.operations[0]),
      },
      newlyPersistedRevisions: { total: 0, max: 0 },
      operationsByType: { set: 0, patch: 1, delete: 0, sqlite: 0 },
      receivedPatchOperationsByType: {
        replace: 1,
        add: 0,
        remove: 0,
        move: 0,
        splice: 0,
        append: 1,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      newlyAppliedPatchOperationsByType: {
        replace: 0,
        add: 0,
        remove: 0,
        move: 0,
        splice: 0,
        append: 0,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      patchesByPathShape: { "value-root": 1, "value/*": 1 },
      rejectedByName: { SessionError: 1 },
    });
    assertEquals(server.diagnosticsActivityGeneration(), 1);
    assertEquals(server.commitTelemetry(), {
      transactCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      conflictCount: 0,
      replayCount: 0,
      receivedCommitBytes: { total: 0, max: 0 },
      confirmedReadEntries: { total: 0, max: 0 },
      confirmedReadBytes: { total: 0, max: 0 },
      operationEntries: { total: 0, max: 0 },
      operationBytes: { total: 0, max: 0 },
      newlyPersistedRevisions: { total: 0, max: 0 },
      operationsByType: { set: 0, patch: 0, delete: 0, sqlite: 0 },
      receivedPatchOperationsByType: {
        replace: 0,
        add: 0,
        remove: 0,
        move: 0,
        splice: 0,
        append: 0,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      newlyAppliedPatchOperationsByType: {
        replace: 0,
        add: 0,
        remove: 0,
        move: 0,
        splice: 0,
        append: 0,
        "add-unique": 0,
        "remove-by-value": 0,
        increment: 0,
      },
      patchesByPathShape: {},
      rejectedByName: {},
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
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );

    await connection.receive(encodeMemoryBoundary({
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
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-expansion";
  const fixture = createGraphFixture(space);

  try {
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(writerMessages),
    ).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId: writerSessionId,
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
    assertEquals(
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "seed",
    );

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "expand",
      space,
      sessionId,
      commit: {
        localSeq: 1,
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
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
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
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(writerMessages),
    ).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId: writerSessionId,
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
    assertEquals(
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "seed",
    );

    await connection.receive(encodeMemoryBoundary({
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

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "shrink",
      space,
      sessionId: writerSessionId,
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
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
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
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
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

Deno.test("memory v2 server refreshes watched docs by syncing only the touched entity", async () => {
  const server = createServer("memory://memory-v2-server-incremental-watch");
  const messages: ServerMessage[] = [];
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-incremental-watch";

  try {
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(writerMessages),
    ).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId: writerSessionId,
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
    assertEquals(
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "seed",
    );

    await connection.receive(encodeMemoryBoundary({
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

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "update",
      space,
      sessionId: writerSessionId,
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
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "update",
    );

    await tick();
    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.upserts.map((entry) => entry.id), ["of:doc:1"]);
    assertEquals(effect.effect.removes, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server watch.add bootstraps only the newly added watch", async () => {
  const server = createServer("memory://memory-v2-server-watch-add");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-add";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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
      scope: "space",
    }]);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server records emitted watch effects for diagnostics", async () => {
  const server = createServer(
    "memory://memory-v2-server-suppress-own-watch",
    0,
    true,
  );
  const writerMessages: ServerMessage[] = [];
  const observerMessages: ServerMessage[] = [];
  const writer = server.connect((message) => writerMessages.push(message));
  const observerEffectSent = Promise.withResolvers<void>();
  const observer = server.connect((message) => {
    observerMessages.push(message);
    if (message.type === "session/effect") observerEffectSent.resolve();
  });
  const space = "did:key:z6Mk-memory-v2-suppress-own-watch";

  try {
    for (const connection of [writer, observer]) {
      await connection.receive(encodeMemoryBoundary(HELLO));
    }
    const writerSessionOpen = expectHelloOk(writerMessages);
    const observerSessionOpen = expectHelloOk(observerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(writerMessages),
    ).ok!.sessionId;

    await observer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "observer-open",
      space,
      session: {},
      invocation: authInvocation(observerSessionOpen),
    }));
    const observerSessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(observerMessages),
    ).ok!.sessionId;

    for (
      const [connection, sessionId, requestId, messages] of [
        [writer, writerSessionId, "writer-watch", writerMessages],
        [observer, observerSessionId, "observer-watch", observerMessages],
      ] as const
    ) {
      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.set",
        requestId,
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
    }

    const generationBeforeTransaction = server.diagnosticsActivityGeneration();
    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "writer-tx",
      space,
      sessionId: writerSessionId,
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
    const committed = assertResponse<any>(shiftMessage(writerMessages));
    assertEquals(committed.requestId, "writer-tx");
    assertEquals(committed.ok?.seq, 1);
    assertEquals(
      server.diagnosticsActivityGeneration(),
      generationBeforeTransaction + 1,
    );

    let flushComplete = false;
    const flush = server.flushDiagnosticsSessions().then(() => {
      flushComplete = true;
    });

    await observerEffectSent.promise;
    assertEquals(writerMessages, []);
    const observerEffect = assertEffect(shiftMessage(observerMessages));
    assertEquals(observerEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 1,
      doc: {
        value: { version: 1 },
      },
    }]);
    assertEquals(observerEffect.effect.removes, []);
    assertEquals(observerMessages, []);
    await Promise.resolve();
    assertEquals(flushComplete, false);

    await observer.receive(encodeMemoryBoundary({
      type: "session.ack",
      requestId: "observer-ack",
      space,
      sessionId: observerSessionId,
      seenSeq: observerEffect.effect.toSeq,
    }));
    assertEquals(
      assertResponse<unknown>(shiftMessage(observerMessages)).requestId,
      "observer-ack",
    );
    await flush;
    assertEquals(flushComplete, true);
    assertEquals(
      server.diagnosticsActivityGeneration(),
      generationBeforeTransaction + 2,
    );
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 diagnostics flush completes without emitted effects", async () => {
  const server = createServer(
    "memory://memory-v2-server-diagnostics-no-effect",
    0,
    true,
  );
  try {
    await server.flushDiagnosticsSessions();
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 diagnostics flush releases an effect waiter when its connection closes", async () => {
  const server = createServer(
    "memory://memory-v2-server-diagnostics-closed-session",
    0,
    true,
  );
  const messages: ServerMessage[] = [];
  const effectSent = Promise.withResolvers<void>();
  const connection = server.connect((message) => {
    messages.push(message);
    if (message.type === "session/effect") effectSent.resolve();
  });
  const space = "did:key:z6Mk-memory-v2-server-diagnostics-closed-session";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const sessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    ).ok!.sessionId;
    server.syncSessionForConnection = () =>
      Promise.resolve({
        type: "session/effect",
        space,
        sessionId,
        effect: {
          type: "sync",
          fromSeq: 0,
          toSeq: 1,
          upserts: [],
          removes: [],
        },
      });
    server.markSpaceDirty(space);

    const flush = server.flushDiagnosticsSessions();
    await effectSent.promise;
    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.toSeq, 1);
    connection.close();
    await flush;
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 diagnostics flush serializes overlapping effect fences", async () => {
  const server = createServer(
    "memory://memory-v2-server-diagnostics-overlapping-flushes",
    0,
    true,
  );
  const messages: ServerMessage[] = [];
  const effectSent = Promise.withResolvers<void>();
  const connection = server.connect((message) => {
    messages.push(message);
    if (message.type === "session/effect") effectSent.resolve();
  });
  const space = "did:key:z6Mk-memory-v2-server-diagnostics-overlapping-flushes";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const sessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    ).ok!.sessionId;
    server.syncSessionForConnection = () =>
      Promise.resolve({
        type: "session/effect",
        space,
        sessionId,
        effect: {
          type: "sync",
          fromSeq: 0,
          toSeq: 1,
          upserts: [],
          removes: [],
        },
      });
    server.markSpaceDirty(space);

    let firstResolved = false;
    let secondResolved = false;
    const first = server.flushDiagnosticsSessions().then(() => {
      firstResolved = true;
    });
    await effectSent.promise;
    const second = server.flushDiagnosticsSessions().then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    assertEquals(firstResolved, false);
    assertEquals(secondResolved, false);

    const effect = assertEffect(shiftMessage(messages));
    await connection.receive(encodeMemoryBoundary({
      type: "session.ack",
      requestId: "ack",
      space,
      sessionId,
      seenSeq: effect.effect.toSeq,
    }));
    shiftMessage(messages);
    await Promise.all([first, second]);
    assertEquals(firstResolved, true);
    assertEquals(secondResolved, true);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server close releases an outstanding diagnostics flush", async () => {
  const server = createServer(
    "memory://memory-v2-server-diagnostics-close-flush",
    0,
    true,
  );
  const messages: ServerMessage[] = [];
  const effectSent = Promise.withResolvers<void>();
  const connection = server.connect((message) => {
    messages.push(message);
    if (message.type === "session/effect") effectSent.resolve();
  });
  const space = "did:key:z6Mk-memory-v2-server-diagnostics-close-flush";
  let closed = false;

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const sessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    ).ok!.sessionId;
    server.syncSessionForConnection = () =>
      Promise.resolve({
        type: "session/effect",
        space,
        sessionId,
        effect: {
          type: "sync",
          fromSeq: 0,
          toSeq: 1,
          upserts: [],
          removes: [],
        },
      });
    server.markSpaceDirty(space);

    let flushResolved = false;
    const flush = server.flushDiagnosticsSessions().then(() => {
      flushResolved = true;
    });
    await effectSent.promise;
    await Promise.resolve();
    assertEquals(flushResolved, false);

    const close = server.close().then(() => {
      closed = true;
    });
    await Promise.all([flush, close]);
    assertEquals(flushResolved, true);
    assertEquals(closed, true);
  } finally {
    if (!closed) await server.close();
  }
});

Deno.test("memory v2 server returns conflicts before deferred caught-up session sync", async () => {
  const server = createServer("memory://memory-v2-server-conflict-flush", 20);
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-conflict-flush";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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
        scope: "space",
        seq: 0,
        deleted: true,
      },
    ]);

    await connection.receive(encodeMemoryBoundary({
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
    assertEquals(
      assertResponse<unknown>(shiftMessage(messages)).requestId,
      "tx-1",
    );

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    const rejected = assertResponse<unknown>(shiftMessage(messages));
    assertEquals(rejected.requestId, "tx-3");
    assertEquals(rejected.error, {
      name: "ConflictError",
      message: "stale confirmed read: of:doc:1 at seq 1 conflicted with seq 2",
      retryAfterSeq: 2,
    });
    assertEquals(messages.length, 0);

    await server.flushSessions([space]);

    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.caughtUpLocalSeq, 3);
    assertEquals(effect.effect.toSeq, 2);
    assertEquals(effect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 2,
      doc: {
        value: { version: 3 },
      },
    }]);
    assertEquals(messages.length, 0);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server empty caught-up sync preserves previous fromSeq", async () => {
  const server = createServer(
    "memory://memory-v2-server-empty-caught-up-from-seq",
    20,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-empty-caught-up-from-seq";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "of:doc:1",
            path: [],
            seq: 0,
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
    const rejected = assertResponse<any>(shiftMessage(messages));
    assertEquals(rejected.requestId, "tx-2");
    assertEquals(rejected.error?.name, "ConflictError");

    await server.flushSessions([space]);

    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect, {
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      upserts: [],
      removes: [],
      caughtUpLocalSeq: 2,
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
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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

    await connection.receive(encodeMemoryBoundary({
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

    const tx2 = connection.receive(encodeMemoryBoundary({
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

    const tx3 = connection.receive(encodeMemoryBoundary({
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

    const rejected = assertResponse<any>(shiftMessage(messages));
    assertEquals(rejected.requestId, "tx-3");
    assertEquals(rejected.error, {
      name: "ConflictError",
      message: "stale confirmed read: of:doc:1 at seq 1 conflicted with seq 2",
      retryAfterSeq: 2,
    });
    assertEquals(messages.length, 0);

    await server.flushSessions([space]);

    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.caughtUpLocalSeq, 3);
    assertEquals(effect.effect.toSeq, 2);
    assertEquals(effect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 2,
      doc: {
        value: { version: 3 },
      },
    }]);
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
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
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
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(writerMessages),
    ).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId: writerSessionId,
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
    assertEquals(
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "tx-1",
    );

    await time.tickAsync(1);
    await time.tickAsync(0);

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId: writerSessionId,
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
    assertEquals(
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "tx-2",
    );

    const tx3 = writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-3",
      space,
      sessionId: writerSessionId,
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
      scope: "space",
      seq: 1,
      doc: {
        value: { version: 1 },
      },
    }]);
    assertEquals(messages, []);

    releaseTx3.resolve();
    await tx3;
    await time.tickAsync(0);

    assertEquals(
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "tx-3",
    );
    const secondEffect = assertEffect(shiftMessage(messages));
    assertEquals(secondEffect.effect.toSeq, 3);
    assertEquals(secondEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 3,
      doc: {
        value: { version: 3 },
      },
    }, {
      branch: "",
      id: "of:doc:2",
      scope: "space",
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
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
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
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId = assertResponse<{ sessionId: string }>(
      shiftMessage(writerMessages),
    ).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
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

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId: writerSessionId,
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
    assertEquals(
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "tx-1",
    );

    await time.tickAsync(1);
    await time.tickAsync(0);

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId: writerSessionId,
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
    assertEquals(
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "tx-2",
    );

    const tx3 = writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-3",
      space,
      sessionId: writerSessionId,
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
      scope: "space",
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
      scope: "space",
      seq: 2,
      doc: {
        value: { version: 2 },
      },
    }]);
    assertEquals(messages, []);

    releaseTx3.resolve();
    await tx3;
    assertEquals(
      assertResponse<any>(shiftMessage(writerMessages)).requestId,
      "tx-3",
    );
  } finally {
    await server.close();
    time.restore();
  }
});
