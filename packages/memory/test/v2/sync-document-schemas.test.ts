import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "@commonfabric/api";
import {
  getModernCellRepConfig,
  linkRefFrom,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloMessage,
  parseMemoryProtocolFlags,
  type ServerMessage,
  type SessionSync,
} from "../../v2.ts";
import { connect, loopback, type Transport } from "../../v2/client.ts";
import { Server } from "../../v2/server.ts";
import {
  compressServerMessageSchemas,
  compressSessionSyncSchemas,
  expandServerMessageSchemas,
  expandSessionSyncSchemas,
  hasDocumentSchemaReferences,
  type SchemaTableSessionSync,
} from "../../v2/sync-schema-table.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "../v2-auth-test-helpers.ts";

/** Returns a schema large enough to make per-document repetition costly. */
function resultSchema(): JSONSchema {
  return {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
      `field${index}`,
      { type: "string", description: `Description of field ${index}` },
    ])),
    required: ["field1", "field0"],
    additionalProperties: false,
  };
}

/** Returns independently allocated metadata, as decoded storage rows hold it. */
function resultSync(count = 20): SessionSync {
  return {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: Array.from({ length: count }, (_, index) => ({
      id: `of:result-${index}`,
      branch: "",
      seq: 1,
      doc: { value: { field0: `row ${index}` }, schema: resultSchema() },
    })),
    removes: [],
  };
}

