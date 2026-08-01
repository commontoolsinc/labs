// CT-1927: with `flushBeforeVerdict` on, every transact verdict is preceded
// on the session's socket by the delivery of the space's relevant sync state
// — implementing 04-protocol.md §4.11.2 and extending it to accepts. The
// frame that precedes the verdict carries `caughtUpLocalSeq` for the commit
// it reflects (the tightened stamping contract: the marker rides the frame
// that carries the outcome), which is what client-side frame-time overlay
// retirement keys on. Off (the rollback hatch — the flag defaults ON),
// behavior stays verdict-first: the batched fan-out delivers novelty later —
// the deviation CT-1872 catalogued.
//
// The long refresh delay in the flag-on tests is deliberate: it parks the
// writer's novelty behind a timer the pre-verdict flush must cancel and
// absorb, proving the ordering comes from the flush, not from a lucky timer.

import { assertEquals, assertExists } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { Server } from "../v2/server.ts";
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
  flushBeforeVerdict: boolean;
  subscriptionRefreshDelayMs: number;
  store: string;
}) => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(options.store),
    subscriptionRefreshDelayMs: options.subscriptionRefreshDelayMs,
    flushBeforeVerdict: options.flushBeforeVerdict,
  });
  const committerMessages: ServerMessage[] = [];
  const committer = server.connect((message) =>
    committerMessages.push(message)
  );
  const space = "did:key:z6Mk-flush-before-verdict";

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
  // refresh timer WITHOUT a transact verdict — under the flag, a transacting
  // foreign session would have flushed the space itself, which is the
  // feature. seq 1 = doc:b.
  await server.writeDocument(space, "of:doc:b", { from: "writer" });

  return {
    server,
    space,
    committer,
    committerMessages,
    committerSessionId,
  };
};

Deno.test("memory v2 server: flush-before-verdict delivers relevant novelty and the outcome marker ahead of an accept", async () => {
  const context = await setup({
    flushBeforeVerdict: true,
    // Deliberately parked: the pre-verdict flush must cancel and absorb it.
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://flush-before-verdict-accept",
  });
  const { space, committer, committerMessages, committerSessionId } = context;

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

  // FIRST the frame: the parked foreign write to doc:b, stamped with the
  // outcome marker for localSeq 1. The committer's own accepted doc:a is
  // echo-suppressed by dirty-origin tracking — the verdict itself carries
  // its truth (CT-1926's post-apply document) — so the frame covers exactly
  // the foreign novelty the verdict must not outrun.
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

  // THEN the verdict.
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);
  assertEquals(committerMessages.length, 0);
});

Deno.test("memory v2 server: flush-before-verdict delivers read repair ahead of a rejection", async () => {
  const context = await setup({
    flushBeforeVerdict: true,
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://flush-before-verdict-reject",
  });
  const { space, committer, committerMessages, committerSessionId } = context;

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

  // FIRST the repair (the winning doc:b), stamped with the rejected commit's
  // marker — §4.11.2's MUST, no longer compensated by a client-side gate
  // waiting on a 30s timeout. (Coverage of a rejected doc is staged, not
  // guaranteed: had the session cache already held the winning value,
  // sameSnapshot would elide the upsert and the overlay would retire at the
  // verdict instead.)
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts.map((upsert) => ({ id: upsert.id, seq: upsert.seq })),
    [{ id: "of:doc:b", seq: 1 }],
  );

  // THEN the rejection.
  const verdict = assertResponse(shiftMessage(committerMessages));
  assertExists(verdict.error);
  assertEquals(committerMessages.length, 0);
});

