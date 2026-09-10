import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { WorkerReconciler } from "@commonfabric/html/worker";
import type { VDomOp } from "@commonfabric/html/vdom-ops";
import { Identity } from "@commonfabric/identity";
import {
  convertCellsToLinks,
  lookupSchemaDocument,
  Runtime,
  type SigilLink,
} from "@commonfabric/runner";
import {
  getCfcReferenceProvenance,
  readStoredCfcMetadata,
} from "@commonfabric/runner/cfc";
import { linkRefPayload } from "@commonfabric/runner/shared";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { ReferenceRegistry } from "@/backends/reference-registry.ts";
import {
  createCellRef,
  getCell,
  mapCellRefsToSigilLinks,
} from "@/backends/utils.ts";
import {
  type CellRef,
  ClientNotificationType,
  NotificationType,
  RequestType,
} from "@/protocol/mod.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";
import { $conn, CellHandle, type RuntimeClient } from "@/mod.ts";
import { createSigilLinkFromParsedLink } from "../../../runner/src/link-utils.ts";
import { decomposeSchema } from "../../../runner/src/schema-decompose.ts";
import type { URI } from "@commonfabric/memory/interface";
import { deriveFlowJoin } from "../../../runner/src/cfc/prepare.ts";
import { normalizeClause } from "../../../runner/src/cfc/clause.ts";
import type { LabelMapEntry } from "../../../runner/src/cfc/types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";
import { buildProcessor } from "./build-processor.ts";

const signer = await Identity.fromPassphrase("worker-reference-registry");
const space = signer.did();
const selection = normalizeClause({
  anyOf: ["selection", cfcAtom.space(space)],
});

/** Models the transport crossing, which discards live WeakMap associations. */
const wireCopy = <T>(value: T): T => structuredClone(value);

