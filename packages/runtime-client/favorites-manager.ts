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

export class FavoritesManager {
  #rt: RuntimeClient;
  #homeSpaceDID: DID;
  #currentSpaceDID: DID;
  #homeSpaceCell: CellHandle<{ defaultPattern?: unknown }> | null = null;
  #homePatternCell: CellHandle<unknown> | null = null;

  constructor(
    rt: RuntimeClient,
    homeSpaceDID: DID,
    currentSpaceDID: DID,
  ) {
    this.#rt = rt;
    this.#homeSpaceDID = homeSpaceDID;
    this.#currentSpaceDID = currentSpaceDID;
  }

  /**
   * Add a charm to favorites.
   * @param charmId - The entity ID of the charm to add
   * @param tag - Optional tag/category for the favorite
   */
  async addFavorite(charmId: string, tag?: string): Promise<void> {
    console.log("[FavoritesManager] addFavorite called:", { charmId, tag });
    try {
      const handler = await this.#getHandler("addFavorite");
      console.log("[FavoritesManager] got handler:", handler);
      const charmCellRef = this.#createCharmRef(charmId);
      console.log("[FavoritesManager] sending to handler:", {
        charm: charmCellRef,
        tag: tag || "",
      });
      await handler.send({ charm: charmCellRef, tag: tag || "" });
      console.log("[FavoritesManager] addFavorite send completed");
    } catch (error) {
      console.warn(
        "[FavoritesManager] Failed to add favorite:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Remove a charm from favorites.
   * @param charmId - The entity ID of the charm to remove
   */
  async removeFavorite(charmId: string): Promise<void> {
    try {
      const handler = await this.#getHandler("removeFavorite");
      const charmCellRef = this.#createCharmRef(charmId);
      await handler.send({ charm: charmCellRef });
    } catch (error) {
      console.warn(
        "[FavoritesManager] Failed to remove favorite:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Check if a charm is in favorites.
   * @param charmId - The entity ID of the charm to check
   * @returns true if the charm is a favorite
   */
  async isFavorite(charmId: string): Promise<boolean> {
    try {
      const favorites = await this.getFavorites();
      return favorites.some((f) => f.charmId === charmId);
    } catch (error) {
      console.warn(
        "[FavoritesManager] Failed to check favorite:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * Get all favorites.
   * @returns Array of favorite entries with charmId, tag, and userTags
   */
  async getFavorites(): Promise<FavoriteEntry[]> {
    try {
      const defaultPattern = await this.#getDefaultPattern();
      if (!defaultPattern) {
        console.warn(
          "[FavoritesManager] Home space defaultPattern not initialized",
        );
        return [];
      }

      // Get favorites cell
      const favoritesCell = defaultPattern.key("favorites");
      await favoritesCell.sync();
      const favoritesValue = favoritesCell.get();

      return this.#transformFavoritesToEntries(favoritesValue);
    } catch (error) {
      console.warn(
        "[FavoritesManager] Failed to get favorites:",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  /**
   * Subscribe to favorites changes.
   * Callback is called immediately with current favorites (may be empty if not ready),
   * and again whenever favorites change.
   * @param callback - Function called with current favorites array
   * @returns Unsubscribe function
   */
  subscribeFavorites(
    callback: (favorites: FavoriteEntry[]) => void,
  ): () => void {
    console.log("[FavoritesManager] subscribeFavorites called");
    let unsubscribeFavorites: (() => void) | undefined;
    let isDisposed = false;

    const setupSubscription = async () => {
      if (isDisposed) return;
      console.log("[FavoritesManager] setupSubscription starting");

      try {
        // Use ensureHomePatternRunning to get the resolved, running pattern cell
        if (!this.#homePatternCell) {
          console.log("[FavoritesManager] calling ensureHomePatternRunning");
          this.#homePatternCell = await this.#rt.ensureHomePatternRunning();
          console.log(
            "[FavoritesManager] got homePatternCell:",
            this.#homePatternCell,
          );
        }

        const patternCell = this.#homePatternCell as CellHandle<{
          favorites?: unknown[];
        }>;
        await patternCell.sync();
        console.log(
          "[FavoritesManager] patternCell after sync, value:",
          patternCell.get(),
        );

        if (isDisposed) return;

        // Subscribe to the favorites property
        const favoritesCell = patternCell.key("favorites");
        console.log(
          "[FavoritesManager] subscribing to favoritesCell:",
          favoritesCell,
        );
        unsubscribeFavorites = favoritesCell.subscribe((favoritesValue) => {
          console.log(
            "[FavoritesManager] favorites subscription fired, raw value:",
            favoritesValue,
          );
          if (isDisposed) return;

          // Transform entries - need to sync each CellHandle first
          this.#transformFavoritesToEntriesAsync(favoritesValue).then(
            (entries: FavoriteEntry[]) => {
              if (isDisposed) return;
              console.log("[FavoritesManager] transformed entries:", entries);
              callback(entries);
            },
          );
        });
      } catch (error) {
        console.warn(
          "[FavoritesManager] setupSubscription failed:",
          error instanceof Error ? error.message : error,
        );
        callback([]);
      }
    };

    // Start the subscription process
    setupSubscription().catch((error) => {
      console.warn(
        "[FavoritesManager] Failed to setup favorites subscription:",
        error instanceof Error ? error.message : error,
      );
      // Call with empty array on error
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
   * Transform raw favorites value to FavoriteEntry array (async version).
   * Syncs each CellHandle before extracting values.
   */
  async #transformFavoritesToEntriesAsync(
    favoritesValue: unknown,
  ): Promise<FavoriteEntry[]> {
    if (!favoritesValue || !Array.isArray(favoritesValue)) {
      return [];
    }

    const entries: FavoriteEntry[] = [];

    for (const favItem of favoritesValue) {
      console.log(
        "[FavoritesManager] transforming favItem:",
        favItem,
        "isCellHandle:",
        isCellHandle(favItem),
      );

      let charmId = "";
      let tag = "";
      let userTags: string[] = [];

      if (isCellHandle(favItem)) {
        // Sync the CellHandle to get its value
        await favItem.sync();
        const favValue = favItem.get();
        console.log("[FavoritesManager] after sync, favItem.get() =", favValue);

        if (favValue && typeof favValue === "object") {
          const fav = favValue as any;

          if (isCellHandle(fav.cell)) {
            charmId = fav.cell.id();
            console.log(
              "[FavoritesManager] got charmId from fav.cell.id():",
              charmId,
            );
          } else if (fav.cell?.entityId?.["/"] !== undefined) {
            charmId = fav.cell.entityId["/"];
          }

          tag = fav.tag || "";

          if (Array.isArray(fav.userTags)) {
            userTags = fav.userTags;
          } else if (isCellHandle(fav.userTags)) {
            await fav.userTags.sync();
            const ut = fav.userTags.get();
            if (Array.isArray(ut)) userTags = ut;
          }
        } else {
          // Maybe the CellHandle itself IS the charm cell reference
          charmId = favItem.id();
          console.log("[FavoritesManager] favItem IS the cell, id:", charmId);
        }
      } else if (favItem && typeof favItem === "object") {
        const fav = favItem;

        if (isCellHandle(fav.cell)) {
          charmId = fav.cell.id();
        } else if (fav.cell?.entityId?.["/"] !== undefined) {
          charmId = fav.cell.entityId["/"];
        }

        tag = fav.tag || "";

        if (Array.isArray(fav.userTags)) {
          userTags = fav.userTags;
        } else if (isCellHandle(fav.userTags)) {
          await fav.userTags.sync();
          const ut = fav.userTags.get();
          if (Array.isArray(ut)) userTags = ut;
        }
      }

      console.log("[FavoritesManager] final entry:", {
        charmId,
        tag,
        userTags,
      });
      entries.push({ charmId, tag, userTags });
    }

    return entries;
  }

  /**
   * Transform raw favorites value to FavoriteEntry array.
   * Extracted for reuse between getFavorites and subscribeFavorites.
   */
  #transformFavoritesToEntries(favoritesValue: unknown): FavoriteEntry[] {
    if (!favoritesValue || !Array.isArray(favoritesValue)) {
      return [];
    }

    return favoritesValue.map((favItem: any) => {
      console.log(
        "[FavoritesManager] transforming favItem:",
        favItem,
        "isCellHandle:",
        isCellHandle(favItem),
      );

      // Handle different structures:
      // 1. favItem is a CellHandle pointing to a favorite entry object
      // 2. favItem is already an object with { cell, tag, userTags }

      let charmId = "";
      let tag = "";
      let userTags: string[] = [];

      if (isCellHandle(favItem)) {
        // favItem is a CellHandle - get its value which should be { cell, tag, userTags }
        const favValue = favItem.get();
        console.log("[FavoritesManager] favItem.get() =", favValue);

        if (favValue && typeof favValue === "object") {
          // Extract from the favorite entry object
          const fav = favValue as any;

          if (isCellHandle(fav.cell)) {
            const cellId = fav.cell.id();
            charmId = cellId.startsWith("of:") ? cellId.slice(3) : cellId;
            console.log(
              "[FavoritesManager] got charmId from fav.cell.id():",
              charmId,
            );
          } else if (fav.cell?.entityId?.["/"] !== undefined) {
            charmId = fav.cell.entityId["/"];
          }

          tag = fav.tag || "";

          if (Array.isArray(fav.userTags)) {
            userTags = fav.userTags;
          } else if (isCellHandle(fav.userTags)) {
            const ut = fav.userTags.get();
            if (Array.isArray(ut)) userTags = ut;
          }
        } else {
          // Maybe the CellHandle itself IS the charm cell reference
          // In this case, extract the ID directly
          const cellId = favItem.id();
          charmId = cellId.startsWith("of:") ? cellId.slice(3) : cellId;
          console.log("[FavoritesManager] favItem IS the cell, id:", charmId);
        }
      } else if (favItem && typeof favItem === "object") {
        // favItem is already an object
        const fav = favItem;

        if (isCellHandle(fav.cell)) {
          const cellId = fav.cell.id();
          charmId = cellId.startsWith("of:") ? cellId.slice(3) : cellId;
        } else if (fav.cell?.entityId?.["/"] !== undefined) {
          charmId = fav.cell.entityId["/"];
        }

        tag = fav.tag || "";

        if (Array.isArray(fav.userTags)) {
          userTags = fav.userTags;
        } else if (isCellHandle(fav.userTags)) {
          const ut = fav.userTags.get();
          if (Array.isArray(ut)) userTags = ut;
        }
      }

      console.log("[FavoritesManager] final entry:", {
        charmId,
        tag,
        userTags,
      });
      return { charmId, tag, userTags };
    });
  }

  /**
   * Get the home space's defaultPattern cell.
   * Returns null if defaultPattern doesn't exist yet.
   */
  async #getDefaultPattern(): Promise<CellHandle<any> | null> {
    console.log("[FavoritesManager] #getDefaultPattern called");
    try {
      // Use ensureHomePatternRunning which:
      // 1. Gets the home space cell
      // 2. Resolves the defaultPattern cell reference
      // 3. Starts the pattern if needed
      // 4. Returns the resolved, running pattern cell
      if (!this.#homePatternCell) {
        console.log(
          "[FavoritesManager] #getDefaultPattern calling ensureHomePatternRunning",
        );
        this.#homePatternCell = await this.#rt.ensureHomePatternRunning();
        console.log(
          "[FavoritesManager] #getDefaultPattern got homePatternCell:",
          this.#homePatternCell,
        );
      }

      await this.#homePatternCell.sync();
      console.log(
        "[FavoritesManager] #getDefaultPattern homePatternCell value:",
        this.#homePatternCell.get(),
      );

      return this.#homePatternCell as CellHandle<any>;
    } catch (error) {
      console.warn(
        "[FavoritesManager] Failed to get defaultPattern:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  /**
   * Get a handler from the defaultPattern with the correct schema.
   * @param handlerName - Name of the handler (e.g., "addFavorite")
   */
  async #getHandler(handlerName: string): Promise<CellHandle<any>> {
    console.log("[FavoritesManager] #getHandler called for:", handlerName);
    const defaultPattern = await this.#getDefaultPattern();
    console.log(
      "[FavoritesManager] #getHandler got defaultPattern:",
      defaultPattern,
    );
    if (!defaultPattern) {
      throw new Error("Home space defaultPattern not initialized");
    }

    // Apply schema to mark the handler as a stream
    const patternWithSchema = defaultPattern.asSchema({
      type: "object",
      properties: {
        [handlerName]: { asStream: true },
      },
      required: [handlerName],
    }) as CellHandle<Record<string, any>>;
    console.log(
      "[FavoritesManager] #getHandler patternWithSchema:",
      patternWithSchema,
    );

    const handler = patternWithSchema.key(handlerName as any);
    console.log("[FavoritesManager] #getHandler returning handler:", handler);
    return handler;
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
