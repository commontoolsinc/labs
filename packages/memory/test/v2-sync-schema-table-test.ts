import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  isLinkRef,
  LINK_V1_TAG,
  linkRefFrom,
  linkRefPayload,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import type {
  FabricValue,
  MutableFabricPlainObjectLayer,
} from "@commonfabric/data-model/fabric-value";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import type { JSONSchema } from "@commonfabric/api";
import {
  encodeMemoryBoundary,
  type EntityDocument,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type MemoryProtocolFlags,
  resetSyncSchemaCasConfig,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type SessionSync,
  setSyncSchemaCasConfig,
  type WatchAddResult,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import { connect, loopback, type Transport } from "../v2/client.ts";
import {
  compressServerMessageSchemas,
  compressSessionSyncSchemas,
  expandServerMessageSchemas,
  expandSessionSyncSchemas,
  type SchemaTableSessionSync,
} from "../v2/sync-schema-table.ts";
import {
  containsSyncSchemaRefString,
  findSyncSchemaRef,
} from "../v2/sync-schema-ref.ts";
import { mapLinkSchemas } from "../v2/schema-table-links.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

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

// CT-1927: every transact verdict stages a catch-up marker that rides the
// next batched frame — a marker-only empty frame when nothing watched is
// dirty. Tests whose subject is not verdict ordering shift past those
// frames here; the ordering contract itself is pinned by
// v2-verdict-catchup-test.ts.
const nextResponse = <Result>(
  messages: ServerMessage[],
): ResponseMessage<Result> => {
  while (true) {
    const message = shiftMessage(messages);
    if (message.type !== "session/effect") {
      return assertResponse<Result>(message);
    }
    // Only MARKER-ONLY frames may be skipped implicitly: no upserts, no
    // removes, no scheduler observations, and carrying the caughtUpLocalSeq
    // marker that is such a frame's reason to exist. Anything else is
    // content a test must consume explicitly, or an erroneous self-echo,
    // observation delivery, or markerless empty frame would be silently
    // swallowed here.
    const effect = (message as SessionEffectMessage)
      .effect as unknown as SessionSync;
    if (
      effect.upserts.length > 0 || effect.removes.length > 0 ||
      (effect.observations?.length ?? 0) > 0 ||
      effect.caughtUpLocalSeq === undefined
    ) {
      throw new Error(
        "nextResponse skipped a non-marker-only sync frame; consume it explicitly",
      );
    }
  }
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
    encodeMemoryBoundary(message).split("$defs").length - 1;
  const { message: compressed } = compressServerMessageSchemas(message);
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

Deno.test("sync schema table carries each repeated schema once", () => {
  const compressed = compressSessionSyncSchemas(
    repeatedSchemaSync(2),
  ) as SchemaTableSessionSync;
  const hash = internSchema(largeSchema(), true).taggedHashString;

  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [hash]);
  assertEquals(compressed.schemaTable[hash], largeSchema());
});

Deno.test("sync schema table preserves own __proto__ fields", () => {
  const value = JSON.parse(
    '{"__proto__":{"safe":true}}',
  ) as MutableFabricPlainObjectLayer;
  value.ref = linkRefFrom({
    id: "of:target",
    path: [],
    schema: { type: "string" },
  });
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:proto-source",
      scope: "space",
      seq: 1,
      doc: { value },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync);
  const compressedValue = compressed.upserts[0].doc?.value as Record<
    string,
    unknown
  >;

  assert(Object.hasOwn(compressedValue, "__proto__"));
  assertEquals(compressedValue.__proto__, { safe: true });
});

Deno.test("sync schema table leaves legacy alias schemas inline", () => {
  // The mapper no longer treats `$alias.schema` as a schema position:
  // `$alias` records are Pattern-binding vocabulary, not links, and their
  // schema field is binding metadata that travels inline. The alias record
  // IS ordinary data, though — a link nested inside its schema value is a
  // live position and interns normally.
  const aliasSchema: JSONSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
    },
  };
  const nestedLinkSchema: JSONSchema = { type: "string" };
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
                schema: aliasSchema,
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
              $alias: {
                id: "of:alias-with-nested-link",
                path: [],
                schema: {
                  type: "object",
                  default: {
                    "/": {
                      [LINK_V1_TAG]: {
                        id: "of:inside-alias-schema",
                        path: [],
                        schema: nestedLinkSchema,
                      },
                    },
                  },
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
  const nestedHash = internSchema(nestedLinkSchema, true).taggedHashString;

  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [nestedHash]);

  const compressedAliases =
    (compressed.upserts[0].doc?.value as Record<string, unknown>)
      .aliases as Record<string, unknown>[];
  assertEquals(
    (compressedAliases[0].$alias as Record<string, unknown>).schema,
    aliasSchema,
  );
  assertEquals(
    (compressedAliases[1].$alias as Record<string, unknown>).schema,
    "opaque-schema-name",
  );
  const nestedEnvelope = ((
    (compressedAliases[2].$alias as Record<string, unknown>)
      .schema as Record<string, unknown>
  ).default as Record<string, unknown>)["/"] as Record<string, unknown>;
  assertEquals(
    (nestedEnvelope[LINK_V1_TAG] as Record<string, unknown>).schema,
    `schema-ref@2:${nestedHash}`,
  );

  assertEquals(expandSessionSyncSchemas(compressed), sync);
});

