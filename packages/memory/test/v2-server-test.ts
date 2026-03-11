import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  MEMORY_V2_PROTOCOL,
  type GraphUpdateMessage,
  type ResponseMessage,
  type ServerMessage,
} from "../v2.ts";

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const assertResponse = (message: ServerMessage): ResponseMessage<unknown> => {
  assertEquals(message.type, "response");
  return message as ResponseMessage<unknown>;
};

const assertUpdate = (message: ServerMessage): GraphUpdateMessage => {
  assertEquals(message.type, "graph.update");
  return message as GraphUpdateMessage;
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

  const opened = assertResponse(shiftMessage(messages));
  assertEquals(opened.requestId, "open-1");
  assertExists(opened.ok);
  const sessionId = (opened.ok as any).sessionId;

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

  const committed = assertResponse(shiftMessage(messages));
  assertEquals(committed.requestId, "tx-1");
  assertEquals((committed.ok as any)?.seq, 1);

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

  const query = assertResponse(shiftMessage(messages));
  assertEquals(query.requestId, "query-1");
  assertEquals((query.ok as any)?.serverSeq, 1);
  assertEquals((query.ok as any)?.entities.map((entity: any) => ({
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
  const opened = assertResponse(shiftMessage(messages));
  assertExists(opened.ok);
  const sessionId = (opened.ok as any).sessionId;

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

  const subscribed = assertResponse(shiftMessage(messages));
  assertEquals(subscribed.requestId, "query-1");
  assertExists((subscribed.ok as any)?.subscriptionId);

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

  const committed = assertResponse(shiftMessage(messages));
  assertEquals(committed.requestId, "tx-1");
  assertEquals((committed.ok as any)?.seq, 1);

  const update = assertUpdate(shiftMessage(messages));
  assertEquals(update.subscriptionId, (subscribed.ok as any)?.subscriptionId);
  assertEquals(update.result.entities.map((entity: any) => ({
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

Deno.test("memory v2 server coalesces subscription refresh after pending commits", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-server-coalesce"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-coalesce";

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
  const opened = assertResponse(shiftMessage(messages));
  assertExists(opened.ok);
  const sessionId = (opened.ok as any).sessionId;

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
  const subscribed = assertResponse(shiftMessage(messages));
  assertExists((subscribed.ok as any)?.subscriptionId);

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
            count: 1,
          },
        },
      }],
    },
  }));
  assertEquals(assertResponse(shiftMessage(messages)).requestId, "tx-1");

  await connection.receive(JSON.stringify({
    type: "transact",
    requestId: "tx-2",
    space,
    sessionId,
    commit: {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            count: 2,
          },
        },
      }],
    },
  }));
  assertEquals(assertResponse(shiftMessage(messages)).requestId, "tx-2");
  assertEquals(messages.length, 0);

  await tick();

  const update = assertUpdate(shiftMessage(messages));
  assertEquals(update.subscriptionId, (subscribed.ok as any)?.subscriptionId);
  assertEquals(update.result.serverSeq, 2);
  assertEquals(update.result.entities.map((entity: any) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 2,
    document: {
      value: {
        count: 2,
      },
    },
  }]);
  assertEquals(messages.length, 0);

  await server.close();
});

Deno.test("memory v2 server flushes subscription refresh before returning conflicts", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-server-conflict-flush"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-conflict-flush";

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
  const opened = assertResponse(shiftMessage(messages));
  assertExists(opened.ok);
  const sessionId = (opened.ok as any).sessionId;

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
  const subscribed = assertResponse(shiftMessage(messages));
  assertExists((subscribed.ok as any)?.subscriptionId);

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
            version: 1,
          },
        },
      }],
    },
  }));
  assertEquals(assertResponse(shiftMessage(messages)).requestId, "tx-1");

  await connection.receive(JSON.stringify({
    type: "transact",
    requestId: "tx-2",
    space,
    sessionId,
    commit: {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            version: 3,
          },
        },
      }],
    },
  }));
  assertEquals(assertResponse(shiftMessage(messages)).requestId, "tx-2");
  assertEquals(messages.length, 0);

  await connection.receive(JSON.stringify({
    type: "transact",
    requestId: "tx-3",
    space,
    sessionId,
    commit: {
      localSeq: 3,
      reads: {
        confirmed: [{
          id: "of:doc:1",
          path: [],
          seq: 1,
        }],
        pending: [],
      },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            version: 2,
          },
        },
      }],
    },
  }));

  const update = assertUpdate(shiftMessage(messages));
  assertEquals(update.subscriptionId, (subscribed.ok as any)?.subscriptionId);
  assertEquals(update.result.serverSeq, 2);
  assertEquals(update.result.entities.map((entity: any) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 2,
    document: {
      value: {
        version: 3,
      },
    },
  }]);

  const rejected = assertResponse(shiftMessage(messages));
  assertEquals(rejected.requestId, "tx-3");
  assertEquals((rejected.error as any)?.name, "ConflictError");
  assertEquals(messages.length, 0);

  await server.close();
});
