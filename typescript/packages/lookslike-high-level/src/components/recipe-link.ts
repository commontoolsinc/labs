import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { addCharms, runPersistent, type Charm } from "../data.js";
import { type DocImpl, getRecipe } from "@commontools/common-runner";

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

    const charm: DocImpl<Charm> = await runPersistent(recipe);
    addCharms([charm]);

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
      <a
        href="/recipe/${this.recipe ?? "unknown"}"
        @click="${this.handleClick}"
      >
        <slot></slot>
      </a>
    `;
  }
}