Deno.test("sync schema table survives malformed link envelope payloads", () => {
  // Stored data can carry an envelope-shaped record whose payload is not a
  // record at all — cell-rep recognizes the envelope shape only. Compression
  // and expansion must treat these as ordinary data, not throw mid-sync (a
  // throw here breaks the space's sync stream for every watcher). The walk
  // still descends into them, so a valid link nested inside one interns.
  const nestedSchema: JSONSchema = { type: "number" };
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:malformed-envelopes",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          nullPayload: { "/": { [LINK_V1_TAG]: null } },
          stringPayload: { "/": { [LINK_V1_TAG]: "not a payload" } },
          arrayPayload: {
            "/": {
              [LINK_V1_TAG]: [{
                "/": {
                  [LINK_V1_TAG]: {
                    id: "of:nested",
                    path: [],
                    schema: nestedSchema,
                  },
                },
              }],
            },
          },
        },
      },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  const nestedHash = internSchema(nestedSchema, true).taggedHashString;
  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [nestedHash]);
  assertEquals(expandSessionSyncSchemas(compressed), sync);

  // The string scanner takes the same ordinary walk: no throw on the
  // malformed payloads, and a reserved string sitting AS the payload is
  // still found.
  assertEquals(containsSyncSchemaRefString(sync), false);
  assertEquals(
    containsSyncSchemaRefString({
      "/": { [LINK_V1_TAG]: "schema-ref@2:fid1:planted" },
    }),
    true,
  );
});

Deno.test("sync schema table expansion rejects refs at uninterpreted positions", () => {
  // An older server may still intern legacy `$alias` schema positions.
  // This expander no longer interprets them; delivering the surviving ref
  // string as data would silently corrupt the doc, so expansion fails
  // loudly even when the table carries the referenced schema.
  const schema: JSONSchema = { type: "object" };
  const interned = internSchema(schema, true);
  const sync: SchemaTableSessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:old-server-alias",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          bound: {
            $alias: {
              id: "of:target",
              path: [],
              schema: `schema-ref@2:${interned.taggedHashString}`,
            },
          },
        },
      },
    }],
    removes: [],
    schemaTable: { [interned.taggedHashString]: interned.schema },
  };

  assertThrows(
    () => expandSessionSyncSchemas(sync),
    Error,
    "Unexpanded sync schema table reference",
  );
});

Deno.test("sync schema table interns only strict link envelopes", () => {
  // Link recognition goes through the cell-rep link API, which defines a
  // legacy link as the single-key `{ "/": { "link@1": ... } }` envelope. An
  // envelope with sibling keys is NOT a link: its inner "schema" is inert
  // user data — uniformly for compression, expansion, and the reserved-ref
  // hardening — while a strict sibling link in the same record is interned.
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
  const siblingHash = internSchema(siblingSchema, true).taggedHashString;

  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [siblingHash]);
  // The sibling'd envelope is not a link: its schema stays inline.
  assertEquals(compressedPayload.schema, primarySchema);
  assertEquals(compressedSiblingPayload.schema, `schema-ref@2:${siblingHash}`);
  assertEquals(expandSessionSyncSchemas(compressed), sync);

  // The hardening applies the same strictness: a reserved string inside a
  // sibling'd envelope's payload is ordinary data, not a schema position.
  assertEquals(
    findSyncSchemaRef({
      "/": {
        [LINK_V1_TAG]: { id: "of:x", path: [], schema: "schema-ref@2:z" },
      },
      sibling: true,
    }),
    undefined,
  );
});

Deno.test("sync schema table ignores inherited fields while finding schema refs", () => {
  const inherited = {
    hidden: {
      $alias: {
        schema: "schema-ref@2:inherited",
      },
    },
  };
  const payload = Object.create(inherited) as Record<string, unknown>;
  payload.visible = { value: "ordinary data" };

  assertEquals(findSyncSchemaRef(payload), undefined);
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
  assertEquals(
    (expanded as unknown as { schemaTable?: Record<string, JSONSchema> })
      .schemaTable,
    undefined,
  );
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

Deno.test("sync schema table rejects refs without a populated table", () => {
  const compressed = compressSessionSyncSchemas(
    repeatedSchemaSync(1),
  ) as SchemaTableSessionSync;
  const { schemaTable: _schemaTable, ...withoutTable } = compressed;

  assertThrows(
    () => expandSessionSyncSchemas(withoutTable),
    Error,
    "Invalid sync schema table reference",
  );
  assertThrows(
    () => expandSessionSyncSchemas({ ...withoutTable, schemaTable: {} }),
    Error,
    "Invalid sync schema table reference",
  );
});

Deno.test("sync schema table validates dangling refs without recursive traversal", () => {
  const danglingRef = "schema-ref@2:sha256:missing";
  let deeplyNested: FabricValue = {
    $alias: {
      id: "of:deep-target",
      path: [],
      schema: danglingRef,
    },
  };
  for (let index = 0; index < 20_000; index += 1) {
    deeplyNested = { next: deeplyNested };
  }

  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:deep-dangling-ref",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          harmless: danglingRef,
          nested: deeplyNested,
        },
      },
    }],
    removes: [],
  };

  assertThrows(
    () => expandSessionSyncSchemas(sync),
    Error,
    "Invalid sync schema table reference",
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

  for (
    const untouched of [
      hello,
      responseWithoutOk,
      responseWithPrimitiveOk,
      responseWithNonSyncOk,
    ]
  ) {
    const compressed = compressServerMessageSchemas(untouched);
    assertStrictEquals(compressed.message, untouched);
    assertEquals(compressed.staged.size, 0);
  }

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
      const opened = nextResponse<SessionOpenResult>(messages);
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
      // Consume the transact verdict (and, CT-1927 default-on, the
      // marker-only frame preceding it).
      nextResponse(messages);

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

      const watched = nextResponse<WatchAddResult>(messages);
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

/** Opens a cas-negotiated session and returns the pieces a test drives it
 *  with. The caller owns closing the connection and the server. */
const openCasSession = async (
  server: Server,
  space: string,
  clientFlags: MemoryProtocolFlags,
) => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
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
  const opened = nextResponse<SessionOpenResult>(messages);
  assertExists(opened.ok);
  return { connection, messages, sessionId: opened.ok.sessionId };
};

