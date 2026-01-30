#!/usr/bin/env -S deno run -A

/**
 * Integration test: Recipe and Data Persistence
 *
 * This test demonstrates the full layered persistence model:
 * 1. Recipe source code stored in `datum` table (content-addressed)
 * 2. Precious data stored in `datum` table
 * 3. Recipe loaded from storage reacts to data loaded from storage
 *
 * The test uses multiple runtime instances to prove that both recipe
 * and data are truly persisted and can be loaded fresh from storage.
 */

import { assertEquals } from "@std/assert";
import { Runtime, type RuntimeProgram } from "@commontools/runner";
import { Identity, type IdentityCreateConfig } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { JSONSchema } from "@commontools/runner";
import { env } from "@commontools/integration";

const { API_URL } = env;

const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};

const TIMEOUT_MS = 180000; // 3 minutes timeout

/**
 * A simple recipe that:
 * - Takes a cell reference as input (the "precious" data)
 * - Computes derived values using lift() (defined outside recipe body)
 */
const recipeProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { recipe, lift } from 'commontools';",
        "",
        "// Define lifts outside the recipe body",
        "const computeSum = lift((data: { values: number[] }) => {",
        "  return data.values.reduce((acc: number, v: number) => acc + v, 0);",
        "});",
        "",
        "const formatResult = lift((data: { label: string; sum: number }) => {",
        "  return `${data.label}: ${data.sum}`;",
        "});",
        "",
        "// The recipe argument type is the value type",
        "export default recipe<{ data: { values: number[]; label: string } }>(",
        "  'Sum and Label',",
        "  ({ data }) => {",
        "    const sum = computeSum(data);",
        "    const result = formatResult({ label: data.label, sum });",
        "    return { sum, result };",
        "  }",
        ");",
      ].join("\n"),
    },
  ],
};

const inputDataSchema = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "number" } },
    label: { type: "string" },
  },
  required: ["values", "label"],
} as const satisfies JSONSchema;

async function testRecipeAndDataPersistence() {
  console.log("\n=== TEST: Recipe and Data Persistence ===");
  const testId = Date.now().toString();
  const identity = await Identity.fromPassphrase(
    `recipe-data-persistence-${testId}`,
    keyConfig,
  );
  const space = identity.did();

  // ============================================================
  // PHASE 1: First runtime - save recipe and data to storage
  // ============================================================
  console.log("\n--- Phase 1: Save recipe and data ---");

  const storageManager1 = StorageManager.open({
    as: identity,
    address: new URL("/api/storage/memory", API_URL),
  });

  const runtime1 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: storageManager1,
  });

  // Compile and save the recipe
  const compiled = await runtime1.recipeManager.compileRecipe(recipeProgram);
  const recipeId = runtime1.recipeManager.registerRecipe(
    compiled,
    recipeProgram,
  );
  await runtime1.recipeManager.saveAndSyncRecipe({ recipeId, space });

  console.log(`Recipe saved with ID: ${recipeId}`);

  // Save some precious data
  const initialData = { values: [1, 2, 3, 4, 5], label: "Numbers" };

  let tx = runtime1.edit();
  const dataCell1 = runtime1.getCell(
    space,
    "test-input-data",
    inputDataSchema,
    tx,
  );
  dataCell1.set(initialData);
  await tx.commit();

  await runtime1.storageManager.synced();
  console.log("Data saved:", initialData);

  // Dispose runtime1 - this clears the in-memory cache
  await runtime1.dispose();
  await storageManager1.close();
  console.log("Runtime 1 disposed (cache cleared)");

  // ============================================================
  // PHASE 2: Second runtime - load recipe and data from storage
  // ============================================================
  console.log("\n--- Phase 2: Load recipe and data from storage ---");

  const storageManager2 = StorageManager.open({
    as: identity,
    address: new URL("/api/storage/memory", API_URL),
  });

  const runtime2 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: storageManager2,
  });

  tx = runtime2.edit();

  // Load the recipe from storage (not from cache - it's a fresh runtime)
  const loadedRecipe = await runtime2.recipeManager.loadRecipe(
    recipeId,
    space,
    tx,
  );
  console.log("Recipe loaded from storage");

  // Load the data cell from storage
  const dataCell2 = runtime2.getCell(
    space,
    "test-input-data",
    inputDataSchema,
    tx,
  );
  await dataCell2.sync();
  console.log(`Data loaded: ${JSON.stringify(dataCell2.get())}`);

  // Create a result cell for the recipe output
  const resultCell = runtime2.getCell<{ sum: number; result: string }>(
    space,
    "test-recipe-result",
    undefined,
    tx,
  );

  // Run the loaded recipe with the loaded data cell
  const runResult = runtime2.run(
    tx,
    loadedRecipe,
    { data: dataCell2 },
    resultCell,
  );
  await tx.commit();

  // Wait for the recipe to compute
  await runResult.pull();

  const output1 = runResult.getAsQueryResult();
  console.log(`Computed result: ${JSON.stringify(output1)}`);

  // Verify the derived values
  assertEquals(output1.sum, 15, "Sum should be 1+2+3+4+5=15");
  assertEquals(
    output1.result,
    "Numbers: 15",
    "Result should be formatted correctly",
  );

  // ============================================================
  // PHASE 3: Update data and verify reactivity
  // ============================================================
  console.log("\n--- Phase 3: Update data and verify reactivity ---");

  const updatedData = { values: [10, 20, 30], label: "Big numbers" };

  tx = runtime2.edit();
  dataCell2.withTx(tx).set(updatedData);
  await tx.commit();

  // Wait for reactivity to propagate
  await runResult.pull();

  const output2 = runResult.getAsQueryResult();
  console.log(`After update: ${JSON.stringify(output2)}`);

  // Verify the recipe reacted to the data change
  assertEquals(output2.sum, 60, "Sum should be 10+20+30=60");
  assertEquals(
    output2.result,
    "Big numbers: 60",
    "Result should reflect updated data",
  );

  // Cleanup
  await runtime2.dispose();
  await storageManager2.close();

  console.log("\n=== TEST PASSED ===");
}

Deno.test({
  name: "recipe and data persistence - full reactive cycle",
  fn: async () => {
    let timeoutHandle: number;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    try {
      await Promise.race([testRecipeAndDataPersistence(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