describe("sync-document-schemas", () => {
  it("reduces repeated metadata and reconstructs the complete sync after encoding", () => {
    const sync = resultSync();
    const before = encodeMemoryBoundary(sync);
    const compressed = compressSessionSyncSchemas(
      sync,
      undefined,
      true,
    ) as SchemaTableSessionSync;
    const wire = encodeMemoryBoundary(compressed);
    expect(wire.length).toBeLessThan(before.length / 4);
    expect(Object.keys(compressed.schemaTable!)).toHaveLength(1);
    expect(
      compressed.upserts.every((u) =>
        u.documentSchemaRef !== undefined && !Object.hasOwn(u.doc!, "schema")
      ),
    ).toBe(true);
    expect(expandSessionSyncSchemas(decodeMemoryBoundary(wire))).toEqual(sync);
    expect(encodeMemoryBoundary(sync)).toBe(before);
  });

  it("leaves unique, small, and content-addressed metadata inline", () => {
    const one = resultSync(1);
    expect(compressSessionSyncSchemas(one, undefined, true)).toBe(one);
    for (const schema of [true, false, {}, { $ref: "cid:fid1:existing" }]) {
      const sync = resultSync(2);
      for (const upsert of sync.upserts) upsert.doc = { value: 1, schema };
      expect(compressSessionSyncSchemas(sync, undefined, true)).toBe(sync);
    }
  });

  it("keeps metadata inline unless its additional capability is enabled", () => {
    const sync = resultSync();
    expect(compressSessionSyncSchemas(sync)).toBe(sync);
  });

  it("preserves nested application schemas and composes with link-schema tables", () => {
    const sync = resultSync(2);
    const application = {
      schema: resultSchema(),
      documentSchemaRef: "ordinary application data",
      ...Object.fromEntries([["__proto__", { safe: true }]]),
      nested: linkRefFrom({
        id: "of:target",
        path: [],
        schema: resultSchema(),
      }),
    };
    for (const upsert of sync.upserts) {
      upsert.doc = {
        value: application,
        schema: {
          ...resultSchema() as object,
          default: linkRefFrom({ id: "of:default", path: [], schema: true }),
        },
      };
    }
    const compressed = compressSessionSyncSchemas(sync, undefined, true);
    expect(expandSessionSyncSchemas(compressed)).toEqual(sync);
    expect(hasDocumentSchemaReferences({
      type: "response",
      ok: { sync },
    })).toBe(false);
  });

  it("expands metadata-only references in response and effect envelopes", () => {
    const sync = resultSync(2);
    const messages: ServerMessage[] = [
      { type: "response", requestId: "watch", ok: { sync } },
      {
        type: "session/effect",
        sessionId: "test-session",
        space: "did:key:test-space",
        effect: sync,
      },
    ];
    for (const message of messages) {
      const compressed = compressServerMessageSchemas(message, undefined, true);
      expect(hasDocumentSchemaReferences(compressed)).toBe(true);
      expect(encodeMemoryBoundary(compressed).includes("schema-ref@2:")).toBe(
        false,
      );
      expect(expandServerMessageSchemas(compressed)).toEqual(message);
    }
  });

  it("preserves Fabric values in schema defaults through the wire codec", () => {
    const sync = resultSync(2);
    for (const upsert of sync.upserts) {
      upsert.doc = {
        value: 1,
        schema: { ...resultSchema() as object, default: 1n },
      };
    }
    const compressed = compressSessionSyncSchemas(sync, undefined, true);
    expect(
      expandSessionSyncSchemas(
        decodeMemoryBoundary(encodeMemoryBoundary(compressed)),
      ),
    )
      .toEqual(sync);
  });

  it("restores metadata alongside modern links", () => {
    const previous = getModernCellRepConfig();
    setModernCellRepConfig(true);
    try {
      const sync = resultSync(2);
      for (const upsert of sync.upserts) {
        upsert.doc = {
          schema: resultSchema(),
          value: linkRefFrom({
            id: "of:target",
            path: [],
            schema: resultSchema(),
          }),
        };
      }
      const compressed = compressSessionSyncSchemas(sync, undefined, true);
      expect(
        expandSessionSyncSchemas(
          decodeMemoryBoundary(encodeMemoryBoundary(compressed)),
        ),
      )
        .toEqual(sync);
    } finally {
      setModernCellRepConfig(previous);
    }
  });

  it("rejects missing, forged, or ambiguous document-schema references", () => {
    const sync = compressSessionSyncSchemas(
      resultSync(2),
      undefined,
      true,
    ) as SchemaTableSessionSync;
    const hash = sync.upserts[0].documentSchemaRef!;
    for (
      const schemaTable of [undefined, {}, {
        [hash]: { type: "number" as const },
      }]
    ) {
      expect(() => expandSessionSyncSchemas({ ...sync, schemaTable }))
        .toThrow();
    }
    for (
      const upsert of [
        { ...sync.upserts[0], documentSchemaRef: "" },
        { ...sync.upserts[0], documentSchemaRef: undefined },
        { ...sync.upserts[0], doc: undefined },
        { ...sync.upserts[0], doc: { value: 1, schema: true } },
      ]
    ) {
      expect(() => expandSessionSyncSchemas({ ...sync, upserts: [upsert] }))
        .toThrow();
    }
  });

  it("defaults absent capabilities to false and rejects malformed flags", () => {
    const flags = getMemoryProtocolFlags();
    const { syncDocumentSchemasV1: _capability, ...oldFlags } = flags;
    expect(parseMemoryProtocolFlags(oldFlags)?.syncDocumentSchemasV1).toBe(
      false,
    );
    expect(parseMemoryProtocolFlags({ ...flags, syncDocumentSchemasV1: "yes" }))
      .toBeNull();
  });

  for (const clientCapability of [undefined, false, true]) {
    for (const serverCapability of [false, true]) {
      it(`restores cold metadata with client capability ${clientCapability} and server capability ${serverCapability}`, async () => {
        /** Server with an explicit peer capability for the negotiation matrix. */
        class TestServer extends Server {
          /** @inheritDoc */
          override memoryProtocolFlags() {
            return {
              ...super.memoryProtocolFlags(),
              syncDocumentSchemasV1: serverCapability,
            };
          }
        }
        const server = new TestServer({
          ...testSessionOpenServerOptions,
          store: new URL("memory://document-schema-negotiation"),
          subscriptionRefreshDelayMs: 0,
        });
        const underlying = loopback(server);
        const received: unknown[] = [];
        const transport: Transport = {
          ...underlying,
          send(payload) {
            const message = decodeMemoryBoundary(payload) as HelloMessage;
            if (message.type === "hello") {
              const flags = { ...message.flags };
              if (clientCapability === undefined) {
                delete flags.syncDocumentSchemasV1;
              } else flags.syncDocumentSchemasV1 = clientCapability;
              payload = encodeMemoryBoundary({ ...message, flags });
            }
            return underlying.send(payload);
          },
          setReceiver(receiver) {
            underlying.setReceiver((payload) => {
              received.push(decodeMemoryBoundary(payload));
              receiver(payload);
            });
          },
        };
        const client = await connect({ transport });
        try {
          const session = await client.mount(
            "did:key:document-schemas",
            {},
            testSessionOpenAuthFactory,
          );
          const sync = resultSync(2);
          await session.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: sync.upserts.map((u) => ({
              op: "set",
              id: u.id,
              value: u.doc!,
            })),
          });
          const view = await session.watchAdd([{
            id: "results",
            kind: "graph",
            query: {
              roots: sync.upserts.map((u) => ({
                id: u.id,
                selector: { path: [], schema: false },
              })),
            },
          }]);
          expect(received.some(hasDocumentSchemaReferences))
            .toBe(clientCapability === true && serverCapability);
          expect(view.entities.map((e) => e.document))
            .toEqual(sync.upserts.map((u) => u.doc));
        } finally {
          await client.close();
          await server.close();
        }
      });
    }
  }
});
