/**
 * Reading through a link whose stored schema carries `ifc` marks the
 * transaction cfc-relevant even though reader precedence
 * (`combineSchemaForLink`) keeps the link's `ifc` off the combined schema.
 * The marking never depends on which side won a combination — and no
 * flow-control clause is ever transplanted onto the reader's schema, which
 * write policy consumes verbatim. Three seams carry it: the read entry
 * point checks the write-redirect-resolved link's schema and the fully
 * value-resolved link's (`schema-ifc-read`), and the traversal marks every
 * link hop it actually crosses (`schema-ifc-hop`).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { CellLinkRefPayload } from "../src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("link ifc read relevance");
const space = signer.did();

type Holder = { item: { name: string } };

const readerSchema = {
  type: "object",
  properties: {
    item: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
} as const satisfies JSONSchema;

const plainLinkSchema = {
  type: "object",
  properties: { name: { type: "string" } },
} as const satisfies JSONSchema;

const labeledLinkSchema = {
  ...plainLinkSchema,
  ifc: { confidentiality: ["confidential"] },
} as const satisfies JSONSchema;

describe("link-ifc-read-relevance", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let seq = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
    seq++;
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * A stored write-redirect link to `cell` carrying `schema` — the shape
   * pattern bindings mint (`overwrite: "redirect"`, `includeSchema: true`),
   * and the one whose schema the read entry point resolves through its
   * write-redirect pass.
   */
  const linkCarrying = (cell: Cell<unknown>, schema: JSONSchema) => {
    const link = cell.getAsNormalizedFullLink();
    return linkRefFrom<CellLinkRefPayload>({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: [...link.path],
      overwrite: "redirect",
      schema,
    });
  };

  /** A stored plain value link to `cell` carrying `schema`. */
  const plainLinkCarrying = (cell: Cell<unknown>, schema: JSONSchema) => {
    const link = cell.getAsNormalizedFullLink();
    return linkRefFrom<CellLinkRefPayload>({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: [...link.path],
      schema,
    });
  };

  const holderOverLinkCarrying = (storedSchema: JSONSchema): Cell<Holder> => {
    const target = runtime.getCell(space, `target-${seq}`, undefined, tx);
    target.setRaw({ name: "Ada" });
    const holder = runtime.getCell<Holder>(
      space,
      `holder-${seq}`,
      readerSchema,
      tx,
    );
    holder.setRaw({ item: linkCarrying(target, storedSchema) } as never);
    return holder;
  };

  const schemaIfcReadReasons = () =>
    tx.getCfcState().diagnostics.filter((reason) =>
      reason.startsWith("schema-ifc-read:")
    );

  const schemaIfcHopReasons = () =>
    tx.getCfcState().diagnostics.filter((reason) =>
      reason.startsWith("schema-ifc-hop:")
    );

  it("marks a read through an ifc-carrying link cfc-relevant", () => {
    const holder = holderOverLinkCarrying(labeledLinkSchema);

    expect(holder.key("item").get()).toEqual({ name: "Ada" });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(schemaIfcReadReasons().length).toBeGreaterThan(0);
  });

  it("marks an eager read crossing a nested ifc-carrying link cfc-relevant", () => {
    const target = runtime.getCell(
      space,
      `target-${seq}-nested`,
      undefined,
      tx,
    );
    target.setRaw({ name: "Ada" });
    const holder = runtime.getCell<Holder>(
      space,
      `holder-${seq}-nested`,
      readerSchema,
      tx,
    );
    holder.setRaw(
      { item: plainLinkCarrying(target, labeledLinkSchema) } as never,
    );

    expect(holder.get()).toEqual({ item: { name: "Ada" } });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(schemaIfcHopReasons().length).toBeGreaterThan(0);
  });

  it("marks a read entered through a plain ifc-carrying link cfc-relevant", () => {
    const target = runtime.getCell(space, `target-${seq}-plain`, undefined, tx);
    target.setRaw({ name: "Ada" });
    const holder = runtime.getCell<Holder>(
      space,
      `holder-${seq}-plain`,
      readerSchema,
      tx,
    );
    holder.setRaw(
      { item: plainLinkCarrying(target, labeledLinkSchema) } as never,
    );

    expect(holder.key("item").get()).toEqual({ name: "Ada" });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(schemaIfcReadReasons().length).toBeGreaterThan(0);
  });

  it("marks a set() resolving through an ifc-carrying link cfc-relevant", () => {
    // set()'s pre-write resolution reads the resolved terminal value (the
    // stream check), so a crossing it makes marks like any other read.
    const holder = holderOverLinkCarrying(labeledLinkSchema);

    holder.key("item").set({ name: "Grace" });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(schemaIfcHopReasons().length).toBeGreaterThan(0);
  });

  it("leaves a read through an unlabeled link without the schema-ifc marking", () => {
    const holder = holderOverLinkCarrying(plainLinkSchema);

    expect(holder.key("item").get()).toEqual({ name: "Ada" });
    expect(schemaIfcReadReasons()).toEqual([]);
  });
});

