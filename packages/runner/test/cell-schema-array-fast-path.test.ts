// Regression coverage for the plain-schema large-array traversal path.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";

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
});
