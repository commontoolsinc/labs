import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { JSONSchemaObj } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { linkRefPayload } from "@commonfabric/data-model/cell-rep";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { createSigilLinkFromParsedLink } from "../src/link-utils.ts";
import type { NormalizedLink } from "../src/link-types.ts";
import {
  collectExternalSchemaRefHashes,
  parseExternalSchemaRef,
} from "../src/schema-decompose.ts";
import { setContentAddressedSchemasConfig } from "../src/schema-doc-config.ts";
import { lookupSchemaDocument } from "../src/schema-registry.ts";
import type { CellLinkRefPayload, URI } from "../src/sigil-types.ts";

// The Phase 1 writer: with the flag on, a schema-bearing link is stamped
// with a cid: reference and the commit materializes the schema documents
// into the destination space (the write-side delivery guarantee).
describe("schema-doc-writer", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let space: MemorySpace;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("schema-doc-writer");
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      storageManager: writerStorage,
      apiUrl: new URL(import.meta.url),
      experimental: { contentAddressedSchemas: true },
    });
    space = signer.did();
  });

  afterEach(async () => {
    // The ambient flag is realm-sticky; later test files must see it off.
    setContentAddressedSchemasConfig(false);
    await writer.dispose();
    await writerStorage.close();
    await readerStorage.close();
    await server.close();
  });

  const sigilFor = (schema: JSONSchemaObj) => {
    const link: NormalizedLink = {
      id: "of:writer-target" as URI,
      space,
      path: [],
      schema,
    };
    return createSigilLinkFromParsedLink(link, {
      baseSpace: space,
      includeSchema: true,
    });
  };

  const payloadSchema = (sigil: unknown) =>
    (linkRefPayload(sigil as Parameters<typeof linkRefPayload>[0]) as
      | CellLinkRefPayload
      | undefined)?.schema;

  it("stamps a reference, and the commit delivers the closure to the space", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: {
        writerName: { $ref: "#/$defs/WriterName" },
        writerCount: { type: "number" },
      },
      $defs: { WriterName: { type: "string" } },
    };
    const sigil = sigilFor(schema);
    const stamped = payloadSchema(sigil) as JSONSchemaObj;

    // The link carries a reference, not the inline schema...
    expect(typeof stamped.$ref).toBe("string");
    const rootRef = stamped.$ref!;
    const rootHash = parseExternalSchemaRef(rootRef)!.taggedHash;
    // ...whose closure the writer registered realm-wide.
    expect(lookupSchemaDocument(rootHash)).toBeDefined();

    const tx = writer.edit();
    tx.writeValueOrThrow(
      { space, id: "of:writer-target" as URI, scope: "space", path: [] },
      { writerName: "Ada", writerCount: 3 },
    );
    tx.writeValueOrThrow(
      { space, id: "of:writer-root" as URI, scope: "space", path: [] },
      { person: sigil },
    );
    const result = await tx.commit();
    expect(result.ok).toBeDefined();

    // The same commit materialized the whole closure into the space: the
    // reader pulls the documents from storage, not from the shared realm
    // registry.
    const provider = readerStorage.open(space);
    const closure = new Set<string>([rootHash]);
    for (const hash of closure) {
      const document = lookupSchemaDocument(hash)!;
      for (const dep of collectExternalSchemaRefHashes(document)) {
        closure.add(dep);
      }
    }
    for (const hash of closure) {
      const synced = await provider.sync(`cid:${hash}` as URI, {
        path: [],
        schema: false,
      });
      expect(synced.error).toBeUndefined();
      const stored = (provider as unknown as {
        get: (uri: URI) => unknown;
      }).get(`cid:${hash}` as URI);
      expect(stored).toBeDefined();
    }
  });

  it("keeps a schema decomposition refuses inline", () => {
    const schema = {
      type: "object",
      properties: {
        refused: { $id: "https://example.invalid/x", type: "string" },
      },
    } as JSONSchemaObj;
    const stamped = payloadSchema(sigilFor(schema)) as JSONSchemaObj;
    expect(stamped.$ref).toBeUndefined();
    expect(stamped.properties).toBeDefined();
  });

  it("leaves inline-vintage links readable with the flag on", async () => {
    // A hand-built inline link (the stored vintage) written under the flag:
    // nothing on the read path consults the flag, so it reads as always.
    const inlineSigil = {
      "/": {
        "link@1": {
          id: "of:vintage-target",
          path: [],
          schema: {
            type: "object",
            properties: { vintageMarker: { type: "string" } },
          },
        },
      },
    };
    const tx = writer.edit();
    tx.writeValueOrThrow(
      { space, id: "of:vintage-target" as URI, scope: "space", path: [] },
      { vintageMarker: "still here" },
    );
    tx.writeValueOrThrow(
      { space, id: "of:vintage-root" as URI, scope: "space", path: [] },
      { vintage: inlineSigil },
    );
    expect((await tx.commit()).ok).toBeDefined();

    const provider = readerStorage.open(space);
    const synced = await provider.sync("of:vintage-root" as URI, {
      path: [],
      schema: true,
    });
    expect(synced.error).toBeUndefined();
    const stored = (provider as unknown as {
      get: (uri: URI) => unknown;
    }).get("of:vintage-root" as URI);
    expect(stored).toBeDefined();
  });
});
