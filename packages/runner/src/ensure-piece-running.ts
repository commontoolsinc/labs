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

function followResultCellChain(
  runtime: Runtime,
  rootCell: Cell<any>,
  tx: IExtendedStorageTransaction,
  observedDocIds: string[],
): Cell<any> | undefined {
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
    const currentId = currentCell.getAsNormalizedFullLink().id;
    if (!observedDocIds.includes(currentId)) observedDocIds.push(currentId);

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
 * A classified `ensurePieceRunning` outcome (server-execution v2 stage
 * P2-F): the serving loop's demand cycle needs to tell a doc that is
 * LOADED but carries no pattern meta (the OW19 terminal class —
 * terminal-on-loaded-doc-without-pattern-meta, re-armed by a commit
 * touching an observed doc) from the other not-startable shapes, and
 * needs the resolved OWNING root so the per-(action × instance) run
 * supply can map a demanded argument/derived doc to its piece's actions.
 */
export type EnsurePieceVerdict = {
  /** The owning piece is (now) running. */
  started: boolean;
  /** Why a `started: false` verdict could not start the piece. */
  reason?:
    /** Result-metadata cycle, or traversal depth exceeded. */
    | "chain-cycle"
    /** The chain's owning doc carries no `patternIdentity` meta — as
     * OBSERVED LOCALLY: an un-synced doc reads the same way, so a
     * terminal decision must confirm durable state first (the caller
     * syncs and re-asks). */
    | "no-pattern-meta"
    /** Meta present but `loadPatternByIdentity` found nothing. */
    | "pattern-unloadable";
  /** The owning result doc's id (the chain terminus) where the chain
   * resolved — present for `started`, `no-pattern-meta`, and
   * `pattern-unloadable`. */
  rootId?: string;
  /** Every doc id the traversal read (the demanded root plus chain
   * links): the demand cycle's commit-triggered re-arm watches these. */
  observedDocIds: string[];
};

/**
 * Classified variant of {@link ensurePieceRunning} — same traversal and
 * start, richer outcome. `propagateErrors` RETHROWS instead of
 * collapsing every exception into a verdict (review thread
 * r3739139521): the serving loop's demand cycle must distinguish a
 * deferral from an actual load/start FAILURE; default stays
 * best-effort for the event-recovery caller.
 */
export async function ensurePieceRunningVerdict(
  runtime: Runtime,
  cellLink: NormalizedFullLink,
  options?: { propagateErrors?: boolean },
): Promise<EnsurePieceVerdict> {
  const observedDocIds: string[] = [];
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
      const resultCell = followResultCellChain(
        runtime,
        rootCell,
        tx,
        observedDocIds,
      );
      if (resultCell === undefined) {
        return { started: false, reason: "chain-cycle", observedDocIds };
      }
      const rootId = resultCell.getAsNormalizedFullLink().id;

      // If rootCell is a result cell, it will carry a `{ identity, symbol }`
      // pattern pointer.
      const identityRef = readPatternIdentity(resultCell);
      if (!identityRef) {
        logger.debug("ensure-piece", () => [
          `No pattern identity found in result metadata`,
        ]);
        return {
          started: false,
          reason: "no-pattern-meta",
          rootId,
          observedDocIds,
        };
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
        return {
          started: false,
          reason: "pattern-unloadable",
          rootId,
          observedDocIds,
        };
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

      return { started: true, rootId, observedDocIds };
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
    if (options?.propagateErrors === true) throw error;
    logger.error("ensure-piece", "Error ensuring piece is running:", error);
    return { started: false, observedDocIds };
  }
}

/**
 * Ensures the piece responsible for a given storage location is running.
 *
 * Note: We don't track which pieces we've already started because starting an
 * already-running piece is a no-op: this calls `runtime.start()`, which returns
 * as soon as it finds the piece already registered, without running setup. It
 * therefore neither re-materializes metadata nor re-validates the stored
 * argument — a piece whose `patternSetupIdentity` names another version is not
 * repaired through this route, only through one that reaches setup. This keeps
 * the code simple and stateless.
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
 * @param options - `propagateErrors` RETHROWS instead of collapsing every
 *   exception into `false` (review thread r3739139521): the serving loop's
 *   demand cycle must distinguish a creation-race DEFERRAL (`false` — retry
 *   next cycle) from an actual load/start FAILURE (throw — counted
 *   `structureLoadFailures`); with the collapse, its failure arm was
 *   unreachable and real errors retried silently every input-driven cycle.
 *   Default stays best-effort for the event-recovery caller.
 * @returns Promise<boolean> - true if a piece was started, false otherwise
 */
export async function ensurePieceRunning(
  runtime: Runtime,
  cellLink: NormalizedFullLink,
  options?: { propagateErrors?: boolean },
): Promise<boolean> {
  return (await ensurePieceRunningVerdict(runtime, cellLink, options)).started;
}
