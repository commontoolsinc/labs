import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { FabricValue, JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type DecomposedSchema,
  decomposeSchema,
  parseExternalSchemaRef,
} from "../src/schema-decompose.ts";
import {
  isSchemaDocumentClosureComplete,
  lookupSchemaDocument,
} from "../src/schema-registry.ts";
import { resolveSchema } from "../src/schema.ts";
import { LINK_V1_TAG, type URI } from "../src/sigil-types.ts";

// Two managers on one shared loopback server model two real sessions: what
// the writer commits reaches the reader only through an explicit sync, so
// the reader's registrations come from frame arrival, not from local writes.
describe("schema-doc-sync", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let space: MemorySpace;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("schema-doc-sync");
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      storageManager: writerStorage,
      apiUrl: new URL(import.meta.url),
    });
    space = signer.did();
  });

  afterEach(async () => {
    await writer.dispose();
    await writerStorage.close();
    await readerStorage.close();
    await server.close();
  });

  const writeDocs = async (
    values: Record<string, FabricValue>,
  ): Promise<void> => {
    const tx = writer.edit();
    for (const [id, value] of Object.entries(values)) {
      tx.writeValueOrThrow(
        { space, id: id as URI, scope: "space", path: [] },
        value,
      );
    }
    const result = await tx.commit();
    expect(result.ok).toBeDefined();
  };

  const writeSchemaDocs = (decomposed: DecomposedSchema): Promise<void> =>
    writeDocs(Object.fromEntries(
      [...decomposed.documents].map((
        [hash, document],
      ) => [`cid:${hash}`, document as FabricValue]),
    ));

  it("registers a schema document on sync arrival and chases its dependencies", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { arrivalChase: { $ref: "#/$defs/ArrivalChaseLeaf" } },
      $defs: {
        ArrivalChaseLeaf: {
          type: "object",
          properties: { arrivalLeaf: { type: "string" } },
        },
      },
    };
    const decomposed = decomposeSchema(schema);
    await writeSchemaDocs(decomposed);

    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    expect(lookupSchemaDocument(rootHash)).toBeUndefined();

    // Sync ONLY the root document; the arrival hook registers it and chases
    // the leaf, and `synced()` covers the chase to quiescence.
    const result = await readerStorage.open(space).sync(
      `cid:${rootHash}` as URI,
      { path: [], schema: false },
    );
    expect(result.error).toBeUndefined();
    expect(lookupSchemaDocument(rootHash)).toBeDefined();
    await readerStorage.synced();

    expect(isSchemaDocumentClosureComplete(rootHash)).toBe(true);
    expect(resolveSchema({ $ref: decomposed.rootRef })).not.toBe(false);
  });

  it("rejects a forged schema document on arrival and leaves resolution closed", async () => {
    const claimed = internSchemaAsTaggedHashString({
      type: "object",
      properties: { forgedSyncTarget: { type: "string" } },
    });
    await writeDocs({
      [`cid:${claimed}`]: { type: "string", title: "forged sync content" },
    });

    const result = await readerStorage.open(space).sync(
      `cid:${claimed}` as URI,
      { path: [], schema: false },
    );
    expect(result.error).toBeUndefined();
    expect(lookupSchemaDocument(claimed)).toBeUndefined();
    expect(resolveSchema({ $ref: `cid:${claimed}` })).toBe(false);
  });

  it("syncSchemaDocumentClosure() pulls a chain to completion and fails loudly on a hole", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { closureHelper: { $ref: "#/$defs/ClosureHelperMid" } },
      $defs: {
        ClosureHelperMid: {
          type: "object",
          properties: { mid: { $ref: "#/$defs/ClosureHelperLeaf" } },
        },
        ClosureHelperLeaf: { type: "number" },
      },
    };
    const decomposed = decomposeSchema(schema);
    await writeSchemaDocs(decomposed);

    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    const failure = await readerStorage.syncSchemaDocumentClosure(
      space,
      rootHash,
    );
    expect(failure).toBeUndefined();
    expect(isSchemaDocumentClosureComplete(rootHash)).toBe(true);

    // A reference whose document was never written fails loudly, not
    // silently: the closure stays incomplete and resolution stays closed.
    const missing = internSchemaAsTaggedHashString({
      type: "object",
      properties: { closureHelperMissing: { type: "string" } },
    });
    const holeFailure = await readerStorage.syncSchemaDocumentClosure(
      space,
      missing,
    );
    expect(holeFailure).toBeDefined();
  });

  it("keeps registrations alive past one manager's close while another session holds its lease", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { leaseSurvivor: { type: "string" } },
    };
    const decomposed = decomposeSchema(schema);
    await writeSchemaDocs(decomposed);

    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    const result = await readerStorage.open(space).sync(
      `cid:${rootHash}` as URI,
      { path: [], schema: false },
    );
    expect(result.error).toBeUndefined();
    expect(lookupSchemaDocument(rootHash)).toBeDefined();

    // The reader's session ends; the writer's lease still holds retention.
    // (The last-lease-out clear itself is pinned by the registry unit tests;
    // the shared teardown performs that transition after this test.)
    await readerStorage.close();
    expect(lookupSchemaDocument(rootHash)).toBeDefined();
  });

  it("delivers and registers the schema closure behind a reference link in the same round trip", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: {
        e2eName: { $ref: "#/$defs/E2eName" },
        e2eCount: { type: "number" },
      },
      $defs: { E2eName: { type: "string" } },
    };
    const decomposed = decomposeSchema(schema);
    await writeSchemaDocs(decomposed);
    await writeDocs({
      "of:e2e-target": { e2eName: "Ada", e2eCount: 3 },
      "of:e2e-root": {
        person: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:e2e-target",
              path: [],
              schema: { $ref: decomposed.rootRef },
            },
          },
        },
      },
    });

    // One schema-guided sync of the root doc: the server traversal follows
    // the link, loads the schema documents into the watch result, and the
    // reader registers them as the frame arrives — no second round trip.
    const result = await readerStorage.open(space).sync(
      "of:e2e-root" as URI,
      { path: [], schema: true },
    );
    expect(result.error).toBeUndefined();
    await readerStorage.synced();

    for (const hash of decomposed.documents.keys()) {
      expect(lookupSchemaDocument(hash)).toBeDefined();
    }
    const resolved = resolveSchema({
      $ref: decomposed.rootRef,
    }) as JSONSchema;
    expect(resolved).not.toBe(false);
    expect((resolved as JSONSchemaObj).type).toBe("object");
  });
});
