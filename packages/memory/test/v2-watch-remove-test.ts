import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
} from "../v2.ts";
import * as MemoryV2Client from "../v2/client.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

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

const expectHelloOk = (messages: ServerMessage[]): SessionOpenAuthMetadata => {
  const hello = shiftMessage(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return hello.sessionOpen;
};

const watchSpec = (id: string) => ({
  id: `watch-${id}`,
  kind: "graph" as const,
  query: {
    roots: [{ id, selector: { path: [], schema: false } }],
  },
});

type WatchResult = { serverSeq: number; sync: SessionSync };

Deno.test("memory v2 server advertises the watchRemove capability", () => {
  assertEquals(getMemoryProtocolFlags().watchRemove, true);
});

Deno.test("memory v2 client removes watches on a session holding none", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-watch-remove-empty"),
    subscriptionRefreshDelayMs: 0,
  });
  const client = await MemoryV2Client.connect({
    transport: MemoryV2Client.loopback(server),
  });
  try {
    const session = await client.mount(
      "did:key:z6Mk-watch-remove-empty",
      {},
      testSessionOpenAuthFactory,
    );
    // No watch has been installed, so the session has no view to apply the
    // answer to and no watch to drop. It still gets a usable view back.
    const { view, sync } = await session.watchRemoveSync(["watch-absent"]);
    assertEquals(sync.upserts, []);
    assertEquals(sync.removes, []);
    assertExists(view);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 server drops named watches and reports what left the union", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-watch-remove"),
    subscriptionRefreshDelayMs: 0,
  });
  const messages: ServerMessage[] = [];
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
  const space = "did:key:z6Mk-watch-remove";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    await writer.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: {
        aud: sessionOpen.audience,
        challenge: sessionOpen.challenge.value,
      },
    }));
    const opened = assertResponse<{ sessionId: string }>(
      shiftMessage(messages),
    );
    const sessionId = opened.ok!.sessionId;

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: {
        aud: writerSessionOpen.audience,
        challenge: writerSessionOpen.challenge.value,
      },
    }));
    const writerOpened = assertResponse<{ sessionId: string }>(
      shiftMessage(writerMessages),
    );
    const writerSessionId = writerOpened.ok!.sessionId;

    for (const [index, id] of ["of:doc:1", "of:doc:2"].entries()) {
      await writer.receive(encodeMemoryBoundary({
        type: "transact",
        requestId: `tx-${index}`,
        space,
        sessionId: writerSessionId,
        commit: {
          localSeq: index + 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id, value: { value: { n: index } } }],
        },
      }));
      shiftMessage(writerMessages);
    }

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch",
      space,
      sessionId,
      watches: [watchSpec("of:doc:1"), watchSpec("of:doc:2")],
    }));
    const installed = assertResponse<WatchResult>(shiftMessage(messages));
    assertEquals(
      installed.ok!.sync.upserts.map((upsert) => upsert.id),
      ["of:doc:1", "of:doc:2"],
    );

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.remove",
      requestId: "remove",
      space,
      sessionId,
      // The unknown id is ignored rather than rejected.
      watchIds: ["watch-of:doc:1", "watch-of:nothing"],
    }));
    const removed = assertResponse<WatchResult>(shiftMessage(messages));
    // Only the document that left the union is named, and the one that stayed
    // is not resent: the session already holds it at this sequence number.
    assertEquals(removed.ok!.sync.removes, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
    }]);
    assertEquals(removed.ok!.sync.upserts, []);

    // A write to the dropped document no longer reaches this session, and one
    // to the surviving document still does.
    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-after",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:doc:1", value: { value: { n: 100 } } },
          { op: "set", id: "of:doc:2", value: { value: { n: 200 } } },
        ],
      },
    }));
    shiftMessage(writerMessages);
    // Drive the subscription refresh rather than waiting for its timer, so the
    // assertion below reads a settled state.
    await server.flushSessions();

    const effects = messages.filter((message) =>
      message.type === "session/effect"
    ) as { effect: SessionSync }[];
    const touched = effects.flatMap((message) =>
      message.effect.upserts.map((upsert) => upsert.id)
    );
    assertEquals(touched, ["of:doc:2"]);
  } finally {
    await server.close();
  }
});
