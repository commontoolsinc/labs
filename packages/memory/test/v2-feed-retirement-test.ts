import { assert, assertEquals, assertExists } from "@std/assert";
import {
  applyServerPrimaryExecutionGraphRetirementEnvConfig,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resetServerPrimaryExecutionGraphRetirementConfig,
  type ResponseMessage,
  SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES_ENV,
  type ServerMessage,
  serverPrimaryExecutionGraphRetirementAdmits,
  type SessionEffectMessage,
  type SessionSync,
  setServerPrimaryExecutionGraphRetirementConfig,
} from "../v2.ts";
import { Server } from "../v2/server.ts";

// --- F5 (FW5 redesign after FB9): retire per-session schema-graph
// re-evaluation where the watch surface is doc-set. The per-space dial's
// behavioral authority is DOC-SET ADMISSION: a space it does not name
// rejects `docs`-kind registration with a clean ProtocolError (the runner's
// reconcile catches it and keeps its graph watches), so a withheld space
// genuinely stays on graph behavior (OQ4). For admitted spaces the
// zero-traversal property of a fully-demoted surface is structural (F3
// grouping exclusion + F4b client demotion); the refresh loop classifies the
// surface PER WATCH (FA3/FA13): residual graph watches fail open (still
// traversed — never a delivery gap), counted as held vs actually-traversed
// (FB28) with per-space DAG attribution (FB11 budget). The watermark stays
// one emission per session per wave (FA1); conflict catch-up survives
// retirement (FA7). ---

const TEST_AUDIENCE = "did:key:z6Mk-feed-retirement-audience";
const SPONSOR = "did:key:z6Mk-feed-retirement-sponsor";

// The server advertises the doc-set subcapability; the client HELLO negotiates
// it too. Both are folded above the base server-primary-execution flag.
const DOCSET_SERVER_FLAGS = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionDocSetWatchV1: true,
} as const;

const DOCSET_HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: {
    ...getMemoryProtocolFlags(),
    ...DOCSET_SERVER_FLAGS,
  },
} as const;

const createServer = (store: string): Server =>
  new Server(
    {
      store: new URL(store),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : SPONSOR;
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
      protocolFlags: { ...DOCSET_SERVER_FLAGS },
    } as unknown as ConstructorParameters<typeof Server>[0],
  );

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const drainEffects = (
  messages: ServerMessage[],
): (SessionEffectMessage & { effect: SessionSync })[] => {
  const effects: (SessionEffectMessage & { effect: SessionSync })[] = [];
  while (messages.length > 0) {
    const message = shiftMessage(messages);
    if (message.type === "session/effect") {
      effects.push(message as SessionEffectMessage & { effect: SessionSync });
    }
  }
  return effects;
};

type Harness = {
  server: Server;
  connection: ReturnType<Server["connect"]>;
  messages: ServerMessage[];
  sessionId: string;
};

const openSession = async (
  server: Server,
  space: string,
): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(DOCSET_HELLO));
  const hello = shiftMessage(messages);
  assertEquals(hello.type, "hello.ok");
  const sessionOpen = (hello as { sessionOpen?: unknown }).sessionOpen as {
    audience: string;
    challenge: { value: string };
  };
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "open-1",
    space,
    session: {},
    invocation: {
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
    authorization: { principal: SPONSOR },
  }));
  const opened = shiftMessage(messages) as ResponseMessage<
    { sessionId: string }
  >;
  const sessionId = opened.ok!.sessionId;
  return { server, connection, messages, sessionId };
};

const docsWatchSet = (
  harness: Harness,
  space: string,
  requestId: string,
  watches: unknown[],
) =>
  harness.connection.receive(encodeMemoryBoundary({
    type: "session.watch.set",
    requestId,
    space,
    sessionId: harness.sessionId,
    watches,
  }));

const transact = (
  harness: Harness,
  space: string,
  requestId: string,
  commit: unknown,
) =>
  harness.connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId,
    space,
    sessionId: harness.sessionId,
    commit,
  }));

