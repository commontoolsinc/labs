import { assert, assertEquals, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resetRequestSchemaCasConfig,
  setRequestSchemaCasConfig,
} from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import { openSchemaStore } from "../v2/schema-store.ts";
import { Server } from "../v2/server.ts";
import { memoryWireUtf8Bytes } from "../v2/wire-accounting.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const space = "did:key:client-request-schema-cas";
const schema = (description: string): JSONSchema => ({
  type: "object",
  description: description.repeat(32),
  properties: { name: { type: "string" } },
});

class CapturingLoopbackTransport implements Transport {
  readonly sent: Array<{ payload: string; message: Record<string, unknown> }> =
    [];
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  #connectionCount = 0;
  #reconnected = Promise.withResolvers<void>();

  constructor(private server: Server) {}

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
    this.sent.push({
      payload,
      message,
    });
    await this.connection().receive(payload);
    if (this.#connectionCount >= 2 && message.type === "session.open") {
      this.#reconnected.resolve();
    }
  }

  close(): Promise<void> {
    this.disconnect(false);
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  reconnect(server = this.server): Promise<void> {
    this.server = server;
    this.disconnect(true);
    return this.#reconnected.promise;
  }

  private disconnect(notifyClient: boolean): void {
    this.#connection?.close();
    this.#connection = null;
    if (notifyClient) this.#closeReceiver(new Error("disconnect"));
  }

  private connection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.#connectionCount += 1;
      this.#connection = this.server.connect((message) => {
        this.#receiver(encodeMemoryBoundary(message));
      });
    }
    return this.#connection;
  }
}

const messagesOf = (
  transport: CapturingLoopbackTransport,
  type: string,
): Record<string, unknown>[] =>
  transport.sent.filter((frame) => frame.message.type === type).map((frame) =>
    frame.message
  );

const expectedGraphQueryFrame = (
  message: Record<string, unknown>,
  canonicalSchema: JSONSchema,
  hash: string,
  includeDefinition: boolean,
): string =>
  encodeMemoryBoundary({
    type: "graph.query",
    requestId: message.requestId,
    space: message.space,
    sessionId: message.sessionId,
    query: {
      roots: [{
        id: "of:root",
        selector: {
          path: [],
          schema: `schema-cas@1:${hash}`,
        },
      }],
    },
    ...(includeDefinition
      ? { schemaDefinitions: { [hash]: canonicalSchema } }
      : {}),
  });

const expectedInlineGraphQueryFrame = (
  message: Record<string, unknown>,
  canonicalSchema: JSONSchema,
): string =>
  encodeMemoryBoundary({
    type: "graph.query",
    requestId: message.requestId,
    space: message.space,
    sessionId: message.sessionId,
    query: {
      roots: [{
        id: "of:root",
        selector: { path: [], schema: canonicalSchema },
      }],
    },
  });

const expectedWatchSetFrame = (
  message: Record<string, unknown>,
  canonicalSchema: JSONSchema,
  hash: string,
  includeDefinition: boolean,
): string =>
  encodeMemoryBoundary({
    type: "session.watch.set",
    requestId: message.requestId,
    space: message.space,
    sessionId: message.sessionId,
    watches: [{
      id: "watch",
      kind: "graph",
      query: {
        roots: [{
          id: "of:root",
          selector: {
            path: [],
            schema: `schema-cas@1:${hash}`,
          },
        }],
      },
    }],
    ...(includeDefinition
      ? { schemaDefinitions: { [hash]: canonicalSchema } }
      : {}),
  });

const expectedInlineWatchSetFrame = (
  message: Record<string, unknown>,
  canonicalSchema: JSONSchema,
): string =>
  encodeMemoryBoundary({
    type: "session.watch.set",
    requestId: message.requestId,
    space: message.space,
    sessionId: message.sessionId,
    watches: [{
      id: "watch",
      kind: "graph",
      query: {
        roots: [{
          id: "of:root",
          selector: { path: [], schema: canonicalSchema },
        }],
      },
    }],
  });

