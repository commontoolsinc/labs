/**
 * Home space schemas package.
 *
 * Contains schema definitions for home space data structures:
 * - Favorites: user's favorited charms
 * - Journal: user's activity log
 *
 * This package exists to break the circular dependency between
 * @commontools/runner and @commontools/charm. Both packages can
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

export const objectStubSchema = {
  type: "object",
  properties: {},
} as const satisfies JSONSchema;
export type ObjectStub = Schema<typeof objectStubSchema>;

export { type Home, homeSchema } from "./home.ts";
