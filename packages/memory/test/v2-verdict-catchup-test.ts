// CT-1927: transact verdicts return INLINE — the fan-out stays batched, so
// N commits can apply against one watch-union recompute — and the ordering
// contract is enforced through the catch-up marker instead: every verdict
// (accepts as well as conflict rejections) stages a `caughtUpLocalSeq`
// obligation, and the batched fan-out stamps the marker on the next frame to
// the committing session — an otherwise-empty frame if nothing it watches is
// dirty. The CLIENT parks each accept's promotion until the marker covers
// it (04-protocol.md §4.11.2); these tests pin the server half: the marker
// rides the frame that reflects the decided outcomes, and it always arrives.
//
// The long refresh delay parks the writer's novelty behind a timer so each
// test drives delivery explicitly with flushSessions().

import { assertEquals, assertExists } from "@std/assert";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
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

const watchBoth = (space: string, sessionId: string) => ({
  type: "session.watch.set",
  requestId: "watch-both",
  space,
  sessionId,
  watches: [{
    id: "root",
    kind: "graph",
    query: {
      roots: [
        { id: "of:doc:a", selector: { path: [], schema: false } },
        { id: "of:doc:b", selector: { path: [], schema: false } },
      ],
    },
  }],
});

const setup = async (options: {
  subscriptionRefreshDelayMs: number;
  store: string;
}) => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(options.store),
    subscriptionRefreshDelayMs: options.subscriptionRefreshDelayMs,
  });
  const committerMessages: ServerMessage[] = [];
  const committer = server.connect((message) =>
    committerMessages.push(message)
  );
  const space = "did:key:z6Mk-verdict-catchup";

  await committer.receive(encodeMemoryBoundary(HELLO));
  const committerSessionOpen = expectHelloOk(committerMessages);

  await committer.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "committer-open",
    space,
    session: {},
    invocation: authInvocation(committerSessionOpen),
  }));
  const committerSessionId =
    assertResponse<{ sessionId: string }>(shiftMessage(committerMessages))
      .ok!.sessionId;

  await committer.receive(
    encodeMemoryBoundary(watchBoth(space, committerSessionId)),
  );
  assertResponse(shiftMessage(committerMessages));

  // Foreign novelty the committer has NOT received: the out-of-band direct
  // write path (the blob-upload path) marks the space dirty behind the
  // refresh timer WITHOUT a transact verdict. seq 1 = doc:b.
  await server.writeDocument(space, "of:doc:b", { from: "writer" });

  return {
    server,
    space,
    committer,
    committerMessages,
    committerSessionId,
  };
};

Deno.test("memory v2 server: an accept returns inline and its marker rides the batched frame with the parked novelty", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-accept",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-a",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }));

  // The verdict is INLINE — no flush precedes it; the fan-out stays batched
  // so a burst of commits shares one watch-union recompute.
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);
  assertEquals(committerMessages.length, 0);

  // The batched pass then delivers the parked foreign write STAMPED with the
  // accept's marker: the frame reflects every decided outcome ≤ 1 for the
  // docs it covers, and the client applies the parked promotion on it. The
  // committer's own accepted doc:a is echo-suppressed — the parked verdict
  // carries its truth.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts
      .map((upsert) => ({ id: upsert.id, seq: upsert.seq, doc: upsert.doc })),
    [
      { id: "of:doc:b", seq: 1, doc: { value: { from: "writer" } } },
    ],
  );
  assertEquals(committerMessages.length, 0);
});

Deno.test("memory v2 server: an accept with no watched novelty still gets its marker on an otherwise-empty frame", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-empty-frame",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  // Drain the fixture's parked doc:b first so nothing watched is dirty.
  await server.flushSessions([space]);
  assertEffect(shiftMessage(committerMessages));

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-a",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }));
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);

  // The client's parked promotion is keyed on this marker, so it MUST
  // arrive even when the session's own write is the only novelty (and is
  // echo-suppressed): the obligation forces an otherwise-empty frame.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(sync.upserts, []);
  assertEquals(sync.removes, []);
});

