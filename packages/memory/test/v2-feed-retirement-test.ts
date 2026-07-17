import { assertEquals, assertExists } from "@std/assert";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resetServerPrimaryExecutionGraphRetirementConfig,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionSync,
  setServerPrimaryExecutionGraphRetirementConfig,
} from "../v2.ts";
import { Server } from "../v2/server.ts";

// --- F5: retire per-session schema-graph re-evaluation where the watch
// surface is doc-set. The refresh loop skips `refreshTrackedGraph` for a
// fully-doc-set eligible session; residual graph watches fail open and are
// counted; the per-space dial gates eligibility only (FA3/FA7/FA11/FA13);
// the watermark stays one emission per session per wave (FA1). ---

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
    assertEquals(server.feedStats.refreshGraphsRefreshed - before.graphs, 0);
    assertEquals(
      server.feedStats.traversalByOperation["session.watch.refresh"],
      undefined,
    );
  } finally {
    await watcher.connection.close();
    await writerHarness.connection.close();
    await server.close();
    resetServerPrimaryExecutionGraphRetirementConfig();
  }
});

Deno.test("F5: the per-space dial gates eligibility only — a space not listed never retires (FA13)", async () => {
  const space = "did:key:z6Mk-feed-retire-disabled";
  const server = createServer("memory://feed-retire-disabled");
  // Dial ABSENT for this space (absent-false) — eligibility must stay closed.
  const watcher = await openSession(server, space);
  const writerHarness = await openSession(server, space);
  try {
    await docsWatchSet(watcher, space, "w", [
      { id: "docs", kind: "docs", docs: [{ id: "of:member" }] },
    ]);
    while (watcher.messages.length > 0) shiftMessage(watcher.messages);

    const beforeEligible = server.feedStats.refreshRetirementEligibleSessions;

    await transact(writerHarness, space, "seed", {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:member", value: { value: "v1" } }],
    });
    while (writerHarness.messages.length > 0) {
      shiftMessage(writerHarness.messages);
    }
    await server.flushSessions([space]);

    // The member delta still delivers (F3 fan-out is not gated by the dial) —
    // only the retirement ACCOUNTING is gated.
    const effects = drainEffects(watcher.messages);
    assertEquals(effects.length, 1);
    assertEquals(effects[0].effect.upserts.map((u) => u.id), ["of:member"]);
    assertEquals(
      server.feedStats.refreshRetirementEligibleSessions - beforeEligible,
      0,
    );
  } finally {
    await watcher.connection.close();
    await writerHarness.connection.close();
    await server.close();
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
    // failed open (still traversed) and was counted as a regression.
    assertEquals(
      server.feedStats.refreshRetirementEligibleSessions - before.eligible,
      1,
    );
    assertEquals(server.feedStats.refreshFullyDocSetSessions - before.fully, 0);
    assertEquals(
      server.feedStats.refreshResidualGraphWatches - before.residual,
      1,
    );
    assertExists(
      server.feedStats.traversalByOperation["session.watch.refresh"],
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
    // across the whole series.
    assertEquals(
      server.feedStats.traversalByOperation["session.watch.refresh"],
      undefined,
    );
    assertEquals(
      server.feedStats.refreshResidualGraphWatches - before.residual,
      0,
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