const watchAdd = async (
  connection: { receive(payload: string): Promise<void> },
  space: string,
  sessionId: string,
  requestId: string,
  id: string,
) =>
  await connection.receive(encodeMemoryBoundary({
    type: "session.watch.add",
    requestId,
    space,
    sessionId,
    watches: [{
      id: requestId,
      kind: "graph",
      query: { roots: [{ id, selector: { path: [], schema: false } }] },
    }],
  }));

Deno.test("connection-scoped schema bodies span a connection, not a frame", async () => {
  setSyncSchemaCasConfig(true);
  const space = "did:key:z6Mk-sync-schema-cas-connection";
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://sync-schema-cas-connection"),
  });
  const schema = largeSchema();
  const hash = internSchema(schema, true).taggedHashString;
  const docValue = (target: string) => ({
    ref: linkRefFrom({ id: target, path: [], schema }),
  });

  try {
    await server.writeDocument(space, "of:cas-a", docValue("of:target-a"));
    await server.writeDocument(space, "of:cas-b", docValue("of:target-b"));

    const first = await openCasSession(server, space, getMemoryProtocolFlags());
    try {
      await watchAdd(first.connection, space, first.sessionId, "a", "of:cas-a");
      const watchedA = nextResponse<WatchAddResult>(first.messages);
      const syncA = watchedA.ok?.sync as SchemaTableSessionSync;
      assertExists(syncA.schemaTable);
      assertEquals(Object.keys(syncA.schemaTable), [hash]);

      // Same schema, same connection, different document: the body has
      // already been delivered, so only the reference travels.
      await watchAdd(first.connection, space, first.sessionId, "b", "of:cas-b");
      const watchedB = nextResponse<WatchAddResult>(first.messages);
      const syncB = watchedB.ok?.sync as SchemaTableSessionSync;
      assertEquals(syncB.schemaTable, undefined);
      assertEquals(
        findSyncSchemaRef(syncB.upserts[0].doc),
        `schema-cas@1:${hash}`,
      );
    } finally {
      first.connection.close();
    }

    // A FRESH connection has delivered nothing, so it is taught the body
    // again. This is the direction a reconnect drifts in — the server
    // forgets while the client remembers — and it costs bytes, not
    // correctness.
    const second = await openCasSession(
      server,
      space,
      getMemoryProtocolFlags(),
    );
    try {
      await watchAdd(
        second.connection,
        space,
        second.sessionId,
        "b",
        "of:cas-b",
      );
      const watched = nextResponse<WatchAddResult>(second.messages);
      const sync = watched.ok?.sync as SchemaTableSessionSync;
      assertExists(sync.schemaTable);
      assertEquals(Object.keys(sync.schemaTable), [hash]);
    } finally {
      second.connection.close();
    }
  } finally {
    await server.close();
    resetSyncSchemaCasConfig();
  }
});

/** What a watch view holds after a frame the client could not process. */
type LostFrameOutcome = {
  /** The document whose schema rode on the lost frame, or null if none
   *  arrived. */
  lost: EntityDocument | null;
  /** A later document naming that same schema, or null if none arrived. */
  later: EntityDocument | null;
};

/**
 * A loopback shaped like `WebSocketTransport` rather than like `loopback()`.
 *
 * The two differ in exactly the places a client's connection state machine is
 * fragile, so exercising only `loopback()` leaves those paths untested:
 * `WebSocketTransport.close()` detaches its socket first and then AWAITS the
 * close handshake — arbitrarily long on the half-open socket that mangles a
 * frame in the first place — and its close listener stays silent for a socket
 * it has already replaced. A send re-opens.
 */
const slowCloseLoopback = (server: Server, rewrite: (p: string) => string) => {
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  let connection: ReturnType<Server["connect"]> | null = null;
  let releaseClose: (() => void) | null = null;
  // While held, a close detaches at once but does not settle, standing in for
  // the close handshake a real socket waits through.
  const state = { closes: 0, hellos: 0, holdClose: false };
  const open = () => {
    connection ??= server.connect((message) => {
      receiver(rewrite(encodeMemoryBoundary(message)));
    });
    return connection;
  };
  const transport: Transport = {
    async send(payload) {
      if (payload.includes('"hello"')) state.hellos += 1;
      await open().receive(payload);
    },
    close() {
      state.closes += 1;
      const current = connection;
      connection = null;
      current?.close();
      // Deliberately no close callback — the real transport suppresses it for
      // a socket it has already replaced.
      if (!state.holdClose) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      closeReceiver = next;
    },
  };
  return {
    transport,
    state,
    /** Kills the current connection the way a socket dying does: the peer is
     *  gone and the client is told, so its reconnect loop takes over. */
    dropConnection: () => {
      connection?.close();
      connection = null;
      closeReceiver(new Error("socket died"));
    },
    /** Lets the pending close finish, as a real socket's close event does,
     *  and stops holding later ones. */
    settleClose: () => {
      state.holdClose = false;
      releaseClose?.();
      releaseClose = null;
    },
  };
};

