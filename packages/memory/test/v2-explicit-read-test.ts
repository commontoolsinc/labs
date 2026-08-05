// Server-execution v2 stage F: the read-side admission row (protocol.md
// §2's READ row; the read half of §1's transaction identity model, ledger
// LD5). A read naming an explicit `entity_scope_key` is admissible only
// for a live lease holder on the co-hosted memory server — the operand
// mapping is the session's authenticated principal equaling the
// SERVICE-IDENTITY component of the space's live DR1 holder. A non-holder
// naming a key is REJECTED (before stage F the wire could not even
// express one); a read naming none resolves from the session as today.

import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  resolveScopeKey,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  setServerExecutionConfig,
  type WatchSetResult,
} from "../v2.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";

const TEST_AUDIENCE = "did:key:z6Mk-explicit-read-audience";
const SPACE = "did:key:z6Mk-explicit-read-space";
const SERVICE = "did:key:z6Mk-explicit-read-service";
const ALICE = "did:key:z6Mk-explicit-read-alice";
const BOB = "did:key:z6Mk-explicit-read-bob";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return { messages, connection, sessionOpen: hello.sessionOpen! };
};

let requestCounter = 0;
const nextRequestId = (label: string): string => `${label}-${++requestCounter}`;

const openSession = async (
  harness: Harness,
  principal: string,
): Promise<string> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space: SPACE,
    session: {},
    invocation: {
      iss: principal,
      aud: harness.sessionOpen.audience,
      challenge: harness.sessionOpen.challenge.value,
    },
  }));
  const response = shiftMessage(harness.messages) as ResponseMessage<
    { sessionId: string; sessionOpen: SessionOpenAuthMetadata }
  >;
  assertExists(response.ok, JSON.stringify(response.error));
  harness.sessionOpen = response.ok.sessionOpen;
  return response.ok.sessionId;
};

const newServer = (store: string): Server =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
  });

Deno.test("explicit entity_scope_key reads: lease holder admitted, non-holder and off-flag refused (protocol.md §2's read row)", async () => {
  const server = newServer("memory://explicit-read");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const aliceSession = await openSession(alice, ALICE);

    // Alice writes her own user-scoped instance — the doc under
    // `user:<alice>` that only the read row lets another party name.
    const write = await server.transact({
      type: "transact",
      requestId: nextRequestId("write"),
      space: SPACE,
      sessionId: aliceSession,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:profile",
          scope: "user",
          value: { value: { name: "alice" } },
        }],
      },
    });
    assertExists(write.ok);
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    // The SpaceServer's loopback session: principal = the service
    // identity the DR1 holder was minted from, holding the live lease.
    const service = await connect(server);
    const serviceSession = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(acquireExecutionLease(engine, { space: SPACE, holder }), true);

    // The holder names alice's instance explicitly and reads it.
    const held = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("held"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertExists(held.ok, JSON.stringify(held.error));
    assertEquals(held.ok.entities.length, 1);
    assertEquals(held.ok.entities[0].document?.value, { name: "alice" });

    // A non-holder (bob's ordinary client session) naming a key is
    // REJECTED — the wire field exists now, so the refusal must too.
    const bob = await connect(server);
    const bobSession = await openSession(bob, BOB);
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("refused"),
      space: SPACE,
      sessionId: bobSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(refused.ok, undefined);
    assertEquals(refused.error?.name, "ProtocolError");
    assertEquals(
      refused.error?.message.includes("does not hold a live execution_lease"),
      true,
    );

    // The watch path refuses identically.
    const refusedWatch = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("refused-watch"),
      space: SPACE,
      sessionId: bobSession,
      watches: [{
        id: "w1",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: aliceKey,
            selector: { path: [], schema: false },
          }],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertEquals(refusedWatch.error?.name, "ProtocolError");

    // Bob's key-less read still resolves from his own session (empty —
    // his instance holds nothing), unchanged from today.
    const bobOwn = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("bob-own"),
      space: SPACE,
      sessionId: bobSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          selector: { path: [], schema: false },
        }],
      },
    }) as ResponseMessage<GraphQueryResult>;
    assertExists(bobOwn.ok);
    assertEquals(bobOwn.ok.entities[0]?.document ?? null, null);

    // Off the flag the field is unclaimable, holder or not.
    resetServerExecutionConfig();
    const offFlag = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("off-flag"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(offFlag.error?.name, "ProtocolError");
    assertEquals(
      offFlag.error?.message.includes("EXPERIMENTAL_SERVER_EXECUTION"),
      true,
    );
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});
