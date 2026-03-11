import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import { MEMORY_V2_PROTOCOL, type ServerMessage } from "../v2.ts";

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

Deno.test("memory v2 server opens sessions, commits documents, and queries graph roots", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-server"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server";

  await connection.receive(JSON.stringify({
    type: "hello",
    protocol: MEMORY_V2_PROTOCOL,
  }));

  assertEquals(shiftMessage(messages), {
    type: "hello.ok",
    protocol: MEMORY_V2_PROTOCOL,
  });

  await connection.receive(JSON.stringify({
    type: "session.open",
    requestId: "open-1",
    space,
    session: {},
  }));

  const opened = shiftMessage(messages);
  assertEquals(opened.type, "response");
  assertEquals(opened.requestId, "open-1");
  assertExists(opened.ok);
  const sessionId = opened.ok.sessionId;

  await connection.receive(JSON.stringify({
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
        value: {
          value: {
            hello: "world",
          },
        },
      }],
    },
  }));

  const committed = shiftMessage(messages);
  assertEquals(committed.type, "response");
  assertEquals(committed.requestId, "tx-1");
  assertEquals(committed.ok?.seq, 1);

  await connection.receive(JSON.stringify({
    type: "graph.query",
    requestId: "query-1",
    space,
    sessionId,
    query: {
      roots: [{
        id: "of:doc:1",
        selector: {
          path: [],
          schema: false,
        },
      }],
    },
  }));

  const query = shiftMessage(messages);
  assertEquals(query.type, "response");
  assertEquals(query.requestId, "query-1");
  assertEquals(query.ok?.serverSeq, 1);
  assertEquals(query.ok?.entities.map((entity) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 1,
    document: {
      value: {
        hello: "world",
      },
    },
  }]);

  await server.close();
});

Deno.test("memory v2 server pushes graph query subscription updates", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-server-subscribe"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-subscribe";

  await connection.receive(JSON.stringify({
    type: "hello",
    protocol: MEMORY_V2_PROTOCOL,
  }));
  shiftMessage(messages);

  await connection.receive(JSON.stringify({
    type: "session.open",
    requestId: "open-1",
    space,
    session: {},
  }));
  const opened = shiftMessage(messages);
  assertEquals(opened.type, "response");
  assertExists(opened.ok);
  const sessionId = opened.ok.sessionId;

  await connection.receive(JSON.stringify({
    type: "graph.query",
    requestId: "query-1",
    space,
    sessionId,
    query: {
      subscribe: true,
      roots: [{
        id: "of:doc:1",
        selector: {
          path: [],
          schema: false,
        },
      }],
    },
  }));

  const subscribed = shiftMessage(messages);
  assertEquals(subscribed.type, "response");
  assertEquals(subscribed.requestId, "query-1");
  assertExists(subscribed.ok?.subscriptionId);

  await connection.receive(JSON.stringify({
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
        value: {
          value: {
            hello: "subscription",
          },
        },
      }],
    },
  }));

  const committed = shiftMessage(messages);
  assertEquals(committed.type, "response");
  assertEquals(committed.requestId, "tx-1");
  assertEquals(committed.ok?.seq, 1);

  const update = shiftMessage(messages);
  assertEquals(update.type, "graph.update");
  assertEquals(update.subscriptionId, subscribed.ok?.subscriptionId);
  assertEquals(update.result.entities.map((entity) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 1,
    document: {
      value: {
        hello: "subscription",
      },
    },
  }]);

  await server.close();
});
