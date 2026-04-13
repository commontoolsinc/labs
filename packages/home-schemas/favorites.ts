/**
 * Favorites schemas for home space data.
 * These define the structure of user's favorited pieces.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

export const favoriteEntrySchema = {
  type: "object",
  properties: {
    // we use type unknown to validate, but avoid including children
    cell: { type: "unknown", asCell: ["cell"] },
    tag: { type: "string", default: "" },
    userTags: { type: "array", items: { type: "string" }, default: [] },
    spaceName: { type: "string" },
    spaceDid: { type: "string" },
  },
  required: ["cell"],
} as const satisfies JSONSchema;

export type FavoriteEntry = Schema<typeof favoriteEntrySchema>;

export const favoriteListSchema = {
  type: "array",
  items: favoriteEntrySchema,
} as const satisfies JSONSchema;

export type FavoriteList = Schema<typeof favoriteListSchema>;
