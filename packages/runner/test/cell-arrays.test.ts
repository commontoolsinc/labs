// Cell array element conversion tests: verifying that array elements are
// correctly converted to cell links when the schema uses asCell.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Writable } from "@commontools/api";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Cell array element conversion", () => {
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
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("creates links to the elements for non-link array items", async () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { foo: { type: "number" } },
        asCell: true,
      },
    } as const satisfies JSONSchema;
    const refCell = runtime.getCell<{ foo: number }[]>(
      space,
      "array-cell-contents",
      schema,
      tx,
    );
    refCell.setRaw([{ foo: 1 }, { foo: 2 }, { foo: 3 }]);

    // Commit transaction to persist data
    await tx.commit();
    await runtime.idle();

    tx = runtime.edit();
    const { ok: entry } = tx.read({
      space,
      type: "application/json",
      id: refCell.getAsNormalizedFullLink().id,
      path: ["value"],
    });
    expect(entry?.value).toEqual([{ foo: 1 }, { foo: 2 }, { foo: 3 }]);

    tx = runtime.edit();

    const result = refCell.get();

    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      const first = result[0];
      expect(isCell(first)).toBe(true);
      const firstCell = first as Writable<{ foo: number }>;
      expect(firstCell.getAsNormalizedFullLink()).toEqual(
        {
          space,
          id: "of:baedreiftqxopzv7ymkvtx4vrg335p7uv5kgswfdwqxfkxx4q6bjrrkybjq",
          type: "application/json",
          path: ["0"],
          schema: { type: "object", properties: { foo: { type: "number" } } },
        },
      );
    }
  });
});
