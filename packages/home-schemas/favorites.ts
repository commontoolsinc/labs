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
    // Discovery tags snapshotted from the piece's schema when favorited
    // (lowercased, without the leading `#`). Matched by wish() tag search.
    tags: { type: "array", items: { type: "string" }, default: [] },
    // Display name snapshotted when favorited. Used as a fallback when the
    // linked piece cannot be resolved quickly in the home favorites tab.
    name: { type: "string" },
    userTags: { type: "array", items: { type: "string" }, default: [] },
    spaceName: { type: "string" },
  },
  required: ["cell"],
} as const satisfies JSONSchema;

export type FavoriteEntry = Schema<typeof favoriteEntrySchema>;

export const favoriteListSchema = {
  type: "array",
  items: favoriteEntrySchema,
} as const satisfies JSONSchema;

export type FavoriteList = Schema<typeof favoriteListSchema>;
