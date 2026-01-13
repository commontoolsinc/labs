/**
 * FavoritesManager - Client-side favorites management using cell primitives.
 *
 * This class provides favorites operations by directly accessing the home space's
 * defaultPattern through cell operations, without requiring specialized IPC messages.
 */

import { DID } from "@commontools/identity";
import { CellHandle, isCellHandle } from "./cell-handle.ts";
import { RuntimeClient } from "./runtime-client.ts";
import type { CellRef } from "./protocol/types.ts";

/** Favorite entry as returned by getFavorites and subscribeFavorites */
export type FavoriteEntry = {
  charmId: string;
  tag: string;
  userTags: string[];
};

/** Expected shape of the home pattern's exported properties */
type HomePatternExports = {
  favorites: unknown[];
  addFavorite: unknown;
  removeFavorite: unknown;
};

type HandlerName = "addFavorite" | "removeFavorite";

export class FavoritesManager {
  #rt: RuntimeClient;
  #currentSpaceDID: DID;
  #homePatternCell: CellHandle<HomePatternExports> | null = null;

  constructor(
    rt: RuntimeClient,
    currentSpaceDID: DID,
  ) {
    this.#rt = rt;
    this.#currentSpaceDID = currentSpaceDID;
  }

  /**
   * Add a charm to favorites.
   * @param charmId - The entity ID of the charm to add
   * @param tag - Optional tag/category for the favorite
   */
  async addFavorite(charmId: string, tag?: string): Promise<void> {
    const handler = await this.#getHandler("addFavorite");
    const charmCellRef = this.#createCharmRef(charmId);
    await handler.send({ charm: charmCellRef, tag: tag || "" });
  }

  /**
   * Remove a charm from favorites.
   * @param charmId - The entity ID of the charm to remove
   */
  async removeFavorite(charmId: string): Promise<void> {
    const handler = await this.#getHandler("removeFavorite");
    const charmCellRef = this.#createCharmRef(charmId);
    await handler.send({ charm: charmCellRef });
  }

  /**
   * Check if a charm is in favorites.
   * @param charmId - The entity ID of the charm to check
   * @returns true if the charm is a favorite
   */
  async isFavorite(charmId: string): Promise<boolean> {
    const favorites = await this.getFavorites();
    return favorites.some((f) => f.charmId === charmId);
  }

  /**
   * Get all favorites.
   * @returns Array of favorite entries with charmId, tag, and userTags
   */
  async getFavorites(): Promise<FavoriteEntry[]> {
    const defaultPattern = await this.#getDefaultPattern();

    const favoritesCell = defaultPattern.key("favorites");
    await favoritesCell.sync();
    const favoritesValue = favoritesCell.get();

    return this.#transformFavoritesToEntriesAsync(favoritesValue);
  }