Deno.test("F5: a fully-doc-set eligible session retires its graph refresh and is counted (FA13)", async () => {
  const space = "did:key:z6Mk-feed-retire-fully";
  const server = createServer("memory://feed-retire-fully");
  setServerPrimaryExecutionGraphRetirementConfig([space]);
  const watcher = await openSession(server, space);
  const writerHarness = await openSession(server, space);
  try {
    // A watch surface that is ENTIRELY doc-set membership: no graph watch.
    await docsWatchSet(watcher, space, "w", [
      { id: "docs", kind: "docs", docs: [{ id: "of:member" }] },
    ]);
    drainEffects(watcher.messages);
    // Discard the registration response.
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    const before = {
      eligible: server.feedStats.refreshRetirementEligibleSessions,
      fully: server.feedStats.refreshFullyDocSetSessions,
      residual: server.feedStats.refreshResidualGraphWatches,
      residualTraversed: server.feedStats.refreshResidualGraphWatchesTraversed,
      graphs: server.feedStats.refreshGraphsRefreshed,
    };

    // Another session commits the member doc — the wave fans out to the
    // watcher as a point read; the graph refresh path must never run.
    await transact(writerHarness, space, "seed", {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:member", value: { value: "v1" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }
    await server.flushSessions([space]);

    // The watcher received exactly its member as a point read.
    const effects = drainEffects(watcher.messages);
    assertEquals(effects.length, 1);
    assertEquals(effects[0].effect.upserts.map((u) => u.id), ["of:member"]);

    // Retirement fired and was counted: eligible + fully-doc-set, zero
    // residual graph watches, and refreshTrackedGraph never ran.
    assertEquals(
      server.feedStats.refreshRetirementEligibleSessions - before.eligible,
      1,
    );
    assertEquals(
      server.feedStats.refreshFullyDocSetSessions - before.fully,
      1,
    );
    assertEquals(
      server.feedStats.refreshResidualGraphWatches - before.residual,
      0,
    );
    assertEquals(
      server.feedStats.refreshResidualGraphWatchesTraversed -
        before.residualTraversed,
      0,
    );
    assertEquals(server.feedStats.refreshGraphsRefreshed - before.graphs, 0);
    assertEquals(
      server.feedStats.traversalByOperation["session.watch.refresh"],
      undefined,
    );
    // FB11 budget: a fully-doc-set surface attributes ZERO residual DAG
    // traversal to its space.
    assertEquals(
      server.feedStats.refreshResidualDagTraversalsBySpace[space],
      undefined,
    );
  } finally {
    await watcher.connection.close();
    await writerHarness.connection.close();
    await server.close();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
});

// FB9: the dial's behavioral authority lives at DOC-SET ADMISSION. A space
// withheld from the dial rejects the F4b demotion `watch.set` with the same
// clean ProtocolError shape a non-negotiating server gives (the runner's
// reconcile catches it, keeps its graph watches, and retries later), so the
// space genuinely STAYS on graph behavior — the OQ4 rollout property the
// pre-FW5 predicate only pretended to have. The second half is the honesty
// control: flipping the dial ON admits the same demotion and the very next
// wave runs zero graph-refresh traversal.
Deno.test("FB9: a space withheld from the dial rejects doc-set demotion and stays on graph behavior (OQ4)", async () => {
  const space = "did:key:z6Mk-feed-retire-withheld";
  const server = createServer("memory://feed-retire-withheld");
  // Dial ABSENT for this space (absent-false) — admission must stay closed.
  const watcher = await openSession(server, space);
  const writerHarness = await openSession(server, space);
  try {
    // The boot surface: a subscribing schema-graph watch over the root.
    await docsWatchSet(watcher, space, "boot", [
      {
        id: "boot",
        kind: "graph",
        query: {
          roots: [{ id: "of:member", selector: { path: [], schema: false } }],
        },
      },
    ]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    // The F4b demotion attempt: replace the graph watch with a docs watch.
    // The dial does not admit this space, so the server must reject it —
    // typed, clean, before any watch or member mutation.
    await docsWatchSet(watcher, space, "demote", [
      { id: "docs", kind: "docs", docs: [{ id: "of:member" }] },
    ]);
    const rejection = shiftMessage(watcher.messages) as ResponseMessage<
      unknown
    >;
    assertEquals(rejection.error?.name, "ProtocolError");
    assert(
      String(rejection.error?.message).includes(
        "serverPrimaryExecutionGraphRetirement",
      ),
      "the rejection names the dial so an operator can find the lever",
    );

    const before = {
      eligible: server.feedStats.refreshRetirementEligibleSessions,
      graphs: server.feedStats.refreshGraphsRefreshed,
    };

    // A wave dirtying the root: the session was HELD on graph behavior, so
    // delivery arrives via the graph refresh — real traversal, not fan-out.
    await transact(writerHarness, space, "seed", {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:member", value: { value: "v1" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }
    await server.flushSessions([space]);

    const effects = drainEffects(watcher.messages);
    assertEquals(effects.length, 1);
    assertEquals(effects[0].effect.upserts.map((u) => u.id), ["of:member"]);
    assertEquals(server.feedStats.refreshGraphsRefreshed - before.graphs, 1);
    assertExists(
      server.feedStats.traversalByOperation["session.watch.refresh"],
    );
    // No members were admitted, so the session is not doc-set eligible.
    assertEquals(
      server.feedStats.refreshRetirementEligibleSessions - before.eligible,
      0,
    );

    // Honesty control: ADD the space to the dial — the same demotion is now
    // admitted, and the next wave delivers as a zero-traversal point read.
    setServerPrimaryExecutionGraphRetirementConfig([space]);
    await docsWatchSet(watcher, space, "demote-2", [
      { id: "docs", kind: "docs", docs: [{ id: "of:member" }] },
    ]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    const dialed = {
      graphs: server.feedStats.refreshGraphsRefreshed,
      fully: server.feedStats.refreshFullyDocSetSessions,
      refresh: server.feedStats.traversalByOperation["session.watch.refresh"]
        .dagTraversals,
    };
    await transact(writerHarness, space, "bump", {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:member", value: { value: "v2" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }
    await server.flushSessions([space]);

    const demoted = drainEffects(watcher.messages);
    assertEquals(demoted.length, 1);
    assertEquals(demoted[0].effect.upserts.map((u) => u.id), ["of:member"]);
    assertEquals(server.feedStats.refreshGraphsRefreshed - dialed.graphs, 0);
    assertEquals(
      server.feedStats.traversalByOperation["session.watch.refresh"]
        .dagTraversals - dialed.refresh,
      0,
    );
    assertEquals(server.feedStats.refreshFullyDocSetSessions - dialed.fully, 1);
  } finally {
    await watcher.connection.close();
    await writerHarness.connection.close();
    await server.close();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
});

Deno.test("F5: a mixed surface fails open — residual graph watch traverses and is counted (FA3)", async () => {
  const space = "did:key:z6Mk-feed-retire-mixed";
  const server = createServer("memory://feed-retire-mixed");
  setServerPrimaryExecutionGraphRetirementConfig([space]);
  const watcher = await openSession(server, space);
  const writerHarness = await openSession(server, space);
  try {
    // BOTH a doc-set member (of:member) AND a residual graph watch (of:graph).
    await docsWatchSet(watcher, space, "w", [
      { id: "docs", kind: "docs", docs: [{ id: "of:member" }] },
      {
        id: "graph",
        kind: "graph",
        query: {
          roots: [{ id: "of:graph", selector: { path: [], schema: false } }],
        },
      },
    ]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    const before = {
      eligible: server.feedStats.refreshRetirementEligibleSessions,
      fully: server.feedStats.refreshFullyDocSetSessions,
      residual: server.feedStats.refreshResidualGraphWatches,
      residualTraversed: server.feedStats.refreshResidualGraphWatchesTraversed,
      refreshDag: server.feedStats.traversalByOperation["session.watch.refresh"]
        ?.dagTraversals ?? 0,
      bySpace: server.feedStats.refreshResidualDagTraversalsBySpace[space] ?? 0,
    };

    // One wave dirties both surfaces.
    await transact(writerHarness, space, "seed", {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:member", value: { value: "m1" } },
        { op: "set", id: "of:graph", value: { value: "g1" } },
      ],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }
    await server.flushSessions([space]);

    // FA1: one emission carries BOTH surfaces at one watermark.
    const effects = drainEffects(watcher.messages);
    assertEquals(effects.length, 1);
    assertEquals(
      effects[0].effect.upserts.map((u) => u.id).toSorted(),
      ["of:graph", "of:member"],
    );

    // Eligible (has members), but NOT fully doc-set: the residual graph watch
    // failed open (still traversed) and was counted as a regression — both as
    // held surface composition and as actually-forced traversal (FB28).
    assertEquals(
      server.feedStats.refreshRetirementEligibleSessions - before.eligible,
      1,
    );
    assertEquals(server.feedStats.refreshFullyDocSetSessions - before.fully, 0);
    assertEquals(
      server.feedStats.refreshResidualGraphWatches - before.residual,
      1,
    );
    assertEquals(
      server.feedStats.refreshResidualGraphWatchesTraversed -
        before.residualTraversed,
      1,
    );
    assertExists(
      server.feedStats.traversalByOperation["session.watch.refresh"],
    );
    // FB11 budget attribution: the residual refresh's DAG work lands on this
    // space's bucket, and equals the session.watch.refresh operation delta —
    // per-space, per-cause (member point reads never land here).
    assertEquals(
      (server.feedStats.refreshResidualDagTraversalsBySpace[space] ?? 0) -
        before.bySpace,
      server.feedStats.traversalByOperation["session.watch.refresh"]
        .dagTraversals - before.refreshDag,
    );
  } finally {
    await watcher.connection.close();
    await writerHarness.connection.close();
    await server.close();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
});

// FB28: the residual gauge classifies the surface PER WATCH (FA3), not per
// branch-grouped graph state. Two residual graph watches sharing one branch
// must count as 2, and a wave that dirties only the doc-set member must not
// count any residual traversal (the idle graph watch traversed nothing).
Deno.test("FB28: residual classification is per watch, and traversal is counted only when it happened", async () => {
  const space = "did:key:z6Mk-feed-retire-perwatch";
  const server = createServer("memory://feed-retire-perwatch");
  setServerPrimaryExecutionGraphRetirementConfig([space]);
  const watcher = await openSession(server, space);
  const writerHarness = await openSession(server, space);
  try {
    // One doc-set member plus TWO graph watches on the SAME (default) branch:
    // branch-grouping folds them into one graph state, but the surface holds
    // two residual watches.
    await docsWatchSet(watcher, space, "w", [
      { id: "docs", kind: "docs", docs: [{ id: "of:member" }] },
      {
        id: "graph-1",
        kind: "graph",
        query: {
          roots: [{ id: "of:g1", selector: { path: [], schema: false } }],
        },
      },
      {
        id: "graph-2",
        kind: "graph",
        query: {
          roots: [{ id: "of:g2", selector: { path: [], schema: false } }],
        },
      },
    ]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    const before = {
      residual: server.feedStats.refreshResidualGraphWatches,
      residualTraversed: server.feedStats.refreshResidualGraphWatchesTraversed,
      bySpace: server.feedStats.refreshResidualDagTraversalsBySpace[space] ?? 0,
      graphs: server.feedStats.refreshGraphsRefreshed,
    };

    // Wave A dirties ONLY the member: the graph watches are held (counted as
    // residual surface) but traverse nothing.
    await transact(writerHarness, space, "member-only", {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:member", value: { value: "m1" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }
    await server.flushSessions([space]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    // Per-watch classification: TWO residual watches held, not one branch
    // group; the idle wave refreshed no graph, forced no residual traversal,
    // and attributed no DAG work to the space (FB28 — the old gauge counted
    // this wave as "still traversed").
    assertEquals(
      server.feedStats.refreshResidualGraphWatches - before.residual,
      2,
    );
    assertEquals(
      server.feedStats.refreshResidualGraphWatchesTraversed -
        before.residualTraversed,
      0,
    );
    assertEquals(
      (server.feedStats.refreshResidualDagTraversalsBySpace[space] ?? 0) -
        before.bySpace,
      0,
    );
    assertEquals(server.feedStats.refreshGraphsRefreshed - before.graphs, 0);

    // Wave B dirties a graph root: the branch group re-traverses, serving
    // both residual watches.
    const beforeB = {
      residual: server.feedStats.refreshResidualGraphWatches,
      residualTraversed: server.feedStats.refreshResidualGraphWatchesTraversed,
      bySpace: server.feedStats.refreshResidualDagTraversalsBySpace[space] ?? 0,
      refreshDag: server.feedStats.traversalByOperation["session.watch.refresh"]
        ?.dagTraversals ?? 0,
      graphs: server.feedStats.refreshGraphsRefreshed,
    };
    await transact(writerHarness, space, "graph-root", {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:g1", value: { value: "g1" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }
    await server.flushSessions([space]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    assertEquals(
      server.feedStats.refreshResidualGraphWatches - beforeB.residual,
      2,
    );
    // BOTH residual watches were served by the one branch-group traversal.
    assertEquals(
      server.feedStats.refreshResidualGraphWatchesTraversed -
        beforeB.residualTraversed,
      2,
    );
    assertEquals(server.feedStats.refreshGraphsRefreshed - beforeB.graphs, 1);
    // The wave's residual DAG work is attributed to this space (FB11).
    assertEquals(
      (server.feedStats.refreshResidualDagTraversalsBySpace[space] ?? 0) -
        beforeB.bySpace,
      server.feedStats.traversalByOperation["session.watch.refresh"]
        .dagTraversals - beforeB.refreshDag,
    );
  } finally {
    await watcher.connection.close();
    await writerHarness.connection.close();
    await server.close();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
});

Deno.test("F5/FA7: a conflicted commit on a fully-doc-set session still releases caughtUpLocalSeq (member conflict)", async () => {
  const space = "did:key:z6Mk-feed-retire-conflict-member";
  const server = createServer("memory://feed-retire-conflict-member");
  setServerPrimaryExecutionGraphRetirementConfig([space]);
  const watcher = await openSession(server, space);
  const writerHarness = await openSession(server, space);
  try {
    await docsWatchSet(watcher, space, "w", [
      { id: "docs", kind: "docs", docs: [{ id: "of:member" }] },
    ]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    // Seed of:member at seq 1 (from the writer session).
    await transact(writerHarness, space, "seed", {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:member", value: { value: "v1" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }
    await server.flushSessions([space]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    // The writer bumps of:member to seq 2.
    await transact(writerHarness, space, "bump", {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:member", value: { value: "v2" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }

    // The WATCHER commits against a stale read of of:member (seq 1) — a
    // ConflictError that stages pendingCaughtUpLocalSeq + the member as dirty.
    await transact(watcher, space, "conflict", {
      localSeq: 7,
      reads: {
        confirmed: [{ id: "of:member", path: [], seq: 1 }],
        pending: [],
      },
      operations: [{ op: "set", id: "of:member", value: { value: "v3" } }],
    });
    const rejected = shiftMessage(watcher.messages) as ResponseMessage<unknown>;
    assertEquals(rejected.error?.name, "ConflictError");

    await server.flushSessions([space]);

    // The release survives retirement: the catch-up carries caughtUpLocalSeq
    // WITH the point-read delivery of the conflicted member (now v2).
    const effects = drainEffects(watcher.messages);
    assertEquals(effects.length, 1);
    assertEquals(effects[0].effect.caughtUpLocalSeq, 7);
    assertEquals(effects[0].effect.upserts.map((u) => u.id), ["of:member"]);
  } finally {
    await watcher.connection.close();
    await writerHarness.connection.close();
    await server.close();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
});

Deno.test("F5/FA7: a non-member conflict on a fully-doc-set session still releases caughtUpLocalSeq (empty catch-up)", async () => {
  const space = "did:key:z6Mk-feed-retire-conflict-nonmember";
  const server = createServer("memory://feed-retire-conflict-nonmember");
  setServerPrimaryExecutionGraphRetirementConfig([space]);
  const watcher = await openSession(server, space);
  const writerHarness = await openSession(server, space);
  try {
    // The watcher tracks ONLY of:member — of:other is never in its surface.
    await docsWatchSet(watcher, space, "w", [
      { id: "docs", kind: "docs", docs: [{ id: "of:member" }] },
    ]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    await transact(writerHarness, space, "seed", {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:other", value: { value: "v1" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }
    await transact(writerHarness, space, "bump", {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:other", value: { value: "v2" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }

    // The watcher conflicts on of:other (NOT a member) — the dirty set never
    // intersects its tracked surface, so it takes the empty-catch-up path.
    await transact(watcher, space, "conflict", {
      localSeq: 9,
      reads: { confirmed: [{ id: "of:other", path: [], seq: 1 }], pending: [] },
      operations: [{ op: "set", id: "of:other", value: { value: "v3" } }],
    });
    const rejected = shiftMessage(watcher.messages) as ResponseMessage<unknown>;
    assertEquals(rejected.error?.name, "ConflictError");

    await server.flushSessions([space]);

    // The empty catch-up still crosses the wire carrying caughtUpLocalSeq: the
    // held/preempted client commit is released rather than stalling.
    const effects = drainEffects(watcher.messages);
    assertEquals(effects.length, 1);
    assertEquals(effects[0].effect.caughtUpLocalSeq, 9);
    assertEquals(effects[0].effect.upserts, []);
  } finally {
    await watcher.connection.close();
    await writerHarness.connection.close();
    await server.close();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
});

// THE W2.9 GATE (mechanical proxy). The shipping-critical acceptance is a
// wall-time measurement the rollout owner runs — the flag-on default-app
// note-create series reaching flag-off parity within noise versus the archived
// baseline (docs/history/development/performance/server-execution-feed-baseline-2026-07-16.md).
// It cannot be run inside this worktree. What CAN be pinned deterministically is
// the mechanism the wall-time drop rests on: across a multi-wave note-create
// series, a fully-doc-set session performs ZERO `session.watch.refresh` DAG
// traversals (that source was ~94k traversals/run flag-on before F5) while its
// members flow as zero-traversal point reads. If this ever regresses, the
// wall-time gate cannot pass and this test goes red first.
Deno.test("F5 W2.9 gate proxy: a note-create SERIES on a fully-doc-set session does zero session.watch.refresh traversal", async () => {
  const space = "did:key:z6Mk-feed-retire-gate";
  const server = createServer("memory://feed-retire-gate");
  setServerPrimaryExecutionGraphRetirementConfig([space]);
  const watcher = await openSession(server, space);
  const author = await openSession(server, space);
  try {
    // The default-app steady-state surface: a doc-set membership watch over the
    // note closure (of:note:1..N), no residual schema-graph watch.
    const NOTES = 6;
    const noteIds = Array.from({ length: NOTES }, (_, i) => `of:note:${i + 1}`);
    await docsWatchSet(watcher, space, "w", [
      { id: "notes", kind: "docs", docs: noteIds.map((id) => ({ id })) },
    ]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    const before = {
      fully: server.feedStats.refreshFullyDocSetSessions,
      residual: server.feedStats.refreshResidualGraphWatches,
      residualTraversed: server.feedStats.refreshResidualGraphWatchesTraversed,
      deliveries: server.feedStats.docSetMemberDeliveries,
    };

    // Each note-create is its own wave (one commit → one refresh flush), the
    // shape the note-create series measures.
    let touchedWaves = 0;
    for (let i = 0; i < NOTES; i++) {
      await transact(author, space, `note-${i}`, {
        localSeq: i + 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: noteIds[i], value: { value: `n${i}` } }],
      });
      while (author.messages.length > 0) shiftMessage(author.messages);
      await server.flushSessions([space]);
      const effects = drainEffects(watcher.messages);
      // Each wave delivered exactly the one created note as a point read.
      assertEquals(effects.length, 1);
      assertEquals(effects[0].effect.upserts.map((u) => u.id), [noteIds[i]]);
      touchedWaves += 1;
    }

    // The gate's core assertion: the retired refresh source did NO traversal
    // across the whole series — no residual watches held, none traversed, no
    // residual DAG work attributed to the space (the FB11 budget reads 0).
    assertEquals(
      server.feedStats.traversalByOperation["session.watch.refresh"],
      undefined,
    );
    assertEquals(
      server.feedStats.refreshResidualGraphWatches - before.residual,
      0,
    );
    assertEquals(
      server.feedStats.refreshResidualGraphWatchesTraversed -
        before.residualTraversed,
      0,
    );
    assertEquals(
      server.feedStats.refreshResidualDagTraversalsBySpace[space],
      undefined,
    );
    // Every touched wave retired (fully doc-set), and members flowed as point
    // reads with zero DAG traversal.
    assertEquals(
      server.feedStats.refreshFullyDocSetSessions - before.fully,
      touchedWaves,
    );
    assertEquals(
      server.feedStats.docSetMemberDeliveries - before.deliveries,
      NOTES,
    );
    const pointReads =
      server.feedStats.traversalByOperation["session.docset.read"];
    assertExists(pointReads);
    assertEquals(pointReads.dagTraversals, 0);
    assertEquals(pointReads.schemaTraversals, 0);
  } finally {
    await watcher.connection.close();
    await author.connection.close();
    await server.close();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
});

// FW5 (FB10): the dial is deployment-reachable — hosts apply
// EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES at server
// construction (toolshed routes/storage/memory.ts, the standalone server).
// The parser lives next to the dial so the rules cannot drift between hosts.
Deno.test("FW5: the dial env applies comma-separated space DIDs or the wildcard (FB10)", () => {
  try {
    // Unset leaves the dial untouched (default: empty — nothing admitted).
    applyServerPrimaryExecutionGraphRetirementEnvConfig(() => undefined);
    assertEquals(
      serverPrimaryExecutionGraphRetirementAdmits("did:key:z6Mk-env-a"),
      false,
    );
    // Comma-separated DIDs admit exactly the named spaces (whitespace and
    // empty segments tolerated).
    applyServerPrimaryExecutionGraphRetirementEnvConfig((name) =>
      name === SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES_ENV
        ? " did:key:z6Mk-env-a, did:key:z6Mk-env-b ,"
        : undefined
    );
    assert(serverPrimaryExecutionGraphRetirementAdmits("did:key:z6Mk-env-a"));
    assert(serverPrimaryExecutionGraphRetirementAdmits("did:key:z6Mk-env-b"));
    assertEquals(
      serverPrimaryExecutionGraphRetirementAdmits("did:key:z6Mk-env-c"),
      false,
    );
    // The wildcard admits every space.
    applyServerPrimaryExecutionGraphRetirementEnvConfig(() => "*");
    assert(
      serverPrimaryExecutionGraphRetirementAdmits("did:key:z6Mk-env-any"),
    );
  } finally {
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
});
