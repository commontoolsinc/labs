import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { traverseValue } from "../src/builder/traverse-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test traverse");
const space = signer.did();

describe("traverseValue with query result proxies", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should handle arrays containing query result proxies", () => {
    // Create cells with data
    const cell1 = runtime.getCell(space, "cell1", undefined, tx);
    cell1.set({ value: "first" });

    const cell2 = runtime.getCell(space, "cell2", undefined, tx);
    cell2.set({ value: "second" });

    // Create an array containing query result proxies
    const arrayWithProxies = [
      cell1.getAsQueryResult(),
      cell2.getAsQueryResult(),
      { regular: "object" },
    ];

    // This should not throw and should handle the query result proxies correctly
    const result = traverseValue(arrayWithProxies, () => undefined);

    // The result should still be an array
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(3);

    // Query result proxies should be preserved (not traversed into)
    expect(result[0]).toBe(arrayWithProxies[0]);
    expect(result[1]).toBe(arrayWithProxies[1]);

    // Regular objects should be traversed but structure preserved
    expect(result[2]).toEqual({ regular: "object" });
  });

  it("should handle nested structures with arrays of query result proxies", () => {
    const cell = runtime.getCell(space, "cell", undefined, tx);
    cell.set({ items: ["a", "b", "c"] });

    const structure = {
      name: "test",
      cells: [
        cell.getAsQueryResult(),
        { normal: "data" },
      ],
      nested: {
        moreCells: [cell.getAsQueryResult()],
      },
    };

    const result = traverseValue(structure, () => undefined);

    expect(result.name).toBe("test");
    expect(Array.isArray(result.cells)).toBe(true);
    expect(result.cells[0]).toBe(structure.cells[0]); // Query result proxy preserved
    expect(result.cells[1]).toEqual({ normal: "data" });
    expect(result.nested.moreCells[0]).toBe(structure.nested.moreCells[0]);
  });

  it("should handle query result proxy that itself contains an array", () => {
    const arrayCell = runtime.getCell(space, "arrayCell", undefined, tx);
    arrayCell.set([1, 2, 3, 4, 5]);

    const proxy = arrayCell.getAsQueryResult();

    // The proxy itself should not be traversed into
    const result = traverseValue(proxy, () => undefined);

    // The proxy should be returned as-is
    expect(result).toBe(proxy);
  });

  it("should handle mixed arrays with query result proxies and regular values", () => {
    const cell1 = runtime.getCell(space, "mixed1", undefined, tx);
    cell1.set({ type: "cell", data: [1, 2, 3] });

    const mixedArray = [
      "regular string",
      42,
      cell1.getAsQueryResult(),
      { nested: { values: [10, 20] } },
      [100, 200, 300],
    ];

    const result = traverseValue(mixedArray, () => undefined);

    expect(result[0]).toBe("regular string");
    expect(result[1]).toBe(42);
    expect(result[2]).toBe(mixedArray[2]); // Query result proxy preserved
    expect(result[3]).toEqual({ nested: { values: [10, 20] } });
    expect(result[4]).toEqual([100, 200, 300]);
  });
});