Deno.test("memory v2 server: a rejection's read repair rides the batched frame with the rejection's marker", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-reject",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  // Stale confirmed read: doc:b moved at seq 1; the committer claims seq 0.
  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-stale",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: {
        confirmed: [{ id: "of:doc:b", path: [], seq: 0 }],
        pending: [],
      },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { derived: true } },
      }],
    },
  }));

  // Rejection inline; the client's read-repair gate holds the drop.
  const verdict = assertResponse(shiftMessage(committerMessages));
  assertExists(verdict.error);
  assertEquals(committerMessages.length, 0);

  // The staged repair (the winning doc:b) arrives with the rejected
  // commit's marker — the gate releases against repaired state.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts.map((upsert) => ({ id: upsert.id, seq: upsert.seq })),
    [{ id: "of:doc:b", seq: 1 }],
  );
});

Deno.test("memory v2 server: a failed fan-out requeues the batch and the scheduled refresh recovers", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-requeue",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-a",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }));
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);

  // Fail INSIDE the fan-out — after refreshLoop has consumed the dirty
  // state — unlike a stubbed flushSessions, which never consumes it.
  const original = server.syncSessionForConnection.bind(server);
  let calls = 0;
  (server as unknown as {
    syncSessionForConnection: typeof original;
  }).syncSessionForConnection = (...args) => {
    calls += 1;
    if (calls === 1) {
      return Promise.reject(new Error("synthetic fan-out failure"));
    }
    return original(...args);
  };
  let threw = false;
  try {
    await server.flushSessions([space]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(committerMessages.length, 0);

  // Recovery: the consumed batch was REQUEUED, so the next pass delivers
  // the parked foreign novelty and the outcome marker the client's parked
  // promotion is waiting for — "batched refresh recovers" is a kept
  // promise, not a hope.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts.map((upsert) => upsert.id),
    ["of:doc:b"],
  );
});

Deno.test("memory v2 server: same-doc foreign novelty is not echo-suppressed by the writer's own commit", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-mixed-origin",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  // The committer patches doc:b ITSELF — the doc already carrying parked
  // foreign novelty. Mixed provenance must clear the echo-suppression
  // origin: suppressing would hide the foreign write from the writer while
  // its sync cursor advances past it (unrecoverable staleness for a client
  // without CT-1926 values).
  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-b",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: "of:doc:b",
        patches: [{ op: "add", path: "/value/mine", value: true }],
      }],
    },
  }));
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);

  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts.map((upsert) => ({
      id: upsert.id,
      seq: upsert.seq,
      doc: upsert.doc,
    })),
    [{
      id: "of:doc:b",
      seq: 2,
      doc: { value: { from: "writer", mine: true } },
    }],
  );
});

