import { assert, assertEquals, assertExists } from "@std/assert";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import type { JSONSchema } from "@commonfabric/api";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloMessage,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type SessionSync,
  type WatchAddResult,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  MemoryWireAccountingAccumulator,
  type MemoryWireAccountingObserver,
  type MemoryWireAccountingRecord,
  memoryWireUtf8Bytes,
} from "../v2/wire-accounting.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const HELLO: HelloMessage = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const expectHelloOk = (messages: ServerMessage[]): SessionOpenAuthMetadata => {
  const message = shiftMessage(messages);
  assertEquals(message.type, "hello.ok");
  const hello = message as HelloOkMessage;
  assertExists(hello.sessionOpen);
  return hello.sessionOpen;
};

const assertResponse = <Result>(
  message: ServerMessage,
): ResponseMessage<Result> => {
  assertEquals(message.type, "response");
  return message as ResponseMessage<Result>;
};

const authInvocation = (sessionOpen: SessionOpenAuthMetadata) => ({
  aud: sessionOpen.audience,
  challenge: sessionOpen.challenge.value,
});

const flushReceiveStart = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const largeSchema = (): JSONSchema => ({
  type: "object",
  $defs: Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `Definition${index}`,
      {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          count: { type: "number" },
        },
        required: ["id", "title"],
      },
    ]),
  ),
  properties: Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `field${index}`,
      { $ref: `#/$defs/Definition${index % 32}` },
    ]),
  ),
});

const schemaSync = (): SessionSync => {
  const schema = largeSchema();
  return {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:wire-accounting-doc",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          title: "Wire accounting document",
          primary: linkRefFrom({
            id: "of:wire-accounting-target",
            path: [],
            schema,
          }),
          secondary: linkRefFrom({
            id: "of:wire-accounting-secondary",
            path: ["value"],
            schema,
          }),
        },
      },
    }],
    removes: [],
  };
};

const createServer = (
  store: string,
  observer?: MemoryWireAccountingObserver,
): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(store),
    wireAccountingObserver: observer,
  });

const openSession = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  space: string,
  hello: HelloMessage = HELLO,
): Promise<string> => {
  await connection.receive(encodeMemoryBoundary(hello));
  const sessionOpen = expectHelloOk(messages);
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "open",
    space,
    session: {},
    invocation: authInvocation(sessionOpen),
  }));
  const opened = assertResponse<SessionOpenResult>(shiftMessage(messages));
  assertExists(opened.ok);
  return opened.ok.sessionId;
};

const writeSchemaDocument = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  space: string,
  sessionId: string,
): Promise<void> => {
  const upsert = schemaSync().upserts[0];
  await connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "write",
    space,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: upsert.id,
        value: upsert.doc,
      }],
    },
  }));
  assertResponse<unknown>(shiftMessage(messages));
};

const watchSchemaDocument = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  space: string,
  sessionId: string,
): Promise<void> => {
  await connection.receive(encodeMemoryBoundary({
    type: "session.watch.add",
    requestId: "watch",
    space,
    sessionId,
    watches: [{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: "of:wire-accounting-doc",
          selector: { path: [], schema: false },
        }],
      },
    }],
  }));
  const watched = assertResponse<WatchAddResult>(shiftMessage(messages));
  assertExists(watched.ok?.sync);
};

