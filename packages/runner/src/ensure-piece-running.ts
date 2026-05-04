import { getLogger } from "@commonfabric/utils/logger";
import type { Cell } from "./cell.ts";
import { getMetaLink, type NormalizedFullLink } from "./link-utils.ts";
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
      const rootCell: Cell<any> = runtime.getCellFromLink(
        // We'll find the piece information at the root of what could be the
        // process cell already, hence remove the path:
        { ...cellLink, path: [] },
        undefined,
        tx,
      );

      // If this is an internal/argument cell, get the result cell instead
      const resultLink = getMetaLink(rootCell, "result");
      // If we have a link, use that; otherwise use the rootCell
      const resultCell = (resultLink !== undefined)
        ? runtime.getCellFromLink(resultLink)
        : rootCell;

      // If rootCell is a result cell, it will have a patter
      const patternId = getMetaLink(resultCell, "pattern")?.id;
      if (!patternId) {
        logger.debug("ensure-piece", () => [
          `No pattern ID (pattern) found in process cell`,
        ]);
        return false;
      }

      // Commit the read transaction before starting the piece
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      // Load the pattern from the persisted spell reference.
      const pattern = await runtime.patternManager.loadPattern(
        patternId,
        cellLink.space,
      );

      if (!pattern) {
        logger.debug("ensure-piece", () => [
          `Failed to load pattern: ${patternId}`,
        ]);
        return false;
      }

      logger.debug("ensure-piece", () => [
        `Starting piece with pattern ${patternId} for result cell ${resultCell.getAsNormalizedFullLink().id}`,
      ]);

      // Start the existing piece - this registers event handlers without
      // re-running setup and potentially allocating a different process cell.
      await runtime.start(resultCell);

      logger.debug("ensure-piece", () => [
        `Piece started successfully`,
      ]);

      return true;
    } catch (error) {
      // Make sure to commit/rollback the transaction on error
      try {
        runtime.prepareTxForCommit(tx);
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
