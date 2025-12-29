#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Simplified Cell Passing POC
 *
 * This is a minimal version of the cell-passing test that focuses on the core
 * mechanism without all the UI complexity. It verifies:
 * 1. A Cell can be created in a parent
 * 2. The Cell can be passed through compileAndRun
 * 3. The compiled child can modify the Cell
 * 4. The parent sees the modifications
 */

import { Identity, Session } from "@commontools/identity";
import { env } from "@commontools/integration";
import { StorageManager } from "../src/storage/cache.ts";
import { Runtime } from "../src/index.ts";
import { CharmManager, compileRecipe } from "@commontools/charm";

(Error as any).stackTraceLimit = 100;

const { API_URL } = env;
const SPACE_NAME = "cell_passing_simple";
const TIMEOUT_MS = 180000;

console.log("Simplified Cell Passing POC");
console.log(`API_URL: ${API_URL}`);

// Child pattern - receives a Cell and modifies it
const CHILD_SOURCE = `/// <cts-enable />
import { Cell, handler, pattern, NAME, UI } from "commontools";

interface Input {
  items: Cell<string[]>;
}

const addItem = handler<{ value: string }, { items: Cell<string[]> }>(
  (event, { items }) => {
    const current = items.get();
    items.set([...current, event.value]);
    console.log("[Child] Added:", event.value, "Array:", items.get());
  }
);

export default pattern<Input>(({ items }) => {
  return {
    [NAME]: "Child",
    [UI]: <div>Child pattern</div>,
    items,
    addItem: addItem({ items }),
  };
});
`;

// Parent pattern - creates a Cell and uses compileAndRun
const PARENT_SOURCE = `/// <cts-enable />
import { cell, Cell, compileAndRun, computed, Default, handler, pattern, NAME, UI } from "commontools";

interface Input {
  childSource: Default<string, "">;
}

const triggerAdd = handler<{ value: string }, { addStream: any }>(
  (event, { addStream }) => {
    console.log("[Parent] Triggering add:", event.value);
    addStream.send({ value: event.value });
  }
);

export default pattern<Input>(({ childSource }) => {
  const sharedItems = cell<string[]>([]);

  const compileParams = computed(() => ({
    files: childSource ? [{ name: "/child.tsx", contents: childSource }] : [],
    main: childSource ? "/child.tsx" : "",
    input: { items: sharedItems },
  }));

  const compiled = compileAndRun(compileParams);

  const childReady = computed(() =>
    !compiled.pending && !!compiled.result && !compiled.error
  );

  // Get the child's addItem handler
  const childAddStream = computed(() =>
    childReady && compiled.result ? compiled.result.key("addItem") : undefined
  );

  return {
    [NAME]: "Parent",
    [UI]: <div>Parent pattern</div>,
    sharedItems,
    childReady,
    childError: compiled.error,
    triggerAdd: triggerAdd({ addStream: childAddStream }),
  };
});
`;

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

  const storageManager = StorageManager.open({
    as: session.as,
    address: new URL("/api/storage/memory", API_URL),
  });

  const runtime = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager,
  });

  const charmManager = new CharmManager(session, runtime);
  await charmManager.ready;

  console.log("Compiling parent pattern...");
  const parentRecipe = await compileRecipe(
    PARENT_SOURCE,
    "recipe",
    runtime,
    space_thingy_space,
  );

  const parentCharm = (await charmManager.runPersistent(parentRecipe, {
    childSource: CHILD_SOURCE,
  })).asSchema({
    type: "object",
    properties: {
      sharedItems: { type: "array", items: { type: "string" } },
      childReady: { type: "boolean" },
      childError: { type: ["string", "null"] },
      triggerAdd: { type: "object", asStream: true },
    },
    required: ["sharedItems", "childReady", "triggerAdd"],
  });

  console.log("Parent charm created:", parentCharm.entityId);

  // Wait for child compilation
  console.log("Waiting for child to compile...");
  let attempts = 0;
  while (!parentCharm.get().childReady && attempts < 30) {
    if (parentCharm.get().childError) {
      console.error("Child compilation error:", parentCharm.get().childError);
      throw new Error("Child failed to compile");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    attempts++;
  }

  if (!parentCharm.get().childReady) {
    throw new Error("Child not ready after timeout");
  }

  console.log("Child compiled successfully!");

  // Test: Add an item through the parent's trigger
  console.log("\nTest: Adding item through parent trigger...");
  const triggerStream = parentCharm.key("triggerAdd") as any;
  triggerStream.send({ value: "test-item-1" });

  await runtime.idle();
  await runtime.storageManager.synced();

  const items = parentCharm.get().sharedItems;
  console.log("Items in parent:", items);

  if (!items.includes("test-item-1")) {
    throw new Error(
      `Expected 'test-item-1' in items, got: ${JSON.stringify(items)}`,
    );
  }

  console.log("✓ Item added successfully!");

  // Test: Add another item
  console.log("\nTest: Adding second item...");
  triggerStream.send({ value: "test-item-2" });

  await runtime.idle();
  await runtime.storageManager.synced();

  const items2 = parentCharm.get().sharedItems;
  console.log("Items after second add:", items2);

  if (items2.length !== 2 || !items2.includes("test-item-2")) {
    throw new Error(`Expected 2 items, got: ${JSON.stringify(items2)}`);
  }

  console.log("✓ Second item added successfully!");
  console.log("\n=== All tests passed! ===");

  await runtime.dispose();
  await storageManager.close();
}

Deno.test({
  name: "simplified cell passing POC",
  fn: async () => {
    let timeoutHandle: number;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    try {
      await Promise.race([runTest(), timeoutPromise]);
      console.log("Test completed successfully");
    } finally {
      clearTimeout(timeoutHandle!);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