Deno.test("a reconnect completed during a discard's close is not handshaken twice", async () => {
  // The discard closes the transport and reconnects once the close settles.
  // A real close is slow, and anything routine — a transact, a request —
  // reconnects inside that window. The deferred reconnect must then notice
  // the connection is already up: a server connection refuses a second
  // `hello` with an error no retry can clear, so handshaking again spins the
  // reconnect loop forever with every request waiting behind it.
  setSyncSchemaCasConfig(true);
  const space = "did:key:z6Mk-sync-schema-double-hello";
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://sync-schema-double-hello"),
    subscriptionRefreshDelayMs: 60_000,
  });
  let corruptNextEffect = false;
  const { transport, state, settleClose } = slowCloseLoopback(
    server,
    (payload) => {
      if (corruptNextEffect && payload.includes("session/effect")) {
        corruptNextEffect = false;
        return `${payload}!corrupt`;
      }
      return payload;
    },
  );

  const client = await connect({ transport });
  try {
    const session = await client.mount(space, {}, testSessionOpenAuthFactory);
    await session.watchAdd([{
      id: "w",
      kind: "graph",
      query: {
        roots: [{ id: "of:double", selector: { path: [], schema: false } }],
      },
    }]);
    assertEquals(state.hellos, 1);

    // Fail a frame: the discard detaches the transport and parks on the close.
    state.holdClose = true;
    corruptNextEffect = true;
    await server.writeDocument(space, "of:double", {
      ref: linkRefFrom({ id: "of:target", path: [], schema: largeSchema() }),
    });
    await server.flushSessions([space]);

    // Someone else reconnects while that close is still pending. This is the
    // ordinary path — `transact` does it whenever the client reads as
    // disconnected — and it succeeds on a fresh connection.
    await client.restoreConnection();
    assertEquals(state.hellos, 2);
    assertEquals(client.isConnected(), true);

    // Now the close settles and the deferred reconnect runs. It must be a
    // no-op; a second handshake here is refused and never recovers.
    settleClose();
    await client.restoreConnection();
    assertEquals(
      state.hellos,
      2,
      "the deferred reconnect must not handshake a live connection",
    );
    assertEquals(client.isConnected(), true);
  } finally {
    settleClose();
    await client.close();
    await server.close();
    resetSyncSchemaCasConfig();
  }
});

Deno.test("the client's encoding follows what its handshake advertised", async () => {
  // The server negotiates from the flags it RECEIVED. A client that re-read
  // the ambient config when `hello.ok` landed could answer differently, and
  // the two ends would then disagree about whether frames describe
  // themselves — the one thing this encoding cannot tolerate. Flipping the
  // config in flight forces exactly that divergence.
  setSyncSchemaCasConfig(true);
  const space = "did:key:z6Mk-sync-schema-advertised";
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://sync-schema-advertised"),
    subscriptionRefreshDelayMs: 60_000,
  });
  let corruptNextEffect = false;
  const { transport, state } = slowCloseLoopback(server, (payload) => {
    if (payload.includes("hello.ok")) {
      // The handshake is committed on both sides; only a later ambient read
      // can still be misled.
      setSyncSchemaCasConfig(false);
    }
    if (corruptNextEffect && payload.includes("session/effect")) {
      corruptNextEffect = false;
      return `${payload}!corrupt`;
    }
    return payload;
  });

  const client = await connect({ transport });
  try {
    const session = await client.mount(space, {}, testSessionOpenAuthFactory);
    await session.watchAdd([{
      id: "w",
      kind: "graph",
      query: {
        roots: [{ id: "of:advertised", selector: { path: [], schema: false } }],
      },
    }]);
    assertEquals(state.closes, 0);

    corruptNextEffect = true;
    await server.writeDocument(space, "of:advertised", {
      ref: linkRefFrom({ id: "of:target", path: [], schema: largeSchema() }),
    });
    await server.flushSessions([space]);

    // This connection speaks cas — both ends advertised it — so a frame the
    // client cannot process must discard it. A client that concluded
    // otherwise from the flipped config would stay on a connection whose
    // later references it can no longer resolve.
    assert(
      state.closes > 0,
      "the connection negotiated cas, so a lost frame must discard it",
    );
  } finally {
    await client.close();
    await server.close();
    resetSyncSchemaCasConfig();
  }
});

Deno.test("a reconnect whose handshake frame is unreadable still recovers", async () => {
  // The server connection has already answered a `hello` by the time it sends
  // a frame the client cannot read, so the reconnect loop's next attempt on
  // that same transport is refused as a repeat — an error nothing marks
  // permanent, so the loop can never succeed on it. Dropping the transport is
  // what lets the following attempt reach a fresh connection.
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://sync-schema-handshake-drop"),
    subscriptionRefreshDelayMs: 60_000,
  });
  let corruptNextHelloOk = false;
  const { transport, state, dropConnection } = slowCloseLoopback(
    server,
    (payload) => {
      if (corruptNextHelloOk && payload.includes("hello.ok")) {
        corruptNextHelloOk = false;
        return `${payload}!corrupt`;
      }
      return payload;
    },
  );

  const client = await connect({ transport });
  try {
    assertEquals(state.hellos, 1);

    // The socket dies, and the reconnect's own handshake frame is the one
    // that arrives unreadable.
    corruptNextHelloOk = true;
    dropConnection();

    // Joins the reconnect loop and resolves once it succeeds. Without the
    // transport drop it never does: every further attempt reuses a connection
    // that has already handshaken.
    await client.restoreConnection();
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("a failed handshake settles rather than stranding its replacement", async () => {
  // Closing the transport on an unreadable handshake frame can drive
  // `onClose` synchronously, so the reconnect it triggers installs its own
  // pending handshake BEFORE the failed one unwinds. A `hello()` that retired
  // the pending unconditionally would retire the replacement's, leaving that
  // handshake awaiting an ack nothing resolves — and `close()`, which waits
  // on the reconnect, never returning.
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://sync-schema-handshake-strand"),
    subscriptionRefreshDelayMs: 60_000,
  });
  const base = loopback(server);
  let corruptNextHelloOk = true;
  const transport: Transport = {
    send: (payload) => base.send(payload),
    close: () => base.close(),
    setReceiver(next) {
      base.setReceiver((payload) => {
        if (corruptNextHelloOk && payload.includes("hello.ok")) {
          corruptNextHelloOk = false;
          next(`${payload}!corrupt`);
          return;
        }
        next(payload);
      });
    },
    setCloseReceiver(next) {
      base.setCloseReceiver?.(next);
    },
  };

  try {
    // Either outcome is acceptable — the handshake may fail or the retry may
    // land — but it must SETTLE. Before the identity guard this neither
    // resolved nor rejected.
    await connect({ transport })
      .then((client) => client.close())
      .catch(() => undefined);
  } finally {
    await server.close();
  }
});

