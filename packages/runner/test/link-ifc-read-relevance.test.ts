/**
 * Reading through a link whose stored schema carries `ifc` marks the
 * transaction cfc-relevant even though reader precedence
 * (`combineSchemaForLink`) keeps the link's `ifc` off the combined schema.
 * The read entry point consults the link schema on its own
 * (`validateAndTransform`'s `schemaHasIfc` gate), so the marking does not
 * depend on which side won the combination — and no flow-control clause is
 * ever transplanted onto the reader's schema, which write policy consumes
 * verbatim.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
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

  it("marks a read through an ifc-carrying link cfc-relevant", () => {
    const holder = holderOverLinkCarrying(labeledLinkSchema);

    expect(holder.key("item").get()).toEqual({ name: "Ada" });
    expect(tx.getCfcState().relevant).toBe(true);
    expect(schemaIfcReadReasons().length).toBeGreaterThan(0);
  });

  it("leaves a read through an unlabeled link without the schema-ifc marking", () => {
    const holder = holderOverLinkCarrying(plainLinkSchema);

    expect(holder.key("item").get()).toEqual({ name: "Ada" });
    expect(schemaIfcReadReasons()).toEqual([]);
  });
});
