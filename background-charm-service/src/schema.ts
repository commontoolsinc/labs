import { type JSONSchema, type Schema } from "@commontools/builder";

// This is the derived space id for toolshed-system
export const BG_SYSTEM_SPACE_ID =
  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88";
export const BG_CELL_CAUSE = "bgUpdater-2025-03-18";
export const BGCharmEntrySchema = {
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
} as const as JSONSchema;
export type BGCharmEntry = Schema<typeof BGCharmEntrySchema>;

export const BGCharmEntriesSchema = {
  type: "array",
  items: BGCharmEntrySchema,
  default: [],
} as const satisfies JSONSchema;

export type BGCharmEntries = Schema<typeof BGCharmEntriesSchema>;
