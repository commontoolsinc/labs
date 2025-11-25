import {
  type Cell,
  EntityId,
  getEntityId,
  type IRuntime,
  spaceCellSchema,
} from "@commontools/runner";
import { charmListSchema, isSameEntity } from "./manager.ts";

/**
 * Filters an array of charms by removing any that match the target entity
 */
function filterOutEntity(
  list: Cell<Cell<unknown>[]>,
  target: Cell<unknown> | string | EntityId,
): Cell<unknown>[] {
  const targetId = getEntityId(target);
  if (!targetId) return list.get() as Cell<unknown>[];
  return list.get().filter((charm) => !isSameEntity(charm, targetId));
}

/**
 * Get the favorites cell from the home space (singleton across all spaces).
 * See docs/common/HOME_SPACE.md for more details.
 */
export function getHomeFavorites(runtime: IRuntime): Cell<Cell<unknown>[]> {
  const homeSpace = runtime.userIdentityDID;
  if (!homeSpace) {
    throw new Error(
      "User identity DID not available - cannot access favorites",
    );
  }
  const homeSpaceCell = runtime.getCell(
    homeSpace,
    homeSpace,
    spaceCellSchema,
  );
  return homeSpaceCell.key("favorites").asSchema(charmListSchema);
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
    if (current.some((c) => isSameEntity(c, id))) return;

    favoritesWithTx.push(charm);
  });

  await runtime.idle();
}

/**
 * Remove a charm from the user's favorites (in home space)
 * @returns true if the charm was removed, false if it wasn't in favorites
 */
export async function removeFavorite(
  runtime: IRuntime,
  charm: Cell<unknown> | EntityId,
): Promise<boolean> {
  const id = getEntityId(charm);
  if (!id) return false;

  const favorites = getHomeFavorites(runtime);
  await favorites.sync();

  let removed = false;
  await runtime.editWithRetry((tx) => {
    const favoritesWithTx = favorites.withTx(tx);
    const filtered = filterOutEntity(favoritesWithTx, id);
    if (filtered.length !== favoritesWithTx.get().length) {
      favoritesWithTx.set(filtered);
      removed = true;
    }
  });

  return removed;
}

/**
 * Check if a charm is in the user's favorites (in home space)
 */
export function isFavorite(
  runtime: IRuntime,
  charm: Cell<unknown> | EntityId,
): boolean {
  const id = getEntityId(charm);
  if (!id) return false;

  try {
    const favorites = getHomeFavorites(runtime);
    const cached = favorites.get();
    return cached?.some((c: Cell<unknown>) => isSameEntity(c, id)) ?? false;
  } catch (_error) {
    // If we can't access the home space (e.g., authorization error),
    // assume the charm is not favorited rather than throwing
    return false;
  }
}
