import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Recipe } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import type { EntityId } from "../src/doc-map.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("runSynced restoration", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let recipe: ReturnType<typeof createBuilder>["recipe"];
  let lift: ReturnType<typeof createBuilder>["lift"];

  const createRuntime = () => {
    return new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  };

  const cleanupRuntime = async (runtimeToClean: Runtime) => {
    await runtimeToClean.idle();
    await runtimeToClean.storage.synced();
    await runtimeToClean.dispose();
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = createRuntime();
    const builder = createBuilder(runtime);
    recipe = builder.recipe;
    lift = builder.lift;
  });

  afterEach(async () => {
    await cleanupRuntime(runtime);
    await storageManager?.close();
  });

  it("should restore recipe state from storage", async () => {
    type SavedCellState = {
      entityId: EntityId;
      rawState: any;
      sourceRawState: {
        entityId: EntityId;
        raw: any;
      };
    };

    const testRecipe = recipe<{ increment: number }>(
      "Counter Recipe",
      ({ increment }) => {
        const count = lift((x: number) => x + 1)(increment);
        return { count };
      },
    );

    /**
     * Helper function to run a recipe test sequence that can work with both
     * fresh cells and restored cells from a previous runtime.
     *
     * @param testRuntime - The runtime instance to use for this test run
     * @param testRecipe - The recipe to run
     * @param existingCell - Optional saved state from a previous runtime (same as what this function returns)
     * @returns State information that can be passed to another runtime instance:
     *   - entityId: The result cell's entity ID
     *   - rawState: The result cell's raw state
     *   - sourceRawState: The source cell's entity ID and raw state
     */
    const runRecipeTest = async (
      testRuntime: Runtime,
      testRecipe: Recipe,
      existingCell?: SavedCellState,
    ): Promise<SavedCellState> => {
      let resultCell;

      if (!existingCell) {
        // Create new cell for first-time execution
        resultCell = testRuntime.getCell(space, "restoration-test");
      } else {
        // Restore from saved state - this simulates loading from storage
        // Get the result cell by its entity ID (cells with same ID across runtimes)
        resultCell = testRuntime.getCellFromEntityId(
          space,
          existingCell.entityId,
        );

        // Get the source/process cell (contains recipe state and internal data)
        const sourceCell = testRuntime.getCellFromEntityId(
          space,
          existingCell.sourceRawState.entityId,
        );

        // Restore the raw state data (simulating storage load)
        resultCell.setRaw(existingCell.rawState);
        sourceCell.setRaw(existingCell.sourceRawState.raw);
      }

      // Run initial test
      // TODO(@ellyse) verify that await runtime.idle() isn't necessary here
      await testRuntime.runSynced(resultCell, testRecipe, { increment: 5 });
      expect(resultCell.get()).toMatchObject({
        count: 6,
      });

      // Update the state
      // TODO(@ellyse) verify that await runtime.idle() isn't necessary here
      await testRuntime.runSynced(resultCell, testRecipe, { increment: 3 });
      expect(resultCell.get()).toMatchObject({
        count: 4,
      });

      // Return state for next runtime - this captures everything needed
      // to restore the recipe's complete state in another runtime instance
      const sourceCell = resultCell.getSourceCell()!;
      return {
        entityId: resultCell.entityId, // Result cell's unique ID
        rawState: resultCell.getRaw(), // Result cell's data (the recipe output)
        sourceRawState: {
          entityId: sourceCell.entityId, // Source cell's unique ID
          raw: sourceCell.getRaw(), // Source cell's data (recipe state, internal data)
        },
      };
    };

    // Phase 1: Run with first runtime
    const savedState = await runRecipeTest(runtime, testRecipe);

    // Phase 2: Create new runtime and run with restored state
    await cleanupRuntime(runtime);
    const runtime2 = createRuntime();

    const restoredState = await runRecipeTest(runtime2, testRecipe, savedState);

    // Verify entity IDs match (proving we're using the same cell)
    expect(restoredState.entityId).toEqual(savedState.entityId);

    // Additional verification: continue execution with new input
    const resultCell = runtime2.getCellFromEntityId(
      space,
      restoredState.entityId,
    );
    await runtime2.runSynced(resultCell, testRecipe, { increment: 7 });
    expect(resultCell.get()).toMatchObject({
      count: 8,
    });

    await cleanupRuntime(runtime2);
  });
});
