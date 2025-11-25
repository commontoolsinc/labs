import { type Cell, getEntityId, type IRuntime, type JSONSchema } from "@commontools/runner";
import { type FavoriteEntry, type FavoriteList, favoriteListSchema, isSameEntity } from "./manager.ts";

/**
 * Temporary helper to get cell description (schema as string).
 * TODO: Replace with getCellDescription from @commontools/runner once available.
 */
function getCellDescription(cell: Cell<unknown>): string {
  try {
    const schema = cell.schema;
    if (schema && typeof schema === "object" && Object.keys(schema).length > 0) {
      return JSON.stringify(schema);
    }
  } catch (_error) {
    // If we can't get the schema, return empty string
  }
  return "";
}

/**
 * Filters an array of favorite entries by removing any that match the target entity
 */
function filterOutEntity(
  list: Cell<FavoriteList>,
  target: Cell<unknown>,
): FavoriteList {
  const targetId = getEntityId(target);
  if (!targetId) return list.get() as FavoriteList;
  return list.get().filter((entry) => !isSameEntity(entry.cell, targetId));
}

/**
 * Get the favorites cell from the home space (singleton across all spaces).
 * See docs/common/HOME_SPACE.md for more details.
 */
export function getHomeFavorites(runtime: IRuntime): Cell<FavoriteList> {
  return runtime.getHomeSpaceCell().key("favorites").asSchema(favoriteListSchema);
}

/**
 * Add a charm to the user's favorites (in home space)
 */
export async function addFavorite(
  runtime: IRuntime,
  charm: Cell<unknown>,
): Promise<void> {
  const favorites = getHomeFavorites(runtime);
  await favorites.sync();

  const id = getEntityId(charm);
  if (!id) return;

  await runtime.editWithRetry((tx) => {
    const favoritesWithTx = favorites.withTx(tx);
    const current = favoritesWithTx.get() || [];

    // Check if already favorited
    if (current.some((entry) => isSameEntity(entry.cell, id))) return;

    // Get the schema tag for this cell
    const tag = getCellDescription(charm);

    favoritesWithTx.push({ cell: charm, tag });
  });

  await runtime.idle();
}

/**
 * Remove a charm from the user's favorites (in home space)
 * @returns true if the charm was removed, false if it wasn't in favorites or tx failed
 */
export async function removeFavorite(
  runtime: IRuntime,
  charm: Cell<unknown>,
): Promise<boolean> {
  const id = getEntityId(charm);
  if (!id) return false;

  const favorites = getHomeFavorites(runtime);
  await favorites.sync();

  let removed = false;
  const result = await runtime.editWithRetry((tx) => {
    const favoritesWithTx = favorites.withTx(tx);
    const filtered = filterOutEntity(favoritesWithTx, charm);
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
export function isFavorite(runtime: IRuntime, charm: Cell<unknown>): boolean {
  const id = getEntityId(charm);
  if (!id) return false;

  try {
    const favorites = getHomeFavorites(runtime);
    const cached = favorites.get();
    return cached?.some((entry) => isSameEntity(entry.cell, id)) ?? false;
  } catch (_error) {
    // If we can't access the home space (e.g., authorization error),
    // assume the charm is not favorited rather than throwing
    return false;
  }
}
