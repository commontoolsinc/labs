import { getLogger } from "@commonfabric/utils/logger";
import type { Cell } from "./cell.ts";
import { getMetaLink } from "./link-utils.ts";

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
  // Do the better sync that syncs all metadata cells recursively
  await syncMetaLinkedDocs(rootCell);
  // Now use the old path to walk the source field until we get to the end of the chain
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

// Recursively load the meta linked docs from the doc
async function syncMetaLinkedDocs(
  cell: Cell<any>,
  cycleCheck: Set<string> = new Set<string>(),
) {
  const pendingCells = [cell];
  cycleCheck.add(cell.sourceURI);
  while (pendingCells.length > 0) {
    const currentCell = pendingCells.shift()!;
    await currentCell.sync();
    for (const meta of ["pattern", "argument", "internal"] as const) {
      const link = getMetaLink(currentCell, meta);
      if (link === undefined) continue;
      const linkedCell = currentCell.runtime.getCellFromLink(link, undefined);
      if (linkedCell === undefined) continue;
      if (cycleCheck.has(linkedCell.sourceURI)) continue;
      cycleCheck.add(linkedCell.sourceURI);
      pendingCells.push(linkedCell);
    }
  }
}
