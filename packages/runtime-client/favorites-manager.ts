/**
 * FavoritesManager - Client-side favorites management using cell primitives.
 *
 * This class provides favorites operations by directly accessing the home space's
 * defaultPattern through cell operations, without requiring specialized IPC messages.
 */

import { DID } from "@commonfabric/identity";
import { CellHandle } from "./cell-handle.ts";
import { RuntimeClient } from "./runtime-client.ts";
import type { CellRef } from "./protocol/types.ts";
import {
  FavoriteEntry,
  favoriteKey,
  favoriteListSchema,
  Home,
  homeSchema,
} from "@commonfabric/home-schemas";
import { tagsFromSchema } from "./schema-tags.ts";

type HandlerName = "addFavorite" | "removeFavorite";

export class FavoritesManager {
  #rt: RuntimeClient;
  #homePatternCell: CellHandle<Home> | null = null;

  constructor(rt: RuntimeClient) {
    this.#rt = rt;
  }

  /**
   * Add a piece to favorites (stored in the home space).
   *
   * Discovery tags are derived here, on the client, from the piece's result
   * schema — which the backend surfaces on the piece's resolved cell ref.
   * Deriving before the handler avoids the handler's event typing shadowing
   * the piece's authored schema. An explicit `tag` overrides the derived
   * tags.
   *
   * @param space - The space the piece lives in (part of its address)
   * @param pieceId - The entity ID of the piece to add
   * @param tag - Optional explicit discovery tag (overrides schema tags)
   * @param spaceName - Optional human-readable name of the space
   */
  async addFavorite(
    space: DID,
    pieceId: string,
    tag?: string,
    spaceName?: string,
  ): Promise<void> {
    const handler = await this.#getHandler("addFavorite");
    const pieceCellRef = this.#createPieceRef(space, pieceId);
    const tags = await this.#deriveTags(space, pieceId, tag);
    // The favorite is addressed by the piece's identity, so a re-favorite dedups
    // and an unfavorite removes by identity. Pattern code cannot introspect the
    // piece cell's link, so the key is computed here from the piece address.
    const id = favoriteKey(pieceCellRef);
    await handler.send({ piece: pieceCellRef, tags, spaceName, id });
  }

  /**
   * Derive the discovery tags for a piece. An explicit tag wins; otherwise
   * read the piece's result schema (carried on its resolved cell ref) and
   * extract its tags. Returns `[]` when no schema is available — a tagless
   * favorite that later code can heal.
   */
  async #deriveTags(
    space: DID,
    pieceId: string,
    explicitTag?: string,
  ): Promise<string[]> {
    if (explicitTag) return [explicitTag.toLowerCase().replace(/^#/, "")];
    try {
      // `getPage` resolves the piece's cell ref, which the backend serializes
      // with its result schema (`getAsLink({ includeSchema: true })`). It does
      // not start the piece (runIt defaults to false), so a piece that is not
      // already running may resolve without a schema and yield no tags — a
      // tagless favorite that later code can heal.
      const page = await this.#rt.getPage(pieceId, space);
      const schema = page?.cell().ref().schema;
      return schema ? tagsFromSchema(schema) : [];
    } catch {
      // A missing or unreadable piece schema yields no tags, not a failure.
      return [];
    }
  }

  /**
   * Remove a piece from favorites.
   * @param space - The space the piece lives in
   * @param pieceId - The entity ID of the piece to remove
   */
  async removeFavorite(space: DID, pieceId: string): Promise<void> {
    const handler = await this.#getHandler("removeFavorite");
    const pieceCellRef = this.#createPieceRef(space, pieceId);
    // Address the favorite entity by the same key add used, so the removal
    // reaches it regardless of the whole list's contents.
    const id = favoriteKey(pieceCellRef);
    await handler.send({ piece: pieceCellRef, id });
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
      // A subscriber tearing down or the runtime being disposed while
      // setup is in flight is an expected race, not a failure.
      if (isDisposed || this.#rt.signal.aborted) return;
      const err = error instanceof Error ? error : new Error(String(error));
      if (onError) {
        onError(err);
      } else {
        console.error(
          "[FavoritesManager] Failed to setup favorites subscription:",
          err,
        );
      }
      callback([]);
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
        [handlerName]: { asCell: ["stream"] },
      },
      required: [handlerName],
    }) as CellHandle<Record<HandlerName, unknown>>;

    return patternWithSchema.key(handlerName);
  }

  /**
   * Create a CellRef for a piece — an address of (space, id).
   */
  #createPieceRef(space: DID, pieceId: string): CellRef {
    return {
      id: `of:${pieceId}`,
      space,
      scope: "space",
      path: [],
    };
  }
}
