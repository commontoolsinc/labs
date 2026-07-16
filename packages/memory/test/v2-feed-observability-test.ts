// F1 feed observability: claim-coverage counters and per-wave traversal
// attribution are additive counters only — these tests pin that they count
// without changing delivery behavior or wire shapes.
import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  type ActionClaimKey,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
} from "../v2.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message);
  return message;
};

const assertResponse = <Result>(
  message: ServerMessage,
): ResponseMessage<Result> => {
  assertEquals(message.type, "response");
  return message as ResponseMessage<Result>;
};

const assertEffect = (message: ServerMessage): SessionEffectMessage => {
  assertEquals(message.type, "session/effect");
  return message as SessionEffectMessage;
};

const expectHelloOk = (messages: ServerMessage[]): SessionOpenAuthMetadata => {
  const hello = shiftMessage(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return hello.sessionOpen;
};

const authInvocation = (sessionOpen: SessionOpenAuthMetadata) => ({
  aud: sessionOpen.audience,
  challenge: sessionOpen.challenge.value,
});

const COVERAGE_SPACE = "did:key:z6Mk-feed-coverage";

const coverageClaimKey = (
  overrides: Partial<ActionClaimKey> = {},
): ActionClaimKey => ({
  branch: "",
  space: COVERAGE_SPACE,
  contextKey: "space",
  pieceId: "piece:coverage",
  actionId: "action:coverage",
  actionKind: "computation",
  implementationFingerprint: "impl-default",
  runtimeFingerprint: "rt-default",
  ...overrides,
});

Deno.test("candidate coverage counters attribute served and unserved candidates", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-feed-coverage"),
  });
  try {
    // Served candidates count per space.
    server.recordExecutionCandidateClaimReady(coverageClaimKey());
    server.recordExecutionCandidateClaimReady(
      coverageClaimKey({ actionId: "action:coverage-2" }),
    );

    // Unserved candidates count per diagnostic code, and distinct offenders
    // dedupe on the implementation fingerprint: three occurrences of a code
    // from two implementations must read as ×3 with 2 offenders.
    server.recordExecutionCandidateUnserved({
      diagnosticCode: "static-read-outside-space",
      claimKey: coverageClaimKey({
        actionId: "wish-1",
        implementationFingerprint: "impl-wish",
      }),
    });
    server.recordExecutionCandidateUnserved({
      diagnosticCode: "static-read-outside-space",
      claimKey: coverageClaimKey({
        actionId: "wish-2",
        implementationFingerprint: "impl-wish",
      }),
    });
    server.recordExecutionCandidateUnserved({
      diagnosticCode: "static-read-outside-space",
      claimKey: coverageClaimKey({
        actionId: "wish-3",
        implementationFingerprint: "impl-wish-b",
      }),
    });
    // Diagnostics can arrive without any claim key (malformed observations);
    // they must still count instead of being dropped.
    server.recordExecutionCandidateUnserved({
      diagnosticCode: "malformed-action-observation",
    });

    assertEquals(server.executionStats.candidateClaimReadyBySpace, {
      [COVERAGE_SPACE]: 2,
    });
    assertEquals(server.executionStats.candidateUnservedByCode, {
      "static-read-outside-space": 3,
      "malformed-action-observation": 1,
    });
    assertEquals(server.executionStats.candidateUnservedOffendersByCode, {
      "static-read-outside-space": 2,
      "malformed-action-observation": 1,
    });
    assertEquals(server.executionStats.candidateUnservedBySpace, {
      [COVERAGE_SPACE]: 3,
      unknown: 1,
    });
  } finally {
    await server.close();
  }
});

