import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  type GraphUpdateMessage,
  MEMORY_V2_PROTOCOL,
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

class CountingServer extends Server {
  queryCount = 0;

  override async evaluateGraphQuery(
    space: string,
    query: Parameters<Server["evaluateGraphQuery"]>[1],
    engine?: Parameters<Server["evaluateGraphQuery"]>[2],
    reuse?: Parameters<Server["evaluateGraphQuery"]>[3],
  ) {
    this.queryCount += 1;
    return await super.evaluateGraphQuery(space, query, engine, reuse);
  }
}

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
  assertEquals(
    (query.ok as any)?.entities.map((entity: any) => ({
      id: entity.id,
      seq: entity.seq,
      document: entity.document,
    })),
    [{
      id: "of:doc:1",
      seq: 1,
      document: {
        value: {
          hello: "world",
        },
      },
    }],
  );

  await server.close();
});

Deno.test("memory v2 server graph queries follow source lineage from source-only docs", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-server-source-lineage"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-source-lineage";

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
    type: "transact",
    requestId: "tx-1",
    space,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:process:1",
        value: {
          value: {
            "$TYPE": "pattern:1",
          },
        },
      }, {
        op: "set",
        id: "of:piece:1",
        value: {
          source: { "/": "process:1" },
        },
      }],
    },
  }));
  const committed = assertResponse(shiftMessage(messages));
  assertEquals((committed.ok as any)?.seq, 1);

  await connection.receive(JSON.stringify({
    type: "graph.query",
    requestId: "query-1",
    space,
    sessionId,
    query: {
      roots: [{
        id: "of:piece:1",
        selector: {
          path: [],
          schema: false,
        },
      }],
    },
  }));

  const query = assertResponse(shiftMessage(messages));
  assertEquals(
    (query.ok as any)?.entities.map((entity: any) => ({
      id: entity.id,
      document: entity.document,
    })),
    [{
      id: "of:piece:1",
      document: {
        source: { "/": "process:1" },
      },
    }, {
      id: "of:process:1",
      document: {
        value: {
          "$TYPE": "pattern:1",
        },
      },
    }],
  );

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

  await tick();

  const update = assertUpdate(shiftMessage(messages));
  assertEquals(update.subscriptionId, (subscribed.ok as any)?.subscriptionId);
  assertEquals(
    update.result.entities.map((entity: any) => ({
      id: entity.id,
      seq: entity.seq,
      document: entity.document,
    })),
    [{
      id: "of:doc:1",
      seq: 1,
      document: {
        value: {
          hello: "subscription",
        },
      },
    }],
  );

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
  assertEquals(
    update.result.entities.map((entity: any) => ({
      id: entity.id,
      seq: entity.seq,
      document: entity.document,
    })),
    [{
      id: "of:doc:1",
      seq: 2,
      document: {
        value: {
          count: 2,
        },
      },
    }],
  );
  assertEquals(messages.length, 0);

  await server.close();
});

