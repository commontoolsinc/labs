import { assert, assertEquals, assertExists } from "@std/assert";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import type { JSONSchema } from "@commonfabric/api";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenResult,
  type SessionSync,
  type WatchAddResult,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  compressServerMessageSchemas,
  expandServerMessageSchemas,
  type SchemaTableSessionSync,
} from "../v2/sync-schema-table.ts";

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

  console.log(
    JSON.stringify({
      fixture: "repeated-schema-sync",
      upserts: sync.upserts.length,
      before: {
        schemaOccurrences: schemaMarkerCount,
        encodedBytes: bytes,
      },
      after: {
        schemaOccurrences: compressedSchemaMarkerCount,
        encodedBytes: compressedBytes,
      },
      encodedByteReduction: Number((1 - compressedBytes / bytes).toFixed(4)),
    }),
  );

  assertEquals(expanded, message);
  assert(
    schemaMarkerCount >= sync.upserts.length,
    "baseline fixture should repeat schema definitions across many upserts",
  );
  assert(
    compressedBytes < bytes / 5,
    "schema-table encoding should materially reduce repeated schema frames",
  );
});

Deno.test("memory server negotiates schema-table sync frames per connection", async () => {
  const flags = getMemoryProtocolFlags();
  const run = async (syncSchemaTable: boolean) => {
    const server = new Server({
      store: new URL(
        `memory://sync-schema-table-negotiation-${syncSchemaTable}`,
      ),
    });
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    const space = `did:key:z6Mk-sync-schema-table-${syncSchemaTable}`;

    try {
      await connection.receive(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: syncSchemaTable ? flags : {
          modernCellRep: flags.modernCellRep,
          persistentSchedulerState: flags.persistentSchedulerState,
          commitPreconditions: flags.commitPreconditions,
        },
      }));
      shiftMessage(messages);

      await connection.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: "open",
        space,
        session: {},
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

  assertExists(await run(true));
  assertEquals(await run(false), undefined);
});