/**
 * Drives a real Client against a real Server over `loopback`, corrupting one
 * session/effect so the client's own decode path fails on it — the frame
 * reaches the client, which then cannot process it.
 */
const watchAfterALostEffect = async (
  label: string,
  cas: boolean,
): Promise<LostFrameOutcome> => {
  setSyncSchemaCasConfig(cas);
  const space = `did:key:z6Mk-sync-schema-lost-frame-${label}`;
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://sync-schema-lost-frame-${label}`),
    // Only the explicit flushes below deliver, so the corrupted frame is the
    // one carrying the schema body rather than whichever frame a scheduled
    // refresh happened to emit first.
    subscriptionRefreshDelayMs: 60_000,
  });
  const base = loopback(server);
  let corruptNextEffect = false;
  const transport: Transport = {
    send: (payload) => base.send(payload),
    close: () => base.close(),
    setReceiver(next) {
      base.setReceiver((payload) => {
        if (corruptNextEffect && payload.includes("session/effect")) {
          corruptNextEffect = false;
          next(`${payload}!corrupt`);
          return;
        }
        next(payload);
      });
    },
    setCloseReceiver(next) {
      base.setCloseReceiver?.(next);
    },
  };

  const client = await connect({ transport });
  try {
    const session = await client.mount(space, {}, testSessionOpenAuthFactory);
    const view = await session.watchAdd([{
      id: "w",
      kind: "graph",
      query: {
        roots: [
          { id: "of:lost", selector: { path: [], schema: false } },
          { id: "of:later", selector: { path: [], schema: false } },
        ],
      },
    }]);

    const updates = view.subscribe();
    const schema = largeSchema();
    corruptNextEffect = true;
    await server.writeDocument(space, "of:lost", {
      ref: linkRefFrom({ id: "of:target-lost", path: [], schema }),
    });
    await server.flushSessions([space]);

    // A later document naming the same schema. A connection that recorded the
    // lost frame's body as delivered sends a bare reference the client can
    // never resolve, and this document never arrives.
    await server.writeDocument(space, "of:later", {
      ref: linkRefFrom({ id: "of:target-later", path: [], schema }),
    });
    await server.flushSessions([space]);

    // Woken by the view, not by a deadline: an update that never arrives
    // leaves this await pending with nothing else holding the loop, which
    // Deno reports as a failure rather than a hang.
    // An entity the view never received and one it holds as absent both mean
    // "no document arrived"; collapse them so a caller asserts the outcome
    // rather than which of the two spellings produced it.
    const documentOf = (id: string): EntityDocument | null =>
      view.entities.find((entity) => entity.id === id)?.document ?? null;
    while (documentOf("of:later") == null) {
      const update = await updates.next();
      if (update.done) break;
    }
    return { lost: documentOf("of:lost"), later: documentOf("of:later") };
  } finally {
    await client.close();
    await server.close();
    resetSyncSchemaCasConfig();
  }
};

Deno.test("a frame the client cannot process costs that frame, not the connection", async () => {
  // Under the frame-local encoding the next frame describes itself, so the
  // connection keeps delivering.
  const frameLocal = await watchAfterALostEffect("frame-local", false);
  assertExists(frameLocal.later);

  // The connection-scoped encoding cannot heal in place: the server counts
  // the lost frame's body as delivered, later frames reference it bare, and
  // no request fetches a schema by hash. The client must discard the
  // connection so a fresh one re-teaches the bodies. Without that, `later`
  // never arrives and this wait fails.
  const cas = await watchAfterALostEffect("cas", true);
  assertExists(cas.later);

  // What is NOT recovered, under EITHER encoding: the lost frame's own
  // content. Its upserts advanced the server's session cache when the frame
  // was built, and resume-time catch-up diffs against that advanced cache —
  // see rollbackUndeliveredSync, which repairs only a send that threw. The
  // discard restores the connection, not the frame.
  assertEquals(frameLocal.lost, null);
  assertEquals(cas.lost, null);
});

Deno.test("both peers must advertise cas before a frame stops describing itself", async () => {
  const schema = largeSchema();
  const hash = internSchema(schema, true).taggedHashString;

  const refUnder = async (
    label: string,
    serverCas: boolean,
    clientCas: boolean,
  ) => {
    setSyncSchemaCasConfig(serverCas);
    const space = `did:key:z6Mk-sync-schema-cas-${label}`;
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://sync-schema-cas-negotiation-${label}`),
    });
    try {
      await server.writeDocument(space, "of:cas-negotiated", {
        ref: linkRefFrom({ id: "of:target", path: [], schema }),
      });
      const { connection, messages, sessionId } = await openCasSession(
        server,
        space,
        { ...getMemoryProtocolFlags(), syncSchemaCasV1: clientCas },
      );
      try {
        await watchAdd(connection, space, sessionId, "w", "of:cas-negotiated");
        const watched = nextResponse<WatchAddResult>(messages);
        return findSyncSchemaRef(
          (watched.ok?.sync as SchemaTableSessionSync).upserts[0].doc,
        );
      } finally {
        connection.close();
      }
    } finally {
      await server.close();
      resetSyncSchemaCasConfig();
    }
  };

  assertEquals(await refUnder("both", true, true), `schema-cas@1:${hash}`);
  // Either peer withholding the capability keeps the connection on
  // self-describing frames — the encodings are exclusive, so a peer must
  // never have to guess which one a frame uses.
  assertEquals(
    await refUnder("client-only", false, true),
    `schema-ref@2:${hash}`,
  );
  assertEquals(
    await refUnder("server-only", true, false),
    `schema-ref@2:${hash}`,
  );
});