Deno.test("memory v2 server refreshes only subscriptions touched by changed docs", async () => {
  const server = new CountingServer({
    store: new URL("memory://memory-v2-server-dirty-filter"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-dirty-filter";

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

  for (const id of ["of:doc:1", "of:doc:2"]) {
    await connection.receive(JSON.stringify({
      type: "graph.query",
      requestId: `query-${id}`,
      space,
      sessionId,
      query: {
        subscribe: true,
        roots: [{
          id,
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }));
    assertExists(
      (assertResponse(shiftMessage(messages)).ok as any)?.subscriptionId,
    );
  }

  assertEquals(server.queryCount, 2);

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

  await tick();

  assertEquals(server.queryCount, 2);
  const update = assertUpdate(shiftMessage(messages));
  assertEquals(
    update.result.entities.map((entity: any) => entity.id),
    ["of:doc:1"],
  );
  assertEquals(messages.length, 0);

  await server.close();
});

Deno.test("memory v2 server patches plain dirty docs without reevaluating the full query", async () => {
  const server = new CountingServer({
    store: new URL("memory://memory-v2-server-direct-patch"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-direct-patch";

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
  assertEquals(server.queryCount, 1);

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

  await tick();

  assertEquals(server.queryCount, 1);
  const update = assertUpdate(shiftMessage(messages));
  assertEquals(update.result.serverSeq, 1);
  assertEquals(
    update.result.entities.map((entity: any) => ({
      id: entity.id,
      seq: entity.seq,
      document: entity.document,
    })),
    [{
      id: "of:doc:1",
      seq: 1,
      document: {
        value: {
          count: 1,
        },
      },
    }],
  );

  await server.close();
});

Deno.test("memory v2 server batches identical graph updates across subscriptions", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-server-batched-updates"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-batched-updates";

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

  for (const requestId of ["query-1", "query-2"]) {
    await connection.receive(JSON.stringify({
      type: "graph.query",
      requestId,
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
  }

  const first = assertResponse(shiftMessage(messages));
  const second = assertResponse(shiftMessage(messages));
  const firstSubscriptionId = (first.ok as any)?.subscriptionId;
  const secondSubscriptionId = (second.ok as any)?.subscriptionId;
  assertExists(firstSubscriptionId);
  assertExists(secondSubscriptionId);

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

  await tick();

  const update = assertUpdate(shiftMessage(messages));
  assertEquals(update.subscriptionIds?.sort(), [
    firstSubscriptionId,
    secondSubscriptionId,
  ].sort());
  assertEquals(update.result.entities.map((entity: any) => entity.id), [
    "of:doc:1",
  ]);
  assertEquals(messages.length, 0);

  await server.close();
});

Deno.test("memory v2 server reevaluates queries when a root doc gains a sigil link", async () => {
  const server = new CountingServer({
    store: new URL("memory://memory-v2-server-sigil-topology"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-sigil-topology";

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
    type: "transact",
    requestId: "tx-seed",
    space,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:target:1",
        value: {
          value: {
            city: "San Francisco",
          },
        },
      }, {
        op: "set",
        id: "of:root:1",
        value: {
          value: {
            name: "Alice",
          },
        },
      }],
    },
  }));
  assertEquals(assertResponse(shiftMessage(messages)).requestId, "tx-seed");

  await connection.receive(JSON.stringify({
    type: "graph.query",
    requestId: "query-1",
    space,
    sessionId,
    query: {
      subscribe: true,
      roots: [{
        id: "of:root:1",
        selector: {
          path: [],
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              address: {
                type: "object",
                properties: {
                  city: { type: "string" },
                },
              },
            },
          },
        },
      }],
    },
  }));
  const subscribed = assertResponse(shiftMessage(messages));
  assertExists((subscribed.ok as any)?.subscriptionId);
  assertEquals(server.queryCount, 1);

  await connection.receive(JSON.stringify({
    type: "transact",
    requestId: "tx-1",
    space,
    sessionId,
    commit: {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:root:1",
        value: {
          value: {
            name: "Alice",
            address: {
              "/": {
                "link@1": {
                  id: "of:target:1",
                  path: [],
                  space,
                },
              },
            },
          },
        },
      }],
    },
  }));
  assertEquals(assertResponse(shiftMessage(messages)).requestId, "tx-1");

  await tick();

  assertEquals(server.queryCount, 2);
  const update = assertUpdate(shiftMessage(messages));
  assertEquals(
    update.result.entities.map((entity: any) => entity.id),
    ["of:root:1", "of:target:1"],
  );

  await server.close();
});

Deno.test("memory v2 server reevaluates queries when a sigil write redirect retargets", async () => {
  const server = new CountingServer({
    store: new URL("memory://memory-v2-server-alias-topology"),
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-alias-topology";

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
    type: "transact",
    requestId: "tx-seed",
    space,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:target:first",
        value: {
          value: {
            count: 1,
          },
        },
      }, {
        op: "set",
        id: "of:target:second",
        value: {
          value: {
            count: 2,
          },
        },
      }, {
        op: "set",
        id: "of:alias:1",
        value: {
          value: {
            "/": {
              "link@1": {
                id: "of:target:first",
                overwrite: "redirect",
                path: [],
                space,
              },
            },
          },
        },
      }],
    },
  }));
  assertEquals(assertResponse(shiftMessage(messages)).requestId, "tx-seed");

  await connection.receive(JSON.stringify({
    type: "graph.query",
    requestId: "query-1",
    space,
    sessionId,
    query: {
      subscribe: true,
      roots: [{
        id: "of:alias:1",
        selector: {
          path: [],
          schema: false,
        },
      }],
    },
  }));
  const subscribed = assertResponse(shiftMessage(messages));
  assertExists((subscribed.ok as any)?.subscriptionId);
  assertEquals(server.queryCount, 1);

  await connection.receive(JSON.stringify({
    type: "transact",
    requestId: "tx-1",
    space,
    sessionId,
    commit: {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:alias:1",
        value: {
          value: {
            "/": {
              "link@1": {
                id: "of:target:second",
                overwrite: "redirect",
                path: [],
                space,
              },
            },
          },
        },
      }],
    },
  }));
  assertEquals(assertResponse(shiftMessage(messages)).requestId, "tx-1");

  await tick();

  assertEquals(server.queryCount, 2);
  const update = assertUpdate(shiftMessage(messages));
  assertEquals(
    update.result.entities.map((entity: any) => entity.id),
    ["of:alias:1", "of:target:second"],
  );

  await server.close();
});

