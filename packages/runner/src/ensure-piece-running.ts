import { getLogger } from "@commonfabric/utils/logger";
import { isRecord } from "@commonfabric/utils/types";
import type { Cell } from "./cell.ts";
import { getMetaLink, type NormalizedFullLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Read a result cell's `{ identity, symbol }` pattern pointer. Inlined (rather
 * than imported from runner.ts) to avoid a module-init cycle:
 * built-in → scheduler/events → ensure-piece-running → runner → built-in.
 */
function readPatternIdentity(
  cell: Cell<unknown>,
): { identity: string; symbol: string } | undefined {
  const raw = cell.getMetaRaw("patternIdentity");
  if (
    isRecord(raw) && typeof raw.identity === "string" &&
    typeof raw.symbol === "string"
  ) {
    return { identity: raw.identity, symbol: raw.symbol };
  }
  return undefined;
}

const logger = getLogger("ensure-piece-running", {
  enabled: false,
  level: "debug",
});

const MAX_RESULT_LINK_DEPTH = 10;

function cellTraversalKey(cell: Cell<any>): string {
  const { space, id, path } = cell.getAsNormalizedFullLink();
  return JSON.stringify([space, id, path]);
}

async function followResultCellChain(
  runtime: Runtime,
  rootCell: Cell<any>,
  tx: IExtendedStorageTransaction,
): Promise<Cell<any> | undefined> {
  let currentCell = rootCell;
  const visited = new Set<string>();
  let depth = 0;

  while (true) {
    const key = cellTraversalKey(currentCell);
    if (visited.has(key)) {
      logger.debug("ensure-piece", () => [
        `Cycle found while following result metadata at ${currentCell.getAsNormalizedFullLink().id}`,
      ]);
      return undefined;
    }
    visited.add(key);

    await currentCell.sync();
    const resultLink = getMetaLink(currentCell, "result");
    if (resultLink === undefined) return currentCell;

    if (depth >= MAX_RESULT_LINK_DEPTH) {
      logger.debug("ensure-piece", () => [
        `Exceeded result metadata traversal depth from ${rootCell.getAsNormalizedFullLink().id}`,
      ]);
      return undefined;
    }

    currentCell = runtime.getCellFromLink(resultLink, undefined, tx);
    depth++;
  }
}

/**
 * Ensures the piece responsible for a given storage location is running.
 *
 * Note: We don't track which pieces we've already started because calling
 * runtime.runSynced() on an already-running piece is idempotent - it simply
 * returns without doing anything. This keeps the code simple and stateless.
 *
 * This function follows result metadata from argument or derived internal cells
 * back to the root result cell, then starts the piece if it's not already
 * running.
 *
 * The traversal logic:
 * 1. Start with the cell at the cellLink location
 * 2. Follow result metadata until it reaches the owning result cell
 * 3. Read the owning result cell's pattern metadata
 * 4. Start the existing owning result cell
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
        // owning result cell already, hence remove the path:
        { ...cellLink, path: [] },
        undefined,
        tx,
      );

      // If this is an internal/argument/derived cell, find the result cell that
      // owns the chain.
      const resultCell = await followResultCellChain(runtime, rootCell, tx);
      if (resultCell === undefined) return false;

      // If rootCell is a result cell, it will carry a `{ identity, symbol }`
      // pattern pointer.
      await resultCell.sync();
      const identityRef = readPatternIdentity(resultCell);
      if (!identityRef) {
        logger.debug("ensure-piece", () => [
          `No pattern identity found in result metadata`,
        ]);
        return false;
      }

      // Commit the read transaction before starting the piece
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      // Load the pattern by its content identity.
      const pattern = await runtime.patternManager.loadPatternByIdentity(
        identityRef.identity,
        identityRef.symbol,
        cellLink.space,
      );

      if (!pattern) {
        logger.debug("ensure-piece", () => [
          `Failed to load pattern: ${identityRef.identity}#${identityRef.symbol}`,
        ]);
        return false;
      }

      logger.debug("ensure-piece", () => [
        `Starting piece with pattern ${identityRef.identity} for result cell ${resultCell.getAsNormalizedFullLink().id}`,
      ]);

      // Start the existing piece - this registers event handlers without
      // re-running setup and potentially allocating different metadata cells.
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
