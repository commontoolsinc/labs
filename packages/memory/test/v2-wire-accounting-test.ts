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
  accountMemoryWirePayload,
  classifyServerMessage,
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

Deno.test("memory wire payload accounting conserves bytes and salts candidates per run", () => {
  const payload = encodeMemoryBoundary({
    type: "response",
    requestId: "not-an-identity-candidate",
    space: "space-identity",
    sessionId: "session-identity",
    ok: {
      invocation: {
        iss: "issuer",
        aud: "audience",
        sub: "subject",
        iat: 1,
        exp: 2,
      },
      sync: {
        type: "sync",
        schemaTable: { "schema-ref@2:hash": { type: "object" } },
        fromSeq: 1,
        toSeq: 2,
        upserts: [{
          id: "entity",
          branch: "main",
          scope: "space",
          seq: 2,
          doc: {
            value: {
              id: "user-data",
              seq: 7,
              schema: { userOwned: true },
              message: "user-owned",
              link: { "/": { "link@1": { schema: "schema-ref@2:link" } } },
              inlineLink: {
                "/": { "link@1": { schema: { type: "string" } } },
              },
            },
            schema: { type: "object" },
          },
        }],
      },
    },
  });
  const first = accountMemoryWirePayload(payload, "run-one");
  const repeated = accountMemoryWirePayload(payload, "run-one");
  const secondRun = accountMemoryWirePayload(payload, "run-two");

  assertEquals(
    Object.values(first.semanticBytes).reduce((sum, bytes) => sum + bytes, 0),
    memoryWireUtf8Bytes(payload),
  );
  assert(first.semanticBytes.schema > 0);
  assert(first.semanticBytes.documentValue > 0);
  assert(first.semanticBytes.identity > 0);
  assert(first.semanticBytes.sequence > 0);
  assert(first.semanticBytes.sessionControl > 0);
  assert(first.semanticBytes.authCapability > 0);
  assert(first.candidates.length > 0);
  assertEquals(
    first.candidates.filter((candidate) =>
      candidate.scope === "identityInternable"
    ).length,
    5,
  );
  assertEquals(first.candidates, repeated.candidates);
  assert(
    first.candidates.some((candidate, index) =>
      candidate.fingerprint !== secondRun.candidates[index]?.fingerprint
    ),
  );
  assertEquals(
    JSON.stringify(first.candidates).includes("user-data"),
    false,
  );
  assertEquals(
    first.candidates.some((candidate) =>
      candidate.scope === "identityInternable" &&
      candidate.fingerprint.includes("not-an-identity-candidate")
    ),
    false,
  );
  assertEquals(
    first.candidates.filter((candidate) =>
      candidate.category === "schema" &&
      candidate.scope === "alreadyContentAddressed"
    ).length,
    2,
  );
  assert(
    first.candidates.some((candidate) =>
      candidate.category === "schema" &&
      candidate.scope === "immutableInternable"
    ),
  );
  assertEquals(
    first.candidates
      .filter((candidate) =>
        candidate.category === "schema" &&
        candidate.scope === "alreadyContentAddressed"
      )
      .map((candidate) => candidate.encodedBytes)
      .sort((left, right) => left - right),
    [
      memoryWireUtf8Bytes(JSON.stringify({ type: "object" })),
      memoryWireUtf8Bytes(JSON.stringify("schema-ref@2:link")),
    ].sort((left, right) => left - right),
  );
  assert(
    first.candidates.reduce(
      (sum, candidate) => sum + candidate.encodedBytes,
      0,
    ) <=
      memoryWireUtf8Bytes(payload),
  );
});

Deno.test("memory wire accounting classifies request CAS definitions and refs as content-addressed schemas", () => {
  const payload = encodeMemoryBoundary({
    type: "graph.query",
    requestId: "query",
    space: "did:key:space",
    sessionId: "session",
    query: {
      roots: [{
        id: "of:root",
        selector: { path: [], schema: "schema-cas@1:sha256:test" },
      }],
    },
    schemaDefinitions: {
      "sha256:test": { type: "string" },
    },
  });
  const accounting = accountMemoryWirePayload(payload, "run");
  const schemaCandidates = accounting.candidates.filter((candidate) =>
    candidate.category === "schema"
  );

  assert(accounting.semanticBytes.schema > 0);
  assertEquals(schemaCandidates.length, 2);
  assert(
    schemaCandidates.every((candidate) =>
      candidate.scope === "alreadyContentAddressed"
    ),
  );
});