Deno.test("refresh waves and graph queries attribute traversal work by operation", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-feed-traversal"),
    subscriptionRefreshDelayMs: 0,
  });
  const writerMessages: ServerMessage[] = [];
  const watcherMessages: ServerMessage[] = [];
  const writer = server.connect((message) => writerMessages.push(message));
  const watcher = server.connect((message) => watcherMessages.push(message));
  const space = "did:key:z6Mk-feed-traversal";

  try {
    for (const connection of [writer, watcher]) {
      await connection.receive(encodeMemoryBoundary(HELLO));
    }
    const writerSessionOpen = expectHelloOk(writerMessages);
    const watcherSessionOpen = expectHelloOk(watcherMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerOpen = assertResponse<{ sessionId: string }>(
      shiftMessage(writerMessages),
    );
    await watcher.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "watcher-open",
      space,
      session: {},
      invocation: authInvocation(watcherSessionOpen),
    }));
    const watcherOpen = assertResponse<{ sessionId: string }>(
      shiftMessage(watcherMessages),
    );
    const writerSessionId = writerOpen.ok!.sessionId;
    const watcherSessionId = watcherOpen.ok!.sessionId;

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
          value: { value: { hello: "world" } },
        }],
      },
    }));
    assertExists(assertResponse(shiftMessage(writerMessages)).ok);

    await watcher.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId: watcherSessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: { path: [], schema: false },
          }],
        },
      }],
    }));
    assertExists(assertResponse(shiftMessage(watcherMessages)).ok);

    // Registering the watch set evaluates the graph under the
    // "session.watch.set" operation.
    const watchSetBucket = server.feedStats
      .traversalByOperation["session.watch.set"];
    assertExists(watchSetBucket);
    assertEquals(watchSetBucket.calls >= 1, true);
    assertEquals(watchSetBucket.managerReads >= 1, true);

    // Let any refresh wave scheduled by tx-1 drain, then measure exactly one
    // commit wave as deltas.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = {
      waves: server.feedStats.refreshWaves,
      sessionsTouched: server.feedStats.refreshSessionsTouched,
      graphsRefreshed: server.feedStats.refreshGraphsRefreshed,
      upsertsPushed: server.feedStats.refreshUpsertsPushed,
      refreshCalls: server.feedStats
        .traversalByOperation["session.watch.refresh"]?.calls ?? 0,
    };

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
          id: "of:doc:1",
          value: { value: { hello: "again" } },
        }],
      },
    }));
    assertExists(assertResponse(shiftMessage(writerMessages)).ok);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const effect = assertEffect(shiftMessage(watcherMessages));
    assertEquals(effect.effect.type, "sync");
    assertEquals(effect.effect.upserts.length, 1);

    // One wave: only the watcher session intersects the dirty set, one graph
    // re-traverses, one upsert crosses the wire.
    assertEquals(server.feedStats.refreshWaves, before.waves + 1);
    assertEquals(
      server.feedStats.refreshSessionsTouched,
      before.sessionsTouched + 1,
    );
    assertEquals(
      server.feedStats.refreshGraphsRefreshed,
      before.graphsRefreshed + 1,
    );
    assertEquals(
      server.feedStats.refreshUpsertsPushed,
      before.upsertsPushed + 1,
    );
    const refreshBucket = server.feedStats
      .traversalByOperation["session.watch.refresh"];
    assertExists(refreshBucket);
    assertEquals(refreshBucket.calls, before.refreshCalls + 1);
    assertEquals(refreshBucket.managerReads >= 1, true);

    // graph.query attribution: the executor Worker's per-wave refresh lands
    // here; the response wire shape must stay exactly { serverSeq, entities }.
    const graphQueryCallsBefore =
      server.feedStats.traversalByOperation["graph.query"]?.calls ?? 0;
    await watcher.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-1",
      space,
      sessionId: watcherSessionId,
      query: {
        roots: [{
          id: "of:doc:1",
          selector: { path: [], schema: false },
        }],
      },
    }));
    const queryResponse = assertResponse<GraphQueryResult>(
      shiftMessage(watcherMessages),
    );
    assertExists(queryResponse.ok);
    assertEquals(queryResponse.ok.entities.length, 1);
    assertEquals("stats" in queryResponse.ok, false);
    const graphQueryBucket = server.feedStats
      .traversalByOperation["graph.query"];
    assertExists(graphQueryBucket);
    assertEquals(graphQueryBucket.calls, graphQueryCallsBefore + 1);
  } finally {
    await server.close();
  }
});