Deno.test("memory v2 request schema CAS transfers one definition across sequential clients and reconnects", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "client-request-schema-cas-sequential-",
  });
  const url = toFileUrl(`${directory}/schemas.sqlite`);
  const requestSchema = schema("sequential request schema ");
  const canonical = internSchema(requestSchema, true);
  const firstStore = await openSchemaStore({ url });
  const firstServer = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://client-request-schema-cas-sequential-first"),
    schemaStore: firstStore,
  });
  const firstTransport = new CapturingLoopbackTransport(firstServer);
  const firstClient = await connect({ transport: firstTransport });
  let firstResourcesClosed = false;
  let secondClient: Awaited<ReturnType<typeof connect>> | undefined;
  let secondServer: Server | undefined;
  let secondStore: Awaited<ReturnType<typeof openSchemaStore>> | undefined;
  let secondTransport: CapturingLoopbackTransport | undefined;
  try {
    const firstSession = await firstClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    const query = {
      roots: [{
        id: "of:root",
        selector: { path: [], schema: requestSchema },
      }],
    };

    await firstSession.queryGraph(query);
    await firstSession.queryGraph(query);
    await firstSession.watchSet([{
      id: "watch",
      kind: "graph",
      query,
    }]);
    const [watchFrame] = firstTransport.sent.filter((frame) =>
      frame.message.type === "session.watch.set"
    );
    assertEquals(
      firstTransport.sent.filter((frame) =>
        frame.message.type === "session.watch.set"
      ).length,
      1,
    );
    const expectedWatch = expectedWatchSetFrame(
      watchFrame.message,
      canonical.schema,
      canonical.taggedHashString,
      false,
    );
    assertEquals(watchFrame.payload, expectedWatch);
    assertEquals(
      memoryWireUtf8Bytes(watchFrame.payload),
      memoryWireUtf8Bytes(expectedWatch),
    );
    await firstTransport.reconnect();
    await firstSession.queryGraph(query);
    assertEquals(
      firstTransport.sent.filter((frame) =>
        frame.message.type === "session.watch.set"
      ).length,
      1,
    );

    const sameServerTransport = new CapturingLoopbackTransport(firstServer);
    const sameServerClient = await connect({ transport: sameServerTransport });
    try {
      const sameServerSession = await sameServerClient.mount(
        space,
        {},
        testSessionOpenAuthFactory,
      );
      await sameServerSession.queryGraph(query);
    } finally {
      await sameServerClient.close();
    }

    await firstClient.close();
    await firstServer.close();
    firstStore.close();
    firstResourcesClosed = true;

    secondStore = await openSchemaStore({ url });
    assertEquals(secondStore.generation, firstStore.generation);
    secondServer = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://client-request-schema-cas-sequential-second"),
      schemaStore: secondStore,
    });
    secondTransport = new CapturingLoopbackTransport(secondServer);
    secondClient = await connect({ transport: secondTransport });
    const secondSession = await secondClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    await secondSession.queryGraph(query);

    const schemaFrames = [
      ...firstTransport.sent,
      ...sameServerTransport.sent,
      ...secondTransport.sent,
    ].filter((frame) =>
      frame.message.type === "graph.query" ||
      frame.message.type === "session.watch.set"
    );
    const graphFrames = schemaFrames.filter((frame) =>
      frame.message.type === "graph.query"
    );
    assertEquals(schemaFrames.length, 7);
    assertEquals(
      schemaFrames.map((frame) => frame.message.type),
      [
        "graph.query",
        "graph.query",
        "graph.query",
        "session.watch.set",
        "graph.query",
        "graph.query",
        "graph.query",
      ],
    );
    assertEquals(graphFrames.length, 6);
    const definitionFrames = schemaFrames.filter((frame) =>
      Object.hasOwn(frame.message, "schemaDefinitions")
    );
    assertEquals(definitionFrames.length, 1);
    assert(Object.hasOwn(schemaFrames[1].message, "schemaDefinitions"));

    for (const frame of graphFrames) {
      const includeDefinition = Object.hasOwn(
        frame.message,
        "schemaDefinitions",
      );
      const expected = expectedGraphQueryFrame(
        frame.message,
        canonical.schema,
        canonical.taggedHashString,
        includeDefinition,
      );
      assertEquals(frame.payload, expected);
      assertEquals(
        memoryWireUtf8Bytes(frame.payload),
        memoryWireUtf8Bytes(expected),
      );
      assertEquals(
        (frame.message.query as {
          roots: Array<{ selector: { schema: string } }>;
        }).roots[0].selector.schema,
        `schema-cas@1:${canonical.taggedHashString}`,
      );
      assertEquals(
        frame.message.schemaDefinitions,
        includeDefinition
          ? { [canonical.taggedHashString]: canonical.schema }
          : undefined,
      );
    }

    assertEquals(
      watchFrame.message.schemaDefinitions,
      undefined,
    );
    assertEquals(
      (watchFrame.message.watches as Array<{
        query: { roots: Array<{ selector: { schema: string } }> };
      }>)[0].query.roots[0].selector.schema,
      `schema-cas@1:${canonical.taggedHashString}`,
    );

    const expectedSchemaFrame = (
      frame: (typeof schemaFrames)[number],
    ): string =>
      frame.message.type === "graph.query"
        ? expectedGraphQueryFrame(
          frame.message,
          canonical.schema,
          canonical.taggedHashString,
          Object.hasOwn(frame.message, "schemaDefinitions"),
        )
        : expectedWatchSetFrame(
          frame.message,
          canonical.schema,
          canonical.taggedHashString,
          Object.hasOwn(frame.message, "schemaDefinitions"),
        );
    const expectedRefsOnlySchemaFrame = (
      frame: (typeof schemaFrames)[number],
    ): string =>
      frame.message.type === "graph.query"
        ? expectedGraphQueryFrame(
          frame.message,
          canonical.schema,
          canonical.taggedHashString,
          false,
        )
        : expectedWatchSetFrame(
          frame.message,
          canonical.schema,
          canonical.taggedHashString,
          false,
        );
    const expectedBytes = schemaFrames.reduce(
      (total, frame) => total + memoryWireUtf8Bytes(expectedSchemaFrame(frame)),
      0,
    );
    const actualBytes = schemaFrames.reduce(
      (total, frame) => total + memoryWireUtf8Bytes(frame.payload),
      0,
    );
    assertEquals(actualBytes, expectedBytes);

    const warmFrames = schemaFrames.slice(2);
    assert(warmFrames.length > 2);
    for (const frame of warmFrames) {
      const inlineBaseline = frame.message.type === "graph.query"
        ? expectedInlineGraphQueryFrame(frame.message, canonical.schema)
        : expectedInlineWatchSetFrame(frame.message, canonical.schema);
      assert(
        memoryWireUtf8Bytes(frame.payload) <
          memoryWireUtf8Bytes(inlineBaseline),
      );
    }
    const definitionContribution = definitionFrames.reduce(
      (total, frame) =>
        total + memoryWireUtf8Bytes(frame.payload) -
        memoryWireUtf8Bytes(expectedRefsOnlySchemaFrame(frame)),
      0,
    );
    assert(definitionContribution > 0);
  } finally {
    await secondClient?.close();
    await secondServer?.close();
    secondStore?.close();
    if (!firstResourcesClosed) {
      await firstClient.close();
      await firstServer.close();
      firstStore.close();
    }
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("memory v2 client compresses request schemas without changing logical requests", async () => {
  const store = await openSchemaStore({ url: new URL("memory:") });
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://client-request-schema-cas"),
    schemaStore: store,
  });
  const transport = new CapturingLoopbackTransport(server);
  const client = await connect({ transport });
  const firstSchema = schema("first client request schema ");
  const equivalentSchema = structuredClone(firstSchema);
  try {
    const first = await client.mount(space, {}, testSessionOpenAuthFactory);
    const query = {
      roots: [{ id: "of:root", selector: { path: [], schema: firstSchema } }],
    };
    await first.queryGraph(query);
    const [firstWire, forcedWire] = messagesOf(transport, "graph.query");
    assertEquals(Object.hasOwn(firstWire, "schemaDefinitions"), false);
    assert(Object.hasOwn(forcedWire, "schemaDefinitions"));
    assertEquals(
      (firstWire.query as { roots: { selector: { schema: string } }[] })
        .roots[0]
        .selector.schema,
      `schema-cas@1:${internSchema(firstSchema, true).taggedHashString}`,
    );
    assertEquals(query.roots[0].selector.schema, firstSchema);

    await first.queryGraph({
      roots: [{
        id: "of:root",
        selector: { path: [], schema: equivalentSchema },
      }],
    });
    const secondWire = messagesOf(transport, "graph.query").at(-1)!;
    assertEquals(Object.hasOwn(secondWire, "schemaDefinitions"), false);
    assert(
      memoryWireUtf8Bytes(encodeMemoryBoundary(secondWire)) <
        memoryWireUtf8Bytes(encodeMemoryBoundary(forcedWire)),
    );

    const second = await client.mount(
      `${space}:second`,
      {},
      testSessionOpenAuthFactory,
    );
    await second.queryGraph(query);
    assertEquals(
      Object.hasOwn(
        messagesOf(transport, "graph.query").at(-1)!,
        "schemaDefinitions",
      ),
      false,
    );

    const watchSchema = schema("watch client request schema ");
    await first.watchSet([{
      id: "watch",
      kind: "graph",
      query: {
        roots: [{ id: "of:root", selector: { path: [], schema: watchSchema } }],
      },
    }]);
    assert(
      Object.hasOwn(
        messagesOf(transport, "session.watch.set").at(-1)!,
        "schemaDefinitions",
      ),
    );

    const transactSchema = schema("transact client request schema ");
    await first.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:root",
        value: {
          value: {
            "/": {
              "link@1": { id: "of:child", path: [], schema: transactSchema },
            },
          },
        },
      }],
    });
    assert(
      Object.hasOwn(
        messagesOf(transport, "transact").at(-1)!,
        "schemaDefinitions",
      ),
    );
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

