/**
 * Minimal repro for CT-1173: Array push() via query result proxy doesn't add [ID] to items
 *
 * This test verifies that when using .push() on arrays accessed via query result proxies,
 * new items get [ID] symbols added automatically, ensuring they're stored as separate
 * entity documents rather than inline data.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { isPrimitiveCellLink } from "../src/link-utils.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("CT-1173: array push via query-result-proxy", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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
    tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should add [ID] to objects pushed via query-result-proxy", () => {
    // Create a cell with an empty array
    const arrayCell = runtime.getCell<{ name: string }[]>(
      space,
      "test-array-push-id",
      undefined,
      tx,
    );
    arrayCell.set([]);

    // Create a frame context (simulates being inside a handler)
    const frame = {
      cause: "test-frame",
      space: space,
      runtime,
      tx,
      generatedIdCounter: 0,
      inHandler: true,
    };
    pushFrame(frame);

    try {
      // Get a query result proxy (this is what patterns use when they access
      // writable arrays via their input/output bindings)
      const proxy = createQueryResultProxy<{ name: string }[]>(
        runtime,
        tx,
        arrayCell.getAsNormalizedFullLink(),
        0,
        true, // writable
      );

      // Push objects WITHOUT explicitly adding [ID]
      // The bug was that [ID] should be added automatically but wasn't
      proxy.push({ name: "Alice" });
      proxy.push({ name: "Bob" });
    } finally {
      popFrame();
    }

    // Read back the raw array data
    const result = tx.readValueOrThrow(
      arrayCell.getAsNormalizedFullLink(),
    ) as any[];

    console.log("Result array:", JSON.stringify(result, null, 2));

    // The array should have 2 items
    expect(result.length).toBe(2);

    // Each item should be stored as a cell link (entity reference), not inline data
    // If [ID] was added correctly, diffAndUpdate would have created entity documents
    // and stored links to them in the array
    for (let i = 0; i < result.length; i++) {
      const item = result[i];
      console.log(`Item ${i}:`, item, "isLink:", isPrimitiveCellLink(item));

      // If the fix is working, items should be cell links
      // If the bug exists, items would be inline objects like { name: "Alice" }
      expect(isPrimitiveCellLink(item)).toBe(true);
    }
  });

  it("should persist all fields correctly for second+ items", () => {
    // This specifically tests the persistence issue from the bug report
    const arrayCell = runtime.getCell<
      { name: string; priority: number; createdAt: number }[]
    >(
      space,
      "test-array-persistence",
      undefined,
      tx,
    );
    arrayCell.set([]);

    const frame = {
      cause: "test-frame-2",
      space: space,
      runtime,
      tx,
      generatedIdCounter: 0,
      inHandler: true,
    };
    pushFrame(frame);

    try {
      const proxy = createQueryResultProxy<
        { name: string; priority: number; createdAt: number }[]
      >(
        runtime,
        tx,
        arrayCell.getAsNormalizedFullLink(),
        0,
        true,
      );

      // Push multiple items with all fields populated
      proxy.push({ name: "Alice", priority: 1, createdAt: 1000 });
      proxy.push({ name: "Bob", priority: 2, createdAt: 2000 });
      proxy.push({ name: "Charlie", priority: 3, createdAt: 3000 });
    } finally {
      popFrame();
    }

    // Read back via the cell's get() method (which resolves links)
    const items = arrayCell.get();

    console.log("Items via get():", JSON.stringify(items, null, 2));

    expect(items.length).toBe(3);

    // Verify ALL items have correct values (not just the first one)
    expect(items[0]).toEqual({ name: "Alice", priority: 1, createdAt: 1000 });
    expect(items[1]).toEqual({ name: "Bob", priority: 2, createdAt: 2000 });
    expect(items[2]).toEqual({
      name: "Charlie",
      priority: 3,
      createdAt: 3000,
    });
  });
});