Deno.test("memory wire accounting scopes only direct protocol candidate roots", () => {
  const cases = [
    {
      name: "commit code CID",
      payload: {
        type: "transact",
        commit: { codeCID: "bafy-code", operations: [] },
      },
      category: "patchOperation",
      scope: "alreadyContentAddressed",
    },
    {
      name: "query selector",
      payload: {
        type: "graph.query",
        query: { roots: [{ selector: { path: [] } }] },
      },
      category: "queryWatch",
      scope: "immutableInternable",
    },
    {
      name: "scheduler table collection",
      payload: {
        type: "session/effect",
        effect: { db: { tables: [{ name: "actions" }] } },
      },
      category: "sqliteScheduler",
      scope: "immutableInternable",
    },
  ] as const;

  for (const { name, payload, category, scope } of cases) {
    const accounting = accountMemoryWirePayload(
      encodeMemoryBoundary(payload),
      `candidate-root-${name}`,
    );
    const matchingCandidate = accounting.candidates.find((candidate) =>
      candidate.category === category && candidate.scope === scope
    );
    assertExists(
      matchingCandidate,
      `${name} should be measured at its direct protocol root`,
    );
  }
});

Deno.test("memory wire accounting recognizes protocol identity positions only", () => {
  const identityPayload = encodeMemoryBoundary({
    type: "response",
    space: "did:key:space",
    sessionId: "session",
    ok: { sync: { type: "sync", db: { id: "database", tables: [] } } },
  });
  const rejectedLookalikes = encodeMemoryBoundary({
    type: "response",
    id: "root-id",
    doc: { value: { space: "document-space" } },
    invocation: { space: "capability-space" },
    "/": { "link@1": { schema: { id: "schema-id" } } },
  });

  assertEquals(
    accountMemoryWirePayload(identityPayload, "identity-positions").candidates
      .filter((candidate) => candidate.scope === "identityInternable").length,
    3,
  );
  assertEquals(
    accountMemoryWirePayload(rejectedLookalikes, "identity-lookalikes")
      .candidates.some((candidate) => candidate.scope === "identityInternable"),
    false,
  );
});

Deno.test("memory wire accounting classifies server effect and revocation frames", () => {
  const sync = schemaSync();
  const cases = [
    {
      message: {
        type: "hello.ok",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      } satisfies ServerMessage,
      expected: "server.hello.ok",
    },
    {
      message: {
        type: "session/effect",
        space: "did:key:space",
        sessionId: "session",
        effect: sync,
      } satisfies ServerMessage,
      expected: "server.session/effect.sync",
    },
    {
      message: {
        type: "session/revoked",
        space: "did:key:space",
        sessionId: "session",
        reason: "unauthorized",
      } satisfies ServerMessage,
      expected: "server.session/revoked",
    },
  ];

  for (const { message, expected } of cases) {
    assertEquals(classifyServerMessage(message), expected);
  }
});

Deno.test("memory wire accounting treats noncanonical payloads as opaque and partitions fingerprints", () => {
  const canonical = encodeMemoryBoundary({
    type: "response",
    ok: {
      sync: {
        type: "sync",
        upserts: [{ id: "entity", doc: { value: { title: "x" } } }],
      },
    },
  });
  const noncanonical = canonical.replace('{"type"', '{ "type"');
  const opaque = accountMemoryWirePayload(noncanonical, "run", "connection-a");
  const first = accountMemoryWirePayload(canonical, "run", "connection-a");
  const second = accountMemoryWirePayload(canonical, "run", "connection-a");
  const otherConnection = accountMemoryWirePayload(
    canonical,
    "run",
    "connection-b",
  );

  assertEquals(
    opaque.semanticBytes.encoding,
    memoryWireUtf8Bytes(noncanonical),
  );
  assertEquals(opaque.candidates, []);
  assertEquals(first.candidates, second.candidates);
  assert(
    first.candidates.some((candidate, index) =>
      candidate.fingerprint !== otherConnection.candidates[index]?.fingerprint
    ),
  );
});

