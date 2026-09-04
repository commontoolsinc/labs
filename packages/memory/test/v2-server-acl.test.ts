import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import { Server, SessionRegistry } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type Operation,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type SessionSync,
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

// CT-1927: every transact verdict stages a catch-up marker that rides the
// next batched frame — a marker-only empty frame when nothing watched is
// dirty. Tests whose subject is not verdict ordering shift past those
// frames here; the ordering contract itself is pinned by
// v2-verdict-catchup.test.ts.
const nextResponse = <Result>(
  messages: ServerMessage[],
): ResponseMessage<Result> => {
  while (true) {
    const message = shiftMessage(messages);
    if (message.type !== "session/effect") {
      return assertResponse<Result>(message);
    }
    // Only MARKER-ONLY frames may be skipped implicitly: no upserts, no
    // removes, and carrying the caughtUpLocalSeq marker that is such a
    // frame's reason to exist. Anything else is content a test must consume
    // explicitly, or an erroneous self-echo or markerless empty frame would
    // be silently swallowed here.
    const effect = (message as SessionEffectMessage)
      .effect as unknown as SessionSync;
    if (
      effect.upserts.length > 0 || effect.removes.length > 0 ||
      effect.caughtUpLocalSeq === undefined
    ) {
      throw new Error(
        "nextResponse skipped a non-marker-only sync frame; consume it explicitly",
      );
    }
  }
};

/** Server whose session principal is taken (untested-crypto, test-only) from
 *  `invocation.iss`, mirroring the toolshed hook's result. */
const createAclServer = (
  store: string | URL,
  acl?: {
    mode: "off" | "observe" | "enforce";
    serviceDids?: readonly string[];
    delegatingDids?: readonly string[];
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
  return nextResponse<SessionOpenResult>(messages);
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
      // Deliberately malformed: this suite feeds the server operations it
      // must reject, so the payload is not an `Operation`.
      operations: [operation as unknown as Operation],
    },
  }));
  return nextResponse<{ seq: number }>(messages);
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
  return nextResponse<GraphQueryResult>(messages);
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
    // The terminal session/revoked ARRIVES — but only AFTER the verdict
    // (transactSet consumed the response above, so it ordered first). The
    // detached session can never be delivered a catch-up marker, and the
    // revocation is what tells the client its sync channel is gone so a
    // parked accept applies immediately (CT-1927).
    assertEquals(
      alice.messages.map((message) => (message as { type?: string }).type),
      ["session/revoked"],
      "the writer is revoked only after its own response",
    );
    alice.messages.length = 0;

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

