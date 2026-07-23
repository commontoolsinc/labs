import { assertEquals, assertExists } from "@std/assert";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  type ExecutionLeaseHandle,
  Server,
  SessionRegistry,
} from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  type ExecutionControlEvent,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenRequest,
  type SessionOpenResult,
  toInputBasisSeq,
} from "../v2.ts";
import { verifySessionOpenAuthorization } from "../v2/session-open-auth.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";
import { alice } from "./principal.ts";

const SPACE = "did:key:z6Mk-server-execution-feed-reconnect";
const SIGNED_OPEN_NOW_SECONDS = 1_000_000;

const serverFlags = {
  ...getMemoryProtocolFlags(),
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
};

const createServer = (
  name: string,
  options: { maxExecutionEvents?: number } = {},
): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}`),
    sessions: new SessionRegistry(options),
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

const signedOpenRequest = async (
  auth: SessionOpenAuthMetadata,
  requestId: string,
  session: SessionDescriptor,
): Promise<SessionOpenRequest> => {
  const signedSession = { ...session };
  const signedInvocation = {
    iss: alice.did(),
    aud: auth.audience,
    cmd: "session.open",
    sub: SPACE,
    challenge: auth.challenge.value,
    iat: SIGNED_OPEN_NOW_SECONDS,
    exp: SIGNED_OPEN_NOW_SECONDS + 300,
    args: { protocol: MEMORY_PROTOCOL, session: signedSession },
  };
  const signature = await alice.sign(hashOf(signedInvocation).bytes);
  if (signature.error) throw signature.error;
  return {
    type: "session.open",
    requestId,
    space: SPACE,
    session: { ...session },
    invocation: signedInvocation,
    authorization: { signature: new FabricBytes(signature.ok) },
  };
};

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
});

const eventActionId = (event: ExecutionControlEvent): string =>
  event.type === "session.execution.settlement"
    ? event.settlement.claim.actionId
    : event.claim.actionId;

const acquireSponsorLease = async (
  server: Server,
): Promise<{
  connection: ReturnType<Server["connect"]>;
  lease: ExecutionLeaseHandle;
}> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const auth = await hello(connection, messages);
  const opened = await open(
    connection,
    messages,
    "open-sponsor",
    auth,
    {},
  );
  assertExists(opened.ok);
  await connection.receive(encodeMemoryBoundary({
    type: "session.execution.demand.set",
    requestId: "sponsor-demand",
    space: SPACE,
    sessionId: opened.ok.sessionId,
    branch: "",
    pieces: ["piece:one"],
  }));
  const response = shiftMessage(messages) as ResponseMessage<unknown>;
  assertEquals(response.type, "response");
  assertEquals(response.error, undefined);
  const lease = await server.acquireExecutionLease(SPACE, "");
  assertExists(lease);
  return { connection, lease };
};

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
  let sponsor: Awaited<ReturnType<typeof acquireSponsorLease>> | undefined;
  try {
    const firstAuth = await hello(first, firstMessages);
    const opened = await open(first, firstMessages, "open", firstAuth, {});
    assertExists(opened.ok);
    assertExists(opened.ok.sync?.execution);
    sponsor = await acquireSponsorLease(server);
    const feedSeq = opened.ok.sync.execution.toFeedSeq;
    first.close();

    const resumed = await beginBlockedResume(server, opened.ok, feedSeq);
    try {
      await server.setExecutionClaim(
        sponsor.lease,
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
    sponsor?.connection.close();
    first.close();
    await server.close();
  }
});

Deno.test("unsigned execution feed cursors cannot acknowledge or filter registry events", async () => {
  const sessions = new SessionRegistry({ maxExecutionEvents: 4 });
  const server = new Server({
    store: new URL("memory://execution-feed-signed-cursor"),
    sessions,
    authorizeSessionOpen: (message, context) =>
      verifySessionOpenAuthorization(message, {
        ...context,
        nowSeconds: SIGNED_OPEN_NOW_SECONDS,
        clockSkewSeconds: 0,
      }),
    sessionOpenAuth: {
      audience: alice.did(),
      nowSeconds: () => SIGNED_OPEN_NOW_SECONDS,
    },
    protocolFlags: serverFlags,
    acl: { mode: "off", serviceDids: [alice.did()] },
  });
  const firstMessages: ServerMessage[] = [];
  const first = server.connect((message) => firstMessages.push(message));
  let resumed: ReturnType<Server["connect"]> | undefined;
  try {
    const firstAuth = await hello(first, firstMessages);
    const firstOpen = await signedOpenRequest(firstAuth, "open-signed", {});
    await first.receive(encodeMemoryBoundary(firstOpen));
    const opened = shiftMessage(firstMessages) as ResponseMessage<
      SessionOpenResult
    >;
    assertExists(opened.ok?.sync?.execution);
    const signedCursor = opened.ok.sync.execution.toFeedSeq;
    first.close();

    const state = sessions.get(SPACE, opened.ok.sessionId);
    assertExists(state);
    sessions.appendExecutionEvent(state, {
      type: "session.execution.claim.set",
      claim: {
        ...claimInput("action:retained", "computation"),
        leaseGeneration: 1,
        claimGeneration: 1,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    });
    const feedSeqBefore = state.executionFeedSeq;
    const ackBefore = state.executionFeedAckSeq;
    const eventsBefore = state.executionEvents.map((entry) => entry.feedSeq);

    const resumedMessages: ServerMessage[] = [];
    resumed = server.connect((message) => resumedMessages.push(message));
    const resumeAuth = await hello(resumed, resumedMessages);
    const signedResume = await signedOpenRequest(
      resumeAuth,
      "resume-exact",
      {
        sessionId: opened.ok.sessionId,
        sessionToken: opened.ok.sessionToken,
        seenSeq: opened.ok.serverSeq,
        executionFeedSeq: signedCursor,
      },
    );
    await resumed.receive(encodeMemoryBoundary({
      ...signedResume,
      requestId: "resume-tampered",
      session: {
        ...signedResume.session,
        executionFeedSeq: feedSeqBefore,
      },
    }));
    const rejected = shiftMessage(resumedMessages) as ResponseMessage<
      SessionOpenResult
    >;
    assertEquals(rejected.ok, undefined);
    assertEquals(rejected.error?.name, "AuthorizationError");
    const unchanged = sessions.get(SPACE, opened.ok.sessionId);
    assertExists(unchanged);
    assertEquals(unchanged.executionFeedSeq, feedSeqBefore);
    assertEquals(unchanged.executionFeedAckSeq, ackBefore);
    assertEquals(
      unchanged.executionEvents.map((entry) => entry.feedSeq),
      eventsBefore,
    );

    await resumed.receive(encodeMemoryBoundary(signedResume));
    const accepted = shiftMessage(resumedMessages) as ResponseMessage<
      SessionOpenResult
    >;
    assertExists(accepted.ok?.sync?.execution);
    assertEquals(accepted.ok.sync.execution.fromFeedSeq, signedCursor);
    assertEquals(
      accepted.ok.sync.execution.events.map(eventActionId),
      ["action:retained"],
    );
  } finally {
    resumed?.close();
    first.close();
    await server.close();
  }
});

Deno.test("resume behind a bounded execution suffix installs an exact snapshot and advances", async () => {
  const server = createServer("memory-v2-execution-feed-bounded-resume", {
    maxExecutionEvents: 2,
  });
  const firstMessages: ServerMessage[] = [];
  const first = server.connect((message) => firstMessages.push(message));
  let sponsor: Awaited<ReturnType<typeof acquireSponsorLease>> | undefined;
  let second: ReturnType<Server["connect"]> | undefined;
  try {
    const firstAuth = await hello(first, firstMessages);
    const opened = await open(first, firstMessages, "open", firstAuth, {});
    assertExists(opened.ok);
    assertExists(opened.ok.sync?.execution);
    sponsor = await acquireSponsorLease(server);
    const acknowledgedFeedSeq = opened.ok.sync.execution.toFeedSeq;
    first.close();

    const stale = await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:stale", "computation"),
    );
    assertExists(stale);
    assertEquals(server.revokeExecutionClaim(stale), true);
    const liveOne = await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:live-one", "computation"),
    );
    const liveTwo = await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:live-two", "computation"),
    );
    assertExists(liveOne);
    assertExists(liveTwo);

    const secondMessages: ServerMessage[] = [];
    second = server.connect((message) => secondMessages.push(message));
    const secondAuth = await hello(second, secondMessages);
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
    const resumedBatch = resumed.ok.sync.execution;
    assertEquals(resumedBatch.fromFeedSeq, acknowledgedFeedSeq);
    // Four detached events overflow the two-entry suffix; the resume snapshot
    // itself advances one more feed barrier.
    assertEquals(resumedBatch.toFeedSeq, acknowledgedFeedSeq + 5);
    assertEquals(
      resumedBatch.events.map(eventActionId),
      ["action:live-one", "action:live-two"],
    );
    const byActionId = <T extends { actionId: string }>(left: T, right: T) =>
      left.actionId.localeCompare(right.actionId);
    assertEquals(
      resumedBatch.snapshot?.claims.toSorted(byActionId),
      [liveOne, liveTwo].toSorted(byActionId),
    );
    assertEquals(
      resumedBatch.events.some((event) =>
        eventActionId(event) === "action:stale"
      ),
      false,
    );
    assertEquals(secondMessages, []);

    const liveThree = await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:live-three", "computation"),
    );
    assertExists(liveThree);
    const effect = shiftMessage(secondMessages) as SessionEffectMessage;
    assertEquals(effect.type, "session/effect");
    assertEquals(effect.effect.execution?.fromFeedSeq, resumedBatch.toFeedSeq);
    assertEquals(
      effect.effect.execution?.toFeedSeq,
      resumedBatch.toFeedSeq + 1,
    );
    assertEquals(
      effect.effect.execution?.events.map(eventActionId),
      ["action:live-three"],
    );
    assertEquals(effect.effect.execution?.snapshot, undefined);
    assertEquals(secondMessages, []);
  } finally {
    second?.close();
    sponsor?.connection.close();
    first.close();
    await server.close();
  }
});

Deno.test("resume carries a successful settlement frontier evicted from the bounded suffix", async () => {
  const server = createServer("memory-v2-execution-feed-settlement-frontier", {
    maxExecutionEvents: 2,
  });
  const firstMessages: ServerMessage[] = [];
  const first = server.connect((message) => firstMessages.push(message));
  let sponsor: Awaited<ReturnType<typeof acquireSponsorLease>> | undefined;
  let second: ReturnType<Server["connect"]> | undefined;
  try {
    const firstAuth = await hello(first, firstMessages);
    const opened = await open(first, firstMessages, "open", firstAuth, {});
    assertExists(opened.ok?.sync?.execution);
    sponsor = await acquireSponsorLease(server);
    const acknowledgedFeedSeq = opened.ok.sync.execution.toFeedSeq;
    first.close();

    const live = await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:settled", "computation"),
    );
    assertExists(live);
    const settlement = {
      branch: "" as const,
      claim: live,
      inputBasisSeq: toInputBasisSeq(7),
      outcome: "no-op" as const,
    };
    assertEquals(server.publishActionSettlement(settlement), true);

    // Evict both the original claim.set and its settlement while leaving the
    // exact claim live. The reconnect snapshot must carry enough settlement
    // state to reconcile an overlay held by the disconnected client.
    const noise = await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:noise", "computation"),
    );
    assertExists(noise);
    assertEquals(server.revokeExecutionClaim(noise), true);

    const secondMessages: ServerMessage[] = [];
    second = server.connect((message) => secondMessages.push(message));
    const secondAuth = await hello(second, secondMessages);
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
    assertExists(resumed.ok?.sync?.execution?.snapshot);
    const resumedBatch = resumed.ok.sync.execution;
    const snapshot = resumedBatch.snapshot;
    assertExists(snapshot);
    assertEquals(snapshot.claims, [live]);
    assertEquals(
      snapshot.settlementFrontiers,
      [{
        branch: "",
        claim: live,
        inputBasisSeq: toInputBasisSeq(7),
        throughFeedSeq: acknowledgedFeedSeq + 2,
      }],
    );
    const frontier = snapshot.settlementFrontiers?.[0];
    assertExists(frontier);
    assertEquals(
      frontier.throughFeedSeq > acknowledgedFeedSeq,
      true,
    );
    assertEquals(
      frontier.throughFeedSeq < resumedBatch.toFeedSeq,
      true,
    );
    assertEquals(
      resumedBatch.events.some((event) =>
        event.type === "session.execution.settlement"
      ),
      false,
    );
  } finally {
    second?.close();
    sponsor?.connection.close();
    first.close();
    await server.close();
  }
});

Deno.test("C3.5 (C3A14/C3A15): the frontier coalescer merges vector bases per component and the resume snapshot carries the union", async () => {
  const server = createServer(
    "memory-v2-execution-feed-vector-frontier",
    { maxExecutionEvents: 2 },
  );
  const firstMessages: ServerMessage[] = [];
  const first = server.connect((message) => firstMessages.push(message));
  let sponsor: Awaited<ReturnType<typeof acquireSponsorLease>> | undefined;
  let second: ReturnType<Server["connect"]> | undefined;
  try {
    const firstAuth = await hello(first, firstMessages);
    const opened = await open(first, firstMessages, "open", firstAuth, {});
    assertExists(opened.ok?.sync?.execution);
    sponsor = await acquireSponsorLease(server);
    const acknowledgedFeedSeq = opened.ok.sync.execution.toFeedSeq;
    first.close();

    const live = await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:vector-settled", "computation"),
    );
    assertExists(live);
    const spaceB = "did:key:z6Mk-feed-vector-b";
    const spaceC = "did:key:z6Mk-feed-vector-c";
    // Two settlements of one incarnation with HETEROGENEOUS component
    // sets: the coalesced frontier must take the per-component maximum
    // and UNION the components (C3A15's vacuous rule — the second
    // settlement's missing C component does not erase the first's).
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim: live,
        inputBasisSeq: toInputBasisSeq(5),
        inputBasis: [
          { space: SPACE, seq: toInputBasisSeq(5) },
          { space: spaceB, seq: toInputBasisSeq(9) },
          { space: spaceC, seq: toInputBasisSeq(2) },
        ],
        outcome: "no-op",
      }),
      true,
    );
    assertEquals(
      server.publishActionSettlement({
        branch: "",
        claim: live,
        inputBasisSeq: toInputBasisSeq(7),
        inputBasis: [
          { space: SPACE, seq: toInputBasisSeq(7) },
          { space: spaceB, seq: toInputBasisSeq(4) },
        ],
        outcome: "no-op",
      }),
      true,
    );
    // Evict the retained events so the resume snapshot must rebuild from
    // the coalesced frontier (the C3A14 carrier under test).
    const noise = await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:vector-noise", "computation"),
    );
    assertExists(noise);
    assertEquals(server.revokeExecutionClaim(noise), true);

    const secondMessages: ServerMessage[] = [];
    second = server.connect((message) => secondMessages.push(message));
    const secondAuth = await hello(second, secondMessages);
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
    const snapshot = resumed.ok?.sync?.execution?.snapshot;
    assertExists(snapshot);
    const frontier = snapshot.settlementFrontiers?.[0];
    assertExists(frontier);
    // Scalar max + per-component max under the vacuous union, sorted by
    // space (home, then B/C by lexicographic order of the dids).
    assertEquals(frontier.inputBasisSeq, toInputBasisSeq(7));
    assertEquals(frontier.inputBasis, [
      { space: spaceB, seq: toInputBasisSeq(9) },
      { space: spaceC, seq: toInputBasisSeq(2) },
      { space: SPACE, seq: toInputBasisSeq(7) },
    ]);
  } finally {
    second?.close();
    sponsor?.connection.close();
    first.close();
    await server.close();
  }
});

Deno.test("server-primary resume rejects missing graduated execution subcapabilities", async () => {
  const server = createServer("memory-v2-execution-feed-resume-subcaps");
  const firstMessages: ServerMessage[] = [];
  const first = server.connect((message) => firstMessages.push(message));
  let sponsor: Awaited<ReturnType<typeof acquireSponsorLease>> | undefined;
  try {
    const firstAuth = await hello(first, firstMessages);
    const opened = await open(first, firstMessages, "open", firstAuth, {});
    assertExists(opened.ok);
    assertExists(opened.ok.sync?.execution);
    sponsor = await acquireSponsorLease(server);
    const acknowledgedFeedSeq = opened.ok.sync.execution.toFeedSeq;

    await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:computation", "computation"),
    );
    await server.setExecutionClaim(
      sponsor.lease,
      claimInput("action:builtin", "effect"),
    );
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
      assertEquals(resumed.ok, undefined);
      assertEquals(resumed.error?.name, "ProtocolError");
      assertEquals(
        resumed.error?.message.includes("builtin-passivity-v1"),
        true,
      );
      assertEquals(secondMessages, []);
    } finally {
      second.close();
    }
  } finally {
    sponsor?.connection.close();
    first.close();
    await server.close();
  }
});
