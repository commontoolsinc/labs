/**
 * Favorites schemas for home space data.
 * These define the structure of user's favorited charms.
 */

import type { JSONSchema, Schema } from "@commontools/api";

export const favoriteEntrySchema = {
  type: "object",
  properties: {
    cell: { not: true, asCell: true },
    tag: { type: "string", default: "" },
    userTags: { type: "array", items: { type: "string" }, default: [] },
  },
  required: ["cell"],
} as const satisfies JSONSchema;

export type FavoriteEntry = Schema<typeof favoriteEntrySchema>;

export const favoriteListSchema = {
  type: "array",
  items: favoriteEntrySchema,
} as const satisfies JSONSchema;

export type FavoriteList = Schema<typeof favoriteListSchema>;
