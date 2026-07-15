import { assert, assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import type { JSONSchema } from "@commonfabric/api";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
} from "../v2.ts";
import { compressRequestSchemas } from "../v2/request-schema-cas.ts";
import { openSchemaStore, type SchemaStore } from "../v2/schema-store.ts";
import { Server } from "../v2/server.ts";
import {
  MemoryWireAccountingAccumulator,
  memoryWireUtf8Bytes,
} from "../v2/wire-accounting.ts";

const audience = "did:key:request-schema-cas-server";
const space = "did:key:request-schema-cas-space";
const schema: JSONSchema = {
  type: "object",
  description: "request schema CAS accounting ".repeat(32),
  properties: { name: { type: "string" } },
};
const hash = internSchema(schema, true).taggedHashString;

const shift = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message);
  return message;
};

const response = <Result>(message: ServerMessage): ResponseMessage<Result> => {
  assertEquals(message.type, "response");
  return message as ResponseMessage<Result>;
};

const createServer = (
  schemaStore?: SchemaStore,
  wireAccountingObserver?: MemoryWireAccountingAccumulator,
) =>
  new Server({
    store: new URL("memory://request-schema-cas-server"),
    schemaStore,
    wireAccountingObserver,
    authorizeSessionOpen: () => "did:key:request-schema-cas-principal",
    sessionOpenAuth: { audience },
  });

const open = async (server: Server) => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary({
    type: "hello",
    protocol: MEMORY_PROTOCOL,
    flags: getMemoryProtocolFlags(),
  }));
  const hello = shift(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  const sessionOpen = hello.sessionOpen!;
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
  const opened = response<{ sessionId: string }>(shift(messages));
  return { connection, messages, sessionId: opened.ok!.sessionId, hello };
};

const query = (sessionId: string) => ({
  type: "graph.query" as const,
  requestId: "query",
  space,
  sessionId,
  query: {
    roots: [{ id: "of:root", selector: { path: [], schema } }],
  },
});

Deno.test("server advertises request CAS only with an injected store", async () => {
  const withoutStore = createServer();
  const store = await openSchemaStore({ url: new URL("memory:") });
  const withStore = createServer(store);
  try {
    const without = await open(withoutStore);
    assertEquals(without.hello.flags.requestSchemaCasV1, false);
    assertEquals(without.hello.requestSchemaCas, undefined);

    const withCas = await open(withStore);
    assertEquals(withCas.hello.flags.requestSchemaCasV1, true);
    assertEquals(withCas.hello.requestSchemaCas, {
      generation: store.generation,
      audience,
    });
  } finally {
    await withoutStore.close();
    await withStore.close();
    store.close();
  }
});

Deno.test("server expands authorized definitions, persists them, and accepts later refs", async () => {
  const store = await openSchemaStore({ url: new URL("memory:") });
  const server = createServer(store);
  try {
    const { connection, messages, sessionId } = await open(server);
    const first = compressRequestSchemas(query(sessionId), {
      isKnownSchemaHash: () => false,
    });
    await connection.receive(encodeMemoryBoundary(first));
    assertEquals(response(shift(messages)).error, undefined);
    assertEquals(store.get(hash)?.schema, internSchema(schema, true).schema);

    const later = compressRequestSchemas({
      ...query(sessionId),
      requestId: "later",
    }, {
      isKnownSchemaHash: (candidate) => candidate === hash,
    });
    await connection.receive(encodeMemoryBoundary(later));
    assertEquals(response(shift(messages)).error, undefined);
  } finally {
    await server.close();
    store.close();
  }
});

Deno.test("outbound sync compression records schema evidence in the shared store", async () => {
  const store = await openSchemaStore({ url: new URL("memory:") });
  const server = createServer(store);
  try {
    server.compressServerMessageSchemas({
      type: "session/effect",
      space,
      sessionId: "session",
      effect: {
        type: "sync",
        fromSeq: 0,
        toSeq: 0,
        upserts: [{
          branch: "",
          id: "of:root",
          seq: 0,
          doc: {
            value: {
              "/": { "link@1": { id: "of:child", path: [], schema } },
            },
          },
        }],
        removes: [],
      },
    });
    assertEquals(store.get(hash)?.schema, internSchema(schema, true).schema);
  } finally {
    await server.close();
    store.close();
  }
});

