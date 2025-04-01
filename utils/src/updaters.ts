import { Cell, getCell, storage } from "@commontools/runner";
import { JSONSchema, Schema } from "@commontools/builder";

// This is the derived space id for toolshed-system
export const BG_SYSTEM_SPACE_ID =
  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88";
export const BG_CELL_CAUSE = "bgUpdater-2025-03-18";

export const CharmEntrySchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    charmId: { type: "string" },
    integration: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    disabledAt: { type: "number", default: 0 },
    lastRun: { type: "number", default: 0 },
    status: { type: "string", default: "" },
  },
  required: [
    "space",
    "charmId",
    "integration",
    "createdAt",
    "updatedAt",
    "lastRun",
    "status",
  ],
} as const satisfies JSONSchema;
export type BGCharmEntry = Schema<typeof CharmEntrySchema>;

export const bgUpdaterCharmsSchema = {
  type: "array",
  items: CharmEntrySchema,
  default: [],
} as const satisfies JSONSchema;

export type BGUpdaterCharmsSchema = Schema<typeof bgUpdaterCharmsSchema>;

export async function addOrUpdateBGCharm({
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
  const existingCharm = charms.find(
    (charm: Cell<BGCharmEntry>) =>
      charm.get().space === space && charm.get().charmId === charmId,
  );

  if (!existingCharm) {
    console.log("Adding charm to BGUpdater charms cell");
    const newBG = getCell(BG_SYSTEM_SPACE_ID, undefined, CharmEntrySchema);
    newBG.set({
      space,
      charmId,
      integration,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      disabledAt: undefined,
      lastRun: 0,
      status: "created",
    });
    charmsCell.push(newBG);

    // Ensure changes are synced
    await storage.synced();
    return true;
  } else {
    console.log("Charm already exists in BGUpdater charms cell, re-enabling");
    existingCharm.update({
      disabledAt: 0,
      updatedAt: Date.now(),
      status: "re-added",
    });

    await storage.synced();

    console.log("Charms cell", JSON.stringify(charmsCell.get(), null, 2));
    return false;
  }
}

export async function getBGUpdaterCharmsCell(): Promise<
  Cell<Cell<BGCharmEntry>[]>
> {
  if (!storage.hasSigner()) {
    throw new Error("Storage has no signer");
  }

  if (!storage.hasRemoteStorage()) {
    throw new Error("Storage has no remote storage");
  }
  const schema = {
    type: "array",
    items: {
      ...CharmEntrySchema,
      asCell: true,
    },
    default: [],
  } as const satisfies JSONSchema;

  const charmsCell = getCell(BG_SYSTEM_SPACE_ID, BG_CELL_CAUSE, schema);

  // Ensure the cell is synced
  // FIXME(ja): does True do the right thing here? Does this mean: I REALLY REALLY
  // INSIST THAT YOU HAVE THIS CELL ON THE SERVER!
  await storage.syncCell(charmsCell, true);
  await storage.synced();

  return charmsCell;
}
