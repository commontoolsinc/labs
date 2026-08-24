/**
 * Per-frame schema-ref closure (verification-coverage.md OW61, RULED
 * 2026-08-24): every sync frame that carries a document mentioning `cid:`
 * schema refs must carry the referenced schema documents in the SAME
 * frame (unless the frame already contains them).
 *
 * Why per-frame: the arrival validator's guarantee is per-frame — a
 * delivered document's refs must resolve within the delivered frame or
 * the replica's stored docs (docs/specs/content-addressed-schemas.md;
 * `SpaceReplica.#validateArrivedSchemaDocuments` throws otherwise, and
 * on the background consume path that throw killed the consuming worker
 * wholesale — the OW61 board at 7d97a80aa). The graph-level closure
 * assembly stages a cid doc only when the session's tracked graph never
 * delivered it, and the frame builders additionally elide entries the
 * session cache says were delivered before — so a RE-delivered
 * mentioning doc shipped in a frame without its cid: sibling, and that
 * frame's validity depended on the client having durably applied every
 * earlier frame in order. Delivery-window timing broke that ordering in
 * CI; these pins remove the ordering dependence at the source: the
 * frame itself is closed.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
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
  type SessionSyncUpsert,
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

// Marker-only frames (CT-1927 catch-up markers) may interleave; skip
// exactly those and nothing else.
const nextResponse = <Result>(
  messages: ServerMessage[],
): ResponseMessage<Result> => {
  while (true) {
    const message = shiftMessage(messages);
    if (message.type !== "session/effect") {
      return assertResponse<Result>(message);
    }
    const effect = (message as SessionEffectMessage)
      .effect as unknown as SessionSync;
    if (
      effect.upserts.length > 0 || effect.removes.length > 0 ||
      effect.caughtUpLocalSeq === undefined
    ) {
      throw new Error(
        "nextResponse skipped a non-marker-only sync frame; consume it explicitly",
      );
    }
  }
};

/** The next session/effect frame that carries content (marker-only
 * frames are skipped), waiting for delivery if none is queued yet. */
const nextContentEffect = async (
  messages: ServerMessage[],
): Promise<SessionSync> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    while (messages.length > 0) {
      const message = shiftMessage(messages);
      if (message.type !== "session/effect") {
        throw new Error(
          `expected a session/effect frame, saw ${message.type}`,
        );
      }
      const effect = (message as SessionEffectMessage)
        .effect as unknown as SessionSync;
      if (effect.upserts.length > 0 || effect.removes.length > 0) {
        return effect;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no content-bearing sync frame arrived");
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

type WatchSyncResult = {
  serverSeq: number;
  sync: SessionSync;
};

const upsertIds = (upserts: readonly SessionSyncUpsert[]): string[] =>
  upserts.map((upsert) => upsert.id as string);

// The mention shape the OW61 board hit: a document whose VALUE embeds a
// link carrying a schema `$ref` to a content-addressed schema document.
const leafSchema = { type: "string", title: "ow61-frame-closure" } as const;
const leafHash = internSchemaAsTaggedHashString(leafSchema);
const cidId = `cid:${leafHash}`;

const mentioningDoc = (marker: string) => ({
  value: {
    marker,
    linked: {
      "/": {
        "link@1": {
          id: "of:frame-closure-target",
          path: [],
          schema: { $ref: cidId },
        },
      },
    },
  },
});

Deno.test("memory v2 sync frames re-carry the cid schema docs their documents mention (per-frame closure, OW61)", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-frame-schema-closure"),
    subscriptionRefreshDelayMs: 0,
  });
  const writerMessages: ServerMessage[] = [];
  const watcherMessages: ServerMessage[] = [];
  const writer = server.connect((message) => writerMessages.push(message));
  const watcher = server.connect((message) => watcherMessages.push(message));
  const space = "did:key:z6Mk-frame-schema-closure";

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
    const writerSessionId = nextResponse<{ sessionId: string }>(
      writerMessages,
    ).ok!.sessionId;

    await watcher.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "watcher-open",
      space,
      session: {},
      invocation: authInvocation(watcherSessionOpen),
    }));
    const watcherSessionId = nextResponse<{ sessionId: string }>(
      watcherMessages,
    ).ok!.sessionId;

    // One commit installs the schema doc and TWO documents mentioning it
    // (the write-side closure boundary requires the doc's refs in the
    // commit or the store, so the first mentioning write carries its
    // closure — the write half of the guarantee, already enforced).
    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: cidId, value: { value: leafSchema } },
          { op: "set", id: "of:carrier-a", value: mentioningDoc("a-v1") },
          { op: "set", id: "of:carrier-b", value: mentioningDoc("b-v1") },
        ],
      },
    }));
    assertExists(nextResponse(writerMessages).ok);

    // Frame 1 — the initial watch delivery. The graph-level assembly
    // already closes this one (the cid doc is untracked); the pin's
    // subject is what happens AFTER the tracker holds it.
    await watcher.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId: watcherSessionId,
      watches: [{
        id: "carrier-a",
        kind: "graph",
        query: {
          roots: [{
            id: "of:carrier-a",
            selector: { path: [], schema: false },
          }],
        },
      }],
    }));
    const frame1 = assertResponse<WatchSyncResult>(
      shiftMessage(watcherMessages),
    ).ok!.sync;
    assertEquals(
      upsertIds(frame1.upserts).toSorted(),
      [cidId, "of:carrier-a"].toSorted(),
      "the initial delivery carries the mentioning doc AND its cid schema doc",
    );

    // Frame 2 — a RE-delivery of the mentioning doc (the writer touches
    // it). The session cache says the cid doc was delivered in frame 1,
    // and the tracked graph holds it — both elisions the delivery race
    // rode. The frame must still be closed: a frame's validity may not
    // depend on the fate or ordering of any earlier frame.
    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:carrier-a", value: mentioningDoc("a-v2") },
        ],
      },
    }));
    assertExists(nextResponse(writerMessages).ok);

    const frame2 = await nextContentEffect(watcherMessages);
    assert(
      upsertIds(frame2.upserts).includes("of:carrier-a"),
      "the push frame re-delivers the touched mentioning doc",
    );
    assert(
      upsertIds(frame2.upserts).includes(cidId),
      `the push frame must re-carry the mentioned cid schema doc in the ` +
        `SAME frame (got: ${JSON.stringify(upsertIds(frame2.upserts))}) — ` +
        `a frame whose validity depends on an earlier frame's delivery ` +
        `is the OW61 race`,
    );

    // Frame 3 — watch.add of a SECOND mentioning doc on the existing
    // session. The extension's updates hold only the new carrier; the
    // tracked graph already holds the cid doc. Same bar: the response
    // frame is closed on its own.
    await watcher.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch-2",
      space,
      sessionId: watcherSessionId,
      watches: [{
        id: "carrier-b",
        kind: "graph",
        query: {
          roots: [{
            id: "of:carrier-b",
            selector: { path: [], schema: false },
          }],
        },
      }],
    }));
    const frame3 = nextResponse<WatchSyncResult>(watcherMessages).ok!.sync;
    assert(
      upsertIds(frame3.upserts).includes("of:carrier-b"),
      "the watch.add response delivers the newly watched mentioning doc",
    );
    assert(
      upsertIds(frame3.upserts).includes(cidId),
      `the watch.add response must carry the mentioned cid schema doc in ` +
        `the SAME frame (got: ${
        JSON.stringify(upsertIds(frame3.upserts))
      }) — its earlier delivery rode a different frame whose application ` +
        `the server cannot assume`,
    );
  } finally {
    await server.close();
  }
});
