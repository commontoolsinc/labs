import { css, html, LitElement, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { RuntimeInternals } from "../lib/runtime.ts";
import { Task } from "@lit/task";

/**
 * Favorite button component.
 *
 * NOTE: Favorites functionality is currently disabled while RuntimeClient
 * integration is in progress. The button renders but clicking has no effect.
 * TODO: Re-enable once favorites IPC is implemented.
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

    /* Disabled state */
    x-button.emoji-button.disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
  `;

  @property()
  rt?: RuntimeInternals;

  @property({ attribute: false })
  charmId?: string;

  // Local state for favoriting, used when
  // modifying state inbetween server syncs.
  @state()
  isFavorite: boolean | undefined = undefined;

  private handleFavoriteClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();

    // TODO(runtime-worker-refactor)
    console.warn(
      "[FavoriteButton] Favorites functionality is disabled during RuntimeClient migration",
    );
  }

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has("charmId")) {
      this.isFavorite = undefined;
    }
  }

  private deriveIsFavorite(): boolean {
    // Always return false since favorites are disabled
    return false;
  }

  isFavoriteSync = new Task(this, {
    task: async (
      [_charmId, _rt],
      { signal: _signal },
    ): Promise<boolean> => {
      // TODO(runtime-worker-refactor)
      return await false;
    },
    args: () => [this.charmId, this.rt],
  });

  override render() {
    const isFavorite = this.deriveIsFavorite();

    return html`
      <x-button
        class="emoji-button disabled"
        size="small"
        @click="${this.handleFavoriteClick}"
        title="Favorites temporarily disabled"
      >
        ${isFavorite ? "⭐" : "☆"}
      </x-button>
    `;
  }
}

globalThis.customElements.define("x-favorite-button", XFavoriteButtonElement);
