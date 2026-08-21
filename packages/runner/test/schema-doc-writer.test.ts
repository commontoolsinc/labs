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
import { getLogger } from "@commonfabric/utils/logger";
import { createSigilLinkFromParsedLink } from "../src/link-utils.ts";
import type { NormalizedLink } from "../src/link-types.ts";
import {
  collectExternalSchemaRefHashes,
  parseExternalSchemaRef,
} from "../src/schema-decompose.ts";
import { resetContentAddressedSchemasConfig } from "../src/schema-doc-config.ts";
import { lookupSchemaDocument } from "../src/schema-registry.ts";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import {
  getSyncSchemaTableConfig,
  resetSyncSchemaTableConfig,
} from "@commonfabric/memory/v2";
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
  let signer: Identity;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("schema-doc-writer");
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
    // The ambient flag is realm-sticky; later test files must see its
    // default, and the sync schema table (disabled by the flag-on Runtime
    // construction above) must come back to its own.
    resetContentAddressedSchemasConfig();
    resetSyncSchemaTableConfig();
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

  it("re-installs the same closure across transactions under the immutability boundary", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { reinstalled: { $ref: "#/$defs/ReinstalledLeaf" } },
      $defs: {
        ReinstalledLeaf: {
          type: "object",
          properties: { reinstalledLeaf: { type: "string" } },
        },
      },
    };
    const sigilA = sigilFor(schema);
    const sigilB = sigilFor(schema);
    // The two decompositions bind to the SAME reference: a drifting second
    // decomposition would first-install fresh documents and both commits
    // would still succeed, so the identity of the refs is the pin.
    const refA = (payloadSchema(sigilA) as JSONSchemaObj).$ref!;
    const refB = (payloadSchema(sigilB) as JSONSchemaObj).$ref!;
    expect(refB).toBe(refA);

    const first = writer.edit();
    first.writeValueOrThrow(
      { space, id: "of:reinstall-a" as URI, scope: "space", path: [] },
      { person: sigilA },
    );
    expect((await first.commit()).ok).toBeDefined();

    // A second transaction referencing the same closure materializes the
    // same documents again. The commit boundary accepts only a first
    // installation or a content-identical re-set of a cid: document, so
    // this pins the writer's output as content-stable across transactions.
    const second = writer.edit();
    second.writeValueOrThrow(
      { space, id: "of:reinstall-b" as URI, scope: "space", path: [] },
      { person: sigilB },
    );
    expect((await second.commit()).ok).toBeDefined();

    // Every stored closure document verifies against its id.
    const rootHash = parseExternalSchemaRef(refA)!.taggedHash;
    const closure = new Set<string>([rootHash]);
    for (const hash of closure) {
      for (
        const dep of collectExternalSchemaRefHashes(lookupSchemaDocument(hash))
      ) {
        closure.add(dep);
      }
    }
    const provider = readerStorage.open(space);
    for (const hash of closure) {
      const synced = await provider.sync(`cid:${hash}` as URI, {
        path: [],
        schema: false,
      });
      expect(synced.error).toBeUndefined();
      const stored = (provider as unknown as {
        get: (uri: URI) => { value?: unknown } | undefined;
      }).get(`cid:${hash}` as URI);
      expect(
        internSchemaAsTaggedHashString(stored?.value as JSONSchemaObj),
      ).toBe(hash);
    }
  });

  it("externalizes a schema whose only external refs are embedded", () => {
    const vnodeRef = "https://commonfabric.org/schemas/vnode.json";
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { embeddedUi: { $ref: "#/$defs/EmbeddedUi" } },
      $defs: {
        EmbeddedUi: {
          type: "object",
          properties: { $UI: { $ref: vnodeRef } },
        },
      },
    };
    const stamped = payloadSchema(sigilFor(schema)) as JSONSchemaObj;
    // The embedded ref no longer refuses decomposition: the link carries a
    // cid: reference...
    expect(typeof stamped.$ref).toBe("string");
    const rootHash = parseExternalSchemaRef(stamped.$ref!)!.taggedHash;
    const rootDoc = lookupSchemaDocument(rootHash);
    expect(rootDoc).toBeDefined();
    // ...and the embedded URL rides inside the definition document as
    // ordinary content, contributing nothing to the closure.
    const [uiHash] = [...collectExternalSchemaRefHashes(rootDoc)];
    const uiDoc = lookupSchemaDocument(uiHash) as JSONSchemaObj;
    expect(uiDoc.properties?.["$UI"]).toEqual({ $ref: vnodeRef });
    expect(collectExternalSchemaRefHashes(uiDoc).size).toBe(0);
  });

  it("disables the sync schema table for the process", () => {
    // Both mechanisms dedupe the same link-schema positions; a flag-on
    // process must not negotiate the frame table (the Runtime in
    // beforeEach carries the flag).
    expect(getSyncSchemaTableConfig()).toBe(false);
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

  it("skips a reference the registry cannot supply; the commit boundary rejects it", async () => {
    // Only a hand-crafted value carries a reference its writer never
    // registered: the materializer skips it, and the server's commit-time
    // closure validation rejects the commit outright. The rejection alone
    // would also stand had the scan never met the reference, so the skip's
    // one client-side signal — a warning under its own message key, counted
    // even on a disabled logger — is what separates the two.
    const materializeLogger = getLogger("extended-storage-transaction");
    const skipKey = "schema-doc-materialize";
    const skipsBefore = materializeLogger.countsByKey[skipKey]?.warn ?? 0;
    const absentHash = internSchemaAsTaggedHashString({
      type: "string",
      title: "never-registered-writer-ref",
    });
    const handCrafted = {
      "/": {
        "link@1": {
          id: "of:unsupplied-target",
          path: [],
          schema: { $ref: `cid:${absentHash}` },
        },
      },
    };
    const tx = writer.edit();
    tx.writeValueOrThrow(
      { space, id: "of:unsupplied-root" as URI, scope: "space", path: [] },
      { crafted: handCrafted },
    );
    const result = await tx.commit();
    expect(materializeLogger.countsByKey[skipKey]?.warn ?? 0).toBe(
      skipsBefore + 1,
    );
    expect(result.ok).toBeUndefined();
    expect(String(result.error?.message)).toContain(
      "neither included in the commit nor stored in the space",
    );
  });

  it("resolves the skip warning's message when its logger speaks", async () => {
    // The sibling case above pins the count on a DISABLED logger; this one
    // runs the same skip with the logger on, so the warning's lazy message
    // resolves. A thunk is the one part of the path a silent run never
    // executes, and one that throws would turn a warning into a crash
    // exactly when someone turns the logger on to look.
    const materializeLogger = getLogger("extended-storage-transaction");
    const skipKey = "schema-doc-materialize";
    const skipsBefore = materializeLogger.countsByKey[skipKey]?.warn ?? 0;
    const wasDisabled = materializeLogger.disabled;
    const wasLevel = materializeLogger.level;
    materializeLogger.disabled = false;
    materializeLogger.level = "warn";
    try {
      const absentHash = internSchemaAsTaggedHashString({
        type: "string",
        title: "never-registered-loud-ref",
      });
      const handCrafted = {
        "/": {
          "link@1": {
            id: "of:unsupplied-loud-target",
            path: [],
            schema: { $ref: `cid:${absentHash}` },
          },
        },
      };
      const tx = writer.edit();
      tx.writeValueOrThrow(
        {
          space,
          id: "of:unsupplied-loud-root" as URI,
          scope: "space",
          path: [],
        },
        { crafted: handCrafted },
      );
      const result = await tx.commit();
      expect(result.ok).toBeUndefined();
      expect(materializeLogger.countsByKey[skipKey]?.warn ?? 0).toBe(
        skipsBefore + 1,
      );
    } finally {
      materializeLogger.disabled = wasDisabled;
      materializeLogger.level = wasLevel;
    }
  });

  it("stages nothing with the flag off, so the commit boundary rejects the reference", async () => {
    // Rollback semantics: an explicit `false` stops emission AND delivery.
    // The reference below is one the registry could supply — the flag-on
    // sigil stamping registered it — but the flag-off writer does not
    // stage its closure, so the server's commit-time validation refuses
    // the write. Turning the flag off stops the writer writing; documents
    // already stored keep satisfying that validation on their own.
    const schema: JSONSchemaObj = {
      type: "string",
      title: "flag-off-registered-ref",
    };
    const sigil = sigilFor(schema);
    const offStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    const offRuntime = new Runtime({
      storageManager: offStorage,
      apiUrl: new URL(import.meta.url),
      experimental: { contentAddressedSchemas: false },
    });
    try {
      const tx = offRuntime.edit();
      tx.writeValueOrThrow(
        { space, id: "of:flag-off-root" as URI, scope: "space", path: [] },
        { person: sigil },
      );
      const result = await tx.commit();
      expect(result.ok).toBeUndefined();
      expect(String(result.error?.message)).toContain(
        "neither included in the commit nor stored in the space",
      );
    } finally {
      await offRuntime.dispose();
      await offStorage.close();
    }
  });

  it("materializes a schema document once for two links that share it", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { sharedField: { type: "string" } },
    };
    const first = sigilFor(schema);
    const second = sigilFor(schema);
    // Both links bind to the same reference, so the materializer meets the
    // hash a second time within one transaction and serves it from its
    // dedupe set instead of writing again.
    expect(payloadSchema(second)).toEqual(payloadSchema(first));
    const tx = writer.edit();
    tx.writeValueOrThrow(
      { space, id: "of:shared-root-a" as URI, scope: "space", path: [] },
      { person: first },
    );
    tx.writeValueOrThrow(
      { space, id: "of:shared-root-b" as URI, scope: "space", path: [] },
      { person: second },
    );
    expect((await tx.commit()).ok).toBeDefined();
  });

  it("scans past a delete while collecting references", async () => {
    const setup = writer.edit();
    setup.writeValueOrThrow(
      { space, id: "of:doomed-doc" as URI, scope: "space", path: [] },
      { shortLived: true },
    );
    expect((await setup.commit()).ok).toBeDefined();

    // A transaction carrying both a delete (a write detail with no value)
    // and a reference-bearing link: the scan passes over the former and
    // still delivers the latter's closure.
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { survivorField: { type: "string" } },
    };
    const sigil = sigilFor(schema);
    const tx = writer.edit();
    tx.writeValuesOrThrow!([{
      address: {
        id: "of:doomed-doc" as URI,
        space,
        path: [],
        type: "application/json",
      } as never,
      value: undefined as never,
      delete: true,
    }]);
    tx.writeValueOrThrow(
      { space, id: "of:survivor-root" as URI, scope: "space", path: [] },
      { person: sigil },
    );
    expect((await tx.commit()).ok).toBeDefined();
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
      get: (uri: URI) => { value?: { vintage?: unknown } } | undefined;
    }).get("of:vintage-root" as URI);
    expect(stored).toBeDefined();
    // The stored link is still the inline vintage: the schema rides in
    // place, exactly as written — no reference was stamped on it, and no
    // sync-frame rewrite replaced it.
    const storedSchema = payloadSchema(stored!.value?.vintage) as
      | JSONSchemaObj
      | undefined;
    expect(storedSchema).toEqual({
      type: "object",
      properties: { vintageMarker: { type: "string" } },
    });
    expect(storedSchema?.$ref).toBeUndefined();
  });
});
