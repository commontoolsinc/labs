import { favoriteListSchema, favoriteEntrySchema } from './favorites.ts'
import { journalSchema } from './journal.ts'
import type { JSONSchema, Schema, Stream } from "@commontools/api";

export const homeSchema = {
  type: 'object',
  properties: {
    favorites: favoriteListSchema,
    journal: journalSchema,
    addFavorite: { ...favoriteEntrySchema, asStream: true },
    removeFavorite: { ...favoriteEntrySchema, asStream: true },
  }
} as const satisfies JSONSchema;

export type Home = Schema<typeof homeSchema>;
