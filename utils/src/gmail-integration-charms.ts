import { Cell, getCell, storage } from "@commontools/runner";
import { JSONSchema, Schema } from "@commontools/builder";
import { Identity } from "@commontools/identity";
// This is the derived space id for toolshed-system
export const SYSTEM_SPACE_ID =
  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88";
export const CELL_CAUSE = "bgUpdater-2025-03-18";

export const CharmEntrySchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    charmId: { type: "string" },
    integration: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    enabled: { type: "boolean" },
    runs: { type: "number", default: 0 },
  },
  required: [
    "space",
    "charmId",
    "integration",
    "createdAt",
    "updatedAt",
    "enabled",
    "runs",
  ],
} as const satisfies JSONSchema;
type CharmEntry = Schema<typeof CharmEntrySchema>;

// Define schema for the cell with correct type literals
export const bgUpdaterCharmsSchema = {
  type: "object",
  properties: {
    charms: {
      type: "array",
      items: CharmEntrySchema,
      default: [],
    },
  },
  required: ["charms"],
} as const as JSONSchema;
type BGUpdaterCharmsSchema = Schema<typeof bgUpdaterCharmsSchema>;

/**
 * Add a charm to the Gmail integration charms cell
 */
export async function addCharmToBG({
  space,
  charmId,
  integration,
}: {
  space: string;
  charmId: string;
  integration: string;
}): Promise<boolean> {
  const charmsCell = await getBGUpdaterCharmsCell();

  console.log(
    "charmsCell",
    JSON.stringify(charmsCell.getAsCellLink(), null, 2),
  );

  // FIXME(ja): if we use IDs might might not need to do this?
  // Get current charms data
  const charms = charmsCell.get() || [];

  // Check if this charm is already in the list to avoid duplicates
  const exists = charms.some(
    (charm: CharmEntry) => charm.space === space && charm.charmId === charmId,
  );

  if (!exists) {
    console.log("Adding charm to BGUpdater charms cell");
    charmsCell.push({
      space,
      charmId,
      integration,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      enabled: true,
      runs: 0,
    });

    // Ensure changes are synced
    await storage.synced();
    return true;
  }

  console.log("Charm already exists in BGUpdater charms cell");
  return false;
}

/**
 * Get the BGUpdater charms cell
 */
export async function getBGUpdaterCharmsCell(): Promise<
  Cell<BGUpdaterCharmsSchema>
> {
  await ensureSigner();

  const charmsCell = getCell(
    SYSTEM_SPACE_ID,
    CELL_CAUSE,
    bgUpdaterCharmsSchema.properties.charms,
  );

  // Ensure the cell is synced
  await storage.syncCell(charmsCell, true);
  await storage.synced();

  return charmsCell;
}

/**
 * Ensure we have a signer
 */
async function ensureSigner() {
  try {
    // Just attempt to set a new signer
    // FIXME(ja): remove this !!!!!!!!!
    storage.setRemoteStorage(new URL("http://localhost:8000"));
    const signer = await Identity.fromPassphrase("implicit trust");
    storage.setSigner(signer);
  } catch (error) {
    // If there's already a signer this might fail, which is fine
    console.log("Error setting signer, might already be set:", error);
  }
}
