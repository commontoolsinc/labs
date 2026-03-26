import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  getMemoryV2Flags,
  MEMORY_V2_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
} from "../v2.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_V2_PROTOCOL,
  flags: getMemoryV2Flags(),
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

Deno.test("memory v2 server replaces watch sets and emits session sync effects", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-watch-sync"),
    subscriptionRefreshDelayMs: 0,
  });
  const writerMessages: ServerMessage[] = [];
  const watcherMessages: ServerMessage[] = [];
  const writer = server.connect((message) => writerMessages.push(message));
  const watcher = server.connect((message) => watcherMessages.push(message));
  const space = "did:key:z6Mk-watch-sync";

  try {
    for (const connection of [writer, watcher]) {
      await connection.receive(JSON.stringify(HELLO));
    }
    shiftMessage(writerMessages);
    shiftMessage(watcherMessages);

    await writer.receive(JSON.stringify({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
    }));
    const writerOpen = assertResponse<{ sessionId: string; serverSeq: number }>(
      shiftMessage(writerMessages),
    );

    await watcher.receive(JSON.stringify({
      type: "session.open",
      requestId: "watcher-open",
      space,
      session: {},
    }));
    const watcherOpen = assertResponse<{
      sessionId: string;
      serverSeq: number;
    }>(shiftMessage(watcherMessages));

    const writerSessionId = writerOpen.ok!.sessionId;
    const watcherSessionId = watcherOpen.ok!.sessionId;

    await writer.receive(JSON.stringify({
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
          value: {
            value: {
              hello: "world",
            },
          },
        }],
      },
    }));
    assertEquals(assertResponse(shiftMessage(writerMessages)).ok, {
      seq: 1,
      branch: "",
      revisions: [{
        id: "of:doc:1",
        branch: "",
        seq: 1,
        opIndex: 0,
        commitSeq: 1,
        op: "set",
        document: {
          value: {
            hello: "world",
          },
        },
      }],
    });

    await watcher.receive(JSON.stringify({
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
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const watchResponse = assertResponse<{
      serverSeq: number;
      sync: {
        type: "sync";
        fromSeq: number;
        toSeq: number;
        upserts: Array<{
          branch: string;
          id: string;
          seq: number;
          doc?: unknown;
          deleted?: true;
        }>;
        removes: Array<{ branch: string; id: string }>;
      };
    }>(shiftMessage(watcherMessages));
    assertEquals(watchResponse.ok?.serverSeq, 1);
    assertEquals(watchResponse.ok?.sync.upserts, [{
      branch: "",
      id: "of:doc:1",
      seq: 1,
      doc: {
        value: {
          hello: "world",
        },
      },
    }]);
    assertEquals(watchResponse.ok?.sync.removes, []);

    await writer.receive(JSON.stringify({
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
          value: {
            value: {
              hello: "again",
            },
          },
        }],
      },
    }));
    assertEquals(
      (assertResponse(shiftMessage(writerMessages)).ok as any)?.seq,
      2,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const effect = assertEffect(shiftMessage(watcherMessages));
    assertEquals(effect.sessionId, watcherSessionId);
    assertEquals(effect.effect.type, "sync");
    assertEquals(effect.effect.toSeq, 2);
    assertEquals(effect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      seq: 2,
      doc: {
        value: {
          hello: "again",
        },
      },
    }]);
    assertEquals(effect.effect.removes, []);
  } finally {
    await server.close();
  }
});