Deno.test("a schema body is remembered only once its frame reaches the transport", async () => {
  setSyncSchemaCasConfig(true);
  const space = "did:key:z6Mk-sync-schema-cas-rollback";
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://sync-schema-cas-rollback"),
    subscriptionRefreshDelayMs: 60_000,
  });
  const schema = largeSchema();
  const hash = internSchema(schema, true).taggedHashString;

  try {
    const { connection, messages, sessionId } = await openCasSession(
      server,
      space,
      getMemoryProtocolFlags(),
    );
    try {
      // Watch an absent document: nothing to carry yet, so the body is
      // still undelivered when the write below makes it due.
      await watchAdd(connection, space, sessionId, "w", "of:cas-late");
      assertExists(nextResponse<WatchAddResult>(messages).ok);

      const originalPush = messages.push.bind(messages);
      let failNextEffect = true;
      messages.push = ((message: ServerMessage) => {
        if (failNextEffect && message.type === "session/effect") {
          failNextEffect = false;
          throw new Error("synthetic send failure");
        }
        return originalPush(message);
      }) as typeof messages.push;

      await server.writeDocument(space, "of:cas-late", {
        ref: linkRefFrom({ id: "of:target-late", path: [], schema }),
      });
      await server.flushSessions([space]);
      assertEquals(messages.length, 0, "the effect never reached the wire");

      // The staged body went down with the frame. Recomputation must carry
      // it again — a connection that recorded it here would emit a bare
      // reference the peer can never resolve.
      await server.flushSessions([space]);
      const effect = shiftMessage(messages) as SessionEffectMessage;
      assertEquals(effect.type, "session/effect");
      const sync = effect.effect as SchemaTableSessionSync;
      assertExists(
        sync.schemaTable,
        "the redelivered frame re-carries the undelivered body",
      );
      assertEquals(Object.keys(sync.schemaTable), [hash]);
    } finally {
      connection.close();
    }
  } finally {
    await server.close();
    resetSyncSchemaCasConfig();
  }
});

Deno.test("connection-scoped compression carries a body once, then references it", () => {
  const sync = repeatedSchemaSync(2);
  const hash = internSchema(largeSchema(), true).taggedHashString;
  const delivered = new Set<string>();

  const first = compressSessionSyncSchemas(
    sync,
    delivered,
  ) as SchemaTableSessionSync;
  assertExists(first.schemaTable);
  assertEquals(Object.keys(first.schemaTable), [hash]);
  assertEquals(
    (first.upserts[0].doc?.value as Record<string, unknown>).primary,
    linkRefFrom({
      id: "of:target-0",
      path: [],
      schema: `schema-cas@1:${hash}`,
    }),
  );

  for (const staged of Object.keys(first.schemaTable)) delivered.add(staged);

  const second = compressSessionSyncSchemas(
    sync,
    delivered,
  ) as SchemaTableSessionSync;
  assertEquals(
    second.schemaTable,
    undefined,
    "a steady-state frame carries no table at all",
  );
  assertEquals(
    findSyncSchemaRef(second.upserts[0].doc),
    `schema-cas@1:${hash}`,
  );

  // A receiver that took delivery of the first frame resolves the second.
  const cache = new Map<string, JSONSchema>();
  assertEquals(expandSessionSyncSchemas(first, cache), sync);
  assertEquals(cache.size, 1);
  assertEquals(expandSessionSyncSchemas(second, cache), sync);
});

Deno.test("expansion leaves an inline schema alone", () => {
  // Not every schema position on an expanded frame holds a reference: a
  // server may compress some and leave others, and a position holding an
  // ordinary value is data. Expansion must pass those through rather than
  // treat every schema position as a reference to resolve.
  const inline: JSONSchema = { type: "string" };
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:inline-schema",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          ref: linkRefFrom({ id: "of:target", path: [], schema: inline }),
        },
      },
    }],
    removes: [],
  };

  const cache = new Map<string, JSONSchema>();
  assertEquals(expandSessionSyncSchemas(sync, cache), sync);
  assertEquals(cache.size, 0);
});

Deno.test("connection-scoped references need a table or a delivered body", () => {
  const hash = internSchema(largeSchema(), true).taggedHashString;
  const orphaned = compressSessionSyncSchemas(
    repeatedSchemaSync(1),
    new Set([hash]),
  );

  // The body was never delivered to THIS receiver: an empty cache cannot
  // satisfy the reference, and silently dropping it would hand the session
  // cache a ref string as data.
  assertThrows(
    () => expandSessionSyncSchemas(orphaned, new Map()),
    Error,
    "Invalid sync schema table reference",
  );
});

Deno.test("a frame-local reference never resolves from the connection cache", () => {
  // schema-ref@2: promises the body travels on the same frame. A missing
  // table entry is a sender defect, and must be reported as one rather than
  // satisfied by an unrelated body the cache happens to hold.
  const schema: JSONSchema = { type: "string" };
  const hash = internSchema(schema, true).taggedHashString;
  const cache = new Map<string, JSONSchema>([[hash, schema]]);
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:frame-local-ref",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          ref: linkRefFrom({
            id: "of:target",
            path: [],
            schema: `schema-ref@2:${hash}`,
          }),
        },
      },
    }],
    removes: [],
  };

  assertThrows(
    () => expandSessionSyncSchemas(sync, cache),
    Error,
    "Invalid sync schema table reference",
  );
});

