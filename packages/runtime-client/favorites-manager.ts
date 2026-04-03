/**
 * FavoritesManager - Client-side favorites management using cell primitives.
 *
 * This class provides favorites operations by directly accessing the home space's
 * defaultPattern through cell operations, without requiring specialized IPC messages.
 */

import { DID } from "@commontools/identity";
import { CellHandle } from "./cell-handle.ts";
import { RuntimeClient } from "./runtime-client.ts";
import type { CellRef } from "./protocol/types.ts";
import {
  FavoriteEntry,
  favoriteListSchema,
  Home,
  homeSchema,
} from "@commontools/home-schemas";

type HandlerName = "addFavorite" | "removeFavorite";

export class FavoritesManager {
  #rt: RuntimeClient;
  #currentSpaceDID: DID;
  #homePatternCell: CellHandle<Home> | null = null;

  constructor(
    rt: RuntimeClient,
    currentSpaceDID: DID,
  ) {
    this.#rt = rt;
    this.#currentSpaceDID = currentSpaceDID;
  }

  /**
   * Add a piece to favorites.
   * @param pieceId - The entity ID of the piece to add
   * @param tag - Optional tag/category for the favorite
   * @param spaceName - Optional human-readable name of the space
   */
  async addFavorite(
    pieceId: string,
    tag?: string,
    spaceName?: string,
  ): Promise<void> {
    const handler = await this.#getHandler("addFavorite");
    const pieceCellRef = this.#createPieceRef(pieceId);
    await handler.send({ piece: pieceCellRef, tag: tag || "", spaceName });
  }

  /**
   * Remove a piece from favorites.
   * @param pieceId - The entity ID of the piece to remove
   */
  async removeFavorite(pieceId: string): Promise<void> {
    const handler = await this.#getHandler("removeFavorite");
    const pieceCellRef = this.#createPieceRef(pieceId);
    await handler.send({ piece: pieceCellRef });
  }

  /**
   * Get all favorites.
   * @returns Array of favorite entries with cell, tag, and userTags
   */
  async getFavorites(): Promise<readonly FavoriteEntry[]> {
    const defaultPattern = await this.#getHomePattern();

    const favoritesCell = defaultPattern.key("favorites").asSchema(
      favoriteListSchema,
    ) as CellHandle<readonly FavoriteEntry[]>;
    await favoritesCell.sync();
    return favoritesCell.get() ?? [];
  }

  /**
   * Subscribe to favorites changes.
   * Callback is called immediately with current favorites (may be empty if not ready),
   * and again whenever favorites change.
   * @param callback - Function called with current favorites array
   * @param onError - Optional callback for errors during subscription
   * @returns Unsubscribe function
   */
  subscribeFavorites(
    callback: (favorites: readonly FavoriteEntry[]) => void,
    onError?: (error: Error) => void,
  ): () => void {
    let unsubscribeFavorites: (() => void) | undefined;
    let isDisposed = false;

    const setupSubscription = async () => {
      if (isDisposed) return;

      // Subscribe to the favorites property
      const favoritesCell = (await this.#getHomePattern()).key("favorites")
        .asSchema(favoriteListSchema) as CellHandle<readonly FavoriteEntry[]>;
      unsubscribeFavorites = favoritesCell.subscribe(
        (favoritesValue) => {
          if (isDisposed) return;
          callback(favoritesValue ?? []);
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
   * Get the home space's defaultPattern cell.
   * Throws if defaultPattern can't be initialized.
   */
  async #getHomePattern(): Promise<CellHandle<Home>> {
    // Use ensureHomePatternRunning which:
    // 1. Gets the home space cell
    // 2. Resolves the defaultPattern cell reference
    // 3. Starts the pattern if needed
    // 4. Returns the resolved, running pattern cell
    if (!this.#homePatternCell) {
      // Type boundary: ensureHomePatternRunning returns unknown, we cast to expected shape
      const cell = await this.#rt.ensureHomePatternRunning();
      this.#homePatternCell = cell.asSchema(homeSchema);
    }

    await this.#homePatternCell.sync();
    return this.#homePatternCell;
  }

  /**
   * Get a handler from the defaultPattern with the correct schema.
   * @param handlerName - Name of the handler (e.g., "addFavorite")
   */
  async #getHandler(handlerName: HandlerName): Promise<CellHandle<unknown>> {
    const defaultPattern = await this.#getHomePattern();

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
   * Create a CellRef for a piece in the current space.
   * @param pieceId - The entity ID of the piece
   */
  #createPieceRef(pieceId: string): CellRef {
    return {
      id: `of:${pieceId}`,
      space: this.#currentSpaceDID,
      path: [],
      type: "application/json",
    };
  }
}