Deno.test("memory wire accounting bounds opaque work and consumes retained state", () => {
  const payload = encodeMemoryBoundary({
    type: "response",
    ok: {
      sync: {
        type: "sync",
        upserts: [{
          id: "entity",
          doc: { value: { value: { value: "x" } } },
        }],
      },
    },
  });
  for (
    const limits of [
      { maxPayloadBytes: 1 },
      { maxDepth: 1 },
      { maxNodes: 1 },
      { maxCandidates: 0 },
    ]
  ) {
    const accounting = accountMemoryWirePayload(payload, "run", "connection", {
      maxPayloadBytes: 1_000_000,
      maxDepth: 64,
      maxNodes: 100_000,
      maxCandidates: 10_000,
      ...limits,
    });
    assertEquals(
      accounting.semanticBytes.encoding,
      memoryWireUtf8Bytes(payload),
    );
    assertEquals(accounting.candidates, []);
  }

  const accumulator = new MemoryWireAccountingAccumulator({ maxRecords: 1 });
  accumulator.start();
  accumulator.observe({
    direction: "inbound",
    connectionId: "a",
    classification: "client.hello",
    baselineBytes: 1,
    actualBytes: 1,
    metadata: { nested: { value: 1 } },
  });
  const detached = accumulator.snapshot();
  detached.records[0].metadata = { changed: true };
  accumulator.observe({
    direction: "inbound",
    connectionId: "a",
    classification: "client.hello",
    baselineBytes: 1,
    actualBytes: 1,
  });
  assertEquals(accumulator.isActive(), false);
  assertExists(accumulator.snapshot().truncated);
  accumulator.observe({
    direction: "outbound",
    connectionId: "ignored-after-limit",
    classification: "server.hello.ok",
    baselineBytes: 2,
    actualBytes: 2,
  });
  assertEquals(
    accumulator.snapshot().records.map((record) => record.connectionId),
    ["a"],
  );
  assertEquals(
    (accumulator.snapshot().records[0].metadata as {
      nested: { value: number };
    }).nested.value,
    1,
  );
  const stopped = accumulator.stop();
  assertExists(stopped.truncated);
  assertEquals(accumulator.snapshot().records, []);
});

Deno.test("memory wire accounting ignores user keys that resemble candidate roots", () => {
  const payload = encodeMemoryBoundary({
    type: "response",
    ok: {
      sync: {
        type: "sync",
        upserts: [{
          id: "entity",
          doc: {
            value: {
              value: { nested: true },
              patches: [{ op: "replace" }],
              tables: [{ name: "user" }],
              columns: ["user"],
              codeCID: "user-owned",
            },
          },
        }],
      },
    },
  });
  const accounting = accountMemoryWirePayload(payload, "adversarial");

  assertEquals(accounting.candidates.length, 2);
  assertEquals(
    accounting.candidates.filter((candidate) =>
      candidate.category === "documentValue"
    ).length,
    1,
  );
  assertEquals(
    accounting.candidates.filter((candidate) =>
      candidate.scope === "identityInternable"
    ).length,
    1,
  );
  assertEquals(
    accounting.candidates.reduce(
      (sum, candidate) => sum + candidate.encodedBytes,
      0,
    ) <= accounting.semanticBytes.documentValue,
    true,
  );
});

Deno.test("memory wire accounting candidates ignore nested protocol lookalikes", () => {
  const payload = encodeMemoryBoundary({
    type: "response",
    ok: {
      sync: {
        type: "sync",
        upserts: [{
          id: "entity",
          doc: {
            value: {
              doc: { value: { nested: true } },
              commit: {
                codeCID: "not-a-protocol-code-cid",
                operations: [{
                  value: { nested: true },
                  patches: [{ op: "replace", path: [], value: true }],
                }],
              },
              revisions: [{
                patches: [{ op: "replace", path: [], value: true }],
              }],
              link: { "link@1": { schema: { fake: true } } },
              $alias: { nested: { schema: { fake: true } } },
              query: {
                roots: [{ selector: { schema: { fake: true } } }],
              },
              sync: {
                schemaTable: { fake: { type: "object" } },
              },
            },
          },
        }],
      },
    },
  });
  const accounting = accountMemoryWirePayload(payload, "lookalikes");

  assertEquals(
    accounting.candidates.filter((candidate) =>
      candidate.category === "documentValue"
    ).length,
    1,
  );
  assertEquals(
    accounting.candidates.some((candidate) =>
      candidate.scope === "alreadyContentAddressed"
    ),
    false,
  );
  assertEquals(
    accounting.candidates.some((candidate) => candidate.category === "schema"),
    false,
  );
  assert(
    accounting.candidates.reduce(
      (sum, candidate) => sum + candidate.encodedBytes,
      0,
    ) <= memoryWireUtf8Bytes(payload),
  );
});

