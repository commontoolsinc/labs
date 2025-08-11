import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Recipe Instance Deduplication", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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
    await runtime?.storage.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should reuse same recipe ID when Counter is called with same inputs", async () => {
    const { commontools: { recipe } } = createBuilder(runtime);

    // Create a Counter recipe using the builder API
    const Counter = recipe<{ value: number }, { value: number }>(
      { type: "object", properties: { value: { type: "number" } } },
      { type: "object", properties: { value: { type: "number" } } },
      ({ value }) => {
        return { value };
      },
    );

    // Create a TestWrapper that uses Counter twice with same inputs
    const TestWrapper = recipe(
      "Test wrapper",
      () => {
        const counter1 = Counter({ value: 5 });
        const counter2 = Counter({ value: 5 });
        return { counter1, counter2 };
      },
    );

    // Track new recipes added
    const recipeManager = runtime.recipeManager as any;
    const recipeIdMapBefore = new Map(recipeManager.recipeIdMap);

    // Run the TestWrapper
    const resultCell = runtime.getCell(space, "test-dedup", undefined, tx);
    runtime.run(tx, TestWrapper, {}, resultCell);
    await tx.commit();
    await runtime.idle();

    // Get recipes added after running
    const recipeIdMapAfter = recipeManager.recipeIdMap;
    const newRecipesAdded = recipeIdMapAfter.size - recipeIdMapBefore.size;

    console.log("Recipes before:", recipeIdMapBefore.size);
    console.log("Recipes after:", recipeIdMapAfter.size);
    console.log("New recipes added:", newRecipesAdded);

    // List all new recipe IDs for debugging
    for (const [id, recipe] of recipeIdMapAfter) {
      if (!recipeIdMapBefore.has(id)) {
        console.log("New recipe ID:", id);
      }
    }

    // We expect at most 3 recipes to be added:
    // 1. Counter recipe (factory)
    // 2. TestWrapper recipe
    // 3. One shared recipe for both Counter({ value: 5 }) calls
    // Currently fails: gets 4 because each Counter() call creates a separate recipe
    expect(newRecipesAdded).toBeLessThanOrEqual(3);
  });

  it("should have source for dynamically created recipe instances", async () => {
    const { commontools: { recipe } } = createBuilder(runtime);

    // Create and register a counter recipe with source
    const Counter = recipe<{ value: number }, { value: number }>(
      { type: "object", properties: { value: { type: "number" } } },
      { type: "object", properties: { value: { type: "number" } } },
      ({ value }) => {
        return { value };
      },
    );

    // Define proper TypeScript source for the Counter recipe
    const counterSource = `
import { recipe } from "@commontools/runtime";

export const Counter = recipe<{ value: number }, { value: number }>(
  { type: "object", properties: { value: { type: "number" } } },
  { type: "object", properties: { value: { type: "number" } } },
  ({ value }) => {
    return { value };
  }
);
`;

    const counterProgram = {
      main: "/counter.tsx",
      files: [{ name: "/counter.tsx", contents: counterSource }],
    };
    const counterId = runtime.recipeManager.registerRecipe(
      Counter,
      counterProgram,
    );
    console.log("[TEST] Counter registered with ID:", counterId);

    // Verify Counter has source
    const recipeManager = runtime.recipeManager as any;
    const recipeProgramMap = recipeManager.recipeProgramMap;
    const counterHasSource = recipeProgramMap.has(Counter);
    console.log("[TEST] Original Counter has source:", counterHasSource);
    expect(counterHasSource).toBe(true);

    // Track recipes before running
    const recipeIdMap = recipeManager.recipeIdMap;
    const sizeBefore = recipeIdMap.size;

    // Create a wrapper that calls Counter to get an instance
    const TestWrapper = recipe<Record<PropertyKey, never>, { instance: any }>(
      { type: "object", properties: {} },
      { type: "object", properties: { instance: { type: "object" } } },
      () => {
        return { instance: Counter({ value: 5 }) };
      },
    );

    // Define source for the test wrapper
    const testWrapperSource = `
import { recipe } from "@commontools/runtime";
import { Counter } from "./counter.tsx";

export const TestWrapper = recipe<{}, { instance: any }>(
  { type: "object", properties: {} },
  { type: "object", properties: { instance: { type: "object" } }},
  () => {
    return { instance: Counter({ value: 5 }) };
  }
);
`;

    // Register and run the wrapper
    runtime.recipeManager.registerRecipe(TestWrapper, {
      main: "/test.tsx",
      files: [
        { name: "/test.tsx", contents: testWrapperSource },
        { name: "/counter.tsx", contents: counterSource },
      ],
    });

    const cell = runtime.getCell(space, { type: "test" }, undefined, tx);
    runtime.run(tx, TestWrapper, {}, cell);
    await tx.commit();
    await runtime.idle();

    // Check new recipes added
    const sizeAfter = recipeIdMap.size;
    const newRecipesAdded = sizeAfter - sizeBefore;
    console.log("[TEST] New recipes added:", newRecipesAdded);

    // Check all recipes for source
    let recipesWithoutSource = 0;
    let recipesWithSource = 0;

    for (const [id, recipe] of recipeIdMap.entries()) {
      const hasSource = recipeProgramMap.has(recipe);
      if (hasSource) {
        recipesWithSource++;
      } else {
        recipesWithoutSource++;
        console.log("[TEST] Recipe without source ID:", id);
      }
    }

    console.log("[TEST] Total recipes with source:", recipesWithSource);
    console.log("[TEST] Total recipes without source:", recipesWithoutSource);

    // The issue: dynamically created recipes have no source
    // We should have source for all recipes
    expect(recipesWithoutSource).toBe(0);
  });
});
