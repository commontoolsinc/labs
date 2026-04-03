/**
 * Test for $defs propagation when extracting array item schemas.
 *
 * Reproduces the bug where collectLinkedCellSyncs extracts schema.items
 * from an array schema without carrying $defs. When items use $ref pointing
 * to $defs defined on the parent array schema, downstream schema resolution
 * (joinSchema → resolveSchemaRefsOrThrow) crashes with:
 *   "Failed to resolve $ref: #/$defs/WorkoutSet"
 *
 * This is triggered by patterns using Default<> on fields of objects stored
 * in arrays (e.g., `items: Writable<Default<Item[], []>>` where Item has
 * `name: Default<string, "">`).
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedLink } from "../src/link-types.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("$defs propagation in array item schema extraction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  // Schema matching what the TS compiler generates for:
  //   interface Item { name: Default<string, "">; value: Default<number, 0>; }
  //   interface Input { items?: Writable<Default<Item[], []>>; }
  const itemDef: JSONSchema = {
    type: "object",
    properties: {
      name: { type: "string", default: "" },
      value: { type: "number", default: 0 },
    },
  };

  const arraySchema: JSONSchema = {
    type: "array",
    items: { $ref: "#/$defs/Item" },
    $defs: { Item: itemDef },
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  it("collectLinkedCellSyncs resolves $ref in item schema for linked array items", async () => {
    // Create a cell link in sigil format. When collectLinkedCellSyncs
    // finds this in the array, it extracts itemSchema from the parent
    // array schema and passes it to storageProvider.sync(), which
    // calls pull() → joinSchema(). If $defs aren't carried, joinSchema
    // throws "Failed to resolve $ref: #/$defs/Item".
    const cellLink = {
      "/": {
        "link@1": {
          id: "bafytest1234:test",
          path: [],
          space: signer.did(),
        },
      },
    };

    const base: NormalizedLink = {
      space: signer.did(),
      id: "of:test-doc" as any,
      path: [],
      type: "application/json",
    };
    const promises: Promise<any>[] = [];
    const cfc = new ContextualFlowControl();
    const seen = new Set<any>();

    // Array value containing a cell link — this triggers the sync path
    // where the item schema (with or without $defs) gets passed to
    // storageProvider.sync() and eventually to joinSchema().
    const value = [cellLink];

    // Before the fix: itemSchema was extracted as bare schema.items
    //   → { $ref: "#/$defs/Item" } with no $defs
    //   → sync → pull → joinSchema → resolveSchemaRefsOrThrow throws!
    //
    // After the fix: cfc.getSchemaAtPath(schema, [index]) resolves the
    //   $ref using the parent's $defs, returning the resolved item schema.
    //
    // The sync call itself won't find data (fake ID), but it will
    // call pull() which calls joinSchema() on the schema — and that's
    // where the crash happens.
    (storageManager as any).collectLinkedCellSyncs(
      value,
      base,
      arraySchema,
      cfc,
      promises,
      seen,
    );

    // The promises contain sync calls. If $defs weren't carried,
    // the sync → pull → joinSchema chain will reject with the $ref error.
    // We need to await them to surface the error.
    if (promises.length > 0) {
      // Should not throw "Failed to resolve $ref: #/$defs/Item"
      await expect(Promise.all(promises)).resolves.toBeDefined();
    }
  });
});
