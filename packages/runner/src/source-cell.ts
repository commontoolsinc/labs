import { getLogger } from "@commonfabric/utils/logger";
import type { Cell } from "./cell.ts";

const logger = getLogger("source-cell", {
  enabled: false,
  level: "debug",
});

/**
 * Sync a root cell and each source cell reachable from it.
 *
 * Callers that need a transactional root cell can create it first and pass it.
 * Returns the last followed source cell, or undefined if the root has no source.
 */
export async function syncSourceCellChain(
  rootCell: Cell<unknown>,
): Promise<Cell<unknown> | undefined> {
  await rootCell.sync();

  let currentCell = rootCell;
  let lastSourceCell: Cell<unknown> | undefined;
  let sourceCell = currentCell.getSourceCell();
  while (sourceCell) {
    const nextCell = sourceCell;
    await nextCell.sync();
    logger.debug("follow-source", () => [
      `Following source cell from ${currentCell.getAsNormalizedFullLink().id} to ${nextCell.getAsNormalizedFullLink().id}`,
    ]);
    lastSourceCell = nextCell;
    currentCell = nextCell;
    sourceCell = currentCell.getSourceCell();
  }

  return lastSourceCell;
}