Deno.test("memory v2 server: a durable write is visible to a concurrent flush while its side effects await", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-durable-visibility",
  });
  const { server, space, committerMessages } = context;

  // Second session, gated in its post-commit side effects AFTER the durable
  // apply. Installed after setup so the fixture's writeDocument is not
  // gated.
  const secondMessages: ServerMessage[] = [];
  const second = server.connect((message) => secondMessages.push(message));
  await second.receive(encodeMemoryBoundary(HELLO));
  const secondSessionOpen = expectHelloOk(secondMessages);
  await second.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "second-open",
    space,
    session: {},
    invocation: authInvocation(secondSessionOpen),
  }));
  const secondSessionId =
    assertResponse<{ sessionId: string }>(shiftMessage(secondMessages))
      .ok!.sessionId;

  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const serverInternals = server as unknown as {
    runPostCommitSchedulerSideEffects: (
      ...args: unknown[]
    ) => Promise<void>;
  };
  const originalSideEffects = serverInternals.runPostCommitSchedulerSideEffects
    .bind(server);
  let gated = false;
  serverInternals.runPostCommitSchedulerSideEffects = async (...args) => {
    if (!gated) {
      gated = true;
      reached.resolve();
      await gate.promise;
    }
    return await originalSideEffects(...args);
  };

  // The second session's write to WATCHED doc:a becomes durable, then parks
  // in its side-effect await — its verdict has not been sent.
  const secondCommit = second.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "second-a",
    space,
    sessionId: secondSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "second" } },
      }],
    },
  }));
  await reached.promise;

  // A flush during the await must see the durable doc:a: dirty-marking
  // happens before the first await, so a batch pass can never miss earlier
  // durable watched novelty.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(
    sync.upserts.map((upsert) => ({ id: upsert.id, seq: upsert.seq }))
      .toSorted((left, right) => left.id < right.id ? -1 : 1),
    [
      { id: "of:doc:a", seq: 2 },
      { id: "of:doc:b", seq: 1 },
    ],
  );

  // The gated writer's marker was staged SYNCHRONOUSLY with its dirty
  // marking — before the side-effect await — so the concurrent flush above
  // already delivered it (an otherwise-empty frame, own write suppressed)
  // even though the verdict is still parked. Staged any later, that flush
  // would have consumed the dirty batch and the obligation would ride
  // nothing: the parked promotion would strand (CT-1927 review, round 5).
  const marker = assertEffect(shiftMessage(secondMessages));
  assertEquals((marker.effect as SessionSync).caughtUpLocalSeq, 1);
  assertEquals((marker.effect as SessionSync).upserts, []);

  gate.resolve();
  await secondCommit;
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(secondMessages),
  );
  assertEquals(verdict.ok?.seq, 2);
  assertEquals(secondMessages.length, 0);
});

Deno.test("memory v2 server: a failed send retains the computed sync for the session's next flush", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-retained-send",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-a",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }));
  assertEquals(
    assertResponse<{ seq: number }>(shiftMessage(committerMessages)).ok?.seq,
    2,
  );

  // The send boundary is the commit point for sync state: watch evaluation
  // advances the session cache and consumes the pending marker BEFORE the
  // effect reaches the wire, so a throwing send must retain the computed
  // effect — a plain dirty-batch requeue could not reconstruct it (the
  // advanced cache elides everything as sameSnapshot on recomputation).
  const originalPush = committerMessages.push.bind(committerMessages);
  let failNextEffect = true;
  committerMessages.push = ((message: ServerMessage) => {
    if (failNextEffect && message.type === "session/effect") {
      failNextEffect = false;
      throw new Error("synthetic send failure");
    }
    return originalPush(message);
  }) as typeof committerMessages.push;

  // The flush survives the failed send (the effect is retained, not lost,
  // and not treated as a fan-out failure that would requeue the batch).
  await server.flushSessions([space]);
  assertEquals(committerMessages.length, 0);

  // The next flush delivers the RETAINED effect: the parked foreign write
  // and the accept's marker — nothing about them is stranded or replayed
  // from state the cache no longer reports as novel.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts.map((upsert) => ({ id: upsert.id, seq: upsert.seq })),
    [{ id: "of:doc:b", seq: 1 }],
  );
  assertEquals(committerMessages.length, 0);
});

