import { Cell, getCell, storage } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import { Identity } from "@commontools/identity";

// This is the derived space id for toolshed-system
export const SYSTEM_SPACE_ID =
  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88";
export const CELL_CAUSE = "gmail-integration-2025-03-17";

// Define schema for the cell with correct type literals
export const gmailIntegrationCharmsSchema = {
  type: "object" as const,
  properties: {
    charms: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          space: { type: "string" as const },
          charmId: { type: "string" as const },
        },
        required: ["space", "charmId"],
      },
      default: [],
    },
  },
  required: ["charms"],
};

export interface CharmEntry {
  space: string;
  charmId: string;
}

/**
 * Initialize the Gmail integration charms cell
 */
export async function initializeGmailIntegrationCharmsCell(): Promise<boolean> {
  await ensureSigner();

  const charmsCell = getCell(
    SYSTEM_SPACE_ID,
    CELL_CAUSE,
    gmailIntegrationCharmsSchema,
  );

  // Ensure the cell is synced
  storage.syncCell(charmsCell, true);
  await storage.synced();

  const cellData = charmsCell.get();
  const cellExists = cellData?.charms.length > 0;
  console.log("existingData", cellExists);
  console.log("cell id", charmsCell.entityId);

  if (cellExists) {
    console.log("Cell already exists, skipping initialization");
    return false; // Already initialized
  }

  console.log("Initializing cell");
  charmsCell.set({ charms: [] });
  await storage.synced();
  return true; // Initialized
}

/**
 * Add a charm to the Gmail integration charms cell
 */
export async function addCharmToGmailIntegrations(
  space: string,
  charmId: string,
): Promise<boolean> {
  await ensureSigner();

  const charmsCell = getCell(
    SYSTEM_SPACE_ID,
    CELL_CAUSE,
    gmailIntegrationCharmsSchema,
  );

  // Ensure the cell is synced
  storage.syncCell(charmsCell, true);
  await storage.synced();

  console.log("###########");
  console.log("charmsCell", charmsCell.entityId);
  console.log("###########");

  // Get current charms data
  const charmsData = charmsCell.get() || { charms: [] };

  // Check if this charm is already in the list to avoid duplicates
  const exists = charmsData.charms.some(
    (charm: CharmEntry) => charm.space === space && charm.charmId === charmId,
  );

  if (!exists) {
    // Add the new charm to the list
    charmsData.charms.push({ space, charmId });

    // Update the cell
    charmsCell.set(charmsData);

    // Ensure changes are synced
    await storage.synced();
    return true; // Added
  }

  return false; // Already exists
}

/**
 * Get the Gmail integration charms cell
 */
export async function getGmailIntegrationCharmsCell(): Promise<
  Cell<CharmEntry[]>
> {
  await ensureSigner();

  const charmsCell = getCell(
    SYSTEM_SPACE_ID,
    CELL_CAUSE,
    gmailIntegrationCharmsSchema,
  );

  // Ensure the cell is synced
  storage.syncCell(charmsCell, true);
  await storage.synced();

  return charmsCell;
}

/**
 * Ensure we have a signer
 */
async function ensureSigner() {
  try {
    // Just attempt to set a new signer
    const signer = await Identity.fromPassphrase("implicit trust");
    storage.setSigner(signer);
  } catch (error) {
    // If there's already a signer this might fail, which is fine
    console.log("Error setting signer, might already be set:", error);
  }
}
