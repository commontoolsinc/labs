import { assert, assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
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
  store: string,
  acl?: {
    mode: "off" | "observe" | "enforce";
    serviceDids?: readonly string[];
  },
) =>
  new Server({
    store: new URL(store),
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
): Promise<ResponseMessage<{ sessionId: string; serverSeq: number }>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space,
    session: {},
    invocation: {
      iss: principal,
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
  }));
  return assertResponse<{ sessionId: string; serverSeq: number }>(
    shiftMessage(messages),
  );
};

const transactSet = async (
  { connection, messages }: Harness,
  space: string,
  sessionId: string,
  id: string,
  value: unknown,
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
      operations: [{ op: "set", id, value: { value } }],
    },
  }));
  return assertResponse<{ seq: number }>(shiftMessage(messages));
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

Deno.test("acl enforce: creator is seeded as OWNER and a stranger is denied", async () => {
  const server = createAclServer("memory://acl-enforce-stranger", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-1";
  const alice = await connect(server);
  try {
    const opened = await openSession(alice, space, ALICE);
    assertExists(opened.ok, "creator open should succeed");

    // The seed is a real commit: the ACL doc is readable and names the creator.
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
      `seeded ACL doc should grant creator OWNER, got: ${aclDoc}`,
    );

    // Creator can write.
    const write = await transactSet(
      alice,
      space,
      opened.ok.sessionId,
      "of:doc:1",
      { hello: "world" },
      1,
    );
    assertExists(write.ok, "creator write should succeed");

    // A stranger cannot even open a session.
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
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);

    // Owner grants Bob WRITE (owner may write the ACL doc).
    const grant = await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      `of:${space}`,
      { [ALICE]: "OWNER", [BOB]: "WRITE" },
      1,
    );
    assertExists(grant.ok, "owner should be able to write the ACL doc");

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
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);
    await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      `of:${space}`,
      { [ALICE]: "OWNER", [CAROL]: "READ" },
      1,
    );
    await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      "of:doc:shared",
      { shared: true },
      2,
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
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);
    await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      `of:${space}`,
      { [ALICE]: "OWNER", "*": "READ" },
      1,
    );

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
    // Service touches (and effectively creates) the space first...
    const serviceSession = await openSession(service, space, SERVICE);
    assertExists(serviceSession.ok, "service DID should open any space");
    const write = await transactSet(
      service,
      space,
      serviceSession.ok.sessionId,
      "of:doc:svc",
      { from: "service" },
      1,
    );
    assertExists(write.ok, "service DID should write any space");

    // ...but must NOT have claimed ownership: the space now has data and no
    // ACL doc, so a later regular principal is denied (not silently second).
    const denied = await openSession(alice, space, ALICE);
    assertEquals(denied.error?.name, "AuthorizationError");
  } finally {
    await server.close();
  }
});

Deno.test("acl enforce: principal equal to the space DID has implicit OWNER", async () => {
  const server = createAclServer("memory://acl-enforce-space-key", {
    mode: "enforce",
  });
  const space = "did:key:z6Mk-acl-space-6";
  const holder = await connect(server);
  try {
    const session = await openSession(holder, space, space);
    assertExists(session.ok, "space-key principal should open its own space");
    const write = await transactSet(
      holder,
      space,
      session.ok.sessionId,
      "of:doc:self",
      { self: true },
      1,
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
    const aliceSession = await openSession(alice, space, ALICE);
    assertExists(aliceSession.ok);
    await transactSet(
      alice,
      space,
      aliceSession.ok.sessionId,
      `of:${space}`,
      { [ALICE]: "OWNER", [BOB]: "WRITE" },
      1,
    );

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
      2,
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

Deno.test("acl observe: stranger is allowed but the would-deny is counted", async () => {
  const server = createAclServer("memory://acl-observe", { mode: "observe" });
  const space = "did:key:z6Mk-acl-space-8";
  const alice = await connect(server);
  const bob = await connect(server);
  try {
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

Deno.test("acl observe: creator seeding still happens (migration path)", async () => {
  const server = createAclServer("memory://acl-observe-seed", {
    mode: "observe",
  });
  const space = "did:key:z6Mk-acl-space-9";
  const alice = await connect(server);
  try {
    const opened = await openSession(alice, space, ALICE);
    assertExists(opened.ok);
    const acl = await graphQuery(
      alice,
      space,
      opened.ok.sessionId,
      `of:${space}`,
    );
    const aclDoc = JSON.stringify(acl.ok ?? {});
    assert(
      aclDoc.includes(ALICE) && aclDoc.includes("OWNER"),
      `observe mode should seed creator OWNER, got: ${aclDoc}`,
    );
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
