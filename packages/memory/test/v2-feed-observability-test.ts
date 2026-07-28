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
    // P1 §5c floor-less timing: every bucket carries wall time regardless of
    // the 100ms slow-query floor.
    assertEquals(watchSetBucket.totalMs > 0, true);
    assertEquals(watchSetBucket.maxMs > 0, true);

    // P1 §5c serving gauge: the tracked surface the sampler polls.
    const gauge = server.trackedGraphGauge();
    assertEquals(gauge.sessions >= 1, true);
    assertEquals(gauge.graphs >= 1, true);
    assertEquals(gauge.trackerKeys >= 1, true);

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
      refreshTotalMs: server.feedStats
        .traversalByOperation["session.watch.refresh"]?.totalMs ?? 0,
      transactAcks: server.feedStats.transactAcks,
      transactAckTotalMs: server.feedStats.transactAckTotalMs,
      waveFanoutMs: server.feedStats.waveFanoutMs,
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
    // P1 §5c: the wave's traversal carried wall time (floor-less), the
    // accepted transact recorded its receive→ack leg, and the wave recorded
    // its fanout leg.
    assertEquals(refreshBucket.totalMs > before.refreshTotalMs, true);
    assertEquals(refreshBucket.maxMs > 0, true);
    assertEquals(server.feedStats.transactAcks, before.transactAcks + 1);
    assertEquals(
      server.feedStats.transactAckTotalMs > before.transactAckTotalMs,
      true,
    );
    assertEquals(server.feedStats.transactAckMaxMs > 0, true);
    assertEquals(server.feedStats.waveFanoutMs > before.waveFanoutMs, true);
    assertEquals(server.feedStats.waveDrainWaitMs >= 0, true);

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

// FA5/FB12: the graph.query bucket splits by trigger attribution. The wire
// message carries an OPTIONAL `trigger` ("wave" | "demand"); the server keeps
// the aggregate "graph.query" bucket byte-identical for existing consumers and
// ADDITIONALLY records the split under "graph.query.wave" /
// "graph.query.demand" — additive Record keys, so /api/health/stats consumers
// (z.record) need no schema change. Untriggered queries land in the aggregate
// only: the split buckets never guess.
Deno.test("graph.query trigger attribution splits wave vs demand buckets additively", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-feed-trigger-split"),
    subscriptionRefreshDelayMs: 0,
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-feed-trigger-split";

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
    const open = assertResponse<{ sessionId: string }>(shiftMessage(messages));
    const sessionId = open.ok!.sessionId;

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
          value: { value: { hello: "split" } },
        }],
      },
    }));
    assertExists(assertResponse(shiftMessage(messages)).ok);

    const query = {
      roots: [{
        id: "of:doc:1",
        selector: { path: [], schema: false },
      }],
    };
    const bucket = (operation: string) =>
      server.feedStats.traversalByOperation[operation];
    const calls = (operation: string) => bucket(operation)?.calls ?? 0;

    // Demand-triggered (first-demand cold pull / new-doc closure growth).
    const aggregateBefore = calls("graph.query");
    await connection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-demand",
      space,
      sessionId,
      trigger: "demand",
      query,
    }));
    const demandResponse = assertResponse<GraphQueryResult>(
      shiftMessage(messages),
    );
    assertExists(demandResponse.ok);
    assertEquals("stats" in demandResponse.ok, false);
    assertEquals(calls("graph.query"), aggregateBefore + 1);
    assertEquals(calls("graph.query.demand"), 1);
    assertEquals(calls("graph.query.wave"), 0);
    // The split bucket carries the same traversal attribution as the
    // aggregate, not just a call count.
    assertEquals(
      bucket("graph.query.demand")!.managerReads >= 1,
      true,
    );

    // Wave-triggered (rehydrate/wake refresh forced by an accepted-commit
    // wave).
    await connection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-wave",
      space,
      sessionId,
      trigger: "wave",
      query,
    }));
    assertExists(assertResponse<GraphQueryResult>(shiftMessage(messages)).ok);
    assertEquals(calls("graph.query"), aggregateBefore + 2);
    assertEquals(calls("graph.query.demand"), 1);
    assertEquals(calls("graph.query.wave"), 1);

    // Untriggered: aggregate only — compatibility for callers that predate
    // the split (and honesty: unknown cause is not a bucket).
    await connection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-untriggered",
      space,
      sessionId,
      query,
    }));
    assertExists(assertResponse<GraphQueryResult>(shiftMessage(messages)).ok);
    assertEquals(calls("graph.query"), aggregateBefore + 3);
    assertEquals(calls("graph.query.demand"), 1);
    assertEquals(calls("graph.query.wave"), 1);

    // A malformed trigger value is dropped by the parser (treated as
    // untriggered), never trusted into a bucket key.
    await connection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-malformed",
      space,
      sessionId,
      trigger: "surprise",
      query,
    }));
    assertExists(assertResponse<GraphQueryResult>(shiftMessage(messages)).ok);
    assertEquals(calls("graph.query"), aggregateBefore + 4);
    assertEquals(calls("graph.query.demand"), 1);
    assertEquals(calls("graph.query.wave"), 1);
    assertEquals(bucket("graph.query.surprise"), undefined);
  } finally {
    await server.close();
  }
});