  /**
   * Subscribe to favorites changes.
   * Callback is called immediately with current favorites (may be empty if not ready),
   * and again whenever favorites change.
   * @param callback - Function called with current favorites array
   * @param onError - Optional callback for errors during subscription or transform
   * @returns Unsubscribe function
   */
  subscribeFavorites(
    callback: (favorites: FavoriteEntry[]) => void,
    onError?: (error: Error) => void,
  ): () => void {
    let unsubscribeFavorites: (() => void) | undefined;
    let isDisposed = false;

    const setupSubscription = async () => {
      if (isDisposed) return;

      // Use ensureHomePatternRunning to get the resolved, running pattern cell
      if (!this.#homePatternCell) {
        // Type boundary: ensureHomePatternRunning returns unknown, we cast to expected shape
        const cell = await this.#rt.ensureHomePatternRunning();
        this.#homePatternCell = cell as CellHandle<HomePatternExports>;
      }

      await this.#homePatternCell.sync();

      if (isDisposed) return;

      // Subscribe to the favorites property
      const favoritesCell = this.#homePatternCell.key("favorites");
      unsubscribeFavorites = favoritesCell.subscribe(
        (favoritesValue: unknown) => {
          if (isDisposed) return;

          // Transform entries - need to sync each CellHandle first
          this.#transformFavoritesToEntriesAsync(favoritesValue)
            .then((entries: FavoriteEntry[]) => {
              if (isDisposed) return;
              callback(entries);
            })
            .catch((error) => {
              const err = error instanceof Error
                ? error
                : new Error(String(error));
              if (onError) {
                onError(err);
              } else {
                console.error(
                  "[FavoritesManager] favorites transform failed:",
                  err,
                );
              }
              if (!isDisposed) {
                callback([]);
              }
            });
        },
      );
    };

    // Start the subscription process
    setupSubscription().catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      if (onError) {
        onError(err);
      } else {
        console.error(
          "[FavoritesManager] Failed to setup favorites subscription:",
          err,
        );
      }
      if (!isDisposed) {
        callback([]);
      }
    });

    // Return cleanup function
    return () => {
      isDisposed = true;
      if (unsubscribeFavorites) {
        unsubscribeFavorites();
        unsubscribeFavorites = undefined;
      }
    };
  }

  /**
   * Transform raw favorites value to FavoriteEntry array.
   * Syncs each CellHandle before extracting values.
   *
   * Favorites are stored as an array of CellHandles, each pointing to
   * a favorite entry object with { cell, tag, userTags }.
   */
  async #transformFavoritesToEntriesAsync(
    favoritesValue: unknown,
  ): Promise<FavoriteEntry[]> {
    if (!favoritesValue || !Array.isArray(favoritesValue)) {
      return [];
    }

    const entries: FavoriteEntry[] = [];

    for (const favItem of favoritesValue) {
      if (!isCellHandle(favItem)) {
        console.warn(
          "[FavoritesManager] Skipping non-CellHandle item in favorites",
        );
        continue;
      }

      // Sync the CellHandle to get the favorite entry value
      await favItem.sync();
      const favValue = favItem.get() as
        | { cell?: unknown; tag?: string; userTags?: unknown }
        | undefined;

      if (!favValue || typeof favValue !== "object") {
        console.warn(
          "[FavoritesManager] Skipping invalid favorite entry:",
          favValue,
        );
        continue;
      }

      // Extract charmId from the cell reference
      // CellHandle.id() already strips the "of:" prefix
      const charmId = isCellHandle(favValue.cell) ? favValue.cell.id() : "";

      // Extract tag
      const tag = favValue.tag || "";

      // Extract userTags - may be an array or a CellHandle
      let userTags: string[] = [];
      if (Array.isArray(favValue.userTags)) {
        userTags = favValue.userTags;
      } else if (isCellHandle(favValue.userTags)) {
        await favValue.userTags.sync();
        const ut = favValue.userTags.get();
        if (Array.isArray(ut)) userTags = ut;
      }

      entries.push({ charmId, tag, userTags });
    }

    return entries;
  }

  /**
   * Get the home space's defaultPattern cell.
   * Throws if defaultPattern can't be initialized.
   */
  async #getDefaultPattern(): Promise<CellHandle<HomePatternExports>> {
    // Use ensureHomePatternRunning which:
    // 1. Gets the home space cell
    // 2. Resolves the defaultPattern cell reference
    // 3. Starts the pattern if needed
    // 4. Returns the resolved, running pattern cell
    if (!this.#homePatternCell) {
      // Type boundary: ensureHomePatternRunning returns unknown, we cast to expected shape
      const cell = await this.#rt.ensureHomePatternRunning();
      this.#homePatternCell = cell as CellHandle<HomePatternExports>;
    }

    await this.#homePatternCell.sync();
    return this.#homePatternCell;
  }

  /**
   * Get a handler from the defaultPattern with the correct schema.
   * @param handlerName - Name of the handler (e.g., "addFavorite")
   */
  async #getHandler(handlerName: HandlerName): Promise<CellHandle<unknown>> {
    const defaultPattern = await this.#getDefaultPattern();

    // Apply schema to mark the handler as a stream
    const patternWithSchema = defaultPattern.asSchema({
      type: "object",
      properties: {
        [handlerName]: { asStream: true },
      },
      required: [handlerName],
    }) as CellHandle<Record<HandlerName, unknown>>;

    return patternWithSchema.key(handlerName);
  }

  /**
   * Create a CellRef for a charm in the current space.
   * @param charmId - The entity ID of the charm
   */
  #createCharmRef(charmId: string): CellRef {
    return {
      id: `of:${charmId}`,
      space: this.#currentSpaceDID,
      path: [],
      type: "application/json",
    };
  }
}
