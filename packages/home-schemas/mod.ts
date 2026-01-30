/**
 * Home space schemas package.
 *
 * Contains schema definitions for home space data structures:
 * - Favorites: user's favorited pieces
 * - Journal: user's activity log
 * - Learned: user's learned profile data
 *
 * This package exists to break the circular dependency between
 * @commontools/runner and @commontools/piece. Both packages can
 * safely import schemas from here.
 */

import { JSONSchema } from "@commontools/api";
import { Schema } from "@commontools/api/schema";

export {
  type FavoriteEntry,
  favoriteEntrySchema,
  type FavoriteList,
  favoriteListSchema,
} from "./favorites.ts";

export {
  type Journal,
  type JournalEntry,
  journalEntrySchema,
  type JournalEventType,
  journalEventTypes,
  journalSchema,
  type JournalSnapshot,
  journalSnapshotSchema,
} from "./journal.ts";

export {
  type Fact,
  factSchema,
  type LearnedSection,
  learnedSectionSchema,
  type Preference,
  preferenceSchema,
  type Question,
  questionSchema,
} from "./learned.ts";

export { type Home, homeSchema } from "./home.ts";

export const objectStubSchema = {
  type: "object",
  properties: {},
} as const satisfies JSONSchema;
export type ObjectStub = Schema<typeof objectStubSchema>;