describe("link-ifc-read-relevance at resolution and handle hops", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let seq = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
    seq++;
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  const linkTo = (cell: Cell<unknown>, schema?: JSONSchema) => {
    const link = cell.getAsNormalizedFullLink();
    return linkRefFrom<CellLinkRefPayload>({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: [...link.path],
      ...(schema !== undefined && { schema }),
    });
  };

  const hopReasons = () =>
    tx.getCfcState().diagnostics.filter((reason) =>
      reason.startsWith("schema-ifc-hop:")
    );

  it("marks a labeled intermediate link followed by a plain link", () => {
    const target = runtime.getCell(space, `target-${seq}-chain`, undefined, tx);
    target.setRaw({ name: "Ada" });
    const middle = runtime.getCell(space, `middle-${seq}-chain`, undefined, tx);
    middle.setRaw(linkTo(target));
    const holder = runtime.getCell<Holder>(
      space,
      `holder-${seq}-chain`,
      readerSchema,
      tx,
    );
    holder.setRaw({ item: linkTo(middle, labeledLinkSchema) } as never);

    expect(holder.key("item").get()).toEqual({ name: "Ada" });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  it("marks the extra handle hop of a nested asCell crossing", () => {
    const target = runtime.getCell(
      space,
      `target-${seq}-handle`,
      undefined,
      tx,
    );
    target.setRaw({ name: "Ada" });
    const holder = runtime.getCell(
      space,
      `holder-${seq}-handle`,
      {
        type: "object",
        properties: {
          item: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: ["cell"],
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    holder.setRaw({ item: linkTo(target, labeledLinkSchema) } as never);

    const value = holder.get() as { item: Cell<{ name: string }> };
    expect(value.item.get()).toEqual({ name: "Ada" });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });
});

describe("link-ifc-read-relevance closure, narrowing, and raw readers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let seq = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
    seq++;
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  const linkTo = (cell: Cell<unknown>, schema?: JSONSchema) => {
    const link = cell.getAsNormalizedFullLink();
    return linkRefFrom<CellLinkRefPayload>({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: [...link.path],
      ...(schema !== undefined && { schema }),
    });
  };

  const hopReasons = () =>
    tx.getCfcState().diagnostics.filter((reason) =>
      reason.startsWith("schema-ifc-hop:")
    );

  const holderOver = (storedSchema: JSONSchema): Cell<Holder> => {
    const target = runtime.getCell(space, `target-${seq}-x`, undefined, tx);
    target.setRaw({ name: "Ada" });
    const holder = runtime.getCell<Holder>(
      space,
      `holder-${seq}-x`,
      readerSchema,
      tx,
    );
    holder.setRaw({ item: linkTo(target, storedSchema) } as never);
    return holder;
  };

  it("loads a cold cid-backed labeled schema and marks the crossing", () => {
    const labeled = {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { confidentiality: ["confidential"] },
    } as const satisfies JSONSchema;
    const decomposed = decomposeSchema(labeled as JSONSchemaObj);
    // Every closure document goes into the STORE as a cid: document — the
    // registry stays cold, exactly as a link arriving over sync finds it.
    for (const [hash, doc] of decomposed.documents) {
      tx.writeValueOrThrow(
        {
          space,
          id: `cid:${hash}`,
          scope: "space",
          path: [],
        } as unknown as Parameters<typeof tx.writeValueOrThrow>[0],
        doc,
      );
    }

    const holder = holderOver({ $ref: decomposed.rootRef });

    expect(holder.key("item").get()).toEqual({ name: "Ada" });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  it("narrows a descendant read through a cold cid-backed stored schema", () => {
    const labeled = {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { confidentiality: ["confidential"] },
    } as const satisfies JSONSchema;
    const decomposed = decomposeSchema(labeled as JSONSchemaObj);
    for (const [hash, doc] of decomposed.documents) {
      tx.writeValueOrThrow(
        {
          space,
          id: `cid:${hash}`,
          scope: "space",
          path: [],
        } as unknown as Parameters<typeof tx.writeValueOrThrow>[0],
        doc,
      );
    }

    const holder = holderOver({ $ref: decomposed.rootRef });

    // The read descends past the link position, so the ancestor hop narrows
    // the stored schema across the crossing — the external closure loads
    // before the narrowing walks the ref.
    expect(holder.key("item").key("name").get()).toEqual("Ada");
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  const labeledCidSchema = () => {
    const labeled = {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { confidentiality: ["confidential"] },
    } as const satisfies JSONSchema;
    return decomposeSchema(labeled as JSONSchemaObj);
  };

  const writeClosureDocs = (
    decomposed: ReturnType<typeof decomposeSchema>,
  ) => {
    for (const [hash, doc] of decomposed.documents) {
      tx.writeValueOrThrow(
        {
          space,
          id: `cid:${hash}`,
          scope: "space",
          path: [],
        } as unknown as Parameters<typeof tx.writeValueOrThrow>[0],
        doc,
      );
    }
  };

  it("resolves an eager read as not found until a cold schema closure arrives", () => {
    const decomposed = labeledCidSchema();
    // The closure documents are NOT local yet: the stored schema may carry
    // labels this replica cannot see, so the crossing fails closed — no
    // content, no relevance, until the documents arrive.
    const holder = holderOver({ $ref: decomposed.rootRef });

    expect(holder.get()?.item?.name).toBeUndefined();
    expect(tx.getCfcState().relevant).toBe(false);

    writeClosureDocs(decomposed);
    expect(holder.get()).toEqual({ item: { name: "Ada" } });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  it("resolves a descendant read as not found until a cold schema closure arrives", () => {
    const decomposed = labeledCidSchema();
    const holder = holderOver({ $ref: decomposed.rootRef });

    expect(holder.key("item").key("name").get()).toBeUndefined();
    expect(tx.getCfcState().relevant).toBe(false);

    writeClosureDocs(decomposed);
    expect(holder.key("item").key("name").get()).toEqual("Ada");
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  it("resolves a raw read as not found until a cold schema closure arrives", () => {
    const decomposed = labeledCidSchema();
    const holder = holderOver({ $ref: decomposed.rootRef });

    expect(holder.key("item").key("name").getRaw()).toBeUndefined();
    expect(tx.getCfcState().relevant).toBe(false);

    writeClosureDocs(decomposed);
    expect(holder.key("item").key("name").getRaw()).toEqual("Ada");
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  it("marks what a partial schema shows while still failing the crossing closed", () => {
    const decomposed = labeledCidSchema();
    // The root-level ifc is visible without the missing child document, so
    // the crossing marks — and the crossing still fails closed, since the
    // absent document could carry labels of its own.
    const partiallyVisible = {
      type: "object",
      ifc: { integrity: ["asserted"] },
      properties: { name: { $ref: decomposed.rootRef } },
    } as JSONSchema;
    const holder = holderOver(partiallyVisible);

    expect(holder.get()?.item?.name).toBeUndefined();
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);

    writeClosureDocs(decomposed);
    expect(holder.get()).toEqual({ item: { name: "Ada" } });
  });

  it("withholds a whole asCell array while one element's schema closure is cold", () => {
    const decomposed = labeledCidSchema();
    const warmTarget = runtime.getCell(
      space,
      `array-warm-${seq}`,
      undefined,
      tx,
    );
    warmTarget.setRaw({ name: "Warm" });
    const coldTarget = runtime.getCell(
      space,
      `array-cold-${seq}`,
      undefined,
      tx,
    );
    coldTarget.setRaw({ name: "Cold" });
    const holder = runtime.getCell(space, `array-holder-${seq}`, undefined, tx);
    holder.setRaw({
      items: [
        linkTo(warmTarget, plainLinkSchema),
        linkTo(coldTarget, { $ref: decomposed.rootRef }),
      ],
    } as never);
    const reader = holder.asSchema<{ items?: Cell<{ name: string }>[] }>({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: ["cell"],
          },
        },
      },
    });

    // One cold element withholds the WHOLE array: a partial array would
    // disclose which positions were readable.
    expect(reader.get()?.items).toBeUndefined();

    writeClosureDocs(decomposed);
    const items = reader.get()?.items;
    expect(items).toHaveLength(2);
    expect(items?.[0]?.get()).toEqual({ name: "Warm" });
    expect(items?.[1]?.get()).toEqual({ name: "Cold" });
    expect(tx.getCfcState().relevant).toBe(true);
  });

  it("mints no asCell handle over a crossing whose schema closure is cold", () => {
    const decomposed = labeledCidSchema();
    const holder = holderOver({ $ref: decomposed.rootRef });
    const asCellReader = holder.asSchema<{ item?: Cell<{ name: string }> }>({
      type: "object",
      properties: {
        item: {
          type: "object",
          properties: { name: { type: "string" } },
          asCell: ["cell"],
        },
      },
    });

    // The handle hop consumed the crossing, so a handle minted here would
    // hand its reads out from under the schema's labels: none is minted.
    expect(asCellReader.get()?.item).toBeUndefined();
    expect(tx.getCfcState().relevant).toBe(false);

    writeClosureDocs(decomposed);
    const handle = asCellReader.get()?.item;
    expect(handle?.get()).toEqual({ name: "Ada" });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  it("marks a root-level ifc declaration narrowed away by an ancestor hop", () => {
    const rootLabeled = {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { integrity: ["asserted"] },
    } as const satisfies JSONSchema;
    const holder = holderOver(rootLabeled);

    expect(holder.key("item").key("name").get()).toEqual("Ada");
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  it("marks an ancestor hop whose schema narrows to nothing", () => {
    const rootLabeled = {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { integrity: ["asserted"] },
    } as const satisfies JSONSchema;
    const holder = holderOver(rootLabeled);

    // The remaining path names nothing the stored schema describes, so the
    // traveling schema narrows to undefined — the crossing still marks off
    // the schema as stored.
    expect(holder.key("item").key("unlisted").get()).toBeUndefined();
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  it("marks a schema-less query-result read crossing a labeled link", () => {
    const holder = holderOver(labeledLinkSchema);

    const proxy = holder.getAsQueryResult([], tx) as { item: { name: string } };
    expect(proxy.item.name).toEqual("Ada");
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });

  it("marks a raw read resolving through a labeled link on the way", () => {
    const holder = holderOver(labeledLinkSchema);

    expect(holder.key("item").key("name").getRaw()).toEqual("Ada");
    expect(tx.getCfcState().relevant).toBe(true);
    expect(hopReasons().length).toBeGreaterThan(0);
  });
});