Deno.test("outbound sync compression still succeeds when schema seeding is full", async () => {
  const store = await openSchemaStore({
    url: new URL("memory:"),
    maxEntries: 0,
  });
  const server = createServer(store);
  try {
    const compressed = server.compressServerMessageSchemas({
      type: "session/effect",
      space,
      sessionId: "session",
      effect: {
        type: "sync",
        fromSeq: 0,
        toSeq: 0,
        upserts: [{
          branch: "",
          id: "of:root",
          seq: 0,
          doc: {
            value: {
              "/": { "link@1": { id: "of:child", path: [], schema } },
            },
          },
        }],
        removes: [],
      },
    });
    assertEquals(compressed.type, "session/effect");
    if (compressed.type !== "session/effect") {
      throw new Error("expected session effect");
    }
    assertEquals(Object.hasOwn(compressed.effect, "schemaTable"), false);
    assertEquals(store.has(hash), false);
  } finally {
    await server.close();
    store.close();
  }
});

Deno.test("server returns protocol errors for malformed request CAS envelopes", async () => {
  const store = await openSchemaStore({ url: new URL("memory:") });
  const server = createServer(store);
  try {
    const { connection, messages, sessionId } = await open(server);
    const malformed = [
      {
        type: "graph.query",
        requestId: "bad-query",
        space,
        sessionId,
        query: { roots: [{}] },
        schemaDefinitions: { [hash]: schema },
      },
      {
        type: "session.watch.add",
        requestId: "bad-watch",
        space,
        sessionId,
        watches: [{}],
        schemaDefinitions: { [hash]: schema },
      },
      {
        type: "transact",
        requestId: "bad-transact",
        space,
        sessionId,
        commit: {},
        schemaDefinitions: { [hash]: schema },
      },
    ];
    for (const request of malformed) {
      await connection.receive(encodeMemoryBoundary(request));
      assertEquals(response(shift(messages)).error?.name, "ProtocolError");
      assertEquals(store.has(hash), false);
    }

    let nested: unknown = {
      "/": {
        "link@1": {
          id: "of:child",
          path: [],
          schema: `schema-cas@1:${hash}`,
        },
      },
    };
    for (let depth = 0; depth < 65; depth += 1) nested = { nested };
    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "too-deep",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:root", value: nested }],
      },
    }));
    assertEquals(response(shift(messages)).error?.name, "ProtocolError");
    assertEquals(store.has(hash), false);

    let inlineNested: unknown = { inline: true };
    for (let depth = 0; depth < 65; depth += 1) {
      inlineNested = { nested: inlineNested };
    }
    const inlineRequest = {
      type: "transact",
      requestId: "deep-inline",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:inline", value: inlineNested }],
      },
    };
    await connection.receive(encodeMemoryBoundary({
      ...inlineRequest,
      requestId: "deep-definitions",
      schemaDefinitions: {},
    }));
    assertEquals(response(shift(messages)).error?.name, "ProtocolError");
    await connection.receive(encodeMemoryBoundary(inlineRequest));
    assertEquals(response(shift(messages)).error, undefined);
  } finally {
    await server.close();
    store.close();
  }
});

Deno.test("server normalizes CAS transact schemas before storage and replay", async () => {
  const store = await openSchemaStore({ url: new URL("memory:") });
  const server = createServer(store);
  try {
    const { connection, messages, sessionId } = await open(server);
    const request = {
      type: "transact" as const,
      requestId: "tx",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set" as const,
          id: "of:root",
          value: {
            value: {
              "/": { "link@1": { id: "of:child", path: [], schema } },
            },
          },
        }],
      },
    };
    await connection.receive(
      encodeMemoryBoundary(compressRequestSchemas(request, {
        isKnownSchemaHash: () => false,
      })),
    );
    assertEquals(response(shift(messages)).error, undefined);
    assertEquals(
      ((await server.readDocument(space, "of:root"))!.value as {
        "/": { "link@1": { schema: JSONSchema } };
      })["/"]["link@1"].schema,
      internSchema(schema, true).schema,
    );

    await connection.receive(encodeMemoryBoundary(compressRequestSchemas({
      ...request,
      requestId: "replay",
    }, { isKnownSchemaHash: (candidate) => candidate === hash })));
    assertEquals(response(shift(messages)).error, undefined);
  } finally {
    await server.close();
    store.close();
  }
});

Deno.test("server rejects missing, mismatched, and unnegotiated request CAS safely", async () => {
  const store = await openSchemaStore({ url: new URL("memory:") });
  const server = createServer(store);
  const withoutStore = createServer();
  try {
    const withCas = await open(server);
    const missing = compressRequestSchemas(query(withCas.sessionId), {
      isKnownSchemaHash: () => true,
    });
    await withCas.connection.receive(encodeMemoryBoundary(missing));
    assertEquals(
      response(shift(withCas.messages)).error?.name,
      "MissingSchemas",
    );
    assertEquals(store.has(hash), false);

    const mismatch = {
      ...query(withCas.sessionId),
      schemaDefinitions: { [hash]: false },
    };
    await withCas.connection.receive(encodeMemoryBoundary(mismatch));
    assertEquals(
      response(shift(withCas.messages)).error?.name,
      "ProtocolError",
    );

    const legacy = await open(withoutStore);
    await legacy.connection.receive(encodeMemoryBoundary(compressRequestSchemas(
      query(legacy.sessionId),
      { isKnownSchemaHash: () => false },
    )));
    assertEquals(response(shift(legacy.messages)).error?.name, "ProtocolError");
  } finally {
    await server.close();
    await withoutStore.close();
    store.close();
  }
});

