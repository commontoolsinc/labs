import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
} from "../v2.ts";

const HELLO_FLAGS = getMemoryProtocolFlags();
const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: HELLO_FLAGS,
} as const;

const ALICE = "did:key:z6Mk-acl-alice";
const BOB = "did:key:z6Mk-acl-bob";
const CAROL = "did:key:z6Mk-acl-carol";
const SERVICE = "did:key:z6Mk-acl-service";
const TEST_AUDIENCE = "did:key:z6Mk-acl-test-audience";

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

/** Server whose session principal is taken (untested-crypto, test-only) from
 *  `invocation.iss`, mirroring the toolshed hook's result. */
const createAclServer = (
  store: string | URL,
  acl?: {
    mode: "off" | "observe" | "enforce";
    serviceDids?: readonly string[];
  },
) =>
  new Server({
    store: typeof store === "string" ? new URL(store) : store,
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: {
      audience: TEST_AUDIENCE,
    },
    acl,
  });

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return { messages, connection, sessionOpen: hello.sessionOpen };
};

let requestCounter = 0;
const nextRequestId = (label: string): string => `${label}-${++requestCounter}`;

const openSession = async (
  { connection, messages, sessionOpen }: Harness,
  space: string,
  principal: string,
  session: SessionDescriptor = {},
): Promise<ResponseMessage<SessionOpenResult>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space,
    session,
    invocation: {
      iss: principal,
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
  }));
  return assertResponse<SessionOpenResult>(
    shiftMessage(messages),
  );
};

const transactOperation = async (
  { connection, messages }: Pick<Harness, "connection" | "messages">,
  space: string,
  sessionId: string,
  operation: Record<string, unknown>,
  localSeq: number,
): Promise<ResponseMessage<{ seq: number }>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: nextRequestId("tx"),
    space,
    sessionId,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [operation],
    },
  }));
  return assertResponse<{ seq: number }>(shiftMessage(messages));
};

const transactSet = async (
  { connection, messages }: Harness,
  space: string,
  sessionId: string,
  id: string,
  value: unknown,
  localSeq: number,
): Promise<ResponseMessage<{ seq: number }>> => {
  return await transactOperation(
    { connection, messages },
    space,
    sessionId,
    { op: "set", id, value: { value } },
    localSeq,
  );
};

const graphQuery = async (
  { connection, messages }: Harness,
  space: string,
  sessionId: string,
  id: string,
): Promise<ResponseMessage<GraphQueryResult>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "graph.query",
    requestId: nextRequestId("query"),
    space,
    sessionId,
    query: { roots: [{ id, selector: { path: [], schema: false } }] },
  }));
  return assertResponse<GraphQueryResult>(shiftMessage(messages));
};

/** Initialize a fresh space through the space identity, then transfer OWNER
 *  to the normal user. This mirrors the named-space bootstrap path. */
const initializeSpaceAcl = async (
  server: Server,
  space: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  const authority = await connect(server);
  const opened = await openSession(authority, space, space);
  assertExists(opened.ok, "space identity should open its own space");
  const initialized = await transactSet(
    authority,
    space,
    opened.ok.sessionId,
    `of:${space}`,
    acl,
    1,
  );
  assertExists(initialized.ok, "space identity should initialize the ACL");
};