Deno.test("memory v2 server: a pre-verdict flush failure never eats the verdict", async () => {
  const context = await setup({
    flushBeforeVerdict: true,
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://flush-before-verdict-failure",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  // Break the flush. The verdict must still arrive: the commit's fate is
  // durable, and the batched refresh remains the recovery path.
  const realFlush = server.flushSessions.bind(server);
  (server as unknown as { flushSessions: () => Promise<void> }).flushSessions =
    () => Promise.reject(new Error("synthetic flush failure"));

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

  // Restore and drain so the parked refresh timer is cancelled cleanly.
  (server as unknown as { flushSessions: typeof realFlush }).flushSessions =
    realFlush;
  await realFlush([space]);
});

Deno.test("memory v2 server: flag off keeps verdict-first delivery (the catalogued deviation)", async () => {
  const context = await setup({
    flushBeforeVerdict: false,
    subscriptionRefreshDelayMs: 0,
    store: "memory://flush-before-verdict-off",
  });
  const {
    server,
    space,
    committer,
    committerMessages,
    committerSessionId,
  } = context;

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

  // Verdict arrives with the foreign doc:b novelty still undelivered.
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);

  // The batched fan-out delivers it afterwards (own doc:a echo-suppressed).
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(
    sync.upserts.map((upsert) => upsert.id),
    ["of:doc:b"],
  );
});

Deno.test("memory v2 server: a failed fan-out requeues the batch and the scheduled refresh recovers", async () => {
  const context = await setup({
    flushBeforeVerdict: true,
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://flush-before-verdict-requeue",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

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
  // The verdict survives the failure.
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);

  // Recovery: the consumed batch was REQUEUED, so the next pass delivers
  // the parked foreign novelty and the outcome marker — "batched refresh
  // recovers" is a kept promise, not a hope.
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
    flushBeforeVerdict: true,
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://flush-before-verdict-mixed-origin",
  });
  const { space, committer, committerMessages, committerSessionId } = context;

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
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);
});

Deno.test("memory v2 server: a durable write is visible to a concurrent commit's flush while its side effects await", async () => {
  const context = await setup({
    flushBeforeVerdict: true,
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://flush-before-verdict-durable-visibility",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

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

  // The committer's concurrent commit must see the durable doc:a in its
  // pre-verdict flush: dirty-marking happens before the first await, so a
  // later verdict can never outrun earlier durable watched novelty.
  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-c",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:c",
        value: { value: { from: "committer" } },
      }],
    },
  }));
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
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 3);

  gate.resolve();
  await secondCommit;
});

Deno.test("memory v2 server: a queued second receive does not recreate the drain-wait cycle", async () => {
  const time = new FakeTime();
  const context = await setup({
    flushBeforeVerdict: true,
    subscriptionRefreshDelayMs: 0,
    store: "memory://flush-before-verdict-queued-receive",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;
  const gate = Promise.withResolvers<void>();
  const originalTransact = server.transact.bind(server);
  (server as unknown as {
    transact(
      message: Parameters<Server["transact"]>[0],
    ): ReturnType<Server["transact"]>;
  }).transact = async (message) => {
    if (message.requestId === "tx-1") {
      await gate.promise;
    }
    return await originalTransact(message);
  };

  try {
    const transactFor = (requestId: string, id: string) =>
      encodeMemoryBoundary({
        type: "transact",
        requestId,
        space,
        sessionId: committerSessionId,
        commit: {
          localSeq: requestId === "tx-1" ? 1 : 2,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id, value: { value: { requestId } } }],
        },
      });

    // Two receives: tx-1 gated inside transact, tx-2 SERIALIZED behind it.
    const first = committer.receive(transactFor("tx-1", "of:doc:a"));
    const second = committer.receive(transactFor("tx-2", "of:doc:c"));

    // The scheduled refresh (armed by setup's writeDocument) fires and
    // starts drain-waiting with BOTH receives counted. Under the fake
    // clock its deadline never expires: pre-fix, releasing the gate then
    // deadlocks — tx-1's flush chains behind the drain-waiting pass, which
    // waits for queued tx-2, which cannot run until tx-1 finishes. The
    // whole-queue suspension breaks the cycle deterministically.
    await time.tickAsync(0);
    gate.resolve();
    await first;
    await second;

    const effect = assertEffect(shiftMessage(committerMessages));
    assertEquals(
      (effect.effect as SessionSync).upserts.map((upsert) => upsert.id),
      ["of:doc:b"],
    );
    assertEquals(
      assertResponse<{ seq: number }>(shiftMessage(committerMessages)).ok?.seq,
      2,
    );
  } finally {
    gate.resolve();
    time.restore();
  }
});

Deno.test("memory v2 server: a mid-batch failure does not strand later spaces", async () => {
  const context = await setup({
    flushBeforeVerdict: true,
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://flush-before-verdict-multi-space",
  });
  const { server, space, committerMessages } = context;

  // A SECOND space with its own observing session, so stranding is
  // observable: without an observer, a stranded space holds dirty docs no
  // assertion can see, and the pin passes even against the pre-fix code.
  const spaceB = "did:key:z6Mk-flush-before-verdict-second-space";
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
    flushBeforeVerdict: true,
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://flush-before-verdict-requeue-origin",
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
      server.markSpaceDirty(space, ["space\u0000of:doc:b"], {
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
