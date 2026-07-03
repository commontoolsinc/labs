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
    userTags: { type: "array", items: { type: "string" }, default: [] },
    spaceName: { type: "string" },
    // Stable key derived from the favorited piece's address (see favoriteKey).
    // The favorite entity is addressed by this key, so a re-favorite dedups and
    // an unfavorite removes by identity without reading the whole list.
    id: { type: "string" },
  },
  required: ["cell"],
} as const satisfies JSONSchema;

export type FavoriteEntry = Schema<typeof favoriteEntrySchema>;

export const favoriteListSchema = {
  type: "array",
  items: favoriteEntrySchema,
} as const satisfies JSONSchema;

export type FavoriteList = Schema<typeof favoriteListSchema>;

/**
 * The key a favorite is addressed by: the favorited piece's address — its
 * space, entity id, and value path. Computed by the caller that adds or removes
 * the favorite (which holds the piece's address as strings) and stored on the
 * entry as `id`, so the home handlers reach the same favorite entity with
 * `favorites.elementById(id)`. Pattern code cannot introspect a cell's link, so
 * the key is derived here and passed in as event data rather than recomputed in
 * the handler.
 */
export function favoriteKey(
  ref: { space: string; id: string; path?: readonly unknown[] },
): string {
  return JSON.stringify([ref.space, ref.id, ref.path ?? []]);
}
