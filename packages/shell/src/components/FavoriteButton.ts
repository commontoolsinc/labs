import { css, html, LitElement, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { RuntimeInternals } from "../lib/runtime.ts";
import { Task } from "@lit/task";

/**
 * Favorite button component.
 *
 * Allows users to add/remove charms from their favorites list.
 * Favorites are stored in the user's home space defaultPattern.
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
  charmId?: string;

  // Local state for favoriting, used when
  // modifying state inbetween server syncs.
  @state()
  private _localIsFavorite: boolean | undefined = undefined;

  @state()
  private _isLoading = false;

  private async handleFavoriteClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();

    if (!this.rt || !this.charmId || this._isLoading) return;

    const runtime = this.rt.runtime();
    const currentlyFavorite = this.deriveIsFavorite();

    this._isLoading = true;
    try {
      if (currentlyFavorite) {
        await runtime.removeFavorite(this.charmId);
        this._localIsFavorite = false;
      } else {
        await runtime.addFavorite(this.charmId);
        this._localIsFavorite = true;
      }
      // Re-run the sync task to get fresh state
      this.isFavoriteSync.run();
    } catch (err) {
      console.error("[FavoriteButton] Error toggling favorite:", err);
    } finally {
      this._isLoading = false;
    }
  }

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has("charmId")) {
      this._localIsFavorite = undefined;
    }
  }

  private deriveIsFavorite(): boolean {
    // Prefer local state if set (for optimistic updates)
    if (this._localIsFavorite !== undefined) {
      return this._localIsFavorite;
    }
    // Fall back to synced state from server
    return this.isFavoriteSync.value ?? false;
  }

  isFavoriteSync = new Task(this, {
    task: async (
      [charmId, rt],
      { signal: _signal },
    ): Promise<boolean> => {
      if (!rt || !charmId) return false;
      try {
        const result = await rt.runtime().isFavorite(charmId);
        // Clear local state once we have server state
        this._localIsFavorite = undefined;
        return result;
      } catch (err) {
        console.error("[FavoriteButton] Error checking favorite status:", err);
        return false;
      }
    },
    args: () => [this.charmId, this.rt],
  });

  override render() {
    const isFavorite = this.deriveIsFavorite();
    const isLoading = this._isLoading || this.isFavoriteSync.status === 1; // 1 = pending

    return html`
      <x-button
        class="emoji-button ${isLoading ? "loading" : ""}"
        size="small"
        @click="${this.handleFavoriteClick}"
        title="${isFavorite ? "Remove from favorites" : "Add to favorites"}"
      >
        ${isFavorite ? "⭐" : "☆"}
      </x-button>
    `;
  }
}

globalThis.customElements.define("x-favorite-button", XFavoriteButtonElement);
