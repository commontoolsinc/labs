import { getLogger } from "@commontools/utils/logger";
import { TYPE } from "./builder/types.ts";
import type { Cell } from "./cell.ts";
import { type NormalizedFullLink, parseLink } from "./link-utils.ts";
import type { IRuntime } from "./runtime.ts";

const logger = getLogger("ensure-charm-running", {
  enabled: false,
  level: "debug",
});

/**
 * Ensures the charm responsible for a given storage location is running.
 *
 * Note: We don't track which charms we've already started because calling
 * runtime.runSynced() on an already-running charm is idempotent - it simply
 * returns without doing anything. This keeps the code simple and stateless.
 *
 * This function traverses the source cell chain to find the root process cell,
 * then starts the charm if it's not already running.
 *
 * The traversal logic:
 * 1. Start with the cell at the cellLink location
 * 2. While getSourceCell() returns something, follow it (this traverses
 *    through linked cells to find the process cell)
 * 3. Once there's no source cell, look at resultRef in the resulting document
 * 4. If resultRef is a link, that's the result cell - call runtime.runSynced()
 *    on it to start the charm
 *
 * @param runtime - The runtime instance
 * @param cellLink - The location that received an event or should be current
 * @returns Promise<boolean> - true if a charm was started, false otherwise
 */
export async function ensureCharmRunning(
  runtime: IRuntime,
  cellLink: NormalizedFullLink,
): Promise<boolean> {
  try {
    const tx = runtime.edit();

    try {
      // Get the cell at the event link location
      let currentCell: Cell<any> | undefined = runtime.getCellFromLink(
        // We'll find the charm information at the root of what could be the
        // process cell already, hence remove the path:
        { ...cellLink, path: [] },
        undefined,
        tx,
      );

      // Traverse up the source cell chain
      // This follows links from derived cells back to the process cell
      let sourceCell = currentCell.getSourceCell();
      while (sourceCell) {
        logger.debug("ensure-charm", () => [
          `Following source cell from ${currentCell?.getAsNormalizedFullLink().id} to ${sourceCell?.getAsNormalizedFullLink().id}`,
        ]);
        currentCell = sourceCell;
        sourceCell = currentCell.getSourceCell();
      }

      // currentCell is now the process cell (or the original cell if no sources)
      // Check if it has a resultRef and a TYPE (indicating it's a process cell)
      const processData = currentCell.getRaw();

      if (!processData || typeof processData !== "object") {
        logger.debug("ensure-charm", () => [
          `No process data found at ${currentCell.getAsNormalizedFullLink().id}`,
        ]);
        return false;
      }

      const recipeId = (processData as Record<string, unknown>)[TYPE];
      const resultRef = (processData as Record<string, unknown>).resultRef;

      if (!recipeId) {
        logger.debug("ensure-charm", () => [
          `No recipe ID (TYPE) found in process cell`,
        ]);
        return false;
      }

      if (!resultRef) {
        logger.debug("ensure-charm", () => [
          `No resultRef found in process cell`,
        ]);
        return false;
      }

      // resultRef should be a link to the result cell
      // Parse it and get the result cell
      const resultLink = parseLink(resultRef, currentCell);
      if (!resultLink) {
        logger.debug("ensure-charm", () => [
          `Invalid resultRef: ${resultRef}`,
        ]);
        return false;
      }

      const resultCell = runtime.getCellFromLink(resultLink, undefined, tx);

      // Commit the read transaction before starting the charm
      await tx.commit();

      // Load the recipe
      const recipe = await runtime.recipeManager.loadRecipe(
        recipeId as string,
        cellLink.space,
      );

      if (!recipe) {
        logger.debug("ensure-charm", () => [
          `Failed to load recipe: ${recipeId}`,
        ]);
        return false;
      }

      logger.debug("ensure-charm", () => [
        `Starting charm with recipe ${recipeId} for result cell ${resultCell.getAsNormalizedFullLink().id}`,
      ]);

      // Start the charm - this will register event handlers
      await runtime.runSynced(resultCell, recipe);

      logger.debug("ensure-charm", () => [
        `Charm started successfully`,
      ]);

      return true;
    } catch (error) {
      // Make sure to commit/rollback the transaction on error
      try {
        await tx.commit();
      } catch {
        // Ignore commit errors on cleanup
      }
      throw error;
    }
  } catch (error) {
    logger.error("ensure-charm", "Error ensuring charm is running:", error);
    return false;
  }
}
