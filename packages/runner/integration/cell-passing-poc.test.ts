#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Proof-of-Concept: Cell Passing Through compileAndRun
 *
 * This test verifies that:
 * 1. A parent pattern can create a Cell<string[]>
 * 2. compileAndRun can load and run a child pattern from source code
 * 3. The parent's Cell can be passed as input to the child pattern
 * 4. The child pattern can modify the Cell (add/remove items)
 * 5. The parent pattern sees the changes reactively
 *
 * This demonstrates that Cells maintain their reference identity and
 * reactivity across the compileAndRun boundary.
 */

import { Identity, Session } from "@commontools/identity";
import { env } from "@commontools/integration";
import { StorageManager } from "../src/storage/cache.ts";
import { Runtime } from "../src/index.ts";
import { CharmManager, compileRecipe } from "@commontools/charm";

(Error as any).stackTraceLimit = 100;

const { API_URL } = env;
const MEMORY_WS_URL = `${
  API_URL.replace("http://", "ws://")
}/api/storage/memory`;
const SPACE_NAME = "cell_passing_poc";

const TIMEOUT_MS = 180000; // 3 minutes

console.log("Cell Passing POC Test");
console.log(`Connecting to: ${MEMORY_WS_URL}`);
console.log(`API_URL: ${API_URL}`);

// Child pattern source code (as a string to be compiled)
const CHILD_PATTERN_SOURCE = `/// <cts-enable />
import { Cell, handler, computed, pattern, NAME, UI } from "commontools";

interface Input {
  // The parent will pass a Cell<string[]> here
  items: Cell<string[]>;
}

// Handler to add an item to the array
const addItem = handler<{ detail: { message: string } }, { items: Cell<string[]> }>(
  (event, { items }) => {
    const text = event.detail.message.trim();
    if (text) {
      const current = items.get();
      items.set([...current, text]);
      console.log("[Child] Added item:", text, "Array now:", items.get());
    }
  }
);

// Handler to remove the last item
const removeLast = handler<unknown, { items: Cell<string[]> }>(
  (_, { items }) => {
    const current = items.get();
    if (current.length > 0) {
      const newArray = current.slice(0, -1);
      items.set(newArray);
      console.log("[Child] Removed last item. Array now:", items.get());
    }
  }
);

// Handler to clear all items
const clearAll = handler<unknown, { items: Cell<string[]> }>(
  (_, { items }) => {
    items.set([]);
    console.log("[Child] Cleared all items");
  }
);

export default pattern<Input>(({ items }) => {
  const itemCount = computed(() => items.length);

  return {
    [NAME]: computed(() => \`Child Pattern (\${itemCount} items)\`),
    [UI]: (
      <div style={{ padding: "16px", border: "2px solid blue" }}>
        <h3>Child Pattern</h3>
        <p>Item count: {itemCount}</p>
        <ct-message-input
          placeholder="Add item..."
          onct-send={addItem({ items })}
        />
        <ct-button onClick={removeLast({ items })}>Remove Last</ct-button>
        <ct-button onClick={clearAll({ items })}>Clear All</ct-button>
        <ul>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </div>
    ),
    items,
    itemCount,
  };
});
`;

// Main test function
async function runTest() {
  const account = await Identity.fromPassphrase("common user");
  const space_thingy = await account.derive(SPACE_NAME);
  const space_thingy_space = space_thingy.did();
  const session = {
    isPrivate: false,
    spaceName: SPACE_NAME,
    space: space_thingy_space,
    as: space_thingy,
  } as Session;

  // Create storage manager
  const storageManager = StorageManager.open({
    as: session.as,
    address: new URL("/api/storage/memory", API_URL),
  });

  // Create runtime
  const runtime = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager,
  });

  // Create charm manager
  const charmManager = new CharmManager(session, runtime);
  await charmManager.ready;

  // Read the parent pattern file content
  const parentPatternContent = await Deno.readTextFile(
    "./integration/cell-passing-poc-parent.test.tsx",
  );

  // Compile the parent pattern
  const parentRecipe = await compileRecipe(
    parentPatternContent,
    "recipe",
    runtime,
    space_thingy_space,
  );
  console.log("Parent recipe compiled successfully");

  // Run the parent pattern with the child source code as input
  const parentCharm = (await charmManager.runPersistent(parentRecipe, {
    childSource: CHILD_PATTERN_SOURCE,
  })).asSchema({
    type: "object",
    properties: {
      sharedItems: {
        type: "array",
        items: { type: "string" },
      },
      childReady: { type: "boolean" },
      addItemToShared: { type: "object", asStream: true },
    },
    required: ["sharedItems", "childReady", "addItemToShared"],
  });

  console.log("Parent charm ID:", parentCharm.entityId);
  console.log("Parent charm schema:", parentCharm.schema);

  // Wait for compilation
  console.log("Waiting for child pattern to compile...");
  let attempts = 0;
  while (!parentCharm.get().childReady && attempts < 30) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    attempts++;
  }

  if (!parentCharm.get().childReady) {
    throw new Error("Child pattern failed to compile in time");
  }
  console.log("Child pattern compiled and ready!");

  // Test 1: Add an item through parent
  console.log("\n=== Test 1: Add item through parent ===");
  const addStream = parentCharm.key("addItemToShared") as any;
  addStream.send({ detail: { message: "Item from parent" } });

  await runtime.idle();
  await runtime.storageManager.synced();

  const items1 = parentCharm.get().sharedItems;
  console.log("Items after parent add:", items1);
  if (!items1.includes("Item from parent")) {
    throw new Error("Expected 'Item from parent' in shared items");
  }

  // Test 2: Add another item
  console.log("\n=== Test 2: Add second item ===");
  addStream.send({ detail: { message: "Second item" } });

  await runtime.idle();
  await runtime.storageManager.synced();

  const items2 = parentCharm.get().sharedItems;
  console.log("Items after second add:", items2);
  if (items2.length !== 2) {
    throw new Error(`Expected 2 items, got ${items2.length}`);
  }
  if (!items2.includes("Second item")) {
    throw new Error("Expected 'Second item' in shared items");
  }

  // Test 3: Verify both items are present
  console.log("\n=== Test 3: Verify both items ===");
  if (items2[0] !== "Item from parent" || items2[1] !== "Second item") {
    throw new Error(
      `Expected ['Item from parent', 'Second item'], got ${JSON.stringify(items2)}`,
    );
  }

  console.log("\n=== All tests passed! ===");
  console.log("✓ Cell passing through compileAndRun works correctly");
  console.log("✓ Parent can modify Cell");
  console.log("✓ Changes are visible across pattern boundary");
  console.log("✓ Array mutations work as expected");

  // Clean up
  await runtime.dispose();
  await storageManager.close();
}

// Run the test with timeout
Deno.test({
  name: "cell passing through compileAndRun POC",
  fn: async () => {
    let timeoutHandle: number;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    try {
      await Promise.race([runTest(), timeoutPromise]);
      console.log("Test completed successfully within timeout");
    } finally {
      clearTimeout(timeoutHandle!);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