Deno.test("findSyncSchemaRef ignores inherited object properties", () => {
  // The traversal must only follow own properties: an enumerable INHERITED
  // key carrying a link-payload shape must not surface as a reserved
  // reference. Built on a custom prototype so the test never touches
  // Object.prototype.
  const pollutedProto = {
    polluted: {
      $alias: { id: "of:polluted", path: [], schema: "schema-ref@2:fid1:evil" },
    },
  };
  const doc = Object.assign(Object.create(pollutedProto), {
    value: { plain: "doc" },
  }) as Record<string, unknown>;
  assertEquals(findSyncSchemaRef(doc), undefined);
  // Sanity: the same shape as an OWN property is found.
  assertEquals(
    findSyncSchemaRef({ nested: pollutedProto.polluted }),
    "schema-ref@2:fid1:evil",
  );
});

Deno.test("sync schema table compression preserves own __proto__ keys", () => {
  const schema: JSONSchema = { type: "object" };
  const canonical = internSchema(schema, true);
  const linkWithSchema = {
    "/": {
      [LINK_V1_TAG]: { id: "of:target", path: [], schema },
    },
  };
  // An own "__proto__" data property (constructible via defineProperty or a
  // hostile codec) must survive the rewrite as an own property — plain
  // assignment would silently hit the prototype accessor instead.
  const doc: Record<string, unknown> = { value: { nested: linkWithSchema } };
  Object.defineProperty(doc.value as object, "__proto__", {
    value: { alsoHere: linkWithSchema },
    enumerable: true,
    configurable: true,
    writable: true,
  });

  const sync = {
    type: "sync" as const,
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:example",
      seq: 1,
      doc: doc as unknown as EntityDocument,
    }],
    removes: [],
  };
  const compressed = compressSessionSyncSchemas(sync) as SessionSync & {
    schemaTable?: Record<string, JSONSchema>;
  };
  assertExists(compressed.schemaTable);
  assertEquals(
    compressed.schemaTable![canonical.taggedHashString],
    canonical.schema,
  );

  const value = compressed.upserts[0].doc?.value as Record<string, unknown>;
  const protoEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
  assertExists(protoEntry, "own __proto__ key must remain an own property");
  assertEquals(Object.getPrototypeOf(value), Object.prototype);
  const relocated =
    (protoEntry!.value as Record<string, Record<string, unknown>>)
      .alsoHere["/"] as Record<string, Record<string, unknown>>;
  assertEquals(
    relocated[LINK_V1_TAG].schema,
    `schema-ref@2:${canonical.taggedHashString}`,
  );
});

Deno.test("findSyncSchemaRef traverses arrays and containsSyncSchemaRefString scans leaves", () => {
  assertEquals(
    findSyncSchemaRef([
      "plain",
      [{
        "/": {
          [LINK_V1_TAG]: {
            id: "of:in-array",
            path: [],
            schema: "schema-ref@2:fid1:inside-array",
          },
        },
      }],
    ]),
    "schema-ref@2:fid1:inside-array",
  );

  assertEquals(
    containsSyncSchemaRefString({
      a: 1,
      b: [null, true, { c: "schema-cas@1:fid1:leaf" }],
    }),
    true,
  );
  assertEquals(
    containsSyncSchemaRefString({
      a: 1,
      b: [null, true, { c: "an ordinary string" }],
    }),
    false,
  );
});

Deno.test("schema table and reserved-ref detection handle modern cell-rep links", () => {
  // Under modernCellRep, links are FabricLink instances rather than plain
  // envelopes; recognition must go through the cell-rep chokepoint or every
  // link becomes an opaque leaf and both interning and hardening no-op.
  setModernCellRepConfig(true);
  try {
    const schema: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const canonical = internSchema(schema, true);
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      upserts: [{
        branch: "",
        id: "of:modern",
        scope: "space",
        seq: 1,
        doc: {
          value: {
            contact: linkRefFrom({
              id: "of:contact",
              path: [],
              schema,
            }),
          },
        } as unknown as EntityDocument,
      }],
      removes: [],
    };

    const compressed = compressSessionSyncSchemas(
      sync,
    ) as SchemaTableSessionSync;
    assertExists(compressed.schemaTable, "modern links must be interned");
    const compressedLink =
      (compressed.upserts[0].doc?.value as Record<string, unknown>).contact;
    assert(isLinkRef(compressedLink), "rewrite must preserve the link form");
    assertEquals(
      (linkRefPayload(compressedLink) as Record<string, unknown>).schema,
      `schema-ref@2:${canonical.taggedHashString}`,
    );

    // Hardening detection sees inside FabricLink payloads too.
    assertEquals(
      findSyncSchemaRef(compressed.upserts[0].doc),
      `schema-ref@2:${canonical.taggedHashString}`,
    );
    assertEquals(
      containsSyncSchemaRefString(compressed.upserts[0].doc),
      true,
    );

    const expanded = expandSessionSyncSchemas(compressed);
    const expandedLink =
      (expanded.upserts[0].doc?.value as Record<string, unknown>).contact;
    assert(isLinkRef(expandedLink));
    assertEquals(
      (linkRefPayload(expandedLink) as Record<string, unknown>).schema,
      canonical.schema,
    );
  } finally {
    setModernCellRepConfig(false);
    resetModernCellRepConfig();
  }
});

