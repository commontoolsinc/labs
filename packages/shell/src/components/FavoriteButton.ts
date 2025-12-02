import { css, html, LitElement, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { RuntimeInternals } from "../lib/runtime.ts";
import { Task } from "@lit/task";

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
  `;

  @property()
  rt?: RuntimeInternals;

  @property({ attribute: false })
  charmId?: string;

  // Local state for favoriting, used when
  // modifying state inbetween server syncs.
  @state()
  isFavorite: boolean | undefined = undefined;

  private async handleFavoriteClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.rt || !this.charmId) return;
    const manager = this.rt.cc().manager();

    const isFavorite = this.deriveIsFavorite();

    // Update local state, and use until overridden by
    // syncing state, or another click.
    this.isFavorite = !isFavorite;

    const charmCell = (await this.rt.cc().get(this.charmId, true)).getCell();
    if (isFavorite) {
      await manager.removeFavorite(charmCell);
    } else {
      await manager.addFavorite(charmCell);
    }

    this.isFavoriteSync.run();
  }

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has("charmId")) {
      this.isFavorite = undefined;
    }
  }

  private deriveIsFavorite(): boolean {
    // If `isFavorite` is defined, we have local state that is not
    // yet synced. Prefer local state if defined, otherwise use server state.
    return this.isFavorite ?? this.isFavoriteSync.value ?? false;
  }

  isFavoriteSync = new Task(this, {
    task: async (
      [charmId, rt],
      { signal },
    ): Promise<boolean> => {
      const isFavorite = await isFavoriteSync(rt, charmId);

      // If another favorite request was initiated, store
      // the sync status, but don't overwrite the local state.
      if (signal.aborted) return isFavorite;

      // We update `this.isFavorite` here to `undefined`,
      // indicating that the synced state should be preferred
      // now that it's fresh.
      this.isFavorite = undefined;
      return isFavorite;
    },
    args: () => [this.charmId, this.rt],
  });

  override render() {
    const isFavorite = this.deriveIsFavorite();

    return html`
      <x-button
        class="emoji-button"
        size="small"
        @click="${this.handleFavoriteClick}"
        title="${isFavorite ? "Remove from Favorites" : "Add to Favorites"}"
      >
        ${isFavorite ? "⭐" : "☆"}
      </x-button>
    `;
  }
}

globalThis.customElements.define("x-favorite-button", XFavoriteButtonElement);

async function isFavoriteSync(
  rt?: RuntimeInternals,
  charmId?: string,
): Promise<boolean> {
  if (!charmId || !rt) {
    return false;
  }
  const manager = rt.cc().manager();
  try {
    const charm = await manager.get(charmId, true);
    if (charm) {
      const favorites = manager.getFavorites();
      await favorites.sync();
      return manager.isFavorite(charm);
    } else {
      return false;
    }
  } catch (_) {
    //
  }
  return false;
}