Deno.test("server persists request schemas across server restarts", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "server-request-schema-cas-",
  });
  const url = toFileUrl(`${directory}/schemas.sqlite`);
  const firstStore = await openSchemaStore({ url });
  const first = createServer(firstStore);
  try {
    const { connection, messages, sessionId } = await open(first);
    await connection.receive(encodeMemoryBoundary(compressRequestSchemas(
      query(sessionId),
      { isKnownSchemaHash: () => false },
    )));
    shift(messages);
  } finally {
    await first.close();
    firstStore.close();
  }
  const secondStore = await openSchemaStore({ url });
  const second = createServer(secondStore);
  try {
    const { connection, messages, sessionId } = await open(second);
    await connection.receive(encodeMemoryBoundary(compressRequestSchemas(
      query(sessionId),
      { isKnownSchemaHash: (candidate) => candidate === hash },
    )));
    assertEquals(response(shift(messages)).error, undefined);
  } finally {
    await second.close();
    secondStore.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("inbound request CAS accounting distinguishes cold, forced, and warm frames", async () => {
  const store = await openSchemaStore({ url: new URL("memory:") });
  const accounting = new MemoryWireAccountingAccumulator();
  const server = createServer(store, accounting);
  try {
    const { connection, messages, sessionId } = await open(server);
    accounting.start();

    const cold = compressRequestSchemas({
      ...query(sessionId),
      requestId: "cold",
    }, { isKnownSchemaHash: () => true });
    const forced = compressRequestSchemas({
      ...query(sessionId),
      requestId: "forced",
    }, {
      isKnownSchemaHash: () => true,
      forceDefinitions: true,
    });
    const warm = compressRequestSchemas({
      ...query(sessionId),
      requestId: "warm",
    }, {
      isKnownSchemaHash: (candidate) => candidate === hash,
    });
    const inline = (requestId: string) => ({
      ...query(sessionId),
      requestId,
      query: {
        roots: [{
          id: "of:root",
          selector: {
            path: [],
            schema: internSchema(schema, true).schema,
          },
        }],
      },
    });

    await connection.receive(encodeMemoryBoundary(cold));
    assertEquals(response(shift(messages)).error?.name, "MissingSchemas");
    await connection.receive(encodeMemoryBoundary(forced));
    assertEquals(response(shift(messages)).error, undefined);
    await connection.receive(encodeMemoryBoundary(warm));
    assertEquals(response(shift(messages)).error, undefined);

    const records = accounting.stop().records.filter((record) =>
      record.direction === "inbound" &&
      record.classification === "client.graph.query"
    );
    assertEquals(records.length, 3);
    const [coldRecord, forcedRecord, warmRecord] = records;
    const coldPayload = encodeMemoryBoundary(cold);
    const forcedPayload = encodeMemoryBoundary(forced);
    const warmPayload = encodeMemoryBoundary(warm);
    const forcedInlinePayload = encodeMemoryBoundary(inline("forced"));
    const warmInlinePayload = encodeMemoryBoundary(inline("warm"));

    assertEquals(coldRecord.baselineBytes, memoryWireUtf8Bytes(coldPayload));
    assertEquals(coldRecord.actualBytes, memoryWireUtf8Bytes(coldPayload));
    assertEquals(forcedRecord.actualBytes, memoryWireUtf8Bytes(forcedPayload));
    assertEquals(
      forcedRecord.baselineBytes,
      memoryWireUtf8Bytes(forcedInlinePayload),
    );
    assertEquals(warmRecord.actualBytes, memoryWireUtf8Bytes(warmPayload));
    assertEquals(
      warmRecord.baselineBytes,
      memoryWireUtf8Bytes(warmInlinePayload),
    );
    assert(warmRecord.actualBytes < warmRecord.baselineBytes);

    for (const record of [forcedRecord, warmRecord]) {
      assertEquals(
        Object.values(record.actualSemanticBytes ?? {}).reduce(
          (total, bytes) => total + bytes,
          0,
        ),
        record.actualBytes,
      );
      assertEquals(
        Object.values(record.baselineSemanticBytes ?? {}).reduce(
          (total, bytes) => total + bytes,
          0,
        ),
        record.baselineBytes,
      );
    }
  } finally {
    await server.close();
    store.close();
  }
});
