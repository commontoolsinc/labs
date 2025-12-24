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

export {
  favoriteEntrySchema,
  type FavoriteEntry,
  favoriteListSchema,
  type FavoriteList,
} from "./favorites.ts";

export {
  journalEventTypes,
  type JournalEventType,
  journalSnapshotSchema,
  type JournalSnapshot,
  journalEntrySchema,
  type JournalEntry,
  journalSchema,
  type Journal,
} from "./journal.ts";
