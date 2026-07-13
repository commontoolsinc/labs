// Regression coverage for the plain-schema large-array traversal path.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { toCell } from "../src/back-to-cell.ts";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("schema array fast path test");
const space = signer.did();

type Row = {
  data: { id: string; label: string };
  label: string;
  aliases: string[];
};

const ROWS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
        },
      },
      label: { type: "string" },
      aliases: { type: "array", items: { type: "string" } },
    },
  },
} as const satisfies JSONSchema;

describe("plain-schema array traversal", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    if (tx.status().status === "ready") tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  async function seed(id: string, value: unknown): Promise<void> {
    runtime.getCell(space, id, undefined, tx).set(value);
    await tx.commit();
    tx = runtime.edit();
  }

  async function seedRaw(id: string, value: FabricValue): Promise<void> {
    runtime.getCell(space, id, undefined, tx).setRawUntyped(value);
    await tx.commit();
    tx = runtime.edit();
  }

  it("materializes linked rows with projection, hooks, and stable mutation", async () => {
    await seed("plain-schema-rows", [{
      data: { id: "one", label: "First", ignored: "nested" },
      label: "First",
      aliases: ["one", "first"],
      ignored: "top-level",
    }, {
      data: { id: "two", label: "Second" },
      label: "Second",
      aliases: ["two"],
    }]);

    const cell = runtime.getCell<Row[]>(
      space,
      "plain-schema-rows",
      ROWS_SCHEMA,
      tx,
    );
    const rows = cell.get();

    expect(rows).toEqual([{
      data: { id: "one", label: "First" },
      label: "First",
      aliases: ["one", "first"],
    }, {
      data: { id: "two", label: "Second" },
      label: "Second",
      aliases: ["two"],
    }]);
    expect(toCell in rows).toBe(true);
    expect(toCell in rows[0]).toBe(true);
    expect(toCell in rows[0].data).toBe(true);
    expect(toCell in rows[0].aliases).toBe(true);

    const firstRowCell = (rows[0] as Row & {
      [toCell](): Cell<Row>;
    })[toCell]();
    expect(firstRowCell.getAsNormalizedFullLink().id).not.toBe(
      cell.getAsNormalizedFullLink().id,
    );

    firstRowCell.set({
      data: { id: "one", label: "Updated" },
      label: "Updated",
      aliases: ["one", "updated"],
    });
    expect(cell.get()[0]).toEqual({
      data: { id: "one", label: "Updated" },
      label: "Updated",
      aliases: ["one", "updated"],
    });
  });

  it("falls back to general traversal for schema defaults", async () => {
    await seed("schema-array-default", [{}]);
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", default: "fallback" },
        },
      },
    } as const satisfies JSONSchema;

    const cell = runtime.getCell<{ label: string }[]>(
      space,
      "schema-array-default",
      schema,
      tx,
    );
    expect(cell.get()).toEqual([{ label: "fallback" }]);
  });

  it("preserves primitive-array validation semantics", async () => {
    await seedRaw("undefined-items", [[1]]);
    const undefinedItems = runtime.getCell<undefined[][]>(
      space,
      "undefined-items",
      {
        type: "array",
        items: { type: "array", items: { type: "undefined" } },
      },
      tx,
    );
    expect(undefinedItems.get()).toEqual([[undefined]]);

    await seedRaw("null-items", [[1]]);
    const nullItems = runtime.getCell<null[][]>(
      space,
      "null-items",
      {
        type: "array",
        items: { type: "array", items: { type: "null" } },
      },
      tx,
    );
    expect(nullItems.get()).toEqual([[null]]);

    await seedRaw("invalid-string-items", [[1]]);
    const invalidStringItems = runtime.getCell<string[][]>(
      space,
      "invalid-string-items",
      {
        type: "array",
        items: { type: "array", items: { type: "string" } },
      },
      tx,
    );
    expect(invalidStringItems.get()).toBeUndefined();
  });

  it("falls back when primitive arrays contain links", async () => {
    await seed("linked-string", "linked");
    const linkedString = runtime.getCell<string>(
      space,
      "linked-string",
      undefined,
      tx,
    );
    runtime.getCell(space, "linked-string-array", undefined, tx).setRawUntyped(
      [[linkedString.getAsLink()]],
    );
    await tx.commit();
    tx = runtime.edit();

    const cell = runtime.getCell<string[][]>(
      space,
      "linked-string-array",
      {
        type: "array",
        items: { type: "array", items: { type: "string" } },
      },
      tx,
    );
    expect(cell.get()).toEqual([["linked"]]);
  });

  it("falls back when a linked item has no stored target", async () => {
    const missing = runtime.getCell(
      space,
      "missing-linked-item",
      undefined,
      tx,
    );
    runtime.getCell(space, "missing-item-array", undefined, tx).setRawUntyped(
      [missing.getAsLink()],
    );
    await tx.commit();
    tx = runtime.edit();

    const cell = runtime.getCell<Record<string, never>[]>(
      space,
      "missing-item-array",
      { type: "array", items: { type: "object", properties: {} } },
      tx,
    );
    expect(cell.get()).toBeUndefined();
  });

  it("preserves object-item leaf and invalid-type handling", async () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    await seed("special-object-items", [bytes]);
    const schema = {
      type: "array",
      items: { type: "object", properties: {} },
    } as const satisfies JSONSchema;
    const specialObjects = runtime.getCell<FabricBytes[]>(
      space,
      "special-object-items",
      schema,
      tx,
    );
    expect(specialObjects.get()).toEqual([bytes]);

    await seed("invalid-object-items", [1]);
    const invalidObjects = runtime.getCell<Record<string, never>[]>(
      space,
      "invalid-object-items",
      schema,
      tx,
    );
    expect(invalidObjects.get()).toBeUndefined();
  });
});
