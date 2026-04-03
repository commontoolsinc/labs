/**
 * Space entry schemas for home space data.
 * These define the structure of user's managed spaces list.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

export const spaceEntrySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    did: { type: "string" },
  },
  required: ["name"],
} as const satisfies JSONSchema;

export type SpaceEntry = Schema<typeof spaceEntrySchema>;

export const spacesListSchema = {
  type: "array",
  items: spaceEntrySchema,
  default: [],
} as const satisfies JSONSchema;

export type SpacesList = Schema<typeof spacesListSchema>;
