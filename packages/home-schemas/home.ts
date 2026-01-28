import { favoriteEntrySchema, favoriteListSchema } from "./favorites.ts";
import { journalEntrySchema, journalSchema } from "./journal.ts";
import { learnedSectionSchema } from "./learned.ts";
import type { JSONSchema } from "@commontools/api";
import type { Schema } from "@commontools/api/schema";

export const homeSchema = {
  type: "object",
  properties: {
    favorites: favoriteListSchema,
    journal: journalSchema,
    learned: learnedSectionSchema,
    addFavorite: { ...favoriteEntrySchema, asStream: true },
    removeFavorite: { ...favoriteEntrySchema, asStream: true },
    addJournalEntry: { ...journalEntrySchema, asStream: true },
  },
} as const satisfies JSONSchema;

export type Home = Schema<typeof homeSchema>;
