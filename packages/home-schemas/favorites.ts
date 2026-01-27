/**
 * Favorites schemas for home space data.
 * These define the structure of user's favorited charms.
 */

import type { JSONSchema } from "@commontools/api";
import type { Schema } from "@commontools/api/schema";

export const favoriteEntrySchema = {
  type: "object",
  properties: {
    // we use empty properties to validate, but avoid including children
    cell: { type: "object", properties: {}, asCell: true },
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
