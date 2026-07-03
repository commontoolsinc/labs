import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { LINK_V1_TAG, linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import type { JSONSchema } from "@commonfabric/api";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type SessionSync,
  type WatchAddResult,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  compressServerMessageSchemas,
  compressSessionSyncSchemas,
  expandServerMessageSchemas,
  expandSessionSyncSchemas,
  type SchemaTableSessionSync,
} from "../v2/sync-schema-table.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const textEncoder = new TextEncoder();

const encodedBytes = (value: ServerMessage): number =>
  textEncoder.encode(encodeMemoryBoundary(value)).byteLength;

const largeSchema = (): JSONSchema => ({
  type: "object",
  $defs: Object.fromEntries(
    Array.from({ length: 48 }, (_, index) => [
      `Definition${index}`,
      {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          count: { type: "number" },
          active: { type: "boolean" },
        },
        required: ["id", "title"],
      },
    ]),
  ),
  properties: Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [
      `field${index}`,
      { $ref: `#/$defs/Definition${index % 48}` },
    ]),
  ),
});

const repeatedSchemaSync = (
  count = 128,
): SessionSync => {
  const schema = largeSchema();
  return {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: Array.from({ length: count }, (_, index) => ({
      branch: "",
      id: `of:test-${index}`,
      scope: "space" as const,
      seq: 1,
      doc: {
        value: {
          title: `Document ${index}`,
          primary: linkRefFrom({
            id: `of:target-${index}`,
            path: [],
            schema,
          }),
          secondary: linkRefFrom({
            id: `of:secondary-${index}`,
            path: ["nested"],
            schema,
          }),
        },
      },
    })),
    removes: [],
  };
};

const syncEffect = (effect: SessionSync): SessionEffectMessage => ({
  type: "session/effect",
  space: "did:key:z6Mk-sync-schema-table",
  sessionId: "session:sync-schema-table",
  effect,
});

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
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

const authInvocation = (sessionOpen: SessionOpenAuthMetadata) => ({
  aud: sessionOpen.audience,
  challenge: sessionOpen.challenge.value,
});

Deno.test("sync schema table experiment captures repeated schema savings", () => {
  const sync = repeatedSchemaSync();
  const message = syncEffect(sync);
  const bytes = encodedBytes(message);
  const schemaMarkerCount =
    encodeMemoryBoundary(message).split("$defs").length -
    1;
  const compressed = compressServerMessageSchemas(message);
  const compressedBytes = encodedBytes(compressed);
  const compressedSchemaMarkerCount = encodeMemoryBoundary(compressed)
    .split("$defs").length - 1;
  const expanded = expandServerMessageSchemas(compressed);

  assertEquals(expanded, message);
  assert(
    schemaMarkerCount >= sync.upserts.length,
    "baseline fixture should repeat schema definitions across many upserts",
  );
  assert(
    compressedSchemaMarkerCount < schemaMarkerCount / 100,
    "schema-table encoding should remove almost all repeated schema definitions",
  );
  assert(
    compressedBytes < bytes / 5,
    "schema-table encoding should materially reduce repeated schema frames",
  );
});

Deno.test("sync schema table round-trips legacy aliases nested in arrays", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
    },
  };
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:legacy-alias-source",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          aliases: [
            {
              $alias: {
                id: "of:legacy-target",
                path: [],
                schema,
              },
            },
            {
              $alias: {
                id: "of:string-schema-target",
                path: [],
                schema: "opaque-schema-name",
              },
            },
            {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:no-schema-target",
                  path: [],
                },
              },
            },
          ],
        },
      },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  const compressedAliases =
    (compressed.upserts[0].doc?.value as Record<string, unknown>)
      .aliases as Record<string, unknown>[];
  const schemaHash = internSchema(schema, true).taggedHashString;

  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [schemaHash]);
  assertEquals(
    (compressedAliases[0].$alias as Record<string, unknown>).schema,
    `schema-ref@2:${schemaHash}`,
  );
  assertEquals(
    (compressedAliases[1].$alias as Record<string, unknown>).schema,
    "opaque-schema-name",
  );
  assertEquals(
    (
      (compressedAliases[2]["/"] as Record<string, unknown>)[
        LINK_V1_TAG
      ] as Record<string, unknown>
    ).schema,
    undefined,
  );
  assertEquals(expandSessionSyncSchemas(compressed), sync);
});

