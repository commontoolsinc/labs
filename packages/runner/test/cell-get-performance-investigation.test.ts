import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

/**
 * Performance investigation for Cell.get() with nested structures
 *
 * This test creates a scenario matching the user's description:
 * - A structure spanning ~10 docs
 * - Some recently changed (in nursery)
 * - Measures actual performance
 */

const signer = await Identity.fromPassphrase("perf investigation");
const space = signer.did();

describe("Cell.get() performance investigation", () => {
  it("should measure get() performance on nested structure (10 docs)", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    // Create a nested structure with 10 documents
    const tx = runtime.edit();

    // Create leaf documents
    const leaf1 = runtime.getCell<{ value: number }>(
      space,
      "leaf-1",
      undefined,
      tx,
    );
    const leaf2 = runtime.getCell<{ value: number }>(
      space,
      "leaf-2",
      undefined,
      tx,
    );
    const leaf3 = runtime.getCell<{ value: number }>(
      space,
      "leaf-3",
      undefined,
      tx,
    );

    leaf1.set({ value: 1 });
    leaf2.set({ value: 2 });
    leaf3.set({ value: 3 });

    // Create mid-level documents
    const mid1 = runtime.getCell<{ leaves: any[] }>(space, "mid-1", undefined, tx);
    const mid2 = runtime.getCell<{ leaves: any[] }>(
      space,
      "mid-2",
      undefined,
      tx,
    );

    mid1.set({ leaves: [leaf1, leaf2] });
    mid2.set({ leaves: [leaf2, leaf3] });

    // Create more nested levels
    const level3 = runtime.getCell<{ mids: any[] }>(
      space,
      "level-3",
      undefined,
      tx,
    );
    level3.set({ mids: [mid1, mid2] });

    const level4 = runtime.getCell<{ data: any }>(
      space,
      "level-4",
      undefined,
      tx,
    );
    level4.set({ data: level3 });

    // Top level
    const root = runtime.getCell<{ nested: any }>(space, "root", undefined, tx);
    root.set({ nested: level4 });

    // Commit - this puts data in nursery
    await tx.commit();

    console.log("\n=== Test 1: Reading from NURSERY (recently changed) ===");
    const nurseryStart = performance.now();
    const nurseryValue = root.get();
    const nurseryEnd = performance.now();

    console.log(`Root get() took: ${(nurseryEnd - nurseryStart).toFixed(3)}ms`);
    console.log(`Value loaded:`, JSON.stringify(nurseryValue, null, 2).substring(0, 200));

    // Now wait for sync to move to heap
    await runtime.storageManager.synced();

    console.log("\n=== Test 2: Reading from HEAP (after sync) ===");
    const heapStart = performance.now();
    const heapValue = root.get();
    const heapEnd = performance.now();

    console.log(`Root get() took: ${(heapEnd - heapStart).toFixed(3)}ms`);

    // Test repeated reads (should use any caching)
    console.log("\n=== Test 3: Repeated reads from HEAP ===");
    const repeatedStart = performance.now();
    for (let i = 0; i < 100; i++) {
      root.get();
    }
    const repeatedEnd = performance.now();
    const avgTime = (repeatedEnd - repeatedStart) / 100;

    console.log(`100 reads took: ${(repeatedEnd - repeatedStart).toFixed(3)}ms`);
    console.log(`Average per read: ${avgTime.toFixed(3)}ms`);

    // Now modify ONE doc and test mixed nursery/heap read
    console.log("\n=== Test 4: Mixed NURSERY/HEAP (1 doc changed) ===");
    const tx2 = runtime.edit();
    leaf1.withTx(tx2).set({ value: 999 });
    await tx2.commit();
    // Don't sync - leave it in nursery

    const mixedStart = performance.now();
    const mixedValue = root.get();
    const mixedEnd = performance.now();

    console.log(`Root get() (mixed) took: ${(mixedEnd - mixedStart).toFixed(3)}ms`);

    await runtime.dispose();
    await storageManager.close();
  });

  it("should trace read operations during get()", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const tx = runtime.edit();

    // Simple 3-level structure
    const bottom = runtime.getCell<{ value: string }>(
      space,
      "bottom",
      undefined,
      tx,
    );
    const middle = runtime.getCell<{ ref: any }>(space, "middle", undefined, tx);
    const top = runtime.getCell<{ nested: any }>(space, "top", undefined, tx);

    bottom.set({ value: "test" });
    middle.set({ ref: bottom });
    top.set({ nested: middle });

    await tx.commit();
    await runtime.storageManager.synced();

    // Instrument transaction reads
    const originalReadValueOrThrow = runtime.edit().readValueOrThrow.bind(runtime.edit());
    let readCount = 0;

    const instrumentedTx = runtime.edit();
    const originalRead = instrumentedTx.readValueOrThrow;
    instrumentedTx.readValueOrThrow = function (address: any, options?: any) {
      readCount++;
      const start = performance.now();
      const result = originalRead.call(this, address, options);
      const end = performance.now();
      console.log(
        `  Read #${readCount}: ${address.id} path=${JSON.stringify(address.path)} took ${(end - start).toFixed(3)}ms`,
      );
      return result;
    };

    console.log("\n=== Tracing reads during top.get() ===");
    readCount = 0;
    const start = performance.now();
    const value = top.withTx(instrumentedTx).get();
    const end = performance.now();

    console.log(`\nTotal: ${readCount} reads in ${(end - start).toFixed(3)}ms`);

    await runtime.dispose();
    await storageManager.close();
  });
});