Deno.test("memory v2 client keeps request schemas inline for an old peer", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://client-request-schema-cas-old-peer"),
  });
  const transport = new CapturingLoopbackTransport(server);
  const client = await connect({ transport });
  const requestSchema = schema("old peer schema ");
  try {
    const session = await client.mount(space, {}, testSessionOpenAuthFactory);
    await session.queryGraph({
      roots: [{ id: "of:root", selector: { path: [], schema: requestSchema } }],
    });
    const wire = messagesOf(transport, "graph.query").at(-1)!;
    assertEquals(Object.hasOwn(wire, "schemaDefinitions"), false);
    assertEquals(
      (wire.query as { roots: { selector: { schema: JSONSchema } }[] }).roots[0]
        .selector.schema,
      requestSchema,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 client keeps schemas inline when its advertised CAS capability is off", async () => {
  const sent: Record<string, unknown>[] = [];
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: {
            ...getMemoryProtocolFlags(),
            requestSchemaCasV1: true,
          },
          requestSchemaCas: { generation: "generation", audience: "audience" },
          sessionOpen: {
            audience: "audience",
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
      } else if (message.type === "session.open") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId,
          ok: {
            sessionId: "session",
            sessionToken: "token",
            serverSeq: 0,
            sessionOpen: {
              audience: "audience",
              challenge: { value: "next", expiresAt: 1_000_000 },
            },
          },
        }));
      } else if (message.type === "graph.query") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId,
          ok: { serverSeq: 0, entities: [] },
        }));
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
  };
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  setRequestSchemaCasConfig(false);
  try {
    client = await connect({ transport });
    resetRequestSchemaCasConfig();
    const session = await client.mount(space);
    const requestSchema = schema("locally disabled schema CAS ");
    await session.queryGraph({
      roots: [{ id: "of:root", selector: { path: [], schema: requestSchema } }],
    });

    const hello = sent.find((message) => message.type === "hello")!;
    assertEquals(
      (hello.flags as { requestSchemaCasV1: boolean }).requestSchemaCasV1,
      false,
    );
    const wire = sent.find((message) => message.type === "graph.query")!;
    assertEquals(Object.hasOwn(wire, "schemaDefinitions"), false);
    assertEquals(
      (wire.query as { roots: { selector: { schema: JSONSchema } }[] }).roots[0]
        .selector.schema,
      requestSchema,
    );
  } finally {
    resetRequestSchemaCasConfig();
    await client?.close();
  }
});

