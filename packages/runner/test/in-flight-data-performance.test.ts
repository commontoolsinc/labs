import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

/**
 * Test to verify the in-flight data performance issue
 *
 * Hypothesis: When reading nested structures while commits are in flight,
 * each referenced document triggers a sync() call, leading to multiple
 * concurrent async operations that aren't properly awaited.
 */

const signer = await Identity.fromPassphrase("in-flight test");
const space = signer.did();

describe("In-flight data performance", () => {
  it("should measure reads BEFORE vs AFTER commit", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const tx = runtime.edit();

    // Create 10 separate documents
    const docs = [];
    for (let i = 0; i < 10; i++) {
      const doc = runtime.getCell<{ value: number }>(
        space,
        `doc-${i}`,
        undefined,
        tx,
      );
      doc.set({ value: i });
      docs.push(doc);
    }

    // Create a root that references all of them
    const root = runtime.getCell<{ refs: any[] }>(space, "root", undefined, tx);
    root.set({ refs: docs });

    console.log("\n=== BEFORE COMMIT (data in transaction) ===");
    const beforeStart = performance.now();
    const beforeValue = root.get();
    const beforeEnd = performance.now();
    console.log(`Time: ${(beforeEnd - beforeStart).toFixed(3)}ms`);
    console.log(`Refs loaded: ${beforeValue.refs.length}`);

    // Now commit - this moves data to nursery and starts network operation
    await tx.commit();

    console.log("\n=== AFTER COMMIT (data in nursery, commit in flight) ===");
    const afterStart = performance.now();
    const afterValue = root.get();
    const afterEnd = performance.now();
    console.log(`Time: ${(afterEnd - afterStart).toFixed(3)}ms`);
    console.log(
      `Time increase: ${((afterEnd - afterStart) / (beforeEnd - beforeStart)).toFixed(1)}x`,
    );

    // Wait for sync
    await runtime.storageManager.synced();

    console.log("\n=== AFTER SYNC (data in heap) ===");
    const syncedStart = performance.now();
    const syncedValue = root.get();
    const syncedEnd = performance.now();
    console.log(`Time: ${(syncedEnd - syncedStart).toFixed(3)}ms`);

    await runtime.dispose();
    await storageManager.close();
  });

  it("should count sync() calls during nested read", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const tx = runtime.edit();

    // Create nested structure: root -> mid1 -> leaf1, mid2 -> leaf2
    const leaf1 = runtime.getCell<{ value: number }>(
      space,
      "leaf1",
      undefined,
      tx,
    );
    const leaf2 = runtime.getCell<{ value: number }>(
      space,
      "leaf2",
      undefined,
      tx,
    );
    const mid1 = runtime.getCell<{ ref: any }>(space, "mid1", undefined, tx);
    const mid2 = runtime.getCell<{ ref: any }>(space, "mid2", undefined, tx);
    const root = runtime.getCell<{ refs: any[] }>(space, "root2", undefined, tx);

    leaf1.set({ value: 1 });
    leaf2.set({ value: 2 });
    mid1.set({ ref: leaf1 });
    mid2.set({ ref: leaf2 });
    root.set({ refs: [mid1, mid2] });

    await tx.commit();

    // Instrument syncCell to count calls
    let syncCount = 0;
    const originalSyncCell = runtime.storageManager.syncCell.bind(
      runtime.storageManager,
    );
    runtime.storageManager.syncCell = async function <T>(cell: any) {
      syncCount++;
      console.log(
        `  sync() #${syncCount} called for:`,
        cell.getAsNormalizedFullLink().id,
      );
      return await originalSyncCell(cell);
    };

    console.log("\n=== Counting sync() calls during root.get() ===");
    syncCount = 0;
    const start = performance.now();
    root.get();
    const end = performance.now();

    console.log(`\nTotal sync() calls: ${syncCount}`);
    console.log(`Time: ${(end - start).toFixed(3)}ms`);
    console.log(
      `Avg time per sync: ${syncCount > 0 ? ((end - start) / syncCount).toFixed(3) : 0}ms`,
    );

    await runtime.dispose();
    await storageManager.close();
  });

  it("should test the non-awaited sync() issue", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const tx = runtime.edit();

    const doc = runtime.getCell<{ value: number }>(
      space,
      "test-doc",
      undefined,
      tx,
    );
    doc.set({ value: 42 });

    await tx.commit();

    // Track whether sync completed
    let syncCompleted = false;
    const originalSyncCell = runtime.storageManager.syncCell.bind(
      runtime.storageManager,
    );
    runtime.storageManager.syncCell = async function <T>(cell: any) {
      console.log("  sync() started");
      const result = await originalSyncCell(cell);
      syncCompleted = true;
      console.log("  sync() completed");
      return result;
    };

    console.log("\n=== Testing non-awaited sync() ===");
    console.log("Calling get()...");
    const value = doc.get();
    console.log("get() returned immediately");
    console.log(`Value: ${value.value}`);
    console.log(`sync() completed? ${syncCompleted}`);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log(`sync() completed after 100ms? ${syncCompleted}`);

    await runtime.dispose();
    await storageManager.close();
  });
});
