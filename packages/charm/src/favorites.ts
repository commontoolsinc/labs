import { type Cell, isCell, type Runtime, TAGS } from "@commontools/runner";
import {
  type FavoriteList,
  favoriteListSchema,
} from "@commontools/runner/schemas";

/**
 * Filters an array of favorite entries by removing any that match the target cell
 */
function filterOutCell(
  list: Cell<FavoriteList>,
  target: Cell<unknown>,
): FavoriteList {
  const resolvedTarget = target.resolveAsCell();
  return list.get().filter((entry) =>
    !entry.cell.resolveAsCell().equals(resolvedTarget)
  );
}

/**
 * Get the favorites cell from the home space (singleton across all spaces).
 * See docs/common/HOME_SPACE.md for more details.
 */
export function getHomeFavorites(runtime: Runtime): Cell<FavoriteList> {
  return runtime.getHomeSpaceCell().key("favorites").asSchema(
    favoriteListSchema,
  );
}

/**
 * Validate tags and warn about invalid format.
 * Returns the array of valid tags (strings starting with '#').
 */
function validateTags(tags: unknown[]): string[] {
  const validTags: string[] = [];
  const invalidTags: unknown[] = [];

  for (const t of tags) {
    if (typeof t === "string" && t.startsWith("#")) {
      validTags.push(t);
    } else {
      invalidTags.push(t);
    }
  }

  if (invalidTags.length > 0) {
    console.warn(
      `[favorites] Charm [TAGS] contains invalid tag values: ${
        JSON.stringify(invalidTags)
      }. Tags must be strings starting with '#' (e.g., "#auth/google").`,
    );
  }

  return validTags;
}

/**
 * Add a charm to the user's favorites (in home space).
 *
 * If the charm exports [TAGS], stores a reference for tag-based searching.
 * Accepts both Cell<string[]> (reactive) and plain string[] (static).
 *
 * Tags are the ONLY way to make a favorite searchable by hashtag.
 * Patterns without [TAGS] will not match wish({ query: ... }) queries.
 */
export async function addFavorite(
  runtime: Runtime,
  charm: Cell<unknown>,
): Promise<void> {
  const favorites = getHomeFavorites(runtime);
  await favorites.sync();

  const resolvedCharm = charm.resolveAsCell();
  await resolvedCharm.sync();

  // Detect [TAGS] export - accepts Cell<string[]> or plain string[]
  let tagsCell: Cell<string[]> | undefined;
  try {
    const charmValue = resolvedCharm.get();
    if (charmValue && typeof charmValue === "object" && TAGS in charmValue) {
      const tagsValue = (charmValue as Record<string, unknown>)[TAGS];

      if (isCell(tagsValue)) {
        // Cell<string[]> - store reference directly (reactive)
        const currentTags = (tagsValue as Cell<unknown>).get();
        if (Array.isArray(currentTags)) {
          validateTags(currentTags);
        }
        tagsCell = tagsValue as Cell<string[]>;
      } else if (Array.isArray(tagsValue)) {
        // Plain string[] - validate and wrap in immutable Cell (static)
        const validTags = validateTags(tagsValue);
        if (validTags.length > 0) {
          tagsCell = runtime.getImmutableCell(
            resolvedCharm.space,
            validTags,
            undefined,
            undefined,
          );
        }
      } else if (tagsValue !== undefined) {
        // [TAGS] exists but isn't Cell or array - likely a pattern authoring mistake
        console.warn(
          `[favorites] Charm exports [TAGS] but value is not a Cell or array. ` +
            `Expected Cell<string[]> or string[], got ${typeof tagsValue}. ` +
            `Tags will not be available for this charm.`,
        );
      }
    }
  } catch {
    // Ignore errors detecting TAGS
  }

  await runtime.editWithRetry((tx) => {
    const favoritesWithTx = favorites.withTx(tx);
    const current = favoritesWithTx.get() || [];

    // Check if already favorited
    if (
      current.some((entry) => entry.cell.resolveAsCell().equals(resolvedCharm))
    ) return;

    // Build entry with optional tagsCell
    const entry: { cell: Cell<unknown>; tagsCell?: Cell<string[]> } = {
      cell: charm,
    };
    if (tagsCell) {
      entry.tagsCell = tagsCell;
    }

    favoritesWithTx.push(entry);
  });

  await runtime.idle();
}

/**
 * Remove a charm from the user's favorites (in home space)
 * @returns true if the charm was removed, false if it wasn't in favorites or tx failed
 */
export async function removeFavorite(
  runtime: Runtime,
  charm: Cell<unknown>,
): Promise<boolean> {
  const favorites = getHomeFavorites(runtime);
  await favorites.sync();

  let removed = false;
  const result = await runtime.editWithRetry((tx) => {
    const favoritesWithTx = favorites.withTx(tx);
    const filtered = filterOutCell(favoritesWithTx, charm);
    if (filtered.length !== favoritesWithTx.get().length) {
      favoritesWithTx.set(filtered);
      removed = true;
    }
  });

  // Only return true if tx succeeded and we actually removed something
  return result.ok !== undefined && removed;
}

/**
 * Check if a charm is in the user's favorites (in home space)
 */
export function isFavorite(runtime: Runtime, charm: Cell<unknown>): boolean {
  try {
    const resolvedCharm = charm.resolveAsCell();
    const favorites = getHomeFavorites(runtime);
    const cached = favorites.get();
    return cached?.some((entry) =>
      entry.cell.resolveAsCell().equals(resolvedCharm)
    ) ?? false;
  } catch (_error) {
    // If we can't access the home space (e.g., authorization error),
    // assume the charm is not favorited rather than throwing
    return false;
  }
}