Deno.test("memory v2 server reuses cached subscribed graph queries across reconnect when head is unchanged", async () => {
  const server = new CountingServer({
    store: new URL("memory://memory-v2-server-resume-cache"),
  });
  const space = "did:key:z6Mk-memory-v2-resume-cache";
  const query = {
    subscribe: true,
    roots: [{
      id: "of:doc:1",
      selector: {
        path: [],
        schema: false,
      },
    }],
  } as const;

  const messages1: ServerMessage[] = [];
  const connection1 = server.connect((message) => messages1.push(message));
  await connection1.receive(JSON.stringify({
    type: "hello",
    protocol: MEMORY_V2_PROTOCOL,
  }));
  shiftMessage(messages1);

  await connection1.receive(JSON.stringify({
    type: "session.open",
    requestId: "open-1",
    space,
    session: {},
  }));
  const opened1 = assertResponse(shiftMessage(messages1));
  const sessionId = (opened1.ok as any).sessionId;

  await connection1.receive(JSON.stringify({
    type: "graph.query",
    requestId: "query-1",
    space,
    sessionId,
    query,
  }));
  const subscribed1 = assertResponse(shiftMessage(messages1));
  assertExists((subscribed1.ok as any)?.subscriptionId);
  assertEquals(server.queryCount, 1);
  connection1.close();

  const messages2: ServerMessage[] = [];
  const connection2 = server.connect((message) => messages2.push(message));
  await connection2.receive(JSON.stringify({
    type: "hello",
    protocol: MEMORY_V2_PROTOCOL,
  }));
  shiftMessage(messages2);

  await connection2.receive(JSON.stringify({
    type: "session.open",
    requestId: "open-2",
    space,
    session: {
      sessionId,
      seenSeq: (subscribed1.ok as any)?.serverSeq ?? 0,
    },
  }));
  assertResponse(shiftMessage(messages2));

  await connection2.receive(JSON.stringify({
    type: "graph.query",
    requestId: "query-2",
    space,
    sessionId,
    query,
  }));
  const subscribed2 = assertResponse(shiftMessage(messages2));
  assertExists((subscribed2.ok as any)?.subscriptionId);
  assertEquals(server.queryCount, 1);

  await server.close();
});

Deno.test("memory v2 server invalidates cached subscribed graph queries after head changes", async () => {
  const server = new CountingServer({
    store: new URL("memory://memory-v2-server-resume-cache-stale"),
  });
  const space = "did:key:z6Mk-memory-v2-resume-cache-stale";
  const query = {
    subscribe: true,
    roots: [{
      id: "of:doc:1",
      selector: {
        path: [],
        schema: false,
      },
    }],
  } as const;

  const messages1: ServerMessage[] = [];
  const connection1 = server.connect((message) => messages1.push(message));
  await connection1.receive(JSON.stringify({
    type: "hello",
    protocol: MEMORY_V2_PROTOCOL,
  }));
  shiftMessage(messages1);

  await connection1.receive(JSON.stringify({
    type: "session.open",
    requestId: "open-1",
    space,
    session: {},
  }));
  const opened1 = assertResponse(shiftMessage(messages1));
  const sessionId = (opened1.ok as any).sessionId;

  await connection1.receive(JSON.stringify({
    type: "graph.query",
    requestId: "query-1",
    space,
    sessionId,
    query,
  }));
  const subscribed1 = assertResponse(shiftMessage(messages1));
  assertExists((subscribed1.ok as any)?.subscriptionId);
  assertEquals(server.queryCount, 1);
  connection1.close();

  const messages2: ServerMessage[] = [];
  const connection2 = server.connect((message) => messages2.push(message));
  await connection2.receive(JSON.stringify({
    type: "hello",
    protocol: MEMORY_V2_PROTOCOL,
  }));
  shiftMessage(messages2);

  await connection2.receive(JSON.stringify({
    type: "session.open",
    requestId: "open-2",
    space,
    session: {
      sessionId,
      seenSeq: (subscribed1.ok as any)?.serverSeq ?? 0,
    },
  }));
  assertResponse(shiftMessage(messages2));

  await connection2.receive(JSON.stringify({
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
            hello: "fresh",
          },
        },
      }],
    },
  }));
  assertEquals(assertResponse(shiftMessage(messages2)).requestId, "tx-1");

  await connection2.receive(JSON.stringify({
    type: "graph.query",
    requestId: "query-2",
    space,
    sessionId,
    query,
  }));
  const subscribed2 = assertResponse(shiftMessage(messages2));
  assertExists((subscribed2.ok as any)?.subscriptionId);
  assertEquals(server.queryCount, 2);
  assertEquals((subscribed2.ok as any)?.serverSeq, 1);

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
  assertEquals(
    update.result.entities.map((entity: any) => ({
      id: entity.id,
      seq: entity.seq,
      document: entity.document,
    })),
    [{
      id: "of:doc:1",
      seq: 2,
      document: {
        value: {
          version: 3,
        },
      },
    }],
  );

  const rejected = assertResponse(shiftMessage(messages));
  assertEquals(rejected.requestId, "tx-3");
  assertEquals((rejected.error as any)?.name, "ConflictError");
  assertEquals(messages.length, 0);

  await server.close();
});
