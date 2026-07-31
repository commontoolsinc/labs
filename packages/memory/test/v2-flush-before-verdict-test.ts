// CT-1927: with `flushBeforeVerdict` on, every transact verdict is preceded
// on the session's socket by the delivery of the space's relevant sync state
// — implementing 04-protocol.md §4.11.2 and extending it to accepts. The
// frame that precedes the verdict carries `caughtUpLocalSeq` for the commit
// it reflects (the tightened stamping contract: the marker rides the frame
// that carries the outcome), which is what client-side frame-time overlay
// retirement keys on. Off (the default), behavior stays verdict-first: the
// batched fan-out delivers novelty later — the deviation CT-1872 catalogued.
//
// The long refresh delay in the flag-on tests is deliberate: it parks the
// writer's novelty behind a timer the pre-verdict flush must cancel and
// absorb, proving the ordering comes from the flush, not from a lucky timer.

import { assertEquals, assertExists } from "@std/assert";
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
  // waiting on a 30s timeout.
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
