import { css, html, LitElement, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { RuntimeInternals } from "../lib/runtime.ts";
import type { CellHandle } from "@commontools/runtime-client";
import type { FavoriteEntry } from "@commontools/home-schemas";

/**
 * Favorite button component.
 *
 * Allows users to add/remove pieces from their favorites list.
 * Favorites are stored in the user's home space defaultPattern.
 *
 * Uses reactive subscription to favorites so the button updates
 * when favorites change, even if home.tsx hasn't initialized yet.
 */
export class XFavoriteButtonElement extends LitElement {
  static override styles = css`
    x-button.emoji-button {
      opacity: 0.7;
      transition: opacity 0.2s;
      font-size: 1rem;
    }

    x-button.emoji-button:hover {
      opacity: 1;
    }

    x-button.auth-button {
      font-size: 1rem;
    }

    /* Loading state */
    x-button.emoji-button.loading {
      opacity: 0.5;
      cursor: wait;
    }
  `;

  @property()
  rt?: RuntimeInternals;

  @property({ attribute: false })
  pieceId?: string;

  // Server favorites from subscription
  @state()
  private _serverFavorites: readonly FavoriteEntry[] = [];

  // Local state for favoriting, used for optimistic updates
  // between user click and server sync
  @state()
  private _localIsFavorite: boolean | undefined = undefined;

  @state()
  private _isLoading = false;

  // Subscription cleanup function
  private _unsubscribe: (() => void) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this._setupSubscription();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._cleanupSubscription();
  }

  protected override willUpdate(changedProperties: PropertyValues): void {
    // Reset local state when pieceId changes
    if (changedProperties.has("pieceId")) {
      this._localIsFavorite = undefined;
    }

    // Re-setup subscription when rt changes
    if (changedProperties.has("rt")) {
      // Reset cached state for new runtime
      this._serverFavorites = [];
      this._localIsFavorite = undefined;
      this._cleanupSubscription();
      this._setupSubscription();
    }
  }

  private _setupSubscription(): void {
    if (!this.rt) return;

    this._unsubscribe = this.rt.favorites().subscribeFavorites((favorites) => {
      this._serverFavorites = favorites;
      // Clear local state once we have fresh server state
      this._localIsFavorite = undefined;
      this.requestUpdate();
    });
  }

  private _cleanupSubscription(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
  }

  private _deriveIsFavorite(): boolean {
    // Prefer local state if set (for optimistic updates)
    if (this._localIsFavorite !== undefined) {
      return this._localIsFavorite;
    }
    // Fall back to server state
    if (!this.pieceId) return false;
    return this._serverFavorites.some(
      (f) => (f.cell as unknown as CellHandle<unknown>).id() === this.pieceId,
    );
  }

  private async _handleFavoriteClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();

    if (!this.rt || !this.pieceId || this._isLoading) return;

    const currentlyFavorite = this._deriveIsFavorite();

    this._isLoading = true;
    try {
      if (currentlyFavorite) {
        await this.rt.favorites().removeFavorite(this.pieceId);
        this._localIsFavorite = false;
      } else {
        await this.rt.favorites().addFavorite(
          this.pieceId,
          undefined,
          this.rt.spaceName(),
        );
        this._localIsFavorite = true;
      }
      // Server state will update via subscription
    } catch (err) {
      console.error("[FavoriteButton] Error toggling favorite:", err);
      // Reset local state on error
      this._localIsFavorite = undefined;
    } finally {
      this._isLoading = false;
    }
  }

  override render() {
    const isFavorite = this._deriveIsFavorite();

    return html`
      <x-button
        class="emoji-button ${this._isLoading ? "loading" : ""}"
        size="small"
        @click="${this._handleFavoriteClick}"
        title="${isFavorite ? "Remove from favorites" : "Add to favorites"}"
      >
        ${isFavorite ? "\u2b50" : "\u2606"}
      </x-button>
    `;
  }
}

globalThis.customElements.define("x-favorite-button", XFavoriteButtonElement);
