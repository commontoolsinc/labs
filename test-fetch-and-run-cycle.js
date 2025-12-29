// Test to reproduce fetchAndRunPattern link cycle issue
// Run with: deno run --allow-all test-fetch-and-run-cycle.js

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

console.log("Testing fetchAndRunPattern-like scenario...\n");

// Simulate what fetchAndRunPattern does:
// 1. Creates a cell with compileAndRun
// 2. Returns a link to the result
// 3. The result might reference back to inputs

// Create an "input" cell
const inputCell = runtime.getCell(space, "input", undefined, tx);
inputCell.set({ value: 42 });

// Create a "pattern result" cell that references the input
const resultCell = runtime.getCell(space, "result", undefined, tx);
resultCell.set({
  cell: inputCell.getAsLink(),
  error: null
});

// Create a "compiled pattern" cell that references the result
const compiledCell = runtime.getCell(space, "compiled", undefined, tx);
compiledCell.set({
  result: resultCell.key("cell").getAsLink()
});

console.log("1. Input value:", inputCell.get());
console.log("2. Result cell reference:", resultCell.get());
console.log("3. Compiled result:", compiledCell.key("result").get());

// Now test a more complex scenario: nested pattern execution
// Pattern A calls fetchAndRunPattern which creates Pattern B
// Pattern B result references back to Pattern A's context

const patternACell = runtime.getCell(space, "patternA", undefined, tx);
const patternBCell = runtime.getCell(space, "patternB", undefined, tx);

// Pattern B references Pattern A's context
patternBCell.set({
  parentContext: patternACell.key("context").getAsLink(),
  ownValue: "B's value"
});

// Pattern A references Pattern B's result
patternACell.set({
  context: { data: "A's context" },
  subPatternResult: patternBCell.key("ownValue").getAsLink()
});

console.log("\n4. Pattern A context:", patternACell.key("context").get());
console.log("5. Pattern B accessing A's context:", patternBCell.key("parentContext").get());
console.log("6. Pattern A accessing B's result:", patternACell.key("subPatternResult").get());

// Test case that might trigger cycle:
// Pattern execution creates a cell that references its own input schema
console.log("\n7. Testing self-referential schema pattern...");

const schemaCell = runtime.getCell(space, "schema", undefined, tx);
const executionCell = runtime.getCell(space, "execution", undefined, tx);

// Schema defines structure
schemaCell.set({
  type: "object",
  properties: {
    nested: { $ref: "#" } // Self-reference in schema
  }
});

// Execution references the schema
executionCell.set({
  schema: schemaCell.getAsLink(),
  result: { nested: null } // Result conforms to schema
});

try {
  console.log("8. Execution schema:", executionCell.key("schema").get());
  console.log("✓ Schema self-reference handled correctly");
} catch (error) {
  console.error("✗ Error:", error.message);
}

// Test the specific case from PREEXISTING_BUGS.md:
// suggestion.tsx returns a Counter via fetchAndRunPattern
// The Counter's $alias should resolve, not show as raw object
console.log("\n9. Testing $alias resolution...");

const counterCell = runtime.getCell(space, "counter", undefined, tx);
counterCell.set({ count: 5 });

// Create an alias to the counter's count
const aliasCell = runtime.getCell(space, "alias-test", undefined, tx);
aliasCell.setRaw({
  counterValue: counterCell.key("count").getAsLink()
});

console.log("10. Direct counter value:", counterCell.key("count").get());
console.log("11. Via alias:", aliasCell.key("counterValue").get());
console.log("12. Full alias cell:", aliasCell.get());

await tx.commit();
await runtime.dispose();
await storageManager.close();

console.log("\nTest complete - no cycles detected!");
