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
import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
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

  const writeDocsResult = async (
    values: Record<string, FabricValue>,
  ) => {
    const tx = writer.edit();
    for (const [id, value] of Object.entries(values)) {
      tx.writeValueOrThrow(
        { space, id: id as URI, scope: "space", path: [] },
        value,
      );
    }
    return await tx.commit();
  };

  const writeDocs = async (
    values: Record<string, FabricValue>,
  ): Promise<void> => {
    const result = await writeDocsResult(values);
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

  it("rejects a commit installing a schema document without its closure, and delivers once complete", async () => {
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

    // The root references the leaf, so installing it alone is an
    // incomplete closure the commit boundary refuses.
    const partial = await writeDocsResult({
      [`cid:${rootHash}`]: decomposed.documents.get(rootHash)! as FabricValue,
    });
    expect(String(partial.error?.message)).toContain(
      "neither included in the commit nor stored in the space",
    );

    // The complete closure commits, and a sync delivers it whole.
    await writeSchemaDocs(decomposed);
    const provider = readerStorage.open(space);
    const synced = await provider.sync(`cid:${rootHash}` as URI, {
      path: [],
      schema: false,
    });
    expect(synced.error).toBeUndefined();
    expect(isSchemaDocumentClosureComplete(rootHash)).toBe(true);
    const stored = (provider as unknown as {
      get: (uri: URI) => unknown;
    }).get(`cid:${leafHash}` as URI);
    expect(stored).toBeDefined();
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

  it("rejects a commit whose carrier references a schema document nothing backs", async () => {
    const missing = internSchemaAsTaggedHashString({
      type: "object",
      properties: { danglingCarrierRef: { type: "string" } },
    });
    const result = await writeDocsResult({
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
    expect(String(result.error?.message)).toContain(
      "neither included in the commit nor stored in the space",
    );
  });

  it("rejects a commit backing a reference with forged schema content", async () => {
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
    const result = await writeDocsResult({
      [`cid:${rootHash}`]: decomposed.documents.get(rootHash)! as FabricValue,
      [`cid:${leafHash}`]: { type: "number", title: "forged dep" },
    });
    expect(String(result.error?.message)).toContain(
      "whose included content does not verify",
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

  it("quarantines a frame entry that replaces a stored schema document's content", async () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { replacedTarget: { type: "string" } },
    };
    const hash = internSchemaAsTaggedHashString(schema);
    await writeDocs({ [`cid:${hash}`]: schema as FabricValue });

    const provider = readerStorage.open(space);
    const result = await provider.sync(`cid:${hash}` as URI, {
      path: [],
      schema: false,
    });
    expect(result.error).toBeUndefined();
    await readerStorage.synced();

    // A frame no compliant server sends: the stored, verified document's id
    // re-delivered with different content. Arrival validation quarantines
    // the ARRIVING copy — no throw (a throw here killed the background
    // consumer wholesale, verification-coverage.md OW61) — and the stored,
    // verified document stays.
    const forged = {
      type: "sync",
      fromSeq: 900_000,
      toSeq: 900_001,
      upserts: [{
        branch: "",
        id: `cid:${hash}`,
        scope: "space",
        seq: 900_000,
        doc: { value: { type: "number", title: "forged replacement" } },
      }],
      removes: [],
    };
    const replica = provider.replica as unknown as {
      applySessionSync(sync: unknown, type: string): void;
      getDocument(uri: string): unknown;
    };
    replica.applySessionSync(forged, "integrate");
    expect(
      (replica.getDocument(`cid:${hash}`) as { value?: unknown })?.value,
    ).toEqual(schema);
  });

  it("quarantines a doc delivered with a broken schema ref, applying the rest of the frame", () => {
    const absent = internSchemaAsTaggedHashString({
      type: "string",
      title: "never-delivered-dep",
    });
    const provider = readerStorage.open(space);
    // Malformed entries (a non-string id, a non-object doc) are skipped by
    // the validation scan. The well-formed carrier embedding a broken ref
    // is quarantined — fail-closed for THAT doc — while its innocent
    // sibling in the same frame applies: the frame-wide rejection (and on
    // the background consume path, the process kill it turned into) is
    // exactly the OW61 robustness hole.
    const frame = {
      type: "sync",
      fromSeq: 800_000,
      toSeq: 800_001,
      upserts: [
        { branch: "", id: 42, scope: "space", seq: 1, doc: { value: {} } },
        {
          branch: "",
          id: "of:frame-junk",
          scope: "space",
          seq: 1,
          doc: "junk",
        },
        {
          branch: "",
          id: "of:frame-innocent-sibling",
          scope: "space",
          seq: 1,
          doc: { value: { fine: true } },
        },
        {
          branch: "",
          id: "of:frame-carrier",
          scope: "space",
          seq: 1,
          doc: {
            value: {
              linked: {
                "/": {
                  [LINK_V1_TAG]: {
                    id: "of:frame-target",
                    path: [],
                    schema: { $ref: `cid:${absent}` },
                  },
                },
              },
            },
          },
        },
      ],
      removes: [],
    };
    const replica = provider.replica as unknown as {
      applySessionSync(sync: unknown, type: string): void;
      getDocument(uri: string): unknown;
    };
    replica.applySessionSync(frame, "integrate");
    expect(replica.getDocument("of:frame-innocent-sibling")).toEqual({
      value: { fine: true },
    });
    expect(replica.getDocument("of:frame-carrier")).toBeUndefined();
  });

  it("heals a quarantined doc when a later frame carries the cid sibling (the full-evaluation shape)", () => {
    const depSchema = {
      type: "string",
      title: "heals-on-redelivery",
    } as const;
    const depHash = internSchemaAsTaggedHashString(depSchema);
    const provider = readerStorage.open(space);
    const replica = provider.replica as unknown as {
      applySessionSync(sync: unknown, type: string): void;
      getDocument(uri: string): unknown;
    };
    const carrierDoc = {
      value: {
        linked: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:heal-target",
              path: [],
              schema: { $ref: `cid:${depHash}` },
            },
          },
        },
      },
    };
    // Frame 1: the mentioning doc WITHOUT its cid sibling — what a
    // replica that failed to absorb/retain the earlier cid delivery
    // sees (the OW61 client-side defect class; the server's elision of
    // already-delivered cid docs is the design). Quarantined, replica
    // untouched for it.
    replica.applySessionSync({
      type: "sync",
      fromSeq: 700_000,
      toSeq: 700_001,
      upserts: [
        {
          branch: "",
          id: "of:heal-carrier",
          scope: "space",
          seq: 1,
          doc: carrierDoc,
        },
      ],
      removes: [],
    }, "integrate");
    expect(replica.getDocument("of:heal-carrier")).toBeUndefined();
    // Frame 2: a frame carrying mention AND sibling together — the
    // shape a FULL evaluation produces (watch.set / reconnect ship the
    // whole assembled closure; per-frame resend was reversed, OW61
    // RULED 2026-08-24). The doc applies: quarantine heals there.
    replica.applySessionSync({
      type: "sync",
      fromSeq: 700_001,
      toSeq: 700_002,
      upserts: [
        {
          branch: "",
          id: "of:heal-carrier",
          scope: "space",
          seq: 2,
          doc: carrierDoc,
        },
        {
          branch: "",
          id: `cid:${depHash}`,
          scope: "space",
          seq: 2,
          doc: { value: depSchema },
        },
      ],
      removes: [],
    }, "integrate");
    expect(replica.getDocument("of:heal-carrier")).toEqual(carrierDoc);
  });

  it("absorbs a doc whose cid arrives in a LATER frame, with no re-delivery of the doc (the elision shape)", () => {
    const depSchema = {
      type: "string",
      title: "absorbs-late-cid",
    } as const;
    const depHash = internSchemaAsTaggedHashString(depSchema);
    const provider = readerStorage.open(space);
    const replica = provider.replica as unknown as {
      applySessionSync(sync: unknown, type: string): void;
      getDocument(uri: string): unknown;
    };
    const carrierDoc = {
      value: {
        linked: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:absorb-target",
              path: [],
              schema: { $ref: `cid:${depHash}` },
            },
          },
        },
      },
    };
    // Frame 1: the mentioning doc arrives BEFORE the cid it names. The
    // client's contract is to ABSORB every frame the server sends —
    // never to dismiss one (OW61's owner ruling, 2026-08-24). Holding
    // the doc back from the visible state is fail-closed and correct;
    // DISCARDING it is the defect, because of what frame 2 cannot do.
    replica.applySessionSync({
      type: "sync",
      fromSeq: 900_000,
      toSeq: 900_001,
      upserts: [
        {
          branch: "",
          id: "of:absorb-carrier",
          scope: "space",
          seq: 1,
          doc: carrierDoc,
        },
      ],
      removes: [],
    }, "integrate");
    // Frame 2: the cid sibling ALONE. The server elides an already-
    // delivered cid doc and never re-sends an unchanged carrier, so
    // this is the only further information this session will ever
    // carry about the pair — there is no full evaluation coming. The
    // carrier must become resident off the client's own retained copy.
    replica.applySessionSync({
      type: "sync",
      fromSeq: 900_001,
      toSeq: 900_002,
      upserts: [
        {
          branch: "",
          id: `cid:${depHash}`,
          scope: "space",
          seq: 2,
          doc: { value: depSchema },
        },
      ],
      removes: [],
    }, "integrate");
    expect(replica.getDocument("of:absorb-carrier")).toEqual(carrierDoc);
  });

  it("PULLS the cid a parked doc waits on and applies it, with nothing re-delivered (the OW61 board's shape)", async () => {
    // #6248's ensure-ON board: the cid document IS installed in the
    // space — the server elides it because this session already
    // received it — and the replica that lacks it holds a mentioning
    // doc it can never be re-sent. Absorbing is only half the answer;
    // the client has to go GET what it is missing, or the parked doc
    // waits for a full evaluation that never comes mid-session.
    const depSchema: JSONSchemaObj = {
      type: "object",
      properties: { pulledLeaf: { type: "string" } },
      title: "pulled-by-the-park",
    };
    const decomposed = decomposeSchema(depSchema);
    await writeSchemaDocs(decomposed);
    const depHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;

    const provider = readerStorage.open(space);
    const replica = provider.replica as unknown as {
      applySessionSync(sync: unknown, type: string): void;
      getDocument(uri: string): unknown;
    };
    const carrierDoc = {
      value: {
        linked: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:pull-target",
              path: [],
              schema: { $ref: `cid:${depHash}` },
            },
          },
        },
      },
    };
    const released = defer<void>();
    const cancel = (provider as unknown as {
      sink: (uri: URI, callback: (doc: unknown) => void) => () => void;
    }).sink("of:pull-carrier" as URI, (doc: unknown) => {
      if (doc !== undefined) released.resolve();
    });

    // The elision shape: the mentioning doc alone, naming a cid this
    // replica has never received. Nothing will re-deliver either one.
    replica.applySessionSync({
      type: "sync",
      fromSeq: 950_000,
      toSeq: 950_001,
      upserts: [
        {
          branch: "",
          id: "of:pull-carrier",
          scope: "space",
          seq: 1,
          doc: carrierDoc,
        },
      ],
      removes: [],
    }, "integrate");
    // Held, not visible — fail-closed survives.
    expect(replica.getDocument("of:pull-carrier")).toBeUndefined();

    // The park's own pull fetches the cid from the space and releases
    // the carrier: absorbed, healed IN SESSION, no re-delivery. Waited
    // on the release itself — the sink fires when the carrier becomes
    // visible, which is the event under test.
    await released.promise;
    expect(replica.getDocument(`cid:${depHash}`)).toBeDefined();
    expect(replica.getDocument("of:pull-carrier")).toEqual(carrierDoc);
    cancel();
  });

  it("the background consumer survives a frame that fails to apply and keeps consuming", async () => {
    const provider = readerStorage.open(space);
    const replica = provider.replica as unknown as {
      applySessionSync(sync: unknown, type: string): void;
      consumeUpdates(iterator: AsyncIterator<unknown>): Promise<void>;
      getDocument(uri: string): unknown;
    };
    // Throw once from applySessionSync itself (any non-validation apply
    // bug), self-restoring: the belt in consumeUpdates must swallow it,
    // keep the loop alive, and apply the NEXT frame.
    const original = replica.applySessionSync.bind(replica);
    replica.applySessionSync = (_sync: unknown, _type: string) => {
      replica.applySessionSync = original;
      throw new Error("synthetic apply failure");
    };
    const frames = [
      {
        type: "sync",
        fromSeq: 600_000,
        toSeq: 600_001,
        upserts: [{
          branch: "",
          id: "of:survivor-1",
          scope: "space",
          seq: 1,
          doc: { value: { n: 1 } },
        }],
        removes: [],
      },
      {
        type: "sync",
        fromSeq: 600_001,
        toSeq: 600_002,
        upserts: [{
          branch: "",
          id: "of:survivor-2",
          scope: "space",
          seq: 1,
          doc: { value: { n: 2 } },
        }],
        removes: [],
      },
    ];
    let index = 0;
    const iterator: AsyncIterator<unknown> = {
      next: () =>
        Promise.resolve(
          index < frames.length
            ? { done: false, value: frames[index++] }
            : { done: true, value: undefined },
        ),
    };
    // Must resolve (not reject): a rejection here was the unhandled
    // rejection that killed consuming workers wholesale (OW61).
    await replica.consumeUpdates(iterator);
    expect(replica.getDocument("of:survivor-1")).toBeUndefined();
    expect(replica.getDocument("of:survivor-2")).toEqual({ value: { n: 2 } });
  });

  it("closes the staged watch view when a frame fails validation", async () => {
    const provider = readerStorage.open(space);
    const replica = provider.replica as unknown as {
      applySessionSync(sync: unknown, type: string): void;
    };
    const original = replica.applySessionSync.bind(replica);
    replica.applySessionSync = () => {
      throw new Error("synthetic frame validation failure");
    };
    try {
      const result = await provider.sync("of:view-close-probe" as URI, {
        path: [],
        schema: false,
      });
      expect(String(result.error?.message)).toContain(
        "synthetic frame validation failure",
      );
    } finally {
      replica.applySessionSync = original;
    }
  });

  it("propagates a provider teardown failure out of close", async () => {
    const signer = await Identity.fromPassphrase("schema-doc-sync");
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const provider = storage.open(space) as unknown as {
      destroy(): Promise<void>;
    };
    const originalDestroy = provider.destroy.bind(provider);
    provider.destroy = () => {
      provider.destroy = originalDestroy;
      return Promise.reject(new Error("synthetic destroy failure"));
    };
    await expect(storage.close()).rejects.toThrow("synthetic destroy failure");
    // The rejection left the providers in place; a second close tears them
    // down for real.
    await storage.close();
  });

  it("propagates a provider teardown failure out of closeNow", async () => {
    const signer = await Identity.fromPassphrase("schema-doc-sync");
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const provider = storage.open(space) as unknown as {
      destroyNow(): Promise<void>;
    };
    const originalDestroyNow = provider.destroyNow.bind(provider);
    provider.destroyNow = () => {
      provider.destroyNow = originalDestroyNow;
      return Promise.reject(new Error("synthetic destroyNow failure"));
    };
    await expect(storage.closeNow()).rejects.toThrow(
      "synthetic destroyNow failure",
    );
    await storage.closeNow();
  });

  it("sends a selector reference once its closure is resident, and the server resolves it", async () => {
    setContentAddressedSchemasConfig(true);
    try {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { selectorField: { $ref: "#/$defs/SelectorLeaf" } },
        $defs: {
          SelectorLeaf: {
            type: "object",
            properties: { selectorLeafField: { type: "string" } },
          },
        },
      };
      const decomposed = decomposeSchema(schema);
      await writeSchemaDocs(decomposed);
      await writeDocs({
        "of:selector-target": {
          selectorField: { selectorLeafField: "resident" },
        } as FabricValue,
      });

      const provider = readerStorage.open(space);
      // Cold: the closure is not in the replica yet, so this sync falls
      // back to the inline form (a wrongly emitted reference would be
      // answered with a loud QueryError, failing this expect).
      const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
      const cold = await provider.sync("of:selector-target" as URI, {
        path: [],
        schema,
      });
      expect(cold.error).toBeUndefined();
      await readerStorage.synced();

      // Deliver the closure so the replica holds it...
      const pull = await provider.sync(`cid:${rootHash}` as URI, {
        path: [],
        schema: false,
      });
      expect(pull.error).toBeUndefined();
      await readerStorage.synced();

      // ...and the same logical sync now emits a reference — the server
      // validates it against the space's store and resolves the traversal
      // through it, or answers loudly if it could not.
      const warm = await provider.sync("of:selector-target" as URI, {
        path: [],
        schema,
      });
      expect(warm.error).toBeUndefined();
      await readerStorage.synced();
      const stored = (provider as unknown as {
        get: (uri: URI) => { value?: unknown } | undefined;
      }).get("of:selector-target" as URI);
      expect(stored?.value).toEqual({
        selectorField: { selectorLeafField: "resident" },
      });
    } finally {
      resetContentAddressedSchemasConfig();
    }
  });
});
