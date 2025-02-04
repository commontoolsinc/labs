import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type Charm } from "@commontools/charm";
import { type DocImpl, getRecipe } from "@commontools/runner";
import { charmManager } from "../data.js";

@customElement("common-recipe-link")
export class CommonRecipeLink extends LitElement {
  static override styles = css`
    a {
      color: #3366cc;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  `;

  @property({ type: String })
  recipe: string | undefined = undefined;

  async handleClick(e: Event) {
    e.preventDefault();

    if (!this.recipe) return;
    const recipe = getRecipe(this.recipe);
    if (!recipe) return;

    const charm: DocImpl<Charm> = await charmManager.runPersistent(recipe);
    charmManager.add([charm]);

    this.dispatchEvent(
      new CustomEvent("open-charm", {
        detail: { charmId: JSON.stringify(charm.entityId) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    return html`
      <a href="/recipe/${this.recipe ?? "unknown"}" @click="${this.handleClick}">
        <slot></slot>
      </a>
    `;
  }
}