// P1 covered growth pulls (client-passivity §0 step 1): a graph.query that
// opts in with `omitWatchCovered` returns only docs the session's tracked
// watch surface does NOT already cover — covered (docKey, selector) pairs
// skip re-traversal (counted as coveredSelectorSkips) and their snapshots
// are omitted (the wave path owns their delivery). Without the flag, or on
// a session with no tracked graph, the reply is byte-identical legacy.
Deno.test("graph.query omitWatchCovered returns only the uncovered delta for a watching session", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-covered-pull"),
    subscriptionRefreshDelayMs: 0,
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-covered-pull";
  const link = (id: string) => ({
    "/": { "link@1": { id, path: [], space } },
  });

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
    const open = assertResponse<{ sessionId: string }>(shiftMessage(messages));
    const sessionId = open.ok!.sessionId;

    // child ← linked from BOTH the watched root and the separate query root.
    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:covered-child",
            value: { value: { label: "shared child" } },
          },
          {
            op: "set",
            id: "of:covered-root",
            value: { value: { items: [link("of:covered-child")] } },
          },
          {
            op: "set",
            id: "of:uncovered-root",
            value: { value: { items: [link("of:covered-child")] } },
          },
        ],
      },
    }));
    assertExists(assertResponse(shiftMessage(messages)).ok);

    // Track the covered root: the session's watch surface now covers the
    // root AND the linked child under the schema-true selector.
    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "covered-root-watch",
        kind: "graph",
        query: {
          roots: [{
            id: "of:covered-root",
            selector: { path: [], schema: true },
          }],
        },
      }],
    }));
    assertExists(assertResponse(shiftMessage(messages)).ok);

    const query = {
      roots: [{
        id: "of:uncovered-root",
        selector: { path: [], schema: true },
      }],
    };
    const skipsBefore = server.feedStats
      .traversalByOperation["graph.query"]?.coveredSelectorSkips ?? 0;

    // Covered pull: the uncovered query root returns; the child — covered
    // by the live watch surface — is skipped and omitted.
    await connection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-covered",
      space,
      sessionId,
      omitWatchCovered: true,
      query,
    }));
    const covered = assertResponse<GraphQueryResult>(shiftMessage(messages));
    assertExists(covered.ok);
    assertEquals(
      covered.ok.entities.map((entity) => entity.id).toSorted(),
      ["of:uncovered-root"],
    );
    const skipsAfter = server.feedStats
      .traversalByOperation["graph.query"]?.coveredSelectorSkips ?? 0;
    assertEquals(skipsAfter > skipsBefore, true);

    // Legacy shape without the flag: full closure.
    await connection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-full",
      space,
      sessionId,
      query,
    }));
    const full = assertResponse<GraphQueryResult>(shiftMessage(messages));
    assertExists(full.ok);
    assertEquals(
      full.ok.entities.map((entity) => entity.id).toSorted(),
      ["of:covered-child", "of:uncovered-root"],
    );

    // A session with no tracked graph replies in full even with the flag
    // (fresh connection: session.open challenges are per-connection).
    const freshMessages: ServerMessage[] = [];
    const freshConnection = server.connect((message) =>
      freshMessages.push(message)
    );
    await freshConnection.receive(encodeMemoryBoundary(HELLO));
    const freshOpenAuth = expectHelloOk(freshMessages);
    await freshConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-fresh",
      space,
      session: {},
      invocation: authInvocation(freshOpenAuth),
    }));
    const fresh = assertResponse<{ sessionId: string }>(
      shiftMessage(freshMessages),
    );
    await freshConnection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-fresh",
      space,
      sessionId: fresh.ok!.sessionId,
      omitWatchCovered: true,
      query,
    }));
    const freshReply = assertResponse<GraphQueryResult>(
      shiftMessage(freshMessages),
    );
    assertExists(freshReply.ok);
    assertEquals(
      freshReply.ok.entities.map((entity) => entity.id).toSorted(),
      ["of:covered-child", "of:uncovered-root"],
    );
  } finally {
    await server.close();
  }
});
