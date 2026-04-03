import { type Cell, type Runtime } from "@commontools/runner";
import {
  type FavoriteList,
  favoriteListSchema,
} from "@commontools/home-schemas";
import { addJournalEntry } from "./journal.ts";

/**
 * Get cell description (schema as string) for tag-based search.
 * Uses asSchemaFromLinks() to resolve schema through links and pattern resultSchema.
 * Returns empty string if no schema available (won't match searches).
 */
function getCellDescription(cell: Cell<unknown>): string {
  try {
    const { schema } = cell.asSchemaFromLinks().getAsNormalizedFullLink();
    if (schema !== undefined) {
      return JSON.stringify(schema);
    }
  } catch (e) {
    console.error("Failed to get cell schema for favorite tag:", e);
  }
  return "";
}

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
 * Add a piece to the user's favorites (in home space).
 *
 * Syncs the piece before computing the tag to ensure schema is available.
 * wish.ts has a fallback for computing tags lazily if needed.
 */
export async function addFavorite(
  runtime: Runtime,
  piece: Cell<unknown>,
): Promise<void> {
  const favorites = getHomeFavorites(runtime);
  await favorites.sync();

  const resolvedPiece = piece.resolveAsCell();

  // Sync to ensure schema is available for tag computation
  await resolvedPiece.sync();

  const tag = getCellDescription(piece);

  let wasAdded = false;
  await runtime.editWithRetry((tx) => {
    const favoritesWithTx = favorites.withTx(tx);
    const current = favoritesWithTx.get() || [];

    // Check if already favorited
    if (
      current.some((entry) => entry.cell.resolveAsCell().equals(resolvedPiece))
    ) return;

    favoritesWithTx.push({ cell: piece, tag });
    wasAdded = true;
  });

  await runtime.idle();

  // Add journal entry if we actually favorited
  if (wasAdded) {
    try {
      await addJournalEntry(
        runtime,
        "piece:favorited",
        piece,
        runtime.userIdentityDID,
      );
    } catch (err) {
      console.error("Failed to add journal entry:", err);
    }
  }
}

/**
 * Remove a piece from the user's favorites (in home space)
 * @returns true if the piece was removed, false if it wasn't in favorites or tx failed
 */
export async function removeFavorite(
  runtime: Runtime,
  piece: Cell<unknown>,
): Promise<boolean> {
  const favorites = getHomeFavorites(runtime);
  await favorites.sync();

  let removed = false;
  const result = await runtime.editWithRetry((tx) => {
    const favoritesWithTx = favorites.withTx(tx);
    const filtered = filterOutCell(favoritesWithTx, piece);
    if (filtered.length !== favoritesWithTx.get().length) {
      favoritesWithTx.set(filtered);
      removed = true;
    }
  });

  const wasRemoved = result.ok !== undefined && removed;

  // Add journal entry if we actually unfavorited
  if (wasRemoved) {
    try {
      await addJournalEntry(
        runtime,
        "piece:unfavorited",
        piece,
        runtime.userIdentityDID,
      );
    } catch (err) {
      console.error("Failed to add journal entry:", err);
    }
  }

  return wasRemoved;
}

/**
 * Check if a piece is in the user's favorites (in home space)
 */
export function isFavorite(runtime: Runtime, piece: Cell<unknown>): boolean {
  try {
    const resolvedPiece = piece.resolveAsCell();
    const favorites = getHomeFavorites(runtime);
    const cached = favorites.get();
    return cached?.some((entry) =>
      entry.cell.resolveAsCell().equals(resolvedPiece)
    ) ?? false;
  } catch (_error) {
    // If we can't access the home space (e.g., authorization error),
    // assume the piece is not favorited rather than throwing
    return false;
  }
}