Deno.test("memory v2 server: a retained sync merges into the session's next computed sync", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-retained-merge",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-a",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }));
  assertEquals(
    assertResponse<{ seq: number }>(shiftMessage(committerMessages)).ok?.seq,
    2,
  );

  const originalPush = committerMessages.push.bind(committerMessages);
  let failNextEffect = true;
  committerMessages.push = ((message: ServerMessage) => {
    if (failNextEffect && message.type === "session/effect") {
      failNextEffect = false;
      throw new Error("synthetic send failure");
    }
    return originalPush(message);
  }) as typeof committerMessages.push;
  await server.flushSessions([space]);
  assertEquals(committerMessages.length, 0);

  // NEW novelty lands before the retry: the next sync COMPUTES a fresh
  // frame, and the retained one must merge into it — per-doc latest-wins,
  // bounds spanning both, the marker carried forward — rather than being
  // dropped or delivered as a stale second frame.
  await server.writeDocument(space, "of:doc:a", { from: "writer-2" });
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts
      .map((upsert) => ({ id: upsert.id, seq: upsert.seq }))
      .toSorted((left, right) => left.id < right.id ? -1 : 1),
    [
      { id: "of:doc:a", seq: 3 },
      { id: "of:doc:b", seq: 1 },
    ],
  );
  assertEquals(sync.fromSeq, 0);
  assertEquals(sync.toSeq, 3);
  assertEquals(committerMessages.length, 0);
});

Deno.test("memory v2 server: retained-sync bookkeeping — remove/upsert cancellation, double retention, unknown sessions", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-retained-edges",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;
  void committer;

  // Drain the fixture's parked doc:b so the final flush computes nothing
  // and the merged retained frame is delivered as-is.
  await server.flushSessions([space]);
  assertEffect(shiftMessage(committerMessages));

  // Retaining for a session the registry no longer knows is a no-op: its
  // cache died with it, so nothing is stranded.
  server.retainUnsentEffect(space, "session:gone", {
    type: "session/effect",
    space,
    sessionId: "session:gone",
    effect: { type: "sync", fromSeq: 0, toSeq: 1, upserts: [], removes: [] },
  });

  // Two retentions for one session merge: a doc REMOVED in the older frame
  // and re-upserted in the newer keeps only the upsert (and the reverse
  // cancellation for doc:c), the marker is the max, and the bounds span.
  server.retainUnsentEffect(space, committerSessionId, {
    type: "session/effect",
    space,
    sessionId: committerSessionId,
    effect: {
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      caughtUpLocalSeq: 1,
      upserts: [{
        branch: "",
        id: "of:doc:c",
        scope: "space",
        seq: 1,
        doc: { value: { stale: true } },
      }],
      removes: [{ branch: "", id: "of:doc:b", scope: "space" }],
    },
  });
  server.retainUnsentEffect(space, committerSessionId, {
    type: "session/effect",
    space,
    sessionId: committerSessionId,
    effect: {
      type: "sync",
      fromSeq: 1,
      toSeq: 2,
      caughtUpLocalSeq: 2,
      upserts: [{
        branch: "",
        id: "of:doc:b",
        scope: "space",
        seq: 2,
        doc: { value: { fresh: true } },
      }],
      removes: [{ branch: "", id: "of:doc:c", scope: "space" }],
      observations: [
        { observedAtSeq: 2 } as unknown as NonNullable<
          SessionSync["observations"]
        >[number],
      ],
    },
  });

  // The next flush computes nothing new; the merged retained frame is
  // delivered as-is.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 2);
  assertEquals(sync.fromSeq, 0);
  assertEquals(
    sync.upserts.map((upsert) => ({ id: upsert.id, seq: upsert.seq })),
    [{ id: "of:doc:b", seq: 2 }],
  );
  assertEquals(
    sync.removes.map((remove) => remove.id),
    ["of:doc:c"],
  );
  // Observation rows ride the merge too.
  assertEquals(sync.observations?.length, 1);
});