Deno.test("memory wire accounting is optional for existing server connections", async () => {
  const server = createServer("memory://wire-accounting-no-observer");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message), {
    kind: "browser",
  });

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    assertEquals(shiftMessage(messages).type, "hello.ok");
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting records inbound payload bytes exactly", async () => {
  const accounting = new MemoryWireAccountingAccumulator();
  accounting.start();
  const server = createServer("memory://wire-accounting-inbound", accounting);
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message), {
    kind: "browser",
  });
  const invalidPayload = '{"type":"broken-π"';

  try {
    await connection.receive(invalidPayload);
    assertEquals(shiftMessage(messages).type, "response");
    const inbound = accounting.snapshot().records.find((record) =>
      record.direction === "inbound" &&
      record.classification === "client.invalid"
    );
    assertExists(inbound);
    assertEquals(inbound.baselineBytes, memoryWireUtf8Bytes(invalidPayload));
    assertEquals(inbound.actualBytes, inbound.baselineBytes);
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting reports negotiated server sync schema savings", async () => {
  const accounting = new MemoryWireAccountingAccumulator();
  accounting.start();
  const server = createServer(
    "memory://wire-accounting-negotiated",
    accounting,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message), {
    kind: "browser",
  });
  const space = "did:key:z6Mk-wire-accounting-negotiated";

  try {
    const sessionId = await openSession(connection, messages, space);
    await writeSchemaDocument(connection, messages, space, sessionId);
    await watchSchemaDocument(connection, messages, space, sessionId);

    const watched = accounting.snapshot().records.find((record) =>
      record.classification === "server.response.session.watch.add.sync"
    );
    assertExists(watched);
    assert(watched.actualBytes < watched.baselineBytes);
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting reports unnegotiated server sync equality", async () => {
  const accounting = new MemoryWireAccountingAccumulator();
  accounting.start();
  const server = createServer(
    "memory://wire-accounting-unnegotiated",
    accounting,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message), {
    kind: "browser",
  });
  const flags = getMemoryProtocolFlags();
  const space = "did:key:z6Mk-wire-accounting-unnegotiated";
  const hello = {
    type: "hello",
    protocol: MEMORY_PROTOCOL,
    flags: {
      modernCellRep: flags.modernCellRep,
      persistentSchedulerState: flags.persistentSchedulerState,
      commitPreconditions: flags.commitPreconditions,
    },
  } as const;

  try {
    const sessionId = await openSession(connection, messages, space, hello);
    await writeSchemaDocument(connection, messages, space, sessionId);
    await watchSchemaDocument(connection, messages, space, sessionId);

    const watched = accounting.snapshot().records.find((record) =>
      record.classification === "server.response.session.watch.add.sync"
    );
    assertExists(watched);
    assertEquals(watched.actualBytes, watched.baselineBytes);
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting names response records by originating request", async () => {
  const accounting = new MemoryWireAccountingAccumulator();
  accounting.start();
  const server = createServer(
    "memory://wire-accounting-response-origin",
    accounting,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-wire-accounting-response-origin";

  try {
    const sessionId = await openSession(connection, messages, space);
    await writeSchemaDocument(connection, messages, space, sessionId);
    const rows = accounting.snapshot().byClassification;
    assertExists(
      rows.find((row) => row.key === "server.response.session.open"),
    );
    assertExists(rows.find((row) => row.key === "server.response.transact"));
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting aggregates by connection and metadata kind", async () => {
  const accounting = new MemoryWireAccountingAccumulator();
  accounting.start();
  const server = createServer("memory://wire-accounting-metadata", accounting);
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  const first = server.connect((message) => firstMessages.push(message), {
    kind: "browser",
    runtime: "shell",
  });
  const second = server.connect((message) => secondMessages.push(message), {
    kind: "worker",
  });

  try {
    await first.receive(encodeMemoryBoundary(HELLO));
    await second.receive(encodeMemoryBoundary(HELLO));
    shiftMessage(firstMessages);
    shiftMessage(secondMessages);

    const report = accounting.snapshot();
    const browser = report.byMetadataKind.find((row) => row.key === "browser");
    const worker = report.byMetadataKind.find((row) => row.key === "worker");
    assertExists(browser);
    assertExists(worker);
    assertEquals(browser.connections, 1);
    assertEquals(worker.connections, 1);
    assertEquals(report.byConnection.length, 2);
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting accumulator supports reset start stop snapshot", () => {
  const accounting = new MemoryWireAccountingAccumulator();
  const record: MemoryWireAccountingRecord = {
    direction: "inbound",
    connectionId: "connection:one",
    metadata: { kind: "browser" },
    classification: "client.hello",
    baselineBytes: 10,
    actualBytes: 10,
  };

  accounting.observe(record);
  assertEquals(accounting.snapshot().totals.frames, 0);

  accounting.start();
  accounting.observe(record);
  assertEquals(accounting.snapshot().totals.frames, 1);

  accounting.reset();
  assertEquals(accounting.snapshot().totals.frames, 0);
  accounting.observe(record);
  assertEquals(accounting.stop().totals.frames, 1);

  accounting.observe(record);
  assertEquals(accounting.snapshot().totals.frames, 1);
});

Deno.test("memory wire accounting accumulator starts request bookkeeping only when active", async () => {
  const accounting = new MemoryWireAccountingAccumulator();
  const server = createServer(
    "memory://wire-accounting-start-gate",
    accounting,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-wire-accounting-start-gate";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    expectHelloOk(messages);
    assertEquals(accounting.snapshot().totals.frames, 0);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-before-start",
      space,
      session: {},
      invocation: { aud: "wrong", challenge: "wrong" },
    }));
    assertResponse<SessionOpenResult>(shiftMessage(messages));
    assertEquals(accounting.snapshot().totals.frames, 0);

    accounting.start();
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-after-start",
      space,
      session: {},
      invocation: { aud: "wrong", challenge: "wrong" },
    }));
    assertResponse<SessionOpenResult>(shiftMessage(messages));

    const activeOrigin = accounting.snapshot().records.find((record) =>
      record.classification === "server.response.session.open.error"
    );
    assertExists(activeOrigin);
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting accumulator stops connection records immediately", async () => {
  const accounting = new MemoryWireAccountingAccumulator();
  const server = createServer("memory://wire-accounting-stop-gate", accounting);
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    accounting.start();
    await connection.receive(encodeMemoryBoundary(HELLO));
    expectHelloOk(messages);
    const stopped = accounting.stop();
    assertEquals(stopped.totals.frames, 2);

    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    assertResponse<unknown>(shiftMessage(messages));

    assertEquals(accounting.snapshot().totals.frames, 2);
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting cleans request origins when response is sent while stopped", async () => {
  const accounting = new MemoryWireAccountingAccumulator();
  const authorizations: PromiseWithResolvers<string | undefined>[] = [];
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://wire-accounting-stopped-response-cleanup"),
    authorizeSessionOpen() {
      const authorization = Promise.withResolvers<string | undefined>();
      authorizations.push(authorization);
      return authorization.promise;
    },
    wireAccountingObserver: accounting,
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-wire-accounting-stopped-response-cleanup";
  const requestId = "reused-open-request";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const firstSessionOpen = expectHelloOk(messages);

    accounting.start();
    const firstReceive = connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId,
      space,
      session: {},
      invocation: authInvocation(firstSessionOpen),
    }));
    await flushReceiveStart();
    assertEquals(authorizations.length, 1);

    accounting.stop();
    authorizations.shift()?.resolve("did:key:z6Mk-wire-accounting-principal");
    await firstReceive;
    const firstOpened = assertResponse<SessionOpenResult>(
      shiftMessage(messages),
    );
    assertExists(firstOpened.ok?.sessionOpen);

    const secondReceive = connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId,
      space,
      session: {},
      invocation: authInvocation(firstOpened.ok.sessionOpen),
    }));
    await flushReceiveStart();
    assertEquals(authorizations.length, 1);

    accounting.start();
    authorizations.shift()?.resolve("did:key:z6Mk-wire-accounting-principal");
    await secondReceive;
    assertResponse<SessionOpenResult>(shiftMessage(messages));

    const records = accounting.snapshot().records;
    assertExists(records.find((record) =>
      record.direction === "outbound" &&
      record.classification === "server.response.unknown"
    ));
    assertEquals(
      records.some((record) =>
        record.direction === "outbound" &&
        record.classification === "server.response.session.open"
      ),
      false,
    );
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting observer exceptions are non-fatal", async () => {
  const observer: MemoryWireAccountingObserver = {
    observe() {
      throw new Error("observer failed");
    },
  };
  const server = createServer(
    "memory://wire-accounting-observer-error",
    observer,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    assertEquals(shiftMessage(messages).type, "hello.ok");
  } finally {
    await server.close();
  }
});
