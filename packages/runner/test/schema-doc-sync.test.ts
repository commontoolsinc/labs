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
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import { resolveSchema } from "../src/schema.ts";
import { LINK_V1_TAG, type URI } from "../src/sigil-types.ts";
import { defer } from "@commonfabric/utils/defer";

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

  it("registers a schema document and its delivered closure on sync arrival", async () => {
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

    // Sync ONLY the root document; the server delivers the leaf in the same
    // frame (a schema document's own refs are embedded refs of a delivered
    // document), and the arrival hook registers both.
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

  it("leaves a forged schema document unregistered on arrival, with resolution closed", async () => {
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

  it("syncSchemaDocumentClosure() fails for a space that lacks the documents the realm registry holds", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { spaceless: { type: "string" } },
    };
    const decomposed = decomposeSchema(schema);
    // Realm-registered (as if another space delivered them), but never
    // written to THIS space.
    for (const [hash, document] of decomposed.documents) {
      registerSchemaDocument(hash, document);
    }
    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    const failure = await readerStorage.syncSchemaDocumentClosure(
      space,
      rootHash,
    );
    expect(failure).toBeDefined();
    expect(String(failure)).toContain("absent in this space");
  });

  it("syncSchemaDocumentClosure() fails on a forged local copy even when the realm registry can resolve the hash", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { forgedTwin: { type: "string" } },
    };
    const decomposed = decomposeSchema(schema);
    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    // The realm holds the valid content (as if another space supplied it);
    // THIS space stores a forgery under the same id.
    registerSchemaDocument(rootHash, decomposed.documents.get(rootHash)!);
    await writeDocs({
      [`cid:${rootHash}`]: { type: "number", title: "forged twin" },
    });

    const failure = await readerStorage.syncSchemaDocumentClosure(
      space,
      rootHash,
    );
    expect(failure).toBeDefined();
    expect(String(failure)).toContain("did not verify in this space");
  });

  it("delivers a dependency into the space even when the realm registry already holds it", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { chaseDespite: { $ref: "#/$defs/ChaseDespiteLeaf" } },
      $defs: {
        ChaseDespiteLeaf: {
          type: "object",
          properties: { despiteLeaf: { type: "string" } },
        },
      },
    };
    const decomposed = decomposeSchema(schema);
    await writeSchemaDocs(decomposed);

    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    const leafHash = [...decomposed.documents.keys()]
      .find((hash) => hash !== rootHash)!;
    // The leaf is already realm-registered (as if another space delivered
    // it); the server must still deliver it into THIS space.
    registerSchemaDocument(leafHash, decomposed.documents.get(leafHash)!);

    const provider = readerStorage.open(space);
    const result = await provider.sync(`cid:${rootHash}` as URI, {
      path: [],
      schema: false,
    });
    expect(result.error).toBeUndefined();
    await readerStorage.synced();

    const stored = (provider as unknown as {
      get: (uri: URI) => unknown;
    }).get(`cid:${leafHash}` as URI);
    expect(stored).toBeDefined();
  });

  it("fails a sync whose frame delivers a document with a broken external ref, and completes once the closure lands", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { brokenRef: { $ref: "#/$defs/BrokenRefLeaf" } },
      $defs: {
        BrokenRefLeaf: {
          type: "object",
          properties: { brokenRefLeaf: { type: "string" } },
        },
      },
    };
    const decomposed = decomposeSchema(schema);
    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    const leafHash = [...decomposed.documents.keys()]
      .find((hash) => hash !== rootHash)!;

    // Only the root exists, so the closure cannot be assembled — the
    // server's result-assembly pass must fail the query loudly, never
    // deliver a result with a hole in it.
    await writeDocs({
      [`cid:${rootHash}`]: decomposed.documents.get(rootHash)! as FabricValue,
    });
    const provider = readerStorage.open(space);
    const first = await provider.sync(`cid:${rootHash}` as URI, {
      path: [],
      schema: false,
    });
    expect(String(first.error?.message)).toContain("not stored in this space");
    expect(isSchemaDocumentClosureComplete(rootHash)).toBe(false);

    // The leaf lands late. A fresh sync (differently selected, so coverage
    // does not elide it) delivers the now-complete closure.
    await writeDocs({
      [`cid:${leafHash}`]: decomposed.documents.get(leafHash)! as FabricValue,
    });
    const second = await provider.sync(`cid:${rootHash}` as URI, {
      path: [],
      schema: true,
    });
    expect(second.error).toBeUndefined();
    expect(isSchemaDocumentClosureComplete(rootHash)).toBe(true);
  });

  it("delivers the closure behind a document's embedded refs on a schema-less pull", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { rejectingPull: { $ref: "#/$defs/RejectingPullLeaf" } },
      $defs: {
        RejectingPullLeaf: {
          type: "object",
          properties: { rejectingLeaf: { type: "string" } },
        },
      },
    };
    const decomposed = decomposeSchema(schema);
    await writeSchemaDocs(decomposed);
    await writeDocs({
      "of:rejecting-carrier": {
        carried: {
          "/": {
            "link@1": {
              id: "of:rejecting-carrier-target",
              path: [],
              schema: { $ref: decomposed.rootRef },
            },
          },
        },
      } as FabricValue,
    });

    // The bug this pins: a schema:false pull delivered the carrier alone,
    // leaving its embedded refs permanently unresolvable in the receiving
    // realm — the delivery guarantee violated for non-traversing pulls.
    const provider = readerStorage.open(space);
    const result = await provider.sync("of:rejecting-carrier" as URI, {
      path: [],
      schema: false,
    });
    expect(result.error).toBeUndefined();
    await readerStorage.synced();

    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    expect(isSchemaDocumentClosureComplete(rootHash)).toBe(true);
    for (const hash of decomposed.documents.keys()) {
      const stored = (provider as unknown as {
        get: (uri: URI) => unknown;
      }).get(`cid:${hash}` as URI);
      expect(stored).toBeDefined();
    }
  });

  it("delivers the closures behind both branches of one carrier document", async () => {
    const left = decomposeSchema({
      type: "object",
      properties: { leftBranch: { type: "string" } },
    });
    const right = decomposeSchema({
      type: "object",
      properties: { rightBranch: { type: "number" } },
    });
    await writeSchemaDocs(left);
    await writeSchemaDocs(right);
    await writeDocs({
      "of:two-branch-carrier": {
        left: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:two-branch-a",
              path: [],
              schema: { $ref: left.rootRef },
            },
          },
        },
        right: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:two-branch-b",
              path: [],
              schema: { $ref: right.rootRef },
            },
          },
        },
      } as FabricValue,
    });

    // The scan is document-granular: one delivery of the carrier collects
    // the refs of every branch, whichever path a traversal selected.
    const provider = readerStorage.open(space);
    const result = await provider.sync("of:two-branch-carrier" as URI, {
      path: [],
      schema: false,
    });
    expect(result.error).toBeUndefined();
    for (const decomposed of [left, right]) {
      for (const hash of decomposed.documents.keys()) {
        const stored = (provider as unknown as {
          get: (uri: URI) => unknown;
        }).get(`cid:${hash}` as URI);
        expect(stored).toBeDefined();
      }
    }
  });

  it("fails a pull whose carrier embeds a link schema ref that no document backs", async () => {
    const missing = internSchemaAsTaggedHashString({
      type: "object",
      properties: { danglingCarrierRef: { type: "string" } },
    });
    await writeDocs({
      "of:dangling-carrier": {
        linked: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:dangling-target",
              path: [],
              schema: { $ref: `cid:${missing}` },
            },
          },
        },
      } as FabricValue,
    });

    const result = await readerStorage.open(space).sync(
      "of:dangling-carrier" as URI,
      { path: [], schema: false },
    );
    expect(String(result.error?.message)).toContain("not stored in this space");
  });

  it("fails a pull whose stored dependency is forged even though the realm registry holds a valid copy", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { forgedDep: { $ref: "#/$defs/ForgedDepLeaf" } },
      $defs: {
        ForgedDepLeaf: {
          type: "object",
          properties: { forgedDepLeaf: { type: "string" } },
        },
      },
    };
    const decomposed = decomposeSchema(schema);
    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    const leafHash = [...decomposed.documents.keys()]
      .find((hash) => hash !== rootHash)!;
    await writeDocs({
      [`cid:${rootHash}`]: decomposed.documents.get(rootHash)! as FabricValue,
      [`cid:${leafHash}`]: { type: "number", title: "forged dep" },
    });
    // The realm registry holds the valid leaf (as if another space
    // delivered it); assembly must still fail on THIS space's forgery.
    registerSchemaDocument(leafHash, decomposed.documents.get(leafHash)!);

    const result = await readerStorage.open(space).sync(
      `cid:${rootHash}` as URI,
      { path: [], schema: false },
    );
    expect(String(result.error?.message)).toContain(
      "did not verify in this space",
    );
  });

  it("delivers the closure behind a ref a document gains after the watch was established", async () => {
    const decomposed = decomposeSchema({
      type: "object",
      properties: { lateRefMarker: { type: "string" } },
    });
    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    await writeDocs({
      "of:late-ref-carrier": { plain: "v1" } as FabricValue,
    });
    const provider = readerStorage.open(space);
    const first = await provider.sync("of:late-ref-carrier" as URI, {
      path: [],
      schema: false,
    });
    expect(first.error).toBeUndefined();
    const getDoc = (provider as unknown as {
      get: (uri: URI) => unknown;
    }).get.bind(provider);
    expect(getDoc(`cid:${rootHash}` as URI)).toBeUndefined();

    // The carrier gains a ref, closure written with it (the write-side
    // guarantee). The watch refresh must scan the NEW version and deliver
    // the closure in the same frame, even though the selector was already
    // covered and re-traversal is elided.
    const updated = defer<void>();
    const cancel = (provider as unknown as {
      sink: (uri: URI, callback: (doc: unknown) => void) => () => void;
    }).sink("of:late-ref-carrier" as URI, (doc: unknown) => {
      if (
        doc !== undefined && typeof doc === "object" && doc !== null &&
        "value" in doc &&
        typeof (doc as { value?: unknown }).value === "object" &&
        (doc as { value: { linked?: unknown } }).value?.linked !== undefined
      ) {
        updated.resolve();
      }
    });
    await writeSchemaDocs(decomposed);
    await writeDocs({
      "of:late-ref-carrier": {
        linked: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:late-ref-target",
              path: [],
              schema: { $ref: decomposed.rootRef },
            },
          },
        },
      } as FabricValue,
    });
    await updated.promise;
    cancel();
    expect(getDoc(`cid:${rootHash}` as URI)).toBeDefined();
  });

  it("holds a failed refresh without corrupting the watch, and delivers the closure once the store is repaired", async () => {
    const decomposed = decomposeSchema({
      type: "object",
      properties: { heldRefresh: { $ref: "#/$defs/HeldRefreshLeaf" } },
      $defs: {
        HeldRefreshLeaf: {
          type: "object",
          properties: { heldRefreshLeaf: { type: "string" } },
        },
      },
    });
    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    const leafHash = [...decomposed.documents.keys()]
      .find((hash) => hash !== rootHash)!;
    await writeDocs({
      "of:held-refresh-carrier": { plain: "v1" } as FabricValue,
    });
    const provider = readerStorage.open(space);
    const first = await provider.sync("of:held-refresh-carrier" as URI, {
      path: [],
      schema: false,
    });
    expect(first.error).toBeUndefined();

    // The carrier gains a ref but only PART of the closure is written —
    // the write-side guarantee deliberately violated. The push refresh
    // fails server-side and delivers nothing.
    await writeDocs({
      [`cid:${rootHash}`]: decomposed.documents.get(rootHash)! as FabricValue,
      "of:held-refresh-carrier": {
        linked: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:held-refresh-target",
              path: [],
              schema: { $ref: decomposed.rootRef },
            },
          },
        },
      } as FabricValue,
    });

    // The established session's delivery is held (it keeps serving its
    // consistent pre-break view), while a FRESH session reading the latest
    // store fails loudly against the hole.
    const probeStorage = EmulatedStorageManager.connectTo(server, {
      as: await Identity.fromPassphrase("schema-doc-sync"),
    });
    try {
      const probe = await probeStorage.open(space).sync(
        "of:held-refresh-carrier" as URI,
        { path: [], schema: false },
      );
      expect(String(probe.error?.message)).toContain(
        "not stored in this space",
      );
    } finally {
      await probeStorage.close();
    }

    // The repair lands the leaf; the held dirty state re-delivers with the
    // full closure, through the same watch.
    const repaired = defer<void>();
    const cancel = (provider as unknown as {
      sink: (uri: URI, callback: (doc: unknown) => void) => () => void;
    }).sink("of:held-refresh-carrier" as URI, (doc: unknown) => {
      if (
        doc !== null && typeof doc === "object" && doc !== undefined &&
        "value" in doc &&
        (doc as { value: { linked?: unknown } }).value?.linked !== undefined
      ) {
        repaired.resolve();
      }
    });
    await writeDocs({
      [`cid:${leafHash}`]: decomposed.documents.get(leafHash)! as FabricValue,
    });
    await repaired.promise;
    cancel();
    const getDoc = (provider as unknown as {
      get: (uri: URI) => unknown;
    }).get.bind(provider);
    expect(getDoc(`cid:${rootHash}` as URI)).toBeDefined();
    expect(getDoc(`cid:${leafHash}` as URI)).toBeDefined();
    expect(isSchemaDocumentClosureComplete(rootHash)).toBe(true);
  });

  it("fails a sync after an established dependency is replaced with forged content", async () => {
    const decomposed = decomposeSchema({
      type: "object",
      properties: { forgedSwap: { $ref: "#/$defs/ForgedSwapLeaf" } },
      $defs: {
        ForgedSwapLeaf: {
          type: "object",
          properties: { forgedSwapLeaf: { type: "string" } },
        },
      },
    });
    const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
    const leafHash = [...decomposed.documents.keys()]
      .find((hash) => hash !== rootHash)!;
    await writeSchemaDocs(decomposed);
    await writeDocs({
      "of:forged-swap-carrier": {
        linked: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:forged-swap-target",
              path: [],
              schema: { $ref: decomposed.rootRef },
            },
          },
        },
      } as FabricValue,
    });
    const provider = readerStorage.open(space);
    const first = await provider.sync("of:forged-swap-carrier" as URI, {
      path: [],
      schema: false,
    });
    expect(first.error).toBeUndefined();

    // The leaf's stored content is swapped for a forgery (still
    // schema-shaped, so only the identity check can catch it). Assembly
    // re-verifies the changed version, so a fresh session reading the
    // latest store fails loudly — a valid realm-registry copy
    // notwithstanding.
    await writeDocs({
      [`cid:${leafHash}`]: { type: "boolean", title: "forged replacement" },
    });
    const probeStorage = EmulatedStorageManager.connectTo(server, {
      as: await Identity.fromPassphrase("schema-doc-sync"),
    });
    try {
      const probe = await probeStorage.open(space).sync(
        "of:forged-swap-carrier" as URI,
        { path: [], schema: false },
      );
      expect(String(probe.error?.message)).toContain(
        "did not verify in this space",
      );
    } finally {
      await probeStorage.close();
    }
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