Deno.test("schema subtrees are opaque: nested link shapes inside schemas are data", () => {
  // A schema whose `default` embeds a link-shaped structure with a reserved
  // ref string: the whole schema is one position. Compression swallows it
  // wholesale, expansion restores it byte-identically without interpreting
  // the nested shape, and the validator does not flag it.
  const schemaWithNestedLink: JSONSchema = {
    type: "object",
    default: {
      "/": {
        [LINK_V1_TAG]: {
          id: "of:inner",
          path: [],
          schema: "schema-ref@2:fid1:nested-as-data",
        },
      },
    },
  } as unknown as JSONSchema;
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:opaque-schema",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          ref: linkRefFrom({
            id: "of:target",
            path: [],
            schema: schemaWithNestedLink,
          }),
        },
      },
    }],
    removes: [],
  };

  assertEquals(findSyncSchemaRef(sync.upserts[0].doc), undefined);

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  assertExists(compressed.schemaTable);
  const canonical = internSchema(schemaWithNestedLink, true);
  assertEquals(
    compressed.schemaTable![canonical.taggedHashString],
    canonical.schema,
  );
  const expanded = expandSessionSyncSchemas(compressed);
  assertEquals(expanded, sync);
});

Deno.test("validator covers mapper schema positions plus legacy aliases", () => {
  // Drift guard: findSyncSchemaRef is iterative (stack-safe) while
  // mapLinkSchemas is recursive. The validator must see every position the
  // mapper interprets — equal on link positions — plus exactly one extra
  // family: legacy `$alias` schema positions, which clients shipped before
  // the mapper stopped interpreting them still expand (see
  // sync-schema-ref.ts). If either walker learns or prunes a position,
  // this corpus fails until the other (and its expectation here) is
  // updated.
  const planted = "schema-ref@2:fid1:planted";
  const probe = (value: unknown): string | undefined => {
    let found: string | undefined;
    mapLinkSchemas(value as never, (schema) => {
      if (
        found === undefined && typeof schema === "string" &&
        schema.startsWith("schema-ref@2:")
      ) {
        found = schema;
      }
      return schema;
    });
    return found;
  };

  const corpus: Array<{
    label: string;
    value: unknown;
    validator: string | undefined;
    mapper: string | undefined;
  }> = [
    {
      label: "legacy link payload",
      value: {
        "/": { [LINK_V1_TAG]: { id: "of:a", path: [], schema: planted } },
      },
      validator: planted,
      mapper: planted,
    },
    {
      label: "alias payload is validator-only",
      value: { $alias: { id: "of:b", path: [], schema: planted } },
      validator: planted,
      mapper: undefined,
    },
    {
      label: "nested in array",
      value: [1, [{ $alias: { id: "of:c", path: [], schema: planted } }]],
      validator: planted,
      mapper: undefined,
    },
    {
      label: "sibling'd envelope is not a link",
      value: {
        "/": { [LINK_V1_TAG]: { id: "of:d", path: [], schema: planted } },
        sibling: true,
      },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "plain strings inside an alias schema value are data",
      value: {
        $alias: {
          id: "of:e",
          path: [],
          schema: { type: "object", default: { deep: planted } },
        },
      },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "link nested in an alias schema value is live for both",
      value: {
        $alias: {
          id: "of:h",
          path: [],
          schema: {
            type: "object",
            default: {
              "/": { [LINK_V1_TAG]: { id: "of:i", path: [], schema: planted } },
            },
          },
        },
      },
      validator: planted,
      mapper: planted,
    },
    {
      label: "link schema subtree stays opaque",
      value: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:j",
            path: [],
            schema: { type: "object", default: { deep: planted } },
          },
        },
      },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "malformed envelope payload is not a link",
      value: { "/": { [LINK_V1_TAG]: null } },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "malformed envelope contents are walked as data",
      value: {
        "/": {
          [LINK_V1_TAG]: [{
            "/": { [LINK_V1_TAG]: { id: "of:k", path: [], schema: planted } },
          }],
        },
      },
      validator: planted,
      mapper: planted,
    },
    {
      label: "harmless string position",
      value: { note: planted },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "alias sibling fields still walked",
      value: {
        $alias: {
          id: "of:f",
          path: [],
          extra: { $alias: { id: "of:g", path: [], schema: planted } },
        },
      },
      validator: planted,
      mapper: undefined,
    },
  ];

  for (const { label, value, validator, mapper } of corpus) {
    assertEquals(findSyncSchemaRef(value), validator, `validator on: ${label}`);
    assertEquals(probe(value), mapper, `mapper on: ${label}`);
  }

  // Modern regime: same agreement through FabricLink instances.
  setModernCellRepConfig(true);
  try {
    const modern = {
      wrapped: linkRefFrom({ id: "of:m", path: [], schema: planted }),
    };
    assertEquals(findSyncSchemaRef(modern), probe(modern));
    assertEquals(findSyncSchemaRef(modern), planted);
  } finally {
    setModernCellRepConfig(false);
    resetModernCellRepConfig();
  }
});

Deno.test("encodeMemoryBoundary embeds reserved prefixes verbatim", () => {
  // Pins the property the substring gates depend on (see the note on
  // encodeMemoryBoundary): strings serialize byte-verbatim, so a payload's
  // text contains a reserved prefix iff some string value carries it.
  const withRefs = encodeMemoryBoundary({
    doc: {
      value: {
        a: "schema-ref@2:fid1:x",
        b: { nested: ["schema-cas@1:fid1:y"] },
      },
    },
  });
  assert(withRefs.includes("schema-ref@2:"));
  assert(withRefs.includes("schema-cas@1:"));

  const withoutRefs = encodeMemoryBoundary({
    doc: { value: { a: "plain", b: { nested: [1, true, null] } } },
  });
  assert(!withoutRefs.includes("schema-ref@2:"));
  assert(!withoutRefs.includes("schema-cas@1:"));
});