Deno.test("acl enforce: a genesis ACL without a concrete OWNER is refused and the space stays uninitialized", async () => {
  // The runner's genesis-supplied ACL option hands the caller's document to
  // this same admission check (no client-side validation): a space identity
  // that tries to mint an unowned or malformed space is refused at genesis
  // with the existing shape error, and genesis stays owed.
  const server = createAclServer("memory://acl-genesis-unowned", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-genesis-unowned";
  const authority = await connect(server);
  try {
    const opened = await openSession(authority, space, space);
    assertExists(opened.ok, "space identity should open its own space");
    const unowned: Record<string, unknown>[] = [
      {},
      { "*": "OWNER" },
      { "*": "OWNER", [ALICE]: "WRITE" },
      { [ALICE]: "WRITE", [BOB]: "READ" },
      { [ALICE]: "ADMIN" },
    ];
    let localSeq = 1;
    for (const acl of unowned) {
      const response = await transactSet(
        authority,
        space,
        opened.ok.sessionId,
        `of:${space}`,
        acl,
        localSeq++,
      );
      assertEquals(response.error?.name, "ProtocolError");
      assertEquals(
        response.error?.message,
        "ACL must be valid and retain at least one concrete OWNER",
      );
    }
    // Still fresh: an ordinary write is refused for want of genesis, and
    // there is no ACL document.
    const ordinary = await transactSet(
      authority,
      space,
      opened.ok.sessionId,
      "of:after-refused-genesis",
      { value: 1 },
      localSeq++,
    );
    assertEquals(ordinary.error?.name, "AuthorizationError");
    assertEquals(
      ordinary.error?.message,
      `Space ${space} requires an ACL genesis commit before ordinary writes`,
    );
    assertEquals(await server.readDocument(space, `of:${space}`), null);

    // A concrete OWNER then initializes it — the check refused the
    // document, not the identity.
    const sealed = await transactSet(
      authority,
      space,
      opened.ok.sessionId,
      `of:${space}`,
      { [space]: "OWNER", [ALICE]: "WRITE" },
      localSeq++,
    );
    assertExists(sealed.ok);
    assertEquals(sealed.ok.seq, 1, "the genesis ACL is the first commit");
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

    const entityIds = await server.listEntityIds({
      type: "entity-id.list",
      requestId: nextRequestId("acl-entity-identifiers"),
      space,
      sessionId: bobSession.ok.sessionId,
    });
    assertEquals(entityIds.ok?.ids, [`of:${space}`]);

    const entityExists = await server.entityIdExists({
      type: "entity-id.exists",
      requestId: nextRequestId("acl-entity-exists"),
      space,
      sessionId: bobSession.ok.sessionId,
      id: `of:${space}`,
    });
    assertEquals(entityExists.ok?.exists, true);

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

Deno.test("acl enforce: entity identifier reads require READ capability", async () => {
  const sessions = new SessionRegistry();
  const server = new Server({
    sessions,
    store: new URL("memory://acl-entity-identifiers-denied"),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: { mode: "enforce" },
  });
  const space = "did:key:z6Mk-acl-entity-identifiers-denied";

  try {
    await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
    sessions.open(
      space,
      { sessionId: "session:entity-identifiers-denied" },
      1,
      "entity-identifiers-denied",
      BOB,
    );

    const list = await server.listEntityIds({
      type: "entity-id.list",
      requestId: nextRequestId("acl-entity-identifiers-denied"),
      space,
      sessionId: "session:entity-identifiers-denied",
    });
    assertEquals(list.error?.name, "AuthorizationError");

    const lookup = await server.entityIdExists({
      type: "entity-id.exists",
      requestId: nextRequestId("acl-entity-exists-denied"),
      space,
      sessionId: "session:entity-identifiers-denied",
      id: `of:${space}`,
    });
    assertEquals(lookup.error?.name, "AuthorizationError");
  } finally {
    await server.close();
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

//
// OW31 (WRITE ruled 2026-08-18, READ ruled 2026-08-19): the delegated READ
// binding. A session opened `actingAs: "space-owner"` by a DELEGATING-class
// principal has its READ-class decisions resolved as the space's ACL OWNER
// (the server dereferences the ACL — the ruled service-identity ACL read);
// WRITE/OWNER requirements keep resolving against the ENVELOPE, so the
// binding grants no write path; a delegating principal is NOT a service
// principal and cannot initialize a genesis.
//

Deno.test("OW31 acl enforce: a delegating principal acting as space-owner READS an owner-only space; its writes and ACL-doc writes stay refused", async () => {
  const server = createAclServer("memory://acl-ow31-binding", {
    mode: "enforce",
    delegatingDids: [SERVICE],
  });
  const space = "did:key:z6Mk-acl-ow31-space-1";
  await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
  const plainHarness = await connect(server);
  const service = await connect(server);
  try {
    // WITHOUT the binding: the blanket is gone — the serving identity
    // lacks READ on an owner-only space. (Fresh connection: a denied
    // open still consumes the connection's one challenge.)
    const plain = await openSession(plainHarness, space, SERVICE);
    assertExists(plain.error, "envelope-only open must be denied");
    assertEquals(plain.error?.name, "AuthorizationError");

    // WITH the binding: session.open runs under the acting user (the
    // owner) and is admitted; queries read as the owner.
    const bound = await openSession(service, space, SERVICE, {
      actingAs: "space-owner",
    });
    assertExists(bound.ok, bound.error?.message);
    const read = await graphQuery(service, space, bound.ok.sessionId, "of:x");
    assertExists(read.ok, read.error?.message);

    // WRITE-class requirements resolve against the ENVELOPE: the
    // serving identity cannot write into a user's space over the
    // session plane (the ruled write posture — served writes ride the
    // wave's delegated carriage instead).
    const write = await transactSet(
      service,
      space,
      bound.ok.sessionId,
      "of:ow31-session-write",
      { denied: true },
      1,
    );
    assertExists(write.error, "session-plane write must be refused");
    assertEquals(write.error?.name, "AuthorizationError");

    // ACL-doc writes need OWNER — envelope again: refused.
    const aclWrite = await transactSet(
      service,
      space,
      bound.ok.sessionId,
      `of:${space}`,
      { [SERVICE]: "OWNER" },
      2,
    );
    assertExists(aclWrite.error, "ACL mutation must be refused");
  } finally {
    await server.close();
  }
});

Deno.test("OW31 acl enforce: the actingAs marker from a NON-delegating principal is refused loudly", async () => {
  const server = createAclServer("memory://acl-ow31-nondelegating", {
    mode: "enforce",
    delegatingDids: [SERVICE],
  });
  const space = "did:key:z6Mk-acl-ow31-space-2";
  await initializeSpaceAcl(server, space, {
    [ALICE]: "OWNER",
    "*": "WRITE",
  });
  const bob = await connect(server);
  try {
    // Even on a space where BOB holds "*" WRITE on his own: the MARKER
    // is an admission-validity claim only a delegating principal may
    // make.
    const refused = await openSession(bob, space, BOB, {
      actingAs: "space-owner",
    });
    assertExists(refused.error, "non-delegating actingAs must be refused");
    assertEquals(refused.error?.name, "AuthorizationError");
    assert(
      (refused.error?.message ?? "").includes("delegating"),
      refused.error?.message,
    );
  } finally {
    await server.close();
  }
});

Deno.test("OW31 acl enforce: a delegating principal cannot initialize a fresh space's genesis (not a service DID)", async () => {
  const server = createAclServer("memory://acl-ow31-genesis", {
    mode: "enforce",
    delegatingDids: [SERVICE],
  });
  const space = "did:key:z6Mk-acl-ow31-space-3";
  const service = await connect(server);
  try {
    // Fresh space, actingAs resolves NO binding (no ACL): the envelope's
    // own fresh-space READ floor admits the open.
    const opened = await openSession(service, space, SERVICE, {
      actingAs: "space-owner",
    });
    assertExists(opened.ok, opened.error?.message);
    assertEquals(opened.ok.serverSeq, 0);
    // The genesis ACL write is refused: only the space identity or an
    // OWNER-class service DID may initialize (the delegating class is
    // deliberately NOT one — verification-coverage.md OW31's guard
    // against creep).
    const genesis = await transactSet(
      service,
      space,
      opened.ok.sessionId,
      `of:${space}`,
      { [SERVICE]: "OWNER" },
      1,
    );
    assertExists(genesis.error, "delegating genesis must be refused");
    assert(
      (genesis.error?.message ?? "").includes("initialize"),
      genesis.error?.message,
    );
  } finally {
    await server.close();
  }
});

Deno.test("OW31 acl enforce: an ACL change that removes the bound owner revokes the delegating session", async () => {
  const server = createAclServer("memory://acl-ow31-revoke", {
    mode: "enforce",
    delegatingDids: [SERVICE],
  });
  const space = "did:key:z6Mk-acl-ow31-space-4";
  await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
  const service = await connect(server);
  const alice = await connect(server);
  try {
    const bound = await openSession(service, space, SERVICE, {
      actingAs: "space-owner",
    });
    assertExists(bound.ok, bound.error?.message);

    // ALICE transfers ownership wholly to BOB: the session bound to
    // acting-as-ALICE loses READ and is revoked; the serving plane's
    // next mount re-resolves the new owner.
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);
    const transferred = await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      `of:${space}`,
      { [BOB]: "OWNER" },
      1,
    );
    assertExists(transferred.ok, transferred.error?.message);

    // The bound session was revoked in place: the service connection
    // received the terminal session/revoked for it (the registry entry
    // is gone; the serving plane's next mount re-resolves the owner).
    const revoked = service.messages.find((message) =>
      message.type === "session/revoked"
    );
    assertExists(revoked, "the bound session must be revoked");
  } finally {
    await server.close();
  }
});

Deno.test("OW31 acl observe: a bound session's envelope write is a counted would-deny (the canary's mechanism)", async () => {
  const server = createAclServer("memory://acl-ow31-observe", {
    mode: "observe",
    delegatingDids: [SERVICE],
  });
  const space = "did:key:z6Mk-acl-ow31-space-5";
  await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
  const service = await connect(server);
  try {
    const bound = await openSession(service, space, SERVICE, {
      actingAs: "space-owner",
    });
    assertExists(bound.ok, bound.error?.message);
    const before = server.aclStats.wouldDeny;
    const write = await transactSet(
      service,
      space,
      bound.ok.sessionId,
      "of:ow31-observe-write",
      { observed: true },
      1,
    );
    // Observe mode allows the write but counts it: a non-zero
    // process-identity write would-deny names a residual session-plane
    // write to re-route (verification-coverage.md OW31's canary).
    assertExists(write.ok, write.error?.message);
    assertEquals(server.aclStats.wouldDeny, before + 1);
  } finally {
    await server.close();
  }
});

Deno.test("OW31 acl off: the actingAs marker is inert (off preserves historical behavior)", async () => {
  const server = createAclServer("memory://acl-ow31-off", { mode: "off" });
  const space = "did:key:z6Mk-acl-ow31-space-6";
  const bob = await connect(server);
  try {
    const opened = await openSession(bob, space, BOB, {
      actingAs: "space-owner",
    });
    assertExists(opened.ok, opened.error?.message);
  } finally {
    await server.close();
  }
});

Deno.test("OW31 acl enforce: an ownership TRANSFER re-binds — the bound session is revoked even when the stale acting principal retains READ (a self-owned space included)", async () => {
  const server = createAclServer("memory://acl-ow31-rebind", {
    mode: "enforce",
    delegatingDids: [SERVICE],
  });
  // A SELF-OWNED (home-shaped) space: the binding resolves the space
  // DID itself, whose implicit-OWNER short-circuit would keep READ
  // forever — the stale-binding hazard's worst case (Codex P1 review
  // finding on #6156).
  const space = "did:key:z6Mk-acl-ow31-space-7";
  await initializeSpaceAcl(server, space, { [space]: "OWNER" });
  const service = await connect(server);
  const authority = await connect(server);
  try {
    const bound = await openSession(service, space, SERVICE, {
      actingAs: "space-owner",
    });
    assertExists(bound.ok, bound.error?.message);

    // The space identity transfers ownership wholly to BOB. The bound
    // session's stored acting principal (the space DID) still holds
    // implicit OWNER by identity — but it is no longer what the
    // binding WOULD resolve, so the session must be revoked and the
    // next mount re-binds the new owner.
    const spaceSession = await openSession(authority, space, space);
    assertExists(spaceSession.ok);
    const transferred = await transactSet(
      authority,
      space,
      spaceSession.ok.sessionId,
      `of:${space}`,
      { [BOB]: "OWNER" },
      1,
    );
    assertExists(transferred.ok, transferred.error?.message);

    const revoked = service.messages.find((message) =>
      message.type === "session/revoked"
    );
    assertExists(
      revoked,
      "an ownership transfer must revoke the stale binding",
    );
  } finally {
    await server.close();
  }
});

Deno.test("OW31 acl enforce: an unknown actingAs value is a ProtocolError; a multi-owner ACL binds the lexicographically first concrete owner", async () => {
  const server = createAclServer("memory://acl-ow31-marker-shape", {
    mode: "enforce",
    delegatingDids: [SERVICE],
  });
  const space = "did:key:z6Mk-acl-ow31-space-8";
  // TWO concrete owners, no self-entry, no wildcard: the binding must
  // resolve deterministically (sorted-first — ALICE before CAROL) for
  // the session to read at all.
  await initializeSpaceAcl(server, space, {
    [ALICE]: "OWNER",
    [CAROL]: "OWNER",
  });
  const unknown = await connect(server);
  const bound = await connect(server);
  try {
    const refused = await openSession(unknown, space, SERVICE, {
      actingAs: "space-emperor" as never,
    });
    assertExists(refused.error, "unknown actingAs value must be refused");
    assertEquals(refused.error?.name, "ProtocolError");

    const opened = await openSession(bound, space, SERVICE, {
      actingAs: "space-owner",
    });
    assertExists(opened.ok, opened.error?.message);
    const read = await graphQuery(bound, space, opened.ok.sessionId, "of:x");
    assertExists(read.ok, read.error?.message);

    // The DISCRIMINATING half (delta review D4 on #6156): remove ALICE
    // — the lexicographically FIRST owner — from the ACL. If the
    // binding had resolved CAROL, the new resolution (CAROL) would
    // still match and the session would survive; because it resolved
    // ALICE, the owner-resolution revocation branch fires.
    const carol = await connect(server);
    const carolSession = await openSession(carol, space, CAROL);
    assertExists(carolSession.ok);
    const rewritten = await transactSet(
      carol,
      space,
      carolSession.ok.sessionId,
      `of:${space}`,
      { [CAROL]: "OWNER" },
      1,
    );
    assertExists(rewritten.ok, rewritten.error?.message);
    const revoked = bound.messages.find((message) =>
      message.type === "session/revoked"
    );
    assertExists(
      revoked,
      "removing the first-sorted owner must revoke the binding — the " +
        "binding was ALICE, not CAROL",
    );
  } finally {
    await server.close();
  }
});

Deno.test("OW31 acl enforce: an OWNER-class service envelope stores NO binding — its authority is the operator grant, and an ownership transfer does not revoke it (D2/D3)", async () => {
  // The F1 operator combination: the process identity in BOTH
  // MEMORY_SERVICE_DIDS (OWNER-class, verbatim) and the delegating
  // list. The marker is admitted, but no binding is stored — the
  // session's authority is the explicit operator grant, so the
  // owner-resolution revocation branch (and its writerSessionId
  // carve-out skip) never applies to it.
  const server = createAclServer("memory://acl-ow31-ownerclass", {
    mode: "enforce",
    serviceDids: [SERVICE],
    delegatingDids: [SERVICE],
  });
  const space = "did:key:z6Mk-acl-ow31-space-9";
  await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
  const service = await connect(server);
  const alice = await connect(server);
  try {
    const opened = await openSession(service, space, SERVICE, {
      actingAs: "space-owner",
    });
    assertExists(opened.ok, opened.error?.message);

    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);
    const transferred = await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      `of:${space}`,
      { [BOB]: "OWNER" },
      1,
    );
    assertExists(transferred.ok, transferred.error?.message);

    // No binding was stored, so the ownership transfer revokes nothing:
    // the OWNER-class grant still reads.
    const revoked = service.messages.find((message) =>
      message.type === "session/revoked"
    );
    assertEquals(revoked, undefined, "OWNER-class session must survive");
    const read = await graphQuery(service, space, opened.ok.sessionId, "of:x");
    assertExists(read.ok, read.error?.message);
  } finally {
    await server.close();
  }
});
