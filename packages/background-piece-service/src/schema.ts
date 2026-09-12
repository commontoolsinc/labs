/**
 * The registry of background pieces: where it lives, and the shape of each
 * entry in it.
 */

import { type JSONSchema, type Schema } from "@commonfabric/runner";

/**
 * The system space holding the registry: the space id derived for
 * `toolshed-system`.
 */
export const BG_SYSTEM_SPACE_ID =
  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88";

/**
 * Cause of the registry cell in the system space, the cell listing every
 * registered background piece. It resolves to the entity
 * `of:baedreiew6ioyvfnvp2bdvmgkkz64ffk6gssvgmibh7yaw43yqhtv2nq75a`.
 */
export const BG_CELL_CAUSE = "bgUpdater-2025-03-18";

/**
 * Schema of one registry entry: the piece, the space it lives in, the
 * integration that registered it, and its scheduling state.
 */
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

/** One registry entry, as `BGPieceEntrySchema` types it. */
export type BGPieceEntry = Schema<typeof BGPieceEntrySchema>;

/** Schema of the registry as a whole: a list of entries, empty by default. */
export const BGPieceEntriesSchema = {
  type: "array",
  items: BGPieceEntrySchema,
  default: [],
} as const satisfies JSONSchema;

/** The registry as a whole, as `BGPieceEntriesSchema` types it. */
export type BGPieceEntries = Schema<typeof BGPieceEntriesSchema>;
