// Simple script to test link cycle detection
// Run with: deno run --allow-all test-link-cycle.js

import { Runtime } from "./packages/runner/src/runtime.ts";
import { StorageManager } from "./packages/runner/src/storage/cache.deno.ts";
import { Identity } from "./packages/identity/src/index.ts";

const signer = await Identity.fromPassphrase("test");
const storageManager = StorageManager.emulate({ as: signer });

const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const space = signer.did();
const tx = runtime.edit();

console.log("Creating cells with circular reference...");

// Create cell A
const cellA = runtime.getCell(space, "cellA", undefined, tx);
cellA.set({ name: "Cell A" });

// Create cell B that references A
const cellB = runtime.getCell(space, "cellB", undefined, tx);
cellB.set({ parent: cellA.getAsLink() });

// Create a circular reference: A references B
cellA.key("child").set(cellB.getAsLink());

console.log("Trying to access A -> child -> parent -> name (should work)...");
try {
  const result = cellA.key("child").key("parent").key("name").get();
  console.log("✓ Result:", result);
} catch (error) {
  console.error("✗ Error:", error.message);
}

console.log("\nCreating a true cycle: A -> foo -> A...");
// This should trigger cycle detection
const cellC = runtime.getCell(space, "cellC", undefined, tx);
cellC.setRaw(cellC.getAsLink());

console.log("Trying to access C (should detect cycle)...");
try {
  const result = cellC.get();
  console.log("✓ Result:", result);
} catch (error) {
  console.error("✗ Error (expected):", error.message);
}

await tx.commit();
await storageManager.close();

console.log("\nTest complete.");
