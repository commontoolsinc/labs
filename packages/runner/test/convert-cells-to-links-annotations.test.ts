// A schema-bearing read attaches a non-enumerable `toCell` symbol to the
// values it returns (see `schema.ts`). That annotation is not content, so it
// must not reach -- and be rejected by -- the fabric-conversion gate inside
// `convertCellsToLinks()`.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { convertCellsToLinks } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("convertCellsToLinks() with runtime-annotated arrays", () => {
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

  const listSchema = {
    type: "object",
    properties: { list: { type: "array", items: { type: "number" } } },
  } as const;

  it("converts a schema-read array under `doNotConvertCellResults`", () => {
    // This is the path taken by the HTML reconciler for every array-valued
    // element prop, and by the runtime client for cell gets and sink updates.
    const cell = runtime.getCell(space, "annotated-nested", listSchema, tx);
    cell.set({ list: [1, 2, 3] });

    const list = (cell.get() as { list: number[] }).list;

    expect(
      convertCellsToLinks(list, {
        doNotConvertCellResults: true,
        includeSchema: true,
      }),
    ).toEqual([1, 2, 3]);
  });

  it("converts a schema-read top-level array under `doNotConvertCellResults`", () => {
    const arraySchema = { type: "array", items: { type: "number" } } as const;
    const cell = runtime.getCell(space, "annotated-top", arraySchema, tx);
    cell.set([4, 5]);

    expect(
      convertCellsToLinks(cell.get(), {
        doNotConvertCellResults: true,
        includeSchema: true,
      }),
    ).toEqual([4, 5]);
  });

  it("still rejects an array carrying a genuine named property", () => {
    // Dropping runtime annotations must not become a licence to drop content.
    const arr = [1, 2] as unknown[] & { foo?: string };
    arr.foo = "bar";

    expect(() =>
      convertCellsToLinks(arr, {
        doNotConvertCellResults: true,
        includeSchema: true,
      })
    ).toThrow(
      "Not representable as a `FabricValue`: array that is not an inert array",
    );
  });
});
