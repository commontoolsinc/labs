/**
 * Background-piece registry (write side).
 *
 * This used to live in `packages/background-piece-service`, which owned both
 * ends of it: toolshed wrote registrations here and the service's polling loop
 * read them back to decide which pieces to run. That service has been sunset
 * (owner ruling D12 — it was "a runtime that runs pieces on the server by
 * pretending to be a client"), so the read side is gone and the write side
 * moved here to keep its two callers building.
 *
 * **Nothing in this repository reads this registry today.** It is retained
 * rather than deleted for two reasons:
 *
 *  1. `POST /api/integrations/bg` is a public HTTP surface with a live caller —
 *     the `<cf-updater>` component in `packages/ui`. Turning the write into a
 *     no-op would leave that button reporting "Successfully Registered!" while
 *     registering nothing.
 *  2. The registry is the only record of which pieces have asked for
 *     background execution, and that set is not derivable from this repo — it
 *     is created as a side effect of users connecting accounts. A replacement
 *     standing-registration mechanism will need it.
 *
 * Note that removing the service did not remove its data: registrations
 * written before the sunset are still present in durable storage, alongside
 * the `lastRun`/`status`/`disabledAt` fields the service used to write back.
 * Those three fields are now only ever read, never updated.
 */
import {
  type Cell,
  type JSONSchema,
  type MemorySpace,
  type Runtime,
  type Schema,
} from "@commonfabric/runner";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("bg-registry");

// This is the derived space id for toolshed-system
export const BG_SYSTEM_SPACE_ID =
  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88";
// This maps to of:baedreiew6ioyvfnvp2bdvmgkkz64ffk6gssvgmibh7yaw43yqhtv2nq75a
export const BG_CELL_CAUSE = "bgUpdater-2025-03-18";

export const BGPieceEntrySchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    pieceId: { type: "string" },
    integration: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    disabledAt: { type: "number", default: 0 },
    lastRun: { type: "number", default: 0 },
    status: { type: "string", default: "" },
  },
  required: [
    "space",
    "pieceId",
    "integration",
    "createdAt",
    "updatedAt",
    "lastRun",
    "status",
  ],
} as const satisfies JSONSchema;

export type BGPieceEntry = Schema<typeof BGPieceEntrySchema>;

/**
 * Record a piece's interest in background updates.
 *
 * Returns `true` if a new entry was appended, `false` if an existing entry for
 * the same `space`/`pieceId` was re-enabled instead.
 */
export async function setBGPiece({
  space,
  pieceId,
  integration,
  runtime,
  bgSpace,
  bgCause,
}: {
  space: string;
  pieceId: string;
  integration: string;
  runtime: Runtime;
  bgSpace?: MemorySpace;
  bgCause?: string;
}): Promise<boolean> {
  logger.info("setBGPiece called", { space, pieceId, integration });

  const piecesCell = await getBGPieces({ bgSpace, bgCause, runtime });

  const pieces = piecesCell.get() || [];

  const existingPieceIndex = pieces.findIndex(
    (piece: Cell<BGPieceEntry>) =>
      piece.get().space === space && piece.get().pieceId === pieceId,
  );

  if (existingPieceIndex === -1) {
    logger.info("Adding piece to BGUpdater pieces cell");
    runtime.editWithRetry((tx) => {
      // The `[ID]` write directive was retired upstream (#5242): element
      // identity now comes from the frame anchoring `push` already applies.
      // Duplicate registration is prevented by the index lookup above, which
      // is what this entry's identity was ever load-bearing for.
      piecesCell.withTx(tx).push({
        space,
        pieceId,
        integration,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        disabledAt: undefined,
        lastRun: 0,
        status: "Initializing",
      } as unknown as Cell<BGPieceEntry>);
    });

    await runtime.storageManager.synced();
    return true;
  } else {
    logger.info("Piece already exists, re-enabling");
    const existingPiece = pieces[existingPieceIndex];
    runtime.editWithRetry((tx) => {
      existingPiece.withTx(tx).update({
        disabledAt: 0,
        updatedAt: Date.now(),
        status: "Re-initializing",
      });
    });
    await runtime.storageManager.synced();
    return false;
  }
}

export async function getBGPieces(
  { bgSpace, bgCause, runtime }: {
    bgSpace?: MemorySpace;
    bgCause?: string;
    runtime: Runtime;
  },
): Promise<Cell<Cell<BGPieceEntry>[]>> {
  bgSpace = bgSpace ?? BG_SYSTEM_SPACE_ID;
  bgCause = bgCause ?? BG_CELL_CAUSE;

  const schema = {
    type: "array",
    items: {
      ...BGPieceEntrySchema,
      asCell: ["cell"],
    },
    default: [],
  } as const satisfies JSONSchema;

  const piecesCell = runtime.getCell(bgSpace, bgCause, schema);

  // Ensure the cell is synced
  const privilegedSchema = {
    ...schema,
    ifc: { confidentiality: ["secret"] },
  } as const satisfies JSONSchema;
  await piecesCell.asSchema(privilegedSchema).sync();
  await runtime.storageManager.synced();

  return piecesCell;
}
