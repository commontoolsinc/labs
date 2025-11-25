import {
  type Cell,
  EntityId,
  getEntityId,
  type IRuntime,
  spaceCellSchema,
} from "@commontools/runner";
import { charmListSchema } from "./manager.ts";

/**
 * Helper to consistently compare entity IDs between cells
 */
function isSameEntity(
  a: Cell<unknown> | string | EntityId,
  b: Cell<unknown> | string | EntityId,
): boolean {
  const idA = getEntityId(a);
  const idB = getEntityId(b);
  return idA && idB ? idA["/"] === idB["/"] : false;
}

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
 * Manages user favorites stored in the home space.
 * Favorites are a singleton list per user that persists across all spaces.
 * See docs/common/HOME_SPACE.md for more details.
 */
export class Favorites {
  constructor(private runtime: IRuntime) {}

  /**
   * Get the favorites cell from the home space (singleton across all spaces)
   */
  private getHomeFavorites(): Cell<Cell<unknown>[]> {
    const homeSpace = this.runtime.userIdentityDID;
    if (!homeSpace) {
      throw new Error(
        "User identity DID not available - cannot access favorites",
      );
    }
    const homeSpaceCell = this.runtime.getCell(
      homeSpace,
      homeSpace,
      spaceCellSchema,
    );
    return homeSpaceCell.key("favorites").asSchema(charmListSchema);
  }

  /**
   * Add a charm to the user's favorites (in home space)
   * @param charm - The charm to add to favorites
   */
  async addFavorite(charm: Cell<unknown>): Promise<void> {
    const favorites = this.getHomeFavorites();
    await favorites.sync();

    const id = getEntityId(charm);
    if (!id) return;

    await this.runtime.editWithRetry((tx) => {
      const favoritesWithTx = favorites.withTx(tx);
      const current = favoritesWithTx.get() || [];

      // Check if already favorited
      if (current.some((c) => isSameEntity(c, id))) return;

      favoritesWithTx.push(charm);
    });

    await this.runtime.idle();
  }

  /**
   * Remove a charm from the user's favorites (in home space)
   * @param charm - The charm or entity ID to remove from favorites
   * @returns true if the charm was removed, false if it wasn't in favorites
   */
  async removeFavorite(charm: Cell<unknown> | EntityId): Promise<boolean> {
    const id = getEntityId(charm);
    if (!id) return false;

    const favorites = this.getHomeFavorites();
    await favorites.sync();

    let removed = false;
    await this.runtime.editWithRetry((tx) => {
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
   * @param charm - The charm or entity ID to check
   * @returns true if the charm is favorited, false otherwise
   */
  isFavorite(charm: Cell<unknown> | EntityId): boolean {
    const id = getEntityId(charm);
    if (!id) return false;

    try {
      const favorites = this.getHomeFavorites();
      const cached = favorites.get();
      return cached?.some((c: Cell<unknown>) => isSameEntity(c, id)) ?? false;
    } catch (_error) {
      // If we can't access the home space (e.g., authorization error),
      // assume the charm is not favorited rather than throwing
      return false;
    }
  }

  /**
   * Get the favorites cell from the home space
   * @returns Cell containing the array of favorited charms
   */
  getFavorites(): Cell<Cell<unknown>[]> {
    return this.getHomeFavorites();
  }
}