Deno.test("sync schema table continues through sibling fields after link payloads", () => {
  const primarySchema: JSONSchema = {
    type: "object",
    properties: { title: { type: "string" } },
  };
  const siblingSchema: JSONSchema = {
    type: "object",
    properties: { count: { type: "number" } },
  };
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:link-with-sibling",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          compound: {
            "/": {
              [LINK_V1_TAG]: {
                id: "of:primary",
                path: [],
                schema: primarySchema,
              },
            },
            sibling: linkRefFrom({
              id: "of:sibling",
              path: [],
              schema: siblingSchema,
            }),
          },
        },
      },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  const compressedCompound =
    (compressed.upserts[0].doc?.value as Record<string, unknown>)
      .compound as Record<string, unknown>;
  const compressedPayload =
    (compressedCompound["/"] as Record<string, unknown>)[
      LINK_V1_TAG
    ] as Record<string, unknown>;
  const compressedSiblingPayload =
    ((compressedCompound.sibling as Record<string, unknown>)[
      "/"
    ] as Record<string, unknown>)[LINK_V1_TAG] as Record<string, unknown>;
  const primaryHash = internSchema(primarySchema, true).taggedHashString;
  const siblingHash = internSchema(siblingSchema, true).taggedHashString;

  assertExists(compressed.schemaTable);
  assertEquals(
    Object.keys(compressed.schemaTable).sort(),
    [primaryHash, siblingHash].sort(),
  );
  assertEquals(compressedPayload.schema, `schema-ref@2:${primaryHash}`);
  assertEquals(compressedSiblingPayload.schema, `schema-ref@2:${siblingHash}`);
  assertEquals(expandSessionSyncSchemas(compressed), sync);
});

Deno.test("sync schema table leaves syncs without compressible schemas unchanged", () => {
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [
      {
        branch: "",
        id: "of:missing-doc",
        scope: "space",
        seq: 1,
      },
      {
        branch: "",
        id: "of:no-compressible-schema",
        scope: "space",
        seq: 1,
        doc: {
          value: {
            ref: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:string-schema",
                  path: [],
                  schema: "opaque-schema-name",
                },
              },
            },
          },
        },
      },
    ],
    removes: [],
  };
  const emptyTableSync: SchemaTableSessionSync = { ...sync, schemaTable: {} };

  assertStrictEquals(compressSessionSyncSchemas(sync), sync);
  assertStrictEquals(expandSessionSyncSchemas(sync), sync);
  assertStrictEquals(expandSessionSyncSchemas(emptyTableSync), emptyTableSync);
});

Deno.test("sync schema table expands unused tables and rejects bad refs", () => {
  const schema: JSONSchema = { type: "string" };
  const schemaHash = internSchema(schema, true).taggedHashString;
  const syncWithUnusedTable: SchemaTableSessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [
      {
        branch: "",
        id: "of:missing-doc",
        scope: "space",
        seq: 1,
      },
      {
        branch: "",
        id: "of:non-ref-schema",
        scope: "space",
        seq: 1,
        doc: {
          value: {
            ref: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:non-ref-schema-target",
                  path: [],
                  schema: "opaque-schema-name",
                },
              },
            },
            refWithoutSchema: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:no-schema-target",
                  path: [],
                },
              },
            },
          },
        },
      },
    ],
    removes: [],
    schemaTable: { [schemaHash]: schema },
  };

  const expanded = expandSessionSyncSchemas(syncWithUnusedTable);
  const { schemaTable: _unusedSchemaTable, ...syncWithoutTable } =
    syncWithUnusedTable;
  assertEquals(expanded, syncWithoutTable);
  assertEquals(Object.hasOwn(expanded, "schemaTable"), false);
  assert(Object.isFrozen(expanded));

  assertThrows(
    () =>
      expandSessionSyncSchemas({
        ...syncWithUnusedTable,
        upserts: [{
          branch: "",
          id: "of:bad-ref",
          scope: "space",
          seq: 1,
          doc: {
            value: {
              ref: {
                "/": {
                  [LINK_V1_TAG]: {
                    id: "of:bad-ref-target",
                    path: [],
                    schema: "schema-ref@2:sha256:missing",
                  },
                },
              },
            },
          },
        }],
      }),
    Error,
    "Invalid sync schema table reference",
  );

  assertThrows(
    () =>
      expandSessionSyncSchemas({
        ...syncWithUnusedTable,
        upserts: [{
          branch: "",
          id: "of:poisoned-ref",
          scope: "space",
          seq: 1,
          doc: {
            value: {
              ref: {
                "/": {
                  [LINK_V1_TAG]: {
                    id: "of:poisoned-ref-target",
                    path: [],
                    schema: `schema-ref@2:${schemaHash}`,
                  },
                },
              },
            },
          },
        }],
        schemaTable: { [schemaHash]: { type: "number" } },
      }),
    Error,
    "Invalid sync schema table content",
  );
});

