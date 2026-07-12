import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
} from "../v2.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-server-execution-feed-reconnect";

const serverFlags = {
  ...getMemoryProtocolFlags(),
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
};

const createServer = (name: string): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}`),
    protocolFlags: serverFlags,
    acl: { mode: "off", serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
  });

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const hello = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  capabilities: {
    routing: boolean;
    builtinPassivity: boolean;
  } = { routing: true, builtinPassivity: true },
): Promise<SessionOpenAuthMetadata> => {
  await connection.receive(encodeMemoryBoundary({
    type: "hello",
    protocol: MEMORY_PROTOCOL,
    flags: {
      ...serverFlags,
      serverPrimaryExecutionClaimRoutingV1: capabilities.routing,
      serverPrimaryExecutionBuiltinPassivityV1: capabilities.builtinPassivity,
    },
  }));
  const message = shiftMessage(messages);
  assertEquals(message.type, "hello.ok");
  const response = message as HelloOkMessage;
  assertExists(response.sessionOpen);
  return response.sessionOpen;
};

const invocation = (auth: SessionOpenAuthMetadata) => ({
  aud: auth.audience,
  challenge: auth.challenge.value,
});

const open = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  requestId: string,
  auth: SessionOpenAuthMetadata,
  session: SessionDescriptor,
): Promise<ResponseMessage<SessionOpenResult>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId,
    space: SPACE,
    session,
    invocation: invocation(auth),
  }));
  const message = shiftMessage(messages);
  assertEquals(message.type, "response");
  return message as ResponseMessage<SessionOpenResult>;
};

const enablePolicy = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  sessionId: string,
): Promise<void> => {
  await connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "enable-policy",
    space: SPACE,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}:execution-policy`,
        scope: "space",
        value: {
          value: { version: 1, serverPrimaryExecution: true },
        },
      }],
    },
  }));
  const response = shiftMessage(messages);
  assertEquals(response.type, "response");
  assertEquals((response as ResponseMessage<unknown>).error, undefined);
};

const claimInput = (
  actionId: string,
  actionKind: "computation" | "effect",
) => ({
  branch: "",
  space: SPACE,
  contextKey: "space" as const,
  pieceId: "piece:one",
  actionId,
  actionKind,
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:v1",
  leaseGeneration: 1,
});

const beginBlockedResume = async (
  server: Server,
  session: SessionOpenResult,
  executionFeedSeq: number,
) => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const auth = await hello(connection, messages);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalSync = server.syncSessionForConnection.bind(server);
  let block = true;
  server.syncSessionForConnection = async (...args) => {
    if (block) {
      block = false;
      entered.resolve();
      await release.promise;
    }
    return await originalSync(...args);
  };
  const receiving = connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "resume",
    space: SPACE,
    session: {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      seenSeq: session.serverSeq,
      executionFeedSeq,
    },
    invocation: invocation(auth),
  }));
  await entered.promise;
  return { connection, messages, receiving, release, originalSync };
};

Deno.test("resumed open suppresses live execution effects until its response installs the session", async () => {
  const server = createServer("memory-v2-execution-feed-open-barrier");
  const firstMessages: ServerMessage[] = [];
  const first = server.connect((message) => firstMessages.push(message));
  try {
    const firstAuth = await hello(first, firstMessages);
    const opened = await open(first, firstMessages, "open", firstAuth, {});
    assertExists(opened.ok);
    assertExists(opened.ok.sync?.execution);
    await enablePolicy(first, firstMessages, opened.ok.sessionId);
    const feedSeq = opened.ok.sync.execution.toFeedSeq;
    first.close();

    const resumed = await beginBlockedResume(server, opened.ok, feedSeq);
    try {
      server.setExecutionClaim(
        claimInput("action:during-resume", "computation"),
      );

      // The session registry has transferred ownership to this connection,
      // but Connection.addSession() has not crossed the open-response barrier.
      // A live effect here would later be replayed in the response as well.
      assertEquals(resumed.messages, []);

      resumed.release.resolve();
      await resumed.receiving;
      const response = shiftMessage(resumed.messages) as ResponseMessage<
        SessionOpenResult
      >;
      assertEquals(response.type, "response");
      assertEquals(
        response.ok?.sync?.execution?.events.map((event) => event.type),
        ["session.execution.claim.set"],
      );
      assertEquals(resumed.messages, []);
    } finally {
      server.syncSessionForConnection = resumed.originalSync;
      resumed.release.resolve();
      await resumed.receiving;
      resumed.connection.close();
    }
  } finally {
    first.close();
    await server.close();
  }
});

Deno.test("resumed feed filters retained events through current execution subcapabilities", async () => {
  const server = createServer("memory-v2-execution-feed-resume-subcaps");
  const firstMessages: ServerMessage[] = [];
  const first = server.connect((message) => firstMessages.push(message));
  try {
    const firstAuth = await hello(first, firstMessages);
    const opened = await open(first, firstMessages, "open", firstAuth, {});
    assertExists(opened.ok);
    assertExists(opened.ok.sync?.execution);
    await enablePolicy(first, firstMessages, opened.ok.sessionId);
    const acknowledgedFeedSeq = opened.ok.sync.execution.toFeedSeq;

    server.setExecutionClaim(
      claimInput("action:computation", "computation"),
    );
    server.setExecutionClaim(claimInput("action:builtin", "effect"));
    assertEquals(
      firstMessages.filter((message) => message.type === "session/effect")
        .length,
      2,
    );
    firstMessages.length = 0;
    first.close();

    const secondMessages: ServerMessage[] = [];
    const second = server.connect((message) => secondMessages.push(message));
    try {
      const secondAuth = await hello(second, secondMessages, {
        routing: true,
        builtinPassivity: false,
      });
      const resumed = await open(
        second,
        secondMessages,
        "resume",
        secondAuth,
        {
          sessionId: opened.ok.sessionId,
          sessionToken: opened.ok.sessionToken,
          seenSeq: opened.ok.serverSeq,
          executionFeedSeq: acknowledgedFeedSeq,
        },
      );
      assertExists(resumed.ok?.sync?.execution);
      assertEquals(
        resumed.ok.sync.execution.snapshot?.claims.map((claim) =>
          claim.actionKind
        ),
        ["computation"],
      );
      assertEquals(
        resumed.ok.sync.execution.events.map((event) => {
          if (event.type !== "session.execution.claim.set") return event.type;
          return event.claim.actionKind;
        }),
        ["computation"],
      );
      assertEquals(
        secondMessages.filter((message): message is SessionEffectMessage =>
          message.type === "session/effect"
        ),
        [],
      );
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await server.close();
  }
});