Deno.test("memory wire accounting patch candidates use exact subtree bytes", () => {
  const patches = [{
    op: "replace",
    path: "/choice",
    value: { nested: true },
  }];
  const payload = encodeMemoryBoundary({
    type: "transact",
    requestId: "patch-size",
    space: "did:key:z6Mk-patch-size",
    sessionId: "session",
    commit: { operations: [{ id: "entity", patches }] },
  });
  const accounting = accountMemoryWirePayload(payload, "patch-size");
  const patchCandidate = accounting.candidates.find((candidate) =>
    candidate.category === "patchOperation"
  );

  assertExists(patchCandidate);
  assertEquals(
    patchCandidate.encodedBytes,
    memoryWireUtf8Bytes(JSON.stringify(patches)),
  );
  assert(
    accounting.candidates.reduce(
      (sum, candidate) => sum + candidate.encodedBytes,
      0,
    ) <= memoryWireUtf8Bytes(payload),
  );
});

Deno.test("memory wire accounting keeps handshake flags and challenges in control categories", () => {
  const payload = encodeMemoryBoundary({
    type: "hello.ok",
    protocol: "memory",
    flags: {
      commitPreconditions: true,
      sqliteCommitRowLabelEval: true,
    },
    sessionOpen: {
      audience: "did:key:z6Mk-server",
      challenge: { value: "nonce", expiresAt: 123 },
    },
  });
  const accounting = accountMemoryWirePayload(payload, "handshake-run");

  assert(accounting.semanticBytes.sessionControl > 0);
  assert(accounting.semanticBytes.authCapability > 0);
  assertEquals(accounting.semanticBytes.patchOperation, 0);
  assertEquals(accounting.semanticBytes.sqliteScheduler, 0);
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
    assertEquals(
      Object.values(watched.actualSemanticBytes ?? {}).reduce(
        (sum, bytes) => sum + bytes,
        0,
      ),
      watched.actualBytes,
    );
    assertEquals(
      Object.values(watched.baselineSemanticBytes ?? {}).reduce(
        (sum, bytes) => sum + bytes,
        0,
      ),
      watched.baselineBytes,
    );
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
  assertEquals(accounting.snapshot().totals.frames, 0);
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

    assertEquals(accounting.snapshot().totals.frames, 0);
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

Deno.test("memory wire accounting payload callback exceptions are non-fatal", async () => {
  const records: MemoryWireAccountingRecord[] = [];
  const observer: MemoryWireAccountingObserver = {
    accountPayload() {
      throw new Error("payload accounting failed");
    },
    observe(record) {
      records.push(record);
    },
  };
  const server = createServer(
    "memory://wire-accounting-payload-error",
    observer,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    assertEquals(shiftMessage(messages).type, "hello.ok");
    assertEquals(records.length, 2);
    assertEquals(
      records.every((record) => record.actualSemanticBytes === undefined),
      true,
    );
  } finally {
    await server.close();
  }
});

Deno.test("memory wire accounting activity exceptions are non-fatal", async () => {
  let observed = false;
  const observer: MemoryWireAccountingObserver = {
    isActive() {
      throw new Error("activity check failed");
    },
    observe() {
      observed = true;
    },
  };
  const server = createServer(
    "memory://wire-accounting-activity-error",
    observer,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    assertEquals(shiftMessage(messages).type, "hello.ok");
    assertEquals(observed, false);
  } finally {
    await server.close();
  }
});