Deno.test("server schema table helpers ignore non-sync messages", () => {
  const hello = {
    type: "hello.ok",
    protocol: MEMORY_PROTOCOL,
    flags: getMemoryProtocolFlags(),
  } satisfies ServerMessage;
  const responseWithoutOk = {
    type: "response",
    requestId: "without-ok",
  } satisfies ServerMessage;
  const responseWithPrimitiveOk = {
    type: "response",
    requestId: "primitive-ok",
    ok: "done",
  } satisfies ServerMessage;
  const responseWithNonSyncOk = {
    type: "response",
    requestId: "non-sync",
    ok: { sync: { type: "not-sync" } },
  } satisfies ServerMessage;

  assertStrictEquals(compressServerMessageSchemas(hello), hello);
  assertStrictEquals(
    compressServerMessageSchemas(responseWithoutOk),
    responseWithoutOk,
  );
  assertStrictEquals(
    compressServerMessageSchemas(responseWithPrimitiveOk),
    responseWithPrimitiveOk,
  );
  assertStrictEquals(
    compressServerMessageSchemas(responseWithNonSyncOk),
    responseWithNonSyncOk,
  );

  assertStrictEquals(
    expandServerMessageSchemas("not-an-object"),
    "not-an-object",
  );
  assertStrictEquals(
    expandServerMessageSchemas(responseWithoutOk),
    responseWithoutOk,
  );
  assertStrictEquals(
    expandServerMessageSchemas(responseWithNonSyncOk),
    responseWithNonSyncOk,
  );
});

Deno.test("server schema table helpers expand response sync payloads", () => {
  const sync = repeatedSchemaSync(1);
  const response = {
    type: "response",
    requestId: "sync-response",
    ok: {
      sync: compressSessionSyncSchemas(sync),
    },
  } satisfies ServerMessage;

  const expanded = expandServerMessageSchemas(response) as ResponseMessage<{
    sync: SessionSync;
  }>;

  assertEquals(expanded.ok?.sync, sync);
});

Deno.test("memory server negotiates schema-table v2 sync frames per connection", async () => {
  const flags = getMemoryProtocolFlags();
  const run = async (
    mode: "v2" | "legacy" | "off",
  ) => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(
        `memory://sync-schema-table-negotiation-${mode}`,
      ),
    });
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    const space = `did:key:z6Mk-sync-schema-table-${mode}`;
    const clientFlags = mode === "v2" ? flags : {
      modernCellRep: flags.modernCellRep,
      persistentSchedulerState: flags.persistentSchedulerState,
      commitPreconditions: flags.commitPreconditions,
      ...(mode === "legacy" ? { syncSchemaTable: true } : {}),
    };

    try {
      await connection.receive(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: clientFlags,
      }));
      const sessionOpen = expectHelloOk(messages);

      await connection.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: "open",
        space,
        session: {},
        invocation: authInvocation(sessionOpen),
      }));
      const opened = assertResponse<SessionOpenResult>(
        shiftMessage(messages),
      );
      assertExists(opened.ok);

      const upsert = repeatedSchemaSync(1).upserts[0];
      await connection.receive(encodeMemoryBoundary({
        type: "transact",
        requestId: "write",
        space,
        sessionId: opened.ok.sessionId,
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
      shiftMessage(messages);

      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.add",
        requestId: "watch",
        space,
        sessionId: opened.ok.sessionId,
        watches: [{
          id: "root",
          kind: "graph",
          query: {
            roots: [{
              id: upsert.id,
              selector: {
                path: [],
                schema: false,
              },
            }],
          },
        }],
      }));

      const watched = assertResponse<WatchAddResult>(shiftMessage(messages));
      assertExists(watched.ok);
      return (watched.ok.sync as SchemaTableSessionSync).schemaTable;
    } finally {
      connection.close();
      await server.close();
    }
  };

  assertExists(await run("v2"));
  assertEquals(await run("legacy"), undefined);
  assertEquals(await run("off"), undefined);
});
