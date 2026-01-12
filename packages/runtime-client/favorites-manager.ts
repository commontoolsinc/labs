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

export class FavoritesManager {
  #rt: RuntimeClient;
  #homeSpaceDID: DID;
  #currentSpaceDID: DID;
  #homeSpaceCell: CellHandle<{ defaultPattern?: unknown }> | null = null;

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
    try {
      const handler = await this.#getHandler("addFavorite");
      const charmCellRef = this.#createCharmRef(charmId);
      await handler.send({ charm: charmCellRef, tag: tag || "" });
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
  async getFavorites(): Promise<
    Array<{ charmId: string; tag: string; userTags: string[] }>
  > {
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

      if (!favoritesValue || !Array.isArray(favoritesValue)) {
        return [];
      }

      // Convert to response format
      const result = favoritesValue.map((fav: any) => {
        // Extract charmId from cell handle
        let charmId = "";
        if (isCellHandle(fav.cell)) {
          charmId = fav.cell.id();
        }

        // Extract userTags - handle both array values and Cell handles
        let userTags: string[] = [];
        if (Array.isArray(fav.userTags)) {
          userTags = fav.userTags;
        } else if (isCellHandle(fav.userTags)) {
          const userTagsValue = fav.userTags.get();
          if (Array.isArray(userTagsValue)) {
            userTags = userTagsValue;
          }
        }

        return {
          charmId,
          tag: fav.tag || "",
          userTags,
        };
      });

      return result;
    } catch (error) {
      console.warn(
        "[FavoritesManager] Failed to get favorites:",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  /**
   * Get the home space's defaultPattern cell.
   * Returns null if defaultPattern doesn't exist yet.
   */
  async #getDefaultPattern(): Promise<CellHandle<any> | null> {
    try {
      // Lazily fetch the home space cell
      if (!this.#homeSpaceCell) {
        this.#homeSpaceCell = (await this.#rt.getHomeSpaceCell()) as CellHandle<
          { defaultPattern?: unknown }
        >;
      }

      const homeSpaceCell = this.#homeSpaceCell;
      await homeSpaceCell.sync();
      const homeSpaceValue = homeSpaceCell.get();

      if (!homeSpaceValue || !homeSpaceValue.defaultPattern) {
        return null;
      }

      // After sync, defaultPattern should be deserialized as a CellHandle
      const defaultPatternCell = homeSpaceCell.key("defaultPattern");
      await defaultPatternCell.sync();

      const defaultPatternValue = defaultPatternCell.get();
      if (!defaultPatternValue) {
        return null;
      }

      // If the value is a CellHandle, it's a reference to another cell
      if (isCellHandle(defaultPatternValue)) {
        return defaultPatternValue as CellHandle<any>;
      }

      // Otherwise, the defaultPattern cell itself is what we want
      return defaultPatternCell;
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
    const defaultPattern = await this.#getDefaultPattern();
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

    return patternWithSchema.key(handlerName as any);
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