Deno.test("memory v2 server: a mid-batch failure does not strand later spaces", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-multi-space",
  });
  const { server, space, committerMessages } = context;

  // A SECOND space with its own observing session, so stranding is
  // observable: without an observer, a stranded space holds dirty docs no
  // assertion can see, and the pin passes even against the pre-fix code.
  const spaceB = "did:key:z6Mk-verdict-catchup-second-space";
  const observerMessages: ServerMessage[] = [];
  const observer = server.connect((message) => observerMessages.push(message));
  await observer.receive(encodeMemoryBoundary(HELLO));
  const observerSessionOpen = expectHelloOk(observerMessages);
  await observer.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "observer-open",
    space: spaceB,
    session: {},
    invocation: authInvocation(observerSessionOpen),
  }));
  const observerSessionId =
    assertResponse<{ sessionId: string }>(shiftMessage(observerMessages))
      .ok!.sessionId;
  await observer.receive(encodeMemoryBoundary({
    type: "session.watch.set",
    requestId: "watch-z",
    space: spaceB,
    sessionId: observerSessionId,
    watches: [{
      id: "root",
      kind: "graph",
      query: {
        roots: [{ id: "of:doc:z", selector: { path: [], schema: false } }],
      },
    }],
  }));
  assertResponse(shiftMessage(observerMessages));
  // Parked novelty in spaceB, mirroring setup's doc:b in the first space.
  await server.writeDocument(spaceB, "of:doc:z", { parked: true });

  const original = server.syncSessionForConnection.bind(server);
  let failed = false;
  (server as unknown as {
    syncSessionForConnection: typeof original;
  }).syncSessionForConnection = (...args) => {
    if (!failed) {
      failed = true;
      return Promise.reject(new Error("synthetic first-space failure"));
    }
    return original(...args);
  };

  let threw = false;
  try {
    await server.flushSessions([space, spaceB]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  // The failing pass delivered NOTHING: the rejected sync sent no frame,
  // and the pass aborted before reaching the other space.
  assertEquals(committerMessages.length, 0);
  assertEquals(observerMessages.length, 0);

  // Recovery must reach BOTH spaces: the failed space's consumed batch was
  // requeued, and the unreached space was never removed from the dirty set
  // (spaces leave it at their own processing turn). Pre-fix the whole
  // selection was deleted up front, so whichever space the failure skipped
  // stayed stranded and its observer never heard the parked novelty.
  await server.flushSessions();
  const committerSync = assertEffect(shiftMessage(committerMessages))
    .effect as SessionSync;
  assertEquals(
    committerSync.upserts.map((upsert) => upsert.id),
    ["of:doc:b"],
  );
  const observerSync = assertEffect(shiftMessage(observerMessages))
    .effect as SessionSync;
  assertEquals(
    observerSync.upserts.map((upsert) => upsert.id),
    ["of:doc:z"],
  );
});

Deno.test("memory v2 server: requeue after failure does not resurrect echo suppression for re-dirtied docs", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-requeue-origin",
  });
  const { server, space, committerMessages, committerSessionId } = context;

  // First fan-out consumes the batch (doc:b unattributed) and, BEFORE
  // failing, doc:b is re-dirtied WITH an origin — as a concurrent own
  // write would. The requeue merge must not let the newer origin win:
  // provenance survives only when both batches agree.
  const original = server.syncSessionForConnection.bind(server);
  let failed = false;
  (server as unknown as {
    syncSessionForConnection: typeof original;
  }).syncSessionForConnection = (...args) => {
    if (!failed) {
      failed = true;
      server.markSpaceDirty(space, ["space of:doc:b"], {
        sessionId: committerSessionId,
        // doc:b's ACTUAL seq: echo suppression fires only when the origin's
        // seq matches the delivered upsert's seq, so a fabricated seq would
        // never suppress and the pin would pass even without the provenance
        // rule it exists to guard.
        seq: 1,
      });
      return Promise.reject(new Error("synthetic fan-out failure"));
    }
    return original(...args);
  };

  let threw = false;
  try {
    await server.flushSessions([space]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);

  // Recovery: doc:b must fan out to the committer AUTHORITATIVELY — the
  // consumed batch's unattributed novelty forbids suppressing it as the
  // committer's own echo.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  assertEquals(
    (effect.effect as SessionSync).upserts.map((upsert) => upsert.id),
    ["of:doc:b"],
  );
});
