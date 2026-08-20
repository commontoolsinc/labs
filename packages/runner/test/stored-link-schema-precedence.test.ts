/**
 * What a link's own stored schema decides for a reader that declared one.
 *
 * A link stored in a document may carry a schema, and link resolution adopts
 * it in place of the schema the reader carries in: the stored one describes
 * the value at the link's target, where the reader's describes the value at
 * the source. A schema that constrains nothing — JSON Schema `true`, or an
 * empty object — describes neither, so the reader's schema keeps traveling
 * and governs the projection, which is what makes an element read by its own
 * path project the same as that element read within its array. A stored
 * schema that does constrain still governs, and a stored `false` still
 * selects nothing.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import "@commonfabric/utils/equal-ignoring-symbols";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import type { CellLinkRefPayload } from "../src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("stored link schema precedence");
const space = signer.did();

type Row = { title: string };
type Holder = { rows: Row[] };

/** What a row declares: one required property, out of a wider stored value. */
const rowSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
} as const satisfies JSONSchema;

const holderSchema = {
  type: "object",
  properties: { rows: { type: "array", items: rowSchema } },
} as const satisfies JSONSchema;

/** The value a row link points at, wider than the row schema selects. */
const storedRow = { title: "cruller", glaze: "maple" };

describe("stored-link-schema-precedence", () => {
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
   * A stored link to `cell` carrying `schema`. Built rather than minted:
   * `getAsLink({ includeSchema: true })` leaves out a schema that constrains
   * nothing, so it cannot produce one of these.
   */
  const linkCarrying = (cell: Cell<unknown>, schema: JSONSchema) => {
    const link = cell.getAsNormalizedFullLink();
    return linkRefFrom<CellLinkRefPayload>({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: [...link.path],
      schema,
    });
  };

  /** A one-row array whose single element link carries `storedSchema`. */
  const holderOverLinkCarrying = (storedSchema: JSONSchema): Cell<Holder> => {
    const row = runtime.getCell(space, `row-${seq}`, undefined, tx);
    row.setRaw(storedRow);
    const holder = runtime.getCell<Holder>(
      space,
      `holder-${seq}`,
      holderSchema,
      tx,
    );
    holder.setRaw({ rows: [linkCarrying(row, storedSchema)] } as never);
    return holder;
  };

  const elementByPath = (holder: Cell<Holder>) =>
    holder.key("rows").key(0).get();

  const elementWithinArray = (holder: Cell<Holder>) =>
    holder.key("rows").get()[0];

  /**
   * A read's own enumerable properties. An unconstrained projection hands back
   * a live query-result proxy, which a structural diff renders as `{}`; the
   * spread makes what a read exposes both comparable and printable whichever
   * form it took.
   */
  const projectionOf = (value: unknown) => ({ ...(value as object) });

  describe("a stored schema that constrains nothing", () => {
    it("projects an element by path the same way as within its array", () => {
      const holder = holderOverLinkCarrying(true);

      expect(projectionOf(elementByPath(holder)))
        .toEqual(projectionOf(elementWithinArray(holder)));
    });

    it("projects an element by path through the reader's row schema", () => {
      const holder = holderOverLinkCarrying(true);

      expect(projectionOf(elementByPath(holder))).toEqual({ title: "cruller" });
    });

    it("projects an empty stored schema the same way as `true`", () => {
      const holder = holderOverLinkCarrying({});

      expect(projectionOf(elementByPath(holder)))
        .toEqual(projectionOf(elementWithinArray(holder)));
      expect(projectionOf(elementByPath(holder))).toEqual({ title: "cruller" });
    });

    it("resolves the element link to the schema the reader carried in", () => {
      const holder = holderOverLinkCarrying(true);
      const readerLink = {
        ...holder.getAsNormalizedFullLink(),
        path: ["rows", "0"],
        schema: rowSchema as JSONSchema,
      };

      expect(resolveLink(runtime, tx, readerLink).schema).toEqual(rowSchema);
    });
  });

  describe("a stored schema that constrains", () => {
    it("governs the projection in place of the reader's row schema", () => {
      const holder = holderOverLinkCarrying({
        type: "object",
        properties: { glaze: { type: "string" } },
      });

      expect(projectionOf(elementByPath(holder))).toEqual({ glaze: "maple" });
    });

    it("selects nothing when the stored schema is `false`", () => {
      const holder = holderOverLinkCarrying(false);

      expect(elementByPath(holder)).toBeUndefined();
    });
  });
});
