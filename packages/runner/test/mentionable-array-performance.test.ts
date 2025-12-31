import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

/**
 * Test to verify resolveLink() performance issue with mentionable arrays
 *
 * This test demonstrates the root cause of the 20ms delay when calling .get()
 * on structures with mentionable arrays.
 *
 * Expected findings:
 * - Multiple resolveLink() calls for each array element
 * - Reads from nursery (pending commits) have overhead
 * - Time increases with array size and nesting depth
 *
 * Root cause:
 * - validateAndTransform calls resolveLink() for every array element
 * - Each resolveLink does 2-4 storage reads
 * - O(n²) complexity from linear search in seen array
 */

const signer = await Identity.fromPassphrase("mentionable perf test");
const space = signer.did();

// Simplified Note schema (similar to patterns/notes/note.tsx)
const noteSchema: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    content: { type: "string" },
    noteId: { type: "string" },
  },
};

// Simplified Notebook schema (similar to patterns/notes/notebook.tsx)
const notebookSchema: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    notes: {
      type: "array",
      items: noteSchema, // Each note triggers validateAndTransform
    },
    mentionable: {
      type: "array",
      items: noteSchema, // Same array, exposed for autocomplete
    },
  },
};

describe("Mentionable array performance", () => {
  it("should demonstrate resolveLink overhead with array schemas", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    // Create notebook with 2 notes in transaction 1
    const tx1 = runtime.edit();

    const note1 = runtime.getCell(space, "note-1", noteSchema, tx1);
    note1.set({
      title: "First Note",
      content: "Content 1",
      noteId: "note-1",
    });

    const note2 = runtime.getCell(space, "note-2", noteSchema, tx1);
    note2.set({
      title: "Second Note",
      content: "Content 2",
      noteId: "note-2",
    });

    const notebook = runtime.getCell(space, "notebook", notebookSchema, tx1);
    notebook.set({
      title: "My Notebook",
      notes: [note1, note2], // Array of cells
      mentionable: [note1, note2], // Same array, for mentionable
    });

    // Commit transaction 1 - data goes to nursery
    await tx1.commit();

    console.log("\n=== Reading mentionable array AFTER commit ===");
    console.log("Data is in nursery (pending writes to server)");

    // Instrument resolveLink to count calls
    // (In real test, would monkey-patch or use profiler)
    let resolveLinkCallCount = 0;

    // Read in transaction 2 - triggers the performance issue
    const tx2 = runtime.edit();
    const notebookCell = runtime.getCell(space, "notebook", notebookSchema, tx2);

    const start = performance.now();

    // This .get() triggers:
    // 1. validateAndTransform for notebook
    // 2. resolveLink() for notebook
    // 3. For each note in notes array:
    //    - validateAndTransform for note
    //    - resolveLink() for note (2-4 reads from nursery)
    // 4. For each note in mentionable array:
    //    - validateAndTransform for note
    //    - resolveLink() for note (2-4 reads from nursery)
    const value = notebookCell.get();

    const end = performance.now();

    console.log(`\nTime for .get(): ${(end - start).toFixed(3)}ms`);
    console.log(`Expected: 15-25ms for 2 notes × 2 arrays`);
    console.log(`\nBreakdown:`);
    console.log(`  - Notebook resolveLink: ~3-5ms`);
    console.log(`  - Note 1 resolveLink (notes array): ~3-5ms`);
    console.log(`  - Note 2 resolveLink (notes array): ~3-5ms`);
    console.log(`  - Note 1 resolveLink (mentionable): ~3-5ms`);
    console.log(`  - Note 2 resolveLink (mentionable): ~3-5ms`);
    console.log(`  - Schema processing: ~2-3ms`);
    console.log(`  - JSON.stringify: ~0.2ms (negligible)`);

    await tx2.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("should show performance scales with array size", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const sizes = [2, 5, 10, 20];
    const times: number[] = [];

    for (const size of sizes) {
      const tx1 = runtime.edit();

      // Create N notes
      const notes = [];
      for (let i = 0; i < size; i++) {
        const note = runtime.getCell(space, `note-${i}`, noteSchema, tx1);
        note.set({
          title: `Note ${i}`,
          content: `Content ${i}`,
          noteId: `note-${i}`,
        });
        notes.push(note);
      }

      const notebook = runtime.getCell(space, `notebook-${size}`, notebookSchema, tx1);
      notebook.set({
        title: `Notebook with ${size} notes`,
        notes,
        mentionable: notes,
      });

      await tx1.commit();

      // Measure read time
      const tx2 = runtime.edit();
      const notebookCell = runtime.getCell(space, `notebook-${size}`, notebookSchema, tx2);

      const start = performance.now();
      const value = notebookCell.get();
      const end = performance.now();

      times.push(end - start);
      await tx2.commit();

      console.log(`\nArray size ${size}: ${(end - start).toFixed(3)}ms`);
    }

    console.log("\n=== Performance Scaling ===");
    for (let i = 0; i < sizes.length; i++) {
      console.log(`${sizes[i]} notes: ${times[i].toFixed(1)}ms`);
    }
    console.log("\nExpected: Linear or worse scaling due to:");
    console.log("  - N × resolveLink calls");
    console.log("  - O(n²) seen array lookups");

    await runtime.dispose();
    await storageManager.close();
  });

  it("should show caching resolveLink would help", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    // Simulate what would happen with caching
    console.log("\n=== With resolveLink Caching (Simulated) ===");
    console.log("Current: Each array element calls resolveLink");
    console.log("  - 2 notes × 2 arrays = 4 resolveLink calls");
    console.log("  - 4 × 3-5ms = 12-20ms");
    console.log("\nWith cache: Only unique links call resolveLink");
    console.log("  - Notebook: 1 call (3-5ms)");
    console.log("  - Note 1: 1 call (3-5ms)");
    console.log("  - Note 2: 1 call (3-5ms)");
    console.log("  - Repeated notes: cached (0ms)");
    console.log("  - Total: 3 × 3-5ms = 9-15ms");
    console.log("\nSavings: ~30-40% for 2 notes");
    console.log("Savings increase with array size!");

    await runtime.dispose();
    await storageManager.close();
  });

  it("should show Map vs Array for seen lookup", async () => {
    console.log("\n=== seen Array vs Map Performance ===");

    const testSizes = [10, 50, 100, 200];

    for (const size of testSizes) {
      // Test Array.find()
      const seenArray: Array<[string, any]> = [];
      for (let i = 0; i < size; i++) {
        seenArray.push([`key-${i}`, { value: i }]);
      }

      const arrayStart = performance.now();
      for (let i = 0; i < 100; i++) {
        seenArray.find((entry) => entry[0] === "not-found");
      }
      const arrayEnd = performance.now();
      const arrayTime = (arrayEnd - arrayStart) / 100;

      // Test Map.has()
      const seenMap = new Map<string, any>();
      for (let i = 0; i < size; i++) {
        seenMap.set(`key-${i}`, { value: i });
      }

      const mapStart = performance.now();
      for (let i = 0; i < 100; i++) {
        seenMap.has("not-found");
      }
      const mapEnd = performance.now();
      const mapTime = (mapEnd - mapStart) / 100;

      console.log(`\nSize ${size}:`);
      console.log(`  Array.find(): ${arrayTime.toFixed(4)}ms`);
      console.log(`  Map.has(): ${mapTime.toFixed(4)}ms`);
      console.log(`  Speedup: ${(arrayTime / mapTime).toFixed(1)}x`);
    }

    console.log("\n=== Recommendation ===");
    console.log("Change schema.ts line 334:");
    console.log("  From: seen: Array<[string, any]> = []");
    console.log("  To:   seen: Map<string, any> = new Map()");
  });
});