Deno.test("memory v2 client retries MissingSchemas once with forced definitions", async () => {
  const requestSchema = schema("missing schema retry ");
  const sent: Record<string, unknown>[] = [];
  let receiver = (_payload: string) => {};
  let queryCount = 0;
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          requestSchemaCas: { generation: "generation", audience: "audience" },
          sessionOpen: {
            audience: "audience",
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
      } else if (message.type === "session.open") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId,
          ok: {
            sessionId: "session",
            sessionToken: "token",
            serverSeq: 0,
            sessionOpen: {
              audience: "audience",
              challenge: { value: "next", expiresAt: 1_000_000 },
            },
          },
        }));
      } else if (message.type === "graph.query") {
        queryCount++;
        receiver(encodeMemoryBoundary(
          queryCount === 1 || queryCount >= 3
            ? {
              type: "response",
              requestId: message.requestId,
              error: { name: "MissingSchemas", message: "missing" },
            }
            : {
              type: "response",
              requestId: message.requestId,
              ok: { serverSeq: 0, entities: [] },
            },
        ));
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
  };
  const client = await connect({ transport });
  try {
    const session = await client.mount(space);
    await session.queryGraph({
      roots: [{ id: "of:root", selector: { path: [], schema: requestSchema } }],
    });
    const requests = sent.filter((message) => message.type === "graph.query");
    assertEquals(requests.length, 2);
    assertEquals(Object.hasOwn(requests[0], "schemaDefinitions"), false);
    assert(Object.hasOwn(requests[1], "schemaDefinitions"));
    await assertRejects(
      () =>
        session.queryGraph({
          roots: [{
            id: "of:other",
            selector: { path: [], schema: requestSchema },
          }],
        }),
      Error,
      "missing",
    );
    assertEquals(
      sent.filter((message) => message.type === "graph.query").length,
      4,
    );
    const terminalRequests = sent.filter((message) =>
      message.type === "graph.query"
    );
    assertEquals(
      Object.hasOwn(terminalRequests[2], "schemaDefinitions"),
      false,
    );
    assert(Object.hasOwn(terminalRequests[3], "schemaDefinitions"));
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client preserves caller-supplied schema definitions", async () => {
  const requestSchema = schema("caller supplied definition ");
  const canonical = internSchema(requestSchema, true);
  const sent: Record<string, unknown>[] = [];
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          requestSchemaCas: { generation: "generation", audience: "audience" },
          sessionOpen: {
            audience: "audience",
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
      } else if (message.type === "graph.query") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId,
          ok: { serverSeq: 0, entities: [] },
        }));
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
  };
  const client = await connect({ transport });
  try {
    await client.request({
      type: "graph.query",
      requestId: "caller-definition",
      space,
      sessionId: "session",
      query: {
        roots: [{
          id: "of:root",
          selector: {
            path: [],
            schema: `schema-cas@1:${canonical.taggedHashString}`,
          },
        }],
      },
      schemaDefinitions: {
        [canonical.taggedHashString]: canonical.schema,
      },
    });

    const request = sent.find((message) => message.type === "graph.query");
    assertEquals(request?.schemaDefinitions, {
      [canonical.taggedHashString]: canonical.schema,
    });
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client falls back to one inline retry when the schema store rejects admission", async () => {
  const requestSchema = schema("schema store fallback ");
  const sent: Record<string, unknown>[] = [];
  let receiver = (_payload: string) => {};
  let queryCount = 0;
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          requestSchemaCas: { generation: "generation", audience: "audience" },
          sessionOpen: {
            audience: "audience",
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
      } else if (message.type === "session.open") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId,
          ok: {
            sessionId: "session",
            sessionToken: "token",
            serverSeq: 0,
            sessionOpen: {
              audience: "audience",
              challenge: { value: "next", expiresAt: 1_000_000 },
            },
          },
        }));
      } else if (message.type === "graph.query") {
        queryCount++;
        receiver(encodeMemoryBoundary(
          queryCount === 1
            ? {
              type: "response",
              requestId: message.requestId,
              error: { name: "MissingSchemas", message: "missing" },
            }
            : queryCount === 2
            ? {
              type: "response",
              requestId: message.requestId,
              error: { name: "SchemaStoreError", message: "full" },
            }
            : {
              type: "response",
              requestId: message.requestId,
              ok: { serverSeq: 0, entities: [] },
            },
        ));
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
  };
  const client = await connect({ transport });
  try {
    const session = await client.mount(space);
    await session.queryGraph({
      roots: [{ id: "of:root", selector: { path: [], schema: requestSchema } }],
    });
    const requests = sent.filter((message) => message.type === "graph.query");
    assertEquals(requests.length, 3);
    assertEquals(Object.hasOwn(requests[0], "schemaDefinitions"), false);
    assert(Object.hasOwn(requests[1], "schemaDefinitions"));
    assertEquals(Object.hasOwn(requests[2], "schemaDefinitions"), false);
    assertEquals(
      (requests[2].query as { roots: { selector: { schema: JSONSchema } }[] })
        .roots[0].selector.schema,
      requestSchema,
    );
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client bounds store rejection fallback for caller-supplied CAS", async () => {
  const requestSchema = schema("caller supplied CAS fallback ");
  const canonical = internSchema(requestSchema, true);
  const sent: Record<string, unknown>[] = [];
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          requestSchemaCas: { generation: "generation", audience: "audience" },
          sessionOpen: {
            audience: "audience",
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
      } else if (message.type === "graph.query") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId,
          error: { name: "SchemaStoreError", message: "full" },
        }));
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
  };
  const client = await connect({ transport });
  try {
    await assertRejects(
      () =>
        client.request({
          type: "graph.query",
          requestId: "caller-cas",
          space,
          sessionId: "session",
          query: {
            roots: [{
              id: "of:root",
              selector: {
                path: [],
                schema: `schema-cas@1:${canonical.taggedHashString}`,
              },
            }],
          },
        }),
      Error,
      "full",
    );
    const requests = sent.filter((message) => message.type === "graph.query");
    assertEquals(requests.length, 2);
    assertEquals(requests[0], requests[1]);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client serializes concurrent rejected CAS admissions through inline fallback", async () => {
  const requestSchema = schema("concurrent schema store fallback ");
  const canonical = internSchema(requestSchema, true);
  const sent: Record<string, unknown>[] = [];
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          requestSchemaCas: { generation: "generation", audience: "audience" },
          sessionOpen: {
            audience: "audience",
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
      } else if (message.type === "session.open") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId,
          ok: {
            sessionId: "session",
            sessionToken: "token",
            serverSeq: 0,
            sessionOpen: {
              audience: "audience",
              challenge: { value: "next", expiresAt: 1_000_000 },
            },
          },
        }));
      } else if (message.type === "graph.query") {
        const requestId = message.requestId as string;
        const selector = (message.query as {
          roots: Array<{ selector: { schema: unknown } }>;
        }).roots[0].selector.schema;
        if (Object.hasOwn(message, "schemaDefinitions")) {
          receiver(encodeMemoryBoundary({
            type: "response",
            requestId,
            error: { name: "SchemaStoreError", message: "full" },
          }));
        } else if (typeof selector === "string") {
          receiver(encodeMemoryBoundary({
            type: "response",
            requestId,
            error: { name: "MissingSchemas", message: "missing" },
          }));
        } else {
          receiver(encodeMemoryBoundary({
            type: "response",
            requestId,
            ok: { serverSeq: 0, entities: [] },
          }));
        }
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
  };
  const client = await connect({ transport });
  try {
    const session = await client.mount(space);
    await Promise.all([
      session.queryGraph({
        roots: [{
          id: "of:first",
          selector: { path: [], schema: requestSchema },
        }],
      }),
      session.queryGraph({
        roots: [{
          id: "of:second",
          selector: { path: [], schema: requestSchema },
        }],
      }),
    ]);

    const requests = sent.filter((message) => message.type === "graph.query");
    assertEquals(requests.length, 4);
    const requestsById = Map.groupBy(
      requests,
      (message) => message.requestId as string,
    );
    assertEquals(requestsById.size, 2);
    const first = requestsById.get(requests[0].requestId as string)!;
    const second = requestsById.get(requests[3].requestId as string)!;
    assertEquals(first.length, 3);
    assertEquals(second.length, 1);
    assertEquals(Object.hasOwn(first[0], "schemaDefinitions"), false);
    assertEquals(first[1].schemaDefinitions, {
      [canonical.taggedHashString]: canonical.schema,
    });
    assertEquals(Object.hasOwn(first[2], "schemaDefinitions"), false);
    assertEquals(
      (first[2].query as {
        roots: Array<{ selector: { schema: JSONSchema } }>;
      }).roots[0].selector.schema,
      canonical.schema,
    );
    assertEquals(
      (second[0].query as {
        roots: Array<{ selector: { schema: JSONSchema } }>;
      }).roots[0].selector.schema,
      canonical.schema,
    );
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client holds later requests behind a cold CAS retry", async () => {
  const requestSchema = schema("cold admission ordering ");
  const sent: Record<string, unknown>[] = [];
  const refsSent = Promise.withResolvers<void>();
  const definitionsSent = Promise.withResolvers<void>();
  const laterSent = Promise.withResolvers<void>();
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          requestSchemaCas: { generation: "generation", audience: "audience" },
          sessionOpen: {
            audience: "audience",
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
      } else if (message.requestId === "cold") {
        if (Object.hasOwn(message, "schemaDefinitions")) {
          definitionsSent.resolve();
        } else {
          refsSent.resolve();
        }
      } else if (message.requestId === "later") {
        laterSent.resolve();
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
  };
  const client = await connect({ transport });
  try {
    const cold = client.request({
      type: "graph.query",
      requestId: "cold",
      space,
      sessionId: "session",
      query: {
        roots: [{
          id: "of:cold",
          selector: { path: [], schema: requestSchema },
        }],
      },
    });
    await refsSent.promise;
    const later = client.request({
      type: "graph.query",
      requestId: "later",
      space,
      sessionId: "session",
      query: { roots: [] },
    });
    await Promise.resolve();
    assertEquals(sent.map((message) => message.requestId ?? message.type), [
      "hello",
      "cold",
    ]);

    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "cold",
      error: { name: "MissingSchemas", message: "missing" },
    }));
    await definitionsSent.promise;
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "cold",
      ok: { serverSeq: 0, entities: [] },
    }));
    await cold;
    await laterSent.promise;
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "later",
      ok: { serverSeq: 0, entities: [] },
    }));
    await later;
    assertEquals(sent.map((message) => message.requestId ?? message.type), [
      "hello",
      "cold",
      "cold",
      "later",
    ]);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client keeps confirmed CAS requests concurrent", async () => {
  const requestSchema = schema("warm admission concurrency ");
  const sent: Record<string, unknown>[] = [];
  const warmRequestsSent = Promise.withResolvers<void>();
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          requestSchemaCas: { generation: "generation", audience: "audience" },
          sessionOpen: {
            audience: "audience",
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
      } else if (message.requestId === "warmup") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: "warmup",
          ok: { serverSeq: 0, entities: [] },
        }));
      } else if (
        sent.filter((candidate) =>
          candidate.requestId === "first" || candidate.requestId === "second"
        ).length === 2
      ) {
        warmRequestsSent.resolve();
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
  };
  const client = await connect({ transport });
  const request = (requestId: string) =>
    client.request({
      type: "graph.query",
      requestId,
      space,
      sessionId: "session",
      query: {
        roots: [{
          id: "of:warm",
          selector: { path: [], schema: requestSchema },
        }],
      },
    });
  try {
    await request("warmup");
    const first = request("first");
    const second = request("second");
    await warmRequestsSent.promise;
    assertEquals(sent.map((message) => message.requestId ?? message.type), [
      "hello",
      "warmup",
      "first",
      "second",
    ]);
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "first",
      ok: { serverSeq: 0, entities: [] },
    }));
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "second",
      ok: { serverSeq: 0, entities: [] },
    }));
    await Promise.all([first, second]);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client keeps SchemaStoreError fallback inside its cold admission", async () => {
  const requestSchema = schema("store error ordering ");
  const sent: Record<string, unknown>[] = [];
  const refsSent = Promise.withResolvers<void>();
  const definitionsSent = Promise.withResolvers<void>();
  const inlineSent = Promise.withResolvers<void>();
  const laterSent = Promise.withResolvers<void>();
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          requestSchemaCas: { generation: "generation", audience: "audience" },
          sessionOpen: {
            audience: "audience",
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
      } else if (message.requestId === "cold") {
        if (Object.hasOwn(message, "schemaDefinitions")) {
          definitionsSent.resolve();
        } else if (
          typeof (message.query as { roots: unknown[] }).roots[0] === "object"
        ) {
          const selector = (message.query as {
            roots: Array<{ selector: { schema: unknown } }>;
          }).roots[0].selector;
          if (typeof selector.schema === "string") refsSent.resolve();
          else inlineSent.resolve();
        }
      } else if (message.requestId === "later") {
        laterSent.resolve();
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
  };
  const client = await connect({ transport });
  try {
    const cold = client.request({
      type: "graph.query",
      requestId: "cold",
      space,
      sessionId: "session",
      query: {
        roots: [{
          id: "of:cold",
          selector: { path: [], schema: requestSchema },
        }],
      },
    });
    await refsSent.promise;
    const later = client.request({
      type: "graph.query",
      requestId: "later",
      space,
      sessionId: "session",
      query: { roots: [] },
    });
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "cold",
      error: { name: "MissingSchemas", message: "missing" },
    }));
    await definitionsSent.promise;
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "cold",
      error: { name: "SchemaStoreError", message: "full" },
    }));
    await inlineSent.promise;
    assertEquals(sent.map((message) => message.requestId ?? message.type), [
      "hello",
      "cold",
      "cold",
      "cold",
    ]);
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "cold",
      ok: { serverSeq: 0, entities: [] },
    }));
    await cold;
    await laterSent.promise;
    const laterWire = sent.at(-1)!;
    assertEquals(
      (laterWire.query as { roots: { selector?: { schema?: unknown } }[] })
        .roots,
      [],
    );
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "later",
      ok: { serverSeq: 0, entities: [] },
    }));
    await later;
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client scopes CAS confirmations to negotiated store identity", async () => {
  const requestSchema = schema("reconnect store identity ");
  const sent: Record<string, unknown>[] = [];
  const warmSent = Promise.withResolvers<void>();
  const coldSent = Promise.withResolvers<void>();
  const laterSent = Promise.withResolvers<void>();
  const reconnected = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  let helloCount = 0;
  let identity = { generation: "generation-one", audience: "audience-one" };
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as Record<string, unknown>;
      sent.push(message);
      if (message.type === "hello") {
        helloCount += 1;
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
          requestSchemaCas: identity,
          sessionOpen: {
            audience: identity.audience,
            challenge: { value: "challenge", expiresAt: 1_000_000 },
          },
        }));
        if (helloCount > 1) reconnected[helloCount - 2].resolve();
      } else if (message.requestId === "warmup") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: "warmup",
          ok: { serverSeq: 0, entities: [] },
        }));
      } else if (
        message.requestId === "warm-first" ||
        message.requestId === "warm-second"
      ) {
        if (
          sent.filter((candidate) =>
            candidate.requestId === "warm-first" ||
            candidate.requestId === "warm-second"
          ).length === 2
        ) warmSent.resolve();
      } else if (message.requestId === "cold-after-identity-change") {
        coldSent.resolve();
      } else if (message.requestId === "later") {
        laterSent.resolve();
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      closeReceiver = next;
    },
  };
  const client = await connect({ transport });
  const request = (requestId: string) =>
    client.request({
      type: "graph.query",
      requestId,
      space,
      sessionId: "session",
      query: {
        roots: [{
          id: "of:identity",
          selector: { path: [], schema: requestSchema },
        }],
      },
    });
  try {
    await request("warmup");
    closeReceiver(new Error("disconnect"));
    await reconnected[0].promise;

    const warmFirst = request("warm-first");
    const warmSecond = request("warm-second");
    await warmSent.promise;
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "warm-first",
      ok: { serverSeq: 0, entities: [] },
    }));
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "warm-second",
      ok: { serverSeq: 0, entities: [] },
    }));
    await Promise.all([warmFirst, warmSecond]);

    identity = { generation: "generation-two", audience: "audience-two" };
    closeReceiver(new Error("disconnect"));
    await reconnected[1].promise;
    const cold = request("cold-after-identity-change");
    await coldSent.promise;
    const later = client.request({
      type: "graph.query",
      requestId: "later",
      space,
      sessionId: "session",
      query: { roots: [] },
    });
    await Promise.resolve();
    assertEquals(
      sent.filter((message) => message.requestId === "later").length,
      0,
    );
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "cold-after-identity-change",
      ok: { serverSeq: 0, entities: [] },
    }));
    await cold;
    await laterSent.promise;
    receiver(encodeMemoryBoundary({
      type: "response",
      requestId: "later",
      ok: { serverSeq: 0, entities: [] },
    }));
    await later;
  } finally {
    await client.close();
  }
});