Deno.test("acl enforce: an ordinary opener cannot claim or write a new space", async () => {
  const server = createAclServer("memory://acl-enforce-stranger", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-1";
  const alice = await connect(server);
  try {
    const opened = await openSession(alice, space, ALICE);
    assertExists(
      opened.ok,
      "an authenticated principal may inspect a new space",
    );
    assertEquals(opened.ok.serverSeq, 0, "an ordinary open must not claim it");

    const acl = await graphQuery(
      alice,
      space,
      opened.ok.sessionId,
      `of:${space}`,
    );
    assertExists(acl.ok);
    assertEquals(
      acl.ok.entities[0]?.document ?? null,
      null,
      "ordinary open must not seed an ACL",
    );

    const write = await transactSet(
      alice,
      space,
      opened.ok.sessionId,
      "of:doc:1",
      { hello: "world" },
      1,
    );
    assertEquals(write.error?.name, "AuthorizationError");
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: the space identity initializes a private space", async () => {
  const server = createAclServer("memory://acl-enforce-space-genesis", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-genesis";
  const authority = await connect(server);
  const alice = await connect(server);
  try {
    const authoritySession = await openSession(authority, space, space);
    assertExists(authoritySession.ok, "space identity should open its space");
    assertEquals(authoritySession.ok.serverSeq, 0);

    const genesis = await transactSet(
      authority,
      space,
      authoritySession.ok.sessionId,
      `of:${space}`,
      { [ALICE]: "OWNER" },
      1,
    );
    assertExists(genesis.ok, "space identity should write the genesis ACL");

    const opened = await openSession(alice, space, ALICE);
    assertExists(opened.ok, "the initialized owner should open the space");

    const acl = await graphQuery(
      alice,
      space,
      opened.ok.sessionId,
      `of:${space}`,
    );
    assertExists(acl.ok);
    const aclDoc = JSON.stringify(acl.ok);
    assert(
      aclDoc.includes(ALICE) && aclDoc.includes("OWNER"),
      `genesis should grant the user OWNER, got: ${aclDoc}`,
    );

    const write = await transactSet(
      alice,
      space,
      opened.ok.sessionId,
      "of:doc:1",
      { hello: "world" },
      1,
    );
    assertExists(write.ok, "initialized owner should be able to write");

    const bob = await connect(server);
    const denied = await openSession(bob, space, BOB);
    assertEquals(denied.error?.name, "AuthorizationError");
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: WRITE grant allows transact but not ACL-doc writes", async () => {
  const server = createAclServer("memory://acl-enforce-write-grant", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-2";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "WRITE",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);

    const bobSession = await openSession(bob, space, BOB);
    assertExists(bobSession.ok, "WRITE grant should allow session open");

    const write = await transactSet(
      bob,
      space,
      bobSession.ok.sessionId,
      "of:doc:bob",
      { from: "bob" },
      1,
    );
    assertExists(write.ok, "WRITE grant should allow transact");

    // ...but Bob cannot self-promote: ACL-doc writes need OWNER.
    const escalate = await transactSet(
      bob,
      space,
      bobSession.ok.sessionId,
      `of:${space}`,
      { [BOB]: "OWNER" },
      2,
    );
    assertEquals(escalate.error?.name, "AuthorizationError");
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: READ grant allows queries but not writes", async () => {
  const server = createAclServer("memory://acl-enforce-read-grant", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-3";
  const alice = await connect(server);
  const carol = await connect(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [CAROL]: "READ",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);
    await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      "of:doc:shared",
      { shared: true },
      1,
    );

    const carolSession = await openSession(carol, space, CAROL);
    assertExists(carolSession.ok, "READ grant should allow session open");

    const query = await graphQuery(
      carol,
      space,
      carolSession.ok.sessionId,
      "of:doc:shared",
    );
    assertExists(query.ok, "READ grant should allow graph queries");

    const write = await transactSet(
      carol,
      space,
      carolSession.ok.sessionId,
      "of:doc:carol",
      { from: "carol" },
      1,
    );
    assertEquals(write.error?.name, "AuthorizationError");
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: '*' READ opens the space to any principal read-only", async () => {
  const server = createAclServer("memory://acl-enforce-anyone", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-4";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      "*": "READ",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);

    const bobSession = await openSession(bob, space, BOB);
    assertExists(bobSession.ok, "'*' READ should allow any principal to open");
    const write = await transactSet(
      bob,
      space,
      bobSession.ok.sessionId,
      "of:doc:bob",
      { from: "bob" },
      1,
    );
    assertEquals(write.error?.name, "AuthorizationError");
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: service DIDs have implicit OWNER and do not claim spaces", async () => {
  const server = createAclServer("memory://acl-enforce-service", {
    mode: "enforce",
    serviceDids: [SERVICE],
  });
  const space = "did:key:z6Mk-acl-space-5";
  const service = await connect(server);
  const alice = await connect(server);
  try {
    const serviceSession = await openSession(service, space, SERVICE);
    assertExists(serviceSession.ok, "service DID should open any space");
    const ordinaryWrite = await transactSet(
      service,
      space,
      serviceSession.ok.sessionId,
      "of:doc:svc",
      { from: "service" },
      1,
    );
    assertEquals(
      ordinaryWrite.error?.name,
      "AuthorizationError",
      "even the service must initialize a new space with an ACL",
    );

    const initialize = await transactSet(
      service,
      space,
      serviceSession.ok.sessionId,
      `of:${space}`,
      { [ALICE]: "OWNER" },
      2,
    );
    assertExists(initialize.ok, "service DID should initialize a valid ACL");

    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);
    const write = await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      "of:doc:alice",
      { from: "alice" },
      1,
    );
    assertExists(write.ok);
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: principal equal to the space DID can claim it privately", async () => {
  const server = createAclServer("memory://acl-enforce-space-key", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-6";
  const holder = await connect(server);
  try {
    const session = await openSession(holder, space, space);
    assertExists(session.ok, "space-key principal should open its own space");
    const claim = await transactSet(
      holder,
      space,
      session.ok.sessionId,
      `of:${space}`,
      { [space]: "OWNER" },
      1,
    );
    assertExists(claim.ok, "space-key principal should initialize its ACL");
    const write = await transactSet(
      holder,
      space,
      session.ok.sessionId,
      "of:doc:self",
      { self: true },
      2,
    );
    assertExists(write.ok);
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: revoking a grant takes effect for subsequent messages", async () => {
  const server = createAclServer("memory://acl-enforce-revoke", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-7";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "WRITE",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);

    const bobSession = await openSession(bob, space, BOB);
    assertExists(bobSession.ok);
    const first = await transactSet(
      bob,
      space,
      bobSession.ok.sessionId,
      "of:doc:bob",
      { n: 1 },
      1,
    );
    assertExists(first.ok, "grant should allow Bob's first write");

    // Owner revokes Bob. Bob's live session is torn down (gating alone
    // would still let his existing subscriptions receive pushes).
    const revoke = await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      `of:${space}`,
      { [ALICE]: "OWNER" },
      1,
    );
    assertExists(revoke.ok);

    const revoked = shiftMessage(bob.messages);
    assertEquals(revoked, {
      type: "session/revoked",
      space,
      sessionId: bobSession.ok.sessionId,
      reason: "unauthorized",
    });

    const second = await transactSet(
      bob,
      space,
      bobSession.ok.sessionId,
      "of:doc:bob",
      { n: 2 },
      2,
    );
    assertEquals(
      second.error?.name,
      "SessionError",
      "the revoked session must be gone",
    );

    // And Bob cannot just open a new one.
    const reopen = await openSession(bob, space, BOB);
    assertEquals(reopen.error?.name, "AuthorizationError");
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: revocation during resumed catch-up fails the open", async () => {
  const server = createAclServer("memory://acl-enforce-resume-revoke-race", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-resume-revoke-race";
  const alice = await connect(server);
  const bob = await connect(server);
  const catchupStarted = Promise.withResolvers<void>();
  const releaseCatchup = Promise.withResolvers<void>();
  const originalSync = server.syncSessionForConnection.bind(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "READ",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    const bobSession = await openSession(bob, space, BOB);
    assertExists(aliceSession.ok);
    assertExists(bobSession.ok);

    bob.connection.close();
    await server.idle();
    const resumed = await connect(server);

    const blockedSync: Server["syncSessionForConnection"] = async (...args) => {
      catchupStarted.resolve();
      await releaseCatchup.promise;
      return await originalSync(...args);
    };
    server.syncSessionForConnection = blockedSync;

    const reopening = server.openSession({
      type: "session.open",
      requestId: nextRequestId("resume-revoke-race"),
      space,
      session: {
        sessionId: bobSession.ok.sessionId,
        sessionToken: bobSession.ok.sessionToken,
      },
      invocation: {
        iss: BOB,
        aud: resumed.sessionOpen.audience,
        challenge: resumed.sessionOpen.challenge.value,
      },
    }, resumed.connection);
    await catchupStarted.promise;

    const revoke = await server.transact({
      type: "transact",
      requestId: nextRequestId("resume-revoke-race-revoke"),
      space,
      sessionId: aliceSession.ok.sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: { value: { [ALICE]: "OWNER" } },
        }],
      },
    });
    assertExists(revoke.ok);
    releaseCatchup.resolve();

    const reopened = await reopening;
    assertEquals(reopened.ok, undefined);
    assertEquals(reopened.error?.name, "SessionRevokedError");
    assertEquals(
      server.isSessionAttached(
        space,
        bobSession.ok.sessionId,
        resumed.connection.id,
      ),
      false,
    );
  } finally {
    releaseCatchup.resolve();
    server.syncSessionForConnection = originalSync;
    await server.close();
  }
});

Deno.test("acl enforce: a taken-over session cannot finish an in-flight transaction", async () => {
  const server = createAclServer("memory://acl-enforce-transact-takeover", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-transact-takeover";
  const first = await connect(server);
  const second = await connect(server);
  const openEngineStarted = Promise.withResolvers<void>();
  const releaseOpenEngine = Promise.withResolvers<void>();
  const mutableServer = server as unknown as {
    openEngine: (space: string) => Promise<unknown>;
  };
  const originalOpenEngine = mutableServer.openEngine.bind(server);
  try {
    await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
    const opened = await openSession(first, space, ALICE);
    assertExists(opened.ok);

    let pauseNextOpen = true;
    mutableServer.openEngine = async (requestedSpace: string) => {
      if (pauseNextOpen) {
        pauseNextOpen = false;
        openEngineStarted.resolve();
        await releaseOpenEngine.promise;
      }
      return await originalOpenEngine(requestedSpace);
    };

    const staleWrite = server.transact({
      type: "transact",
      requestId: nextRequestId("transact-takeover-stale"),
      space,
      sessionId: opened.ok.sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:stale-takeover",
          value: { value: { stale: true } },
        }],
      },
    });
    await openEngineStarted.promise;

    const replacement = await openSession(second, space, ALICE, {
      sessionId: opened.ok.sessionId,
      sessionToken: opened.ok.sessionToken,
    });
    assertExists(replacement.ok);
    assertEquals(shiftMessage(first.messages), {
      type: "session/revoked",
      space,
      sessionId: opened.ok.sessionId,
      reason: "taken-over",
    });

    releaseOpenEngine.resolve();
    const rejected = await staleWrite;
    assertEquals(rejected.error?.name, "SessionError");
    assertEquals(
      await server.readDocument(space, "of:doc:stale-takeover"),
      null,
    );
  } finally {
    releaseOpenEngine.resolve();
    mutableServer.openEngine = originalOpenEngine;
    await server.close();
  }
});

Deno.test("acl enforce: a concurrent post-revocation write is rejected", async () => {
  const server = createAclServer("memory://acl-enforce-revoke-race", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-revoke-race";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "OWNER",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    const bobSession = await openSession(bob, space, BOB);
    assertExists(aliceSession.ok);
    assertExists(bobSession.ok);

    // Starting the revoke first deterministically queues both transactions at
    // the old ACL. Session validity and authorization are checked beside
    // apply: once Alice's ACL commit lands and revokes Bob, Bob's
    // already-started request is denied before it can commit.
    const [revoke, write] = await Promise.all([
      server.transact({
        type: "transact",
        requestId: nextRequestId("revoke-race"),
        space,
        sessionId: aliceSession.ok.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { [ALICE]: "OWNER" } },
          }],
        },
      }),
      server.transact({
        type: "transact",
        requestId: nextRequestId("write-race"),
        space,
        sessionId: bobSession.ok.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:bob-race",
            value: { value: { shouldNotLand: true } },
          }],
        },
      }),
    ]);
    assertExists(revoke.ok);
    assertEquals(write.error?.name, "SessionError");
    assertEquals(await server.readDocument(space, "of:doc:bob-race"), null);
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: a concurrent graph query is evaluated before revocation", async () => {
  const server = createAclServer("memory://acl-enforce-query-race", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-query-race";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "READ",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    const bobSession = await openSession(bob, space, BOB);
    assertExists(aliceSession.ok);
    assertExists(bobSession.ok);

    // Starting the query first deterministically queues both operations at the
    // old ACL. Authorization and graph evaluation must share one engine turn:
    // Bob may receive the old ACL, but must never read the post-revoke ACL.
    const [query, revoke] = await Promise.all([
      server.graphQuery({
        type: "graph.query",
        requestId: nextRequestId("query-race"),
        space,
        sessionId: bobSession.ok.sessionId,
        query: {
          roots: [{
            id: `of:${space}`,
            selector: { path: [], schema: false },
          }],
        },
      }),
      server.transact({
        type: "transact",
        requestId: nextRequestId("query-race-revoke"),
        space,
        sessionId: aliceSession.ok.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { [ALICE]: "OWNER" } },
          }],
        },
      }),
    ]);

    assertExists(revoke.ok);
    assertEquals(query.ok?.entities[0]?.document?.value, {
      [ALICE]: "OWNER",
      [BOB]: "READ",
    });
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: revocation settles an in-flight query with a typed error", async () => {
  const server = createAclServer("memory://acl-enforce-query-send-race", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-query-send-race";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "READ",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    const bobSession = await openSession(bob, space, BOB);
    assertExists(aliceSession.ok);
    assertExists(bobSession.ok);

    const queryRequestId = nextRequestId("query-send-race");
    const query = bob.connection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: queryRequestId,
      space,
      sessionId: bobSession.ok.sessionId,
      query: {
        roots: [{
          id: `of:${space}`,
          selector: { path: [], schema: false },
        }],
      },
    }));
    // Let the connection enter graphQuery and block on its engine turn before
    // the competing ACL commit runs.
    await Promise.resolve();
    const revoke = server.transact({
      type: "transact",
      requestId: nextRequestId("query-send-race-revoke"),
      space,
      sessionId: aliceSession.ok.sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: { value: { [ALICE]: "OWNER" } },
        }],
      },
    });
    assertExists((await revoke).ok);
    await query;

    assertEquals(bob.messages, [
      {
        type: "session/revoked",
        space,
        sessionId: bobSession.ok.sessionId,
        reason: "unauthorized",
      },
      {
        type: "response",
        requestId: queryRequestId,
        error: {
          name: "SessionRevokedError",
          message: "Session was revoked while the request was in flight",
        },
      },
    ]);
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: a concurrent watch set is evaluated before revocation", async () => {
  const server = createAclServer("memory://acl-enforce-watch-race", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-watch-race";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "READ",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    const bobSession = await openSession(bob, space, BOB);
    assertExists(aliceSession.ok);
    assertExists(bobSession.ok);

    const [watch, revoke] = await Promise.all([
      server.watchSet({
        type: "session.watch.set",
        requestId: nextRequestId("watch-race"),
        space,
        sessionId: bobSession.ok.sessionId,
        watches: [{
          id: "acl",
          kind: "graph",
          query: {
            roots: [{
              id: `of:${space}`,
              selector: { path: [], schema: false },
            }],
          },
        }],
      }),
      server.transact({
        type: "transact",
        requestId: nextRequestId("watch-race-revoke"),
        space,
        sessionId: aliceSession.ok.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { [ALICE]: "OWNER" } },
          }],
        },
      }),
    ]);

    assertExists(revoke.ok);
    assertEquals(watch.ok?.sync.upserts[0]?.doc?.value, {
      [ALICE]: "OWNER",
      [BOB]: "READ",
    });
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: an in-flight refresh cannot emit after revocation", async () => {
  const server = createAclServer("memory://acl-enforce-refresh-race", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-refresh-race";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "READ",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    const bobSession = await openSession(bob, space, BOB);
    assertExists(aliceSession.ok);
    assertExists(bobSession.ok);

    const watchedId = "of:doc:refresh-race";
    await bob.connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: nextRequestId("watch-refresh-race"),
      space,
      sessionId: bobSession.ok.sessionId,
      watches: [{
        id: "acl",
        kind: "graph",
        query: {
          roots: [{
            id: watchedId,
            selector: { path: [], schema: false },
          }],
        },
      }],
    }));
    assertExists(assertResponse(shiftMessage(bob.messages)).ok);

    // Make the watched graph differ from Bob's cached snapshot. writeDocument
    // schedules its normal timer refresh, but the manual refresh below starts
    // in this turn before that timer can run.
    await server.writeDocument(space, watchedId, { changed: true });

    // refreshDirty yields while re-evaluating the watch. The revoke then drops
    // Bob's session before the refresh result is ready to send.
    const refresh = bob.connection.refreshDirty(space);
    const revoke = server.transact({
      type: "transact",
      requestId: nextRequestId("refresh-race-revoke"),
      space,
      sessionId: aliceSession.ok.sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: { value: { [ALICE]: "OWNER" } },
        }],
      },
    });
    assertExists((await revoke).ok);
    await refresh;

    assertEquals(bob.messages, [{
      type: "session/revoked",
      space,
      sessionId: bobSession.ok.sessionId,
      reason: "unauthorized",
    }]);
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: owner removing their own access still gets the commit response", async () => {
  // The writing session must receive its transact response before any
  // revocation — otherwise the client treats session/revoked as terminal and
  // reports the successful self-removal as a failure. The access change still
  // takes effect on the owner's next message.
  const server = createAclServer("memory://acl-enforce-self-remove", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-self";
  const alice = await connect(server);
  try {
    await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);

    // Alice rewrites the ACL to drop herself entirely (someone else owns now).
    const selfRemove = await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      `of:${space}`,
      { [BOB]: "OWNER" },
      1,
    );
    assertExists(
      selfRemove.ok,
      "self-removal commit must succeed and report ok, not a revocation",
    );
    // No session/revoked was pushed to the writing connection for its own tx.
    assertEquals(
      alice.messages.length,
      0,
      "writer must not be revoked before its own response",
    );

    // The writer's session was still dropped from the registry (so it receives
    // no further pushes without READ): its next message fails closed as an
    // unknown session.
    const after = await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      "of:doc:after",
      { n: 1 },
      2,
    );
    assertEquals(after.error?.name, "SessionError");
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: legacy data without an ACL is authenticated public read/write", async () => {
  const directory = await Deno.makeTempDir({ prefix: "memory-acl-public-" });
  const store = toFileUrl(`${directory}/`);
  const space = "did:key:z6Mk-acl-legacy-public";
  try {
    const seedServer = createAclServer(store, { mode: "off" });
    try {
      const seed = await connect(seedServer);
      const opened = await openSession(seed, space, ALICE);
      assertExists(opened.ok);
      const write = await transactSet(
        seed,
        space,
        opened.ok.sessionId,
        "of:doc:legacy",
        { legacy: true },
        1,
      );
      assertExists(write.ok);
    } finally {
      await seedServer.close();
    }

    const server = createAclServer(store, { mode: "enforce" });
    try {
      const bob = await connect(server);
      const opened = await openSession(bob, space, BOB);
      assertExists(opened.ok, "legacy ACL-less space should be public");

      const read = await graphQuery(
        bob,
        space,
        opened.ok.sessionId,
        "of:doc:legacy",
      );
      assertExists(read.ok);
      assertEquals(read.ok.entities[0]?.document?.value, { legacy: true });

      const write = await transactSet(
        bob,
        space,
        opened.ok.sessionId,
        "of:doc:bob",
        { public: true },
        1,
      );
      assertExists(write.ok, "public compatibility includes WRITE");

      const claim = await transactSet(
        bob,
        space,
        opened.ok.sessionId,
        `of:${space}`,
        { [BOB]: "OWNER" },
        2,
      );
      assertEquals(
        claim.error?.name,
        "AuthorizationError",
        "public compatibility must never grant OWNER",
      );
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("acl enforce: the space identity can privatize a legacy home space", async () => {
  const directory = await Deno.makeTempDir({ prefix: "memory-acl-home-" });
  const store = toFileUrl(`${directory}/`);
  const space = ALICE;
  try {
    const seedServer = createAclServer(store, { mode: "off" });
    try {
      const bob = await connect(seedServer);
      const opened = await openSession(bob, space, BOB);
      assertExists(opened.ok);
      assertExists(
        (await transactSet(
          bob,
          space,
          opened.ok.sessionId,
          "of:doc:legacy-home",
          { legacy: true },
          1,
        )).ok,
      );
    } finally {
      await seedServer.close();
    }

    const server = createAclServer(store, { mode: "enforce" });
    try {
      const legacyReader = await connect(server);
      const legacySession = await openSession(legacyReader, space, BOB);
      assertExists(legacySession.ok, "legacy home starts public");

      const holder = await connect(server);
      const opened = await openSession(holder, space, space);
      assertExists(opened.ok);
      const claim = await transactSet(
        holder,
        space,
        opened.ok.sessionId,
        `of:${space}`,
        { [space]: "OWNER" },
        1,
      );
      assertExists(claim.ok);

      assertEquals(shiftMessage(legacyReader.messages), {
        type: "session/revoked",
        space,
        sessionId: legacySession.ok.sessionId,
        reason: "unauthorized",
      });

      const bob = await connect(server);
      const denied = await openSession(bob, space, BOB);
      assertEquals(denied.error?.name, "AuthorizationError");
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("acl enforce: ACL mutations must preserve a concrete owner", async () => {
  const server = createAclServer("memory://acl-validate-owner", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-validate-owner";
  const alice = await connect(server);
  try {
    await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
    const opened = await openSession(alice, space, ALICE);
    assertExists(opened.ok);

    const invalidOperations: Record<string, unknown>[] = [
      { op: "set", id: `of:${space}`, value: { value: {} } },
      {
        op: "set",
        id: `of:${space}`,
        value: { value: { "*": "OWNER" } },
      },
      {
        op: "set",
        id: `of:${space}`,
        value: { value: { [ALICE]: "READ" } },
      },
      {
        op: "set",
        id: `of:${space}`,
        value: { value: { [ALICE]: "ADMIN" } },
      },
      { op: "delete", id: `of:${space}` },
      {
        op: "patch",
        id: `of:${space}`,
        patches: [{ op: "remove", path: `/${ALICE}` }],
      },
      {
        op: "set",
        id: `of:${space}`,
        scope: "user",
        value: { value: { [ALICE]: "OWNER" } },
      },
    ];

    let localSeq = 1;
    for (const operation of invalidOperations) {
      const response = await transactOperation(
        alice,
        space,
        opened.ok.sessionId,
        operation,
        localSeq++,
      );
      assertEquals(response.error?.name, "ProtocolError");
    }

    const acl = await graphQuery(
      alice,
      space,
      opened.ok.sessionId,
      `of:${space}`,
    );
    assertEquals(acl.ok?.entities[0]?.document?.value, { [ALICE]: "OWNER" });
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: ACL mutations are default-branch ACL-only commits", async () => {
  const server = createAclServer("memory://acl-validate-commit-shape", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-validate-commit-shape";
  const alice = await connect(server);
  try {
    await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
    const opened = await openSession(alice, space, ALICE);
    assertExists(opened.ok);

    const nonDefaultBranch = await server.transact({
      type: "transact",
      requestId: nextRequestId("acl-non-default-branch"),
      space,
      sessionId: opened.ok.sessionId,
      commit: {
        branch: "feature",
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: { value: { [ALICE]: "OWNER", [BOB]: "READ" } },
        }],
      },
    });
    assertEquals(nonDefaultBranch.error?.name, "ProtocolError");

    const mixed = await server.transact({
      type: "transact",
      requestId: nextRequestId("acl-mixed-commit"),
      space,
      sessionId: opened.ok.sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: `of:${space}`,
            value: { value: { [ALICE]: "OWNER", [BOB]: "READ" } },
          },
          {
            op: "set",
            id: "of:ordinary",
            value: { value: { mixed: true } },
          },
        ],
      },
    });
    assertEquals(mixed.error?.name, "ProtocolError");
    assertEquals(await server.readDocument(space, "of:ordinary"), null);
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: auxiliary read and operator surfaces honor capabilities", async () => {
  const diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
  const database = new Database(diskPath);
  database.exec("CREATE TABLE lookup (value TEXT)");
  database.exec("INSERT INTO lookup (value) VALUES ('visible')");
  database.close();

  const server = createAclServer("memory://acl-auxiliary-surfaces", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-auxiliary-surfaces";
  const alice = await connect(server);
  const bob = await connect(server);
  const carol = await connect(server);
  const diskId = "of:acl-disk-source";
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "READ",
      [CAROL]: "WRITE",
    });
    const aliceSession = await openSession(alice, space, ALICE);
    const bobSession = await openSession(bob, space, BOB);
    const carolSession = await openSession(carol, space, CAROL);
    assertExists(aliceSession.ok);
    assertExists(bobSession.ok);
    assertExists(carolSession.ok);

    const deniedRegistration = await server.sqliteRegisterDiskSource({
      type: "sqlite.register-disk-source",
      requestId: nextRequestId("acl-disk-register-denied"),
      space,
      sessionId: carolSession.ok.sessionId,
      id: diskId,
      path: diskPath,
    });
    assertEquals(deniedRegistration.error?.name, "AuthorizationError");

    const registered = await server.sqliteRegisterDiskSource({
      type: "sqlite.register-disk-source",
      requestId: nextRequestId("acl-disk-register"),
      space,
      sessionId: aliceSession.ok.sessionId,
      id: diskId,
      path: diskPath,
    });
    assertExists(registered.ok);

    const sqliteRead = await server.sqliteQuery({
      type: "sqlite.query",
      requestId: nextRequestId("acl-sqlite-read"),
      space,
      sessionId: bobSession.ok.sessionId,
      db: { id: diskId },
      sql: "SELECT value FROM lookup",
    });
    assertEquals(sqliteRead.ok?.rows, [{ value: "visible" }]);

    const snapshots = await server.listSchedulerActionSnapshots({
      type: "scheduler.snapshot.list",
      requestId: nextRequestId("acl-scheduler-snapshots"),
      space,
      sessionId: bobSession.ok.sessionId,
      query: {},
    });
    assertEquals(snapshots.ok?.snapshots, []);

    const bobWriterRequestId = nextRequestId("acl-scheduler-writers");
    await bob.connection.receive(encodeMemoryBoundary({
      type: "scheduler.writer.list",
      requestId: bobWriterRequestId,
      space,
      sessionId: bobSession.ok.sessionId,
      query: {
        branch: "",
        targets: [{ id: "of:output", path: ["value"] }],
      },
    }));
    const writers = assertResponse<{ serverSeq: number; writers: unknown[] }>(
      shiftMessage(bob.messages),
    );
    assertEquals(writers.requestId, bobWriterRequestId);
    assertEquals(writers.ok?.writers, []);

    const carolWriterRequestId = nextRequestId(
      "acl-scheduler-writers-denied",
    );
    await carol.connection.receive(encodeMemoryBoundary({
      type: "scheduler.writer.list",
      requestId: carolWriterRequestId,
      space,
      sessionId: carolSession.ok.sessionId,
      query: {
        branch: "",
        targets: [{ id: "of:output", path: ["value"] }],
      },
    }));
    const deniedWriters = assertResponse<unknown>(shiftMessage(carol.messages));
    assertEquals(deniedWriters.requestId, carolWriterRequestId);
    assertEquals(deniedWriters.error?.name, "AuthorizationError");

    const watch = await server.watchAdd({
      type: "session.watch.add",
      requestId: nextRequestId("acl-watch-add"),
      space,
      sessionId: bobSession.ok.sessionId,
      watches: [],
    });
    assertExists(watch.ok);
  } finally {
    await server.close();
    await Deno.remove(diskPath);
  }
});

Deno.test("acl enforce: direct writes cannot create or mutate ACL state", async () => {
  const server = createAclServer("memory://acl-direct-write", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-direct-write";
  try {
    await assertRejects(
      () => server.writeDocument(space, "of:doc:direct", { direct: true }),
      Error,
      "ACL",
    );

    await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
    await assertRejects(
      () => server.writeDocument(space, `of:${space}`, { [BOB]: "OWNER" }),
      Error,
      "ACL",
    );

    // Blob authorization is explicitly postponed: the direct path may still
    // update an ordinary document once the space has real ACL state.
    await server.writeDocument(space, "of:doc:existing", { direct: true });
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: direct writes reject malformed stored ACL state", async () => {
  const directory = await Deno.makeTempDir({ prefix: "memory-acl-direct-" });
  const store = toFileUrl(`${directory}/`);
  const space = "did:key:z6Mk-acl-direct-invalid";
  try {
    const seedServer = createAclServer(store, { mode: "off" });
    try {
      await seedServer.writeDocument(space, `of:${space}`, {
        [ALICE]: "READ",
      });
    } finally {
      await seedServer.close();
    }

    const server = createAclServer(store, { mode: "enforce" });
    try {
      await assertRejects(
        () => server.writeDocument(space, "of:ordinary", { blocked: true }),
        Error,
        "invalid ACL state",
      );
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("acl enforce: malformed and ownerless stored ACLs fail closed", async () => {
  for (
    const [label, value] of [
      ["malformed", { [ALICE]: "ADMIN" }],
      ["ownerless", { [ALICE]: "WRITE" }],
    ] as const
  ) {
    const directory = await Deno.makeTempDir({
      prefix: `memory-acl-${label}-`,
    });
    const store = toFileUrl(`${directory}/`);
    const space = `did:key:z6Mk-acl-${label}`;
    try {
      const seedServer = createAclServer(store, { mode: "off" });
      try {
        await seedServer.writeDocument(space, `of:${space}`, value);
      } finally {
        await seedServer.close();
      }

      for (const mode of ["observe", "enforce"] as const) {
        const server = createAclServer(store, { mode });
        try {
          const alice = await connect(server);
          const denied = await openSession(alice, space, ALICE);
          assertEquals(denied.error?.name, "AuthorizationError");
        } finally {
          await server.close();
        }
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("acl enforce: a retracted ACL fails closed instead of becoming public", async () => {
  const directory = await Deno.makeTempDir({ prefix: "memory-acl-deleted-" });
  const store = toFileUrl(`${directory}/`);
  const space = "did:key:z6Mk-acl-deleted";
  try {
    const seedServer = createAclServer(store, { mode: "off" });
    try {
      await seedServer.writeDocument(space, `of:${space}`, {
        [ALICE]: "OWNER",
      });
      const alice = await connect(seedServer);
      const opened = await openSession(alice, space, ALICE);
      assertExists(opened.ok);
      const deleted = await transactOperation(
        alice,
        space,
        opened.ok.sessionId,
        { op: "delete", id: `of:${space}` },
        1,
      );
      assertExists(deleted.ok);
    } finally {
      await seedServer.close();
    }

    const server = createAclServer(store, { mode: "enforce" });
    try {
      const alice = await connect(server);
      const denied = await openSession(alice, space, ALICE);
      assertEquals(denied.error?.name, "AuthorizationError");
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("acl observe: stranger is allowed but the would-deny is counted", async () => {
  const server = createAclServer("memory://acl-observe", { mode: "observe" });
  const space = "did:key:z6Mk-acl-space-8";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);

    const bobSession = await openSession(bob, space, BOB);
    assertExists(bobSession.ok, "observe mode must not deny");
    const write = await transactSet(
      bob,
      space,
      bobSession.ok.sessionId,
      "of:doc:bob",
      { from: "bob" },
      1,
    );
    assertExists(write.ok, "observe mode must not deny writes");
    assert(
      server.aclStats.wouldDeny > 0,
      "observe mode should count would-denies",
    );
  } finally {
    await server.close();
  }
});

Deno.test("acl observe: fresh-space genesis remains a hard invariant", async () => {
  const server = createAclServer("memory://acl-observe-seed", {
    mode: "observe",
  });
  const space = "did:key:z6Mk-acl-space-9";
  const alice = await connect(server);
  try {
    const opened = await openSession(alice, space, ALICE);
    assertExists(opened.ok);
    const denied = await transactSet(
      alice,
      space,
      opened.ok.sessionId,
      "of:doc:alice",
      { value: true },
      1,
    );
    assertEquals(denied.error?.name, "AuthorizationError");

    await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
    const reopened = await openSession(await connect(server), space, ALICE);
    assertExists(reopened.ok);
  } finally {
    await server.close();
  }
});

Deno.test("acl off: no seeding, no gating", async () => {
  const server = createAclServer("memory://acl-off", { mode: "off" });
  const space = "did:key:z6Mk-acl-space-10";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
    const opened = await openSession(alice, space, ALICE);
    assertExists(opened.ok);
    assertEquals(opened.ok.serverSeq, 0, "off mode must not seed a commit");

    const bobSession = await openSession(bob, space, BOB);
    assertExists(bobSession.ok);
    const write = await transactSet(
      bob,
      space,
      bobSession.ok.sessionId,
      "of:doc:bob",
      { from: "bob" },
      1,
    );
    assertExists(write.ok);
  } finally {
    await server.close();
  }
});

Deno.test("acl default: absent acl option behaves like off", async () => {
  const server = createAclServer("memory://acl-default");
  const space = "did:key:z6Mk-acl-space-11";
  const bob = await connect(server);
  try {
    const opened = await openSession(bob, space, BOB);
    assertExists(opened.ok);
    assertEquals(opened.ok.serverSeq, 0);
  } finally {
    await server.close();
  }
});
