import { getLogger } from "@commontools/utils/logger";
import { TYPE } from "./builder/types.ts";
import type { Cell } from "./cell.ts";
import { type NormalizedFullLink, parseLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";

const logger = getLogger("ensure-piece-running", {
  enabled: false,
  level: "debug",
});

/**
 * Ensures the piece responsible for a given storage location is running.
 *
 * Note: We don't track which pieces we've already started because calling
 * runtime.runSynced() on an already-running piece is idempotent - it simply
 * returns without doing anything. This keeps the code simple and stateless.
 *
 * This function traverses the source cell chain to find the root process cell,
 * then starts the piece if it's not already running.
 *
 * The traversal logic:
 * 1. Start with the cell at the cellLink location
 * 2. While getSourceCell() returns something, follow it (this traverses
 *    through linked cells to find the process cell)
 * 3. Once there's no source cell, look at resultRef in the resulting document
 * 4. If resultRef is a link, that's the result cell - call runtime.runSynced()
 *    on it to start the piece
 *
 * @param runtime - The runtime instance
 * @param cellLink - The location that received an event or should be current
 * @returns Promise<boolean> - true if a piece was started, false otherwise
 */
export async function ensurePieceRunning(
  runtime: Runtime,
  cellLink: NormalizedFullLink,
): Promise<boolean> {
  try {
    const tx = runtime.edit();
    tx.tx.immediate = true;

    try {
      // Get the cell at the event link location
      let currentCell: Cell<any> | undefined = runtime.getCellFromLink(
        // We'll find the piece information at the root of what could be the
        // process cell already, hence remove the path:
        { ...cellLink, path: [] },
        undefined,
        tx,
      );

      // Traverse up the source cell chain
      // This follows links from derived cells back to the process cell
      let sourceCell = currentCell.getSourceCell();
      while (sourceCell) {
        logger.debug("ensure-piece", () => [
          `Following source cell from ${currentCell?.getAsNormalizedFullLink().id} to ${sourceCell?.getAsNormalizedFullLink().id}`,
        ]);
        currentCell = sourceCell;
        sourceCell = currentCell.getSourceCell();
      }

      // currentCell is now the process cell (or the original cell if no sources)
      // Check if it has a resultRef and a TYPE (indicating it's a process cell)
      const processData = currentCell.getRaw();

      if (!processData || typeof processData !== "object") {
        logger.debug("ensure-piece", () => [
          `No process data found at ${currentCell.getAsNormalizedFullLink().id}`,
        ]);
        return false;
      }

      const recipeId = (processData as Record<string, unknown>)[TYPE];
      const resultRef = (processData as Record<string, unknown>).resultRef;

      if (!recipeId) {
        logger.debug("ensure-piece", () => [
          `No recipe ID (TYPE) found in process cell`,
        ]);
        return false;
      }

      if (!resultRef) {
        logger.debug("ensure-piece", () => [
          `No resultRef found in process cell`,
        ]);
        return false;
      }

      // resultRef should be a link to the result cell
      // Parse it and get the result cell
      const resultLink = parseLink(resultRef, currentCell);
      if (!resultLink) {
        logger.debug("ensure-piece", () => [
          `Invalid resultRef: ${resultRef}`,
        ]);
        return false;
      }

      const resultCell = runtime.getCellFromLink(resultLink, undefined, tx);

      // Commit the read transaction before starting the piece
      await tx.commit();

      // Load the recipe
      const recipe = await runtime.recipeManager.loadRecipe(
        recipeId as string,
        cellLink.space,
      );

      if (!recipe) {
        logger.debug("ensure-piece", () => [
          `Failed to load recipe: ${recipeId}`,
        ]);
        return false;
      }

      logger.debug("ensure-piece", () => [
        `Starting piece with recipe ${recipeId} for result cell ${resultCell.getAsNormalizedFullLink().id}`,
      ]);

      // Start the piece - this will register event handlers
      await runtime.runSynced(resultCell, recipe);

      logger.debug("ensure-piece", () => [
        `Piece started successfully`,
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
    logger.error("ensure-piece", "Error ensuring piece is running:", error);
    return false;
  }
}