describe("reference-registry", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let registry: ReferenceRegistry;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
    registry = new ReferenceRegistry(runtime);
  });

  afterEach(async () => {
    registry.clear();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  const seed = async (
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    tx.writeOrThrow({ ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 2,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    return cell.withTx(undefined);
  };

  const acquireSelected = async () => {
    const target = await seed("target", { public: "visible" });
    const selected = await seed("selection", target.getAsLink(), [{
      path: [],
      observes: "followRef",
      origin: "link",
      label: { confidentiality: [selection] },
    }]);
    const tx = runtime.edit();
    const acquired = selected.withTx(tx).resolveAsCell();
    expect(getCfcReferenceProvenance(acquired)?.confidentiality).toEqual([
      selection,
    ]);
    tx.abort();
    return acquired.withTx(undefined);
  };

  it("keeps immutable tokens distinct by captured slots while deduplicating identical acquisitions", async () => {
    const held = await acquireSelected();
    const trusted = runtime.getImmutableCell(space, [held.getAsLink()]);
    const identical = runtime.getImmutableCell(space, [held.getAsLink()]);
    const independent = runtime.getCellFromLink(
      wireCopy(held.getAsNormalizedFullLink()),
    );
    const publicLiteral = runtime.getImmutableCell(space, [
      independent.getAsLink(),
    ]);
    const opaque = runtime.getImmutableCell(space, [
      wireCopy(independent.getAsLink()),
    ]);
    const trustedRef = createCellRef(trusted, undefined, registry);
    const identicalRef = createCellRef(identical, undefined, registry);
    const opaqueRef = createCellRef(opaque, undefined, registry);
    const publicRef = createCellRef(publicLiteral, undefined, registry);
    expect(getCfcReferenceProvenance(publicLiteral)?.confidentiality).toEqual(
      [],
    );
    expect(getCfcReferenceProvenance(opaque)?.confidentiality).toEqual([]);
    expect(publicRef.cfcReferenceToken).not.toBe(opaqueRef.cfcReferenceToken);
    expect(trustedRef.id).toBe(opaqueRef.id);
    expect(trustedRef.cfcReferenceToken).toBe(identicalRef.cfcReferenceToken);
    expect(trustedRef.cfcReferenceToken).not.toBe(opaqueRef.cfcReferenceToken);

    const tx = runtime.edit();
    const imported = getCell(runtime, wireCopy(trustedRef), registry).withTx(
      tx,
    );
    expect(imported.key("0", "public").get()).toBe("visible");
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    const transferred = registry.importLink(
      wireCopy(registry.exportLink(trusted.getAsLink(), trusted)),
    );
    const output = runtime.getCell(
      space,
      "immutable-token-write",
      undefined,
      tx,
    );
    output.set(transferred);
    expect((await tx.commit()).ok).toBeDefined();
    const read = runtime.edit();
    expect(output.withTx(read).key("0", "public").get()).toBe("visible");
    expect(deriveFlowJoin(read).confidentiality).toContainEqual(selection);
    const unproven = getCell(runtime, wireCopy(opaqueRef), registry).withTx(
      read,
    );
    expect(() => unproven.key("0").resolveAsCell()).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    read.abort();
  });

  it("retains selected identity through a client reference and child dereference", async () => {
    const acquired = await acquireSelected();
    const ref = wireCopy(createCellRef(acquired, undefined, registry));
    expect(ref.cfcReferenceToken).toBeDefined();
    expect(createCellRef(acquired, undefined, registry).cfcReferenceToken)
      .toBe(ref.cfcReferenceToken);
    const child = getCell(runtime, {
      ...ref,
      path: ["public"],
      schema: { type: "string" },
    }, registry);
    const tx = runtime.edit();
    expect(child.withTx(tx).get()).toBe("visible");
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    tx.abort();
  });

  it("retains selected identity when forwarding a sigil through the canonical converter", async () => {
    const acquired = await acquireSelected();
    for (const value of [acquired, acquired.getAsLink()]) {
      const exported = convertCellsToLinks({ result: value }, {
        includeSchema: true,
        transformLink: (cell, link) => registry.exportLink(link, cell),
      });
      const imported = mapCellRefsToSigilLinks(
        wireCopy(exported),
        registry,
      ) as { result: SigilLink };
      expect(linkRefPayload(imported.result)).not.toHaveProperty(
        "cfcReferenceToken",
      );
      expect(getCfcReferenceProvenance(imported.result)?.confidentiality)
        .toEqual([selection]);
      const tx = runtime.edit();
      runtime.getCellFromLink(imported.result, undefined, tx).getAsLink();
      expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
      tx.abort();
    }
  });

  it("preserves tokens through client hydration, schema projection, and key narrowing", async () => {
    const acquired = await acquireSelected();
    const ref = wireCopy(createCellRef(acquired, undefined, registry));
    const client = { [$conn]: () => ({}) } as unknown as RuntimeClient;
    const root = new CellHandle<{ public: string }>(client, ref);
    const child = root.key("public").asSchema({ type: "string" });
    const hydrated = CellHandle.deserialize(
      root,
      wireCopy(child.toSigilLink()),
    ) as CellHandle;
    const imported = mapCellRefsToSigilLinks(
      hydrated.toSigilLink(),
      registry,
    ) as SigilLink;
    expect(getCfcReferenceProvenance(imported)?.confidentiality).toEqual([
      selection,
    ]);
    expect(runtime.getCellFromLink(imported).get()).toBe("visible");
  });

  it("admits a forwarded acquisition and refuses the same link after token stripping", async () => {
    const acquired = await acquireSelected();
    const output = await seed("forward-output", {});
    const ref = wireCopy(createCellRef(acquired, undefined, registry));
    const forwarded = mapCellRefsToSigilLinks(ref, registry);
    const tx = runtime.edit();
    output.withTx(tx).set(forwarded);
    expect((await tx.commit()).error).toBeUndefined();
    const labels = readStoredCfcMetadata(
      runtime.readTx(),
      output.getAsNormalizedFullLink(),
    );
    expect(
      labels?.labelMap.entries.filter((entry) => entry.observes === "followRef")
        .flatMap((entry) => entry.label.confidentiality ?? []),
    )
      .toContainEqual(selection);

    const { cfcReferenceToken: _token, ...stripped } = ref;
    const rejectedOutput = await seed("stripped-output", {});
    const rejected = runtime.edit();
    rejectedOutput.withTx(rejected).set(
      mapCellRefsToSigilLinks(stripped, registry),
    );
    expect((await rejected.commit()).error?.message).toContain(
      "reference acquisition is unresolved",
    );
    expect(rejectedOutput.get()).toEqual({});
  });

  it("preserves a scope cap through client schema rewrites", async () => {
    const tx = runtime.edit();
    const session = runtime.getCell(
      space,
      "session-value",
      undefined,
      tx,
      "session",
    );
    session.set("private session");
    const link = runtime.getCell(space, "scope-holder", undefined, tx);
    link.set(session);
    expect((await tx.commit()).error).toBeUndefined();
    const capped = link.withTx(undefined).asSchema({
      type: "string",
      scope: "space",
    });
    const ref = wireCopy(createCellRef(capped, undefined, registry));
    expect(
      getCell(
        runtime,
        { ...ref, schema: { type: "string", scope: "session" } },
        registry,
      ).get(),
    ).toBeUndefined();
    expect(() =>
      mapCellRefsToSigilLinks({
        ...ref,
        schema: { type: "string", scope: "session" },
      }, registry)
    ).toThrow("scope cap cannot be widened for storage");
    const forwarded = mapCellRefsToSigilLinks(ref, registry) as SigilLink;
    expect(runtime.getCellFromLink(forwarded).get()).toBeUndefined();
    const output = await seed("scope-forward-output", {});
    const forward = runtime.edit();
    output.withTx(forward).set(forwarded);
    const result = await forward.commit();
    expect(result.error).toBeUndefined();
    expect(output.get()).toBeUndefined();
    const uncapped = link.withTx(undefined).asSchema({
      type: "string",
      scope: "session",
    });
    expect(uncapped.get()).toBe("private session");
  });

  it("roundtrips an acquired VDOM binding through a real event handler", async () => {
    const acquired = (await acquireSelected()).key("public");
    await seed("vdom-source", {
      type: "vnode",
      name: "cf-input",
      props: { $value: acquired.getAsLink() },
      children: [],
    }, [{
      path: ["props", "$value"],
      observes: "followRef",
      origin: "link",
      label: { confidentiality: [selection] },
    }]);
    const output = await seed("event-output", {});
    const processor = buildProcessor({ runtime, identity: signer, space });
    const source = processor.handleGetCell({
      type: RequestType.GetCell,
      space,
      cause: "vdom-source",
    }).cell;
    const operations: VDomOp[] = [];
    const client: WorkerClient = {
      id: 0,
      post: (message) => {
        if ("type" in message && message.type === NotificationType.VDomBatch) {
          operations.push(...message.ops);
        }
        return true;
      },
    };
    processor.handleVDomMount({
      type: RequestType.VDomMount,
      mountId: 1,
      cell: source,
    }, client);
    const sourceMount = processor.accessForTestingOnly.vdomMounts.get(
      "0 1",
    )!;
    await runtime.idle();
    sourceMount.reconciler.flush();
    const binding = operations.find((op) => op.op === "set-binding");
    expect(binding).toBeDefined();
    if (!binding) throw new Error("VDOM did not emit its binding");
    expect(binding.cellRef.cfcReferenceToken).toBeDefined();
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: binding.cellRef,
      }).value,
    ).toBe("visible");

    const clientRuntime = { [$conn]: () => ({}) } as unknown as RuntimeClient;
    const handle = new CellHandle(clientRuntime, wireCopy(binding.cellRef));
    const event = wireCopy({
      type: "drop",
      detail: { source: handle.toSigilLink() },
    });
    const eventOps: VDomOp[] = [];
    let commit: ReturnType<ReturnType<Runtime["edit"]>["commit"]> | undefined;
    const receiver = new WorkerReconciler({
      onError: (error) => {
        throw error;
      },
      onOps: (ops) => {
        eventOps.push(...ops);
      },
    });
    const cancel = receiver.mount({
      type: "vnode",
      name: "div",
      props: {
        ondrop: (value: unknown) => {
          const incoming = value as typeof event;
          expect(
            getCfcReferenceProvenance(incoming.detail.source)?.confidentiality,
          ).toEqual([selection]);
          const tx = runtime.edit();
          output.withTx(tx).set(incoming.detail.source);
          commit = tx.commit();
        },
      },
      children: [],
    });
    receiver.flush();
    processor.accessForTestingOnly.vdomMounts.set("0 2", {
      reconciler: receiver,
      cancel,
      client,
    });
    try {
      const handler = eventOps.find((op) => op.op === "set-event");
      expect(handler).toBeDefined();
      if (!handler) throw new Error("VDOM did not register its event handler");
      processor.handleVDomEvent({
        type: ClientNotificationType.VDomEvent,
        mountId: 2,
        handlerId: handler.handlerId,
        nodeId: handler.nodeId,
        event,
      }, client);
      expect(commit).toBeDefined();
      expect((await commit)?.error).toBeUndefined();
      const labels = readStoredCfcMetadata(
        runtime.readTx(),
        output.getAsNormalizedFullLink(),
      );
      expect(
        labels?.labelMap.entries.flatMap((entry) =>
          entry.label.confidentiality ?? []
        ),
      )
        .toContainEqual(selection);
    } finally {
      processor.handleVDomUnmount({
        type: RequestType.VDomUnmount,
        mountId: 1,
      }, client);
      processor.handleVDomUnmount({
        type: RequestType.VDomUnmount,
        mountId: 2,
      }, client);
    }
  });

  it("rejects forged, expired, foreign, widened, and rebound tokens", async () => {
    const cell = (await acquireSelected()).key("public");
    const ref = wireCopy(createCellRef(cell, undefined, registry));
    for (
      const changed of [
        { ...ref, cfcReferenceToken: crypto.randomUUID() },
        { ...ref, path: [] },
        { ...ref, path: ["other"] },
        { ...ref, id: "of:other" as CellRef["id"] },
        { ...ref, space: "did:key:other" as CellRef["space"] },
        { ...ref, scope: "session" as const },
        { ...ref, overwrite: "redirect" as const },
      ]
    ) {
      expect(() => getCell(runtime, changed, registry)).toThrow(
        "Reference acquisition token",
      );
    }
    const foreign = new ReferenceRegistry(runtime);
    expect(() => getCell(runtime, ref, foreign)).toThrow("missing or expired");
    registry.clear();
    expect(() => getCell(runtime, ref, registry)).toThrow("missing or expired");
  });

  it("does not recover stripped tokens from display labels or write imports", async () => {
    const acquired = await acquireSelected();
    const { cfcReferenceToken: _token, ...stripped } = wireCopy(
      createCellRef(acquired, undefined, registry),
    );
    expect(() => getCell(runtime, stripped, registry)).toThrow(
      "missing or expired",
    );
    const imported = mapCellRefsToSigilLinks(stripped, registry) as SigilLink;
    expect(getCfcReferenceProvenance(imported)).toBeUndefined();
    expect(linkRefPayload(imported)).not.toHaveProperty("cfcLabelView");
    const exported = registry.exportLink(imported);
    expect(linkRefPayload(exported)).not.toHaveProperty("cfcReferenceToken");
  });

  it("requires worker tokens for get, resolve, and set targets after host bootstrap", async () => {
    await seed("bootstrap", "value");
    const processor = buildProcessor({ runtime, identity: signer, space });
    const issued = processor.handleGetCell({
      type: RequestType.GetCell,
      space,
      cause: "bootstrap",
    }).cell;
    expect(
      processor.handleCellGet({ type: RequestType.CellGet, cell: issued })
        .value,
    ).toBe("value");
    const { cfcReferenceToken: _token, ...stripped } = wireCopy(issued);
    expect(() =>
      processor.handleCellGet({ type: RequestType.CellGet, cell: stripped })
    ).toThrow("missing or expired");
    expect(() =>
      processor.handleCellResolveAsCell({
        type: RequestType.CellResolveAsCell,
        cell: stripped,
      })
    ).toThrow("missing or expired");
    expect(() =>
      processor.applyCellSet({
        type: RequestType.CellSet,
        cell: stripped,
        value: "changed",
      })
    ).toThrow("missing or expired");
  });

  it("acquires an existing host address without admitting tokenless ordinary requests", async () => {
    const target = await seed("address-bootstrap", { public: "existing" });
    const address = wireCopy(target.key("public").getAsNormalizedFullLink());
    const processor = buildProcessor({ runtime, identity: signer, space });
    const issued = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address,
    }).cell;
    expect(issued.id).toBe(address.id);
    expect(issued.path).toEqual(["public"]);
    expect(issued.cfcReferenceToken).toBeDefined();
    expect(
      processor.handleCellGet({ type: RequestType.CellGet, cell: issued })
        .value,
    ).toBe("existing");
    const { cfcReferenceToken: _token, ...stripped } = wireCopy(issued);
    expect(() =>
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: stripped,
      })
    ).toThrow("missing or expired");
    expect(() =>
      processor.handleCellResolveAsCell({
        type: RequestType.CellResolveAsCell,
        cell: stripped,
      })
    ).toThrow("missing or expired");
    expect(() =>
      processor.applyCellSet({
        type: RequestType.CellSet,
        cell: stripped,
        value: "changed",
      })
    ).toThrow("missing or expired");
  });

  it("reads child metadata while retaining selection and refusing parent widening", async () => {
    const selectedTarget = await acquireSelected();
    const argument = await seed("metadata-argument", {
      public: "argument value",
    });
    const setup = runtime.edit();
    selectedTarget.withTx(setup).setMetaRaw(
      "argument",
      argument.asSchema({
        type: "object",
        properties: { public: { type: "string" } },
        required: ["public"],
      }).getAsLink({ includeSchema: true }),
      rawMetaWriteAuthorization,
    );
    expect((await setup.commit()).error).toBeUndefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const source = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: runtime.getCell(space, "selection").key("public")
        .getAsNormalizedFullLink(),
    }).cell;
    const child = processor.handleCellResolveAsCell({
      type: RequestType.CellResolveAsCell,
      cell: source,
    }).cell;
    expect(child.path).toEqual(["public"]);
    expect(() =>
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: { ...wireCopy(child), path: [] },
      })
    ).toThrow("does not match its binding");
    const response = processor.handleCellGet({
      type: RequestType.CellGet,
      cell: wireCopy(child),
      meta: "argument",
      includeRef: true,
    });
    expect(response.value).toBe("argument value");
    expect(response.cell?.path).toEqual(["public"]);
    expect(response.cell?.cfcReferenceToken).toBeDefined();
    const output = await seed("metadata-forward", {});
    const outputRef = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: output.getAsNormalizedFullLink(),
    }).cell;
    expect(
      (await processor.applyCellSet({
        type: RequestType.CellSet,
        cell: outputRef,
        value: wireCopy(response.cell!),
      })).error,
    ).toBeUndefined();
    const labels = readStoredCfcMetadata(
      runtime.readTx(),
      output.getAsNormalizedFullLink(),
    );
    expect(
      labels?.labelMap.entries.filter((entry) => entry.observes === "followRef")
        .flatMap((entry) => entry.label.confidentiality ?? []),
    )
      .toContainEqual(selection);
    expect(output.get()).toBe("argument value");
  });

  it("projects linked metadata through a delivered external schema", async () => {
    const piece = await seed("cold-metadata-piece", { uniqueChild: "piece" });
    const argument = await seed("cold-metadata-argument", {
      uniqueChild: "argument",
    });
    const { rootRef, documents } = decomposeSchema({
      type: "object",
      properties: { uniqueChild: { type: "string", minLength: 3 } },
      required: ["uniqueChild"],
    });
    expect(lookupSchemaDocument(rootRef.slice(4))).toBeUndefined();
    const setup = runtime.edit();
    for (const [hash, schema] of documents) {
      setup.writeOrThrow({
        space,
        id: `cid:${hash}` as URI,
        scope: "space",
        path: [],
      }, { value: schema as FabricValue });
    }
    piece.withTx(setup).setMetaRaw(
      "argument",
      createSigilLinkFromParsedLink({
        ...argument.getAsNormalizedFullLink(),
        schema: { $ref: rootRef },
      }, { includeSchema: true }),
      rawMetaWriteAuthorization,
    );
    expect((await setup.commit()).error).toBeUndefined();
    expect(lookupSchemaDocument(rootRef.slice(4))).toBeDefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const child = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: piece.key("uniqueChild").getAsNormalizedFullLink(),
    }).cell;
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: child,
        meta: "argument",
      }).value,
    ).toBe("argument");
  });

  it("retains acquired scope caps when reading linked metadata", async () => {
    const piece = await seed("capped-metadata-piece", { child: {} });
    const setup = runtime.edit();
    const session = runtime.getCell(
      space,
      "metadata-session",
      undefined,
      setup,
      "session",
    );
    session.set("private session");
    const argument = runtime.getCell(
      space,
      "capped-metadata-argument",
      undefined,
      setup,
    );
    argument.set({ nested: { child: session } });
    piece.withTx(setup).setMetaRaw(
      "argument",
      argument.key("nested").getAsLink(),
      rawMetaWriteAuthorization,
    );
    piece.withTx(setup).setMetaRaw(
      "result",
      argument.key("nested").asSchema({ scope: "space" }).getAsLink({
        includeSchema: true,
      }),
      rawMetaWriteAuthorization,
    );
    expect((await setup.commit()).error).toBeUndefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const address = piece.key("child").getAsNormalizedFullLink();
    const capped = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: { ...address, schema: { type: "object", scope: "space" } },
    }).cell;
    const uncapped = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: { ...address, schema: { type: "object" } },
    }).cell;
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: uncapped,
        meta: "argument",
      }).value,
    ).toBe("private session");
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: uncapped,
        meta: "result",
      }).value,
    ).toBeUndefined();
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: {
          ...wireCopy(capped),
          schema: { type: "object", scope: "session" },
        },
        meta: "argument",
      }).value,
    ).toBeUndefined();
  });

  it("returns importable references from an internal metadata manifest", async () => {
    const piece = await seed("manifest-piece", { public: "piece" });
    const internal = await seed("manifest-internal", true);
    const setup = runtime.edit();
    piece.withTx(setup).setMetaRaw("internal", [{
      partialCause: "showNewNotePrompt",
      link: internal.getAsLink(),
    }], rawMetaWriteAuthorization);
    expect((await setup.commit()).error).toBeUndefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const issued = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: piece.getAsNormalizedFullLink(),
    }).cell;
    const response = processor.handleCellGet({
      type: RequestType.CellGet,
      cell: wireCopy(issued),
      meta: "internal",
    });
    const client = {
      [$conn]: () => ({
        request: (
          request: { type: RequestType.CellGet; cell: CellRef },
        ) => Promise.resolve(processor.handleCellGet(request)),
      }),
    } as unknown as RuntimeClient;
    const manifest = CellHandle.deserialize(
      new CellHandle(client, issued),
      wireCopy(response.value),
    ) as Array<{ partialCause: string; link: CellHandle<boolean> }>;
    expect(manifest).toHaveLength(1);
    expect(manifest[0].partialCause).toBe("showNewNotePrompt");
    expect(manifest[0].link.ref().cfcReferenceToken).toBeDefined();
    expect(await manifest[0].link.sync()).toBe(true);
    const { cfcReferenceToken: _token, ...stripped } = manifest[0].link.ref();
    expect(() =>
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: stripped,
      })
    ).toThrow("missing or expired");
  });

  it("retains acquired scope caps on references returned in metadata manifests", async () => {
    const piece = await seed("capped-manifest-piece", {});
    const setup = runtime.edit();
    const session = runtime.getCell(
      space,
      "manifest-session",
      undefined,
      setup,
      "session",
    );
    session.set("private session");
    const internal = runtime.getCell(
      space,
      "capped-manifest-internal",
      undefined,
      setup,
    );
    internal.set(session);
    piece.withTx(setup).setMetaRaw("internal", [{
      partialCause: "session-state",
      link: internal.getAsLink(),
    }], rawMetaWriteAuthorization);
    expect((await setup.commit()).error).toBeUndefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const client = {
      [$conn]: () => ({
        request: (
          request: { type: RequestType.CellGet; cell: CellRef },
        ) => Promise.resolve(processor.handleCellGet(request)),
      }),
    } as unknown as RuntimeClient;
    for (const scope of [undefined, "space"] as const) {
      const issued = processor.handleAcquireCell({
        type: RequestType.AcquireCell,
        address: {
          ...piece.getAsNormalizedFullLink(),
          schema: { type: "object", ...(scope !== undefined && { scope }) },
        },
      }).cell;
      const response = processor.handleCellGet({
        type: RequestType.CellGet,
        cell: {
          ...wireCopy(issued),
          schema: { type: "object", scope: "session" },
        },
        meta: "internal",
      });
      const manifest = CellHandle.deserialize(
        new CellHandle(client, issued),
        wireCopy(response.value),
      ) as Array<{ partialCause: string; link: CellHandle<string> }>;
      expect(manifest[0].link.ref().cfcReferenceToken).toBeDefined();
      const projected = manifest[0].link.asSchema({
        type: "string",
        scope: "session",
      });
      expect(await projected.sync()).toBe(
        scope === undefined ? "private session" : undefined,
      );
    }
  });
});
