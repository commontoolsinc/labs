import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { render } from "@commontools/common-ui";
import { addCharms, recipeById, type Charm } from "../data.js";
import { run, type CellImpl } from "@commontools/common-runner";

export const recipeLink = render.view("common-recipe-link", {
  recipe: { type: "object" },
});

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

  handleClick(e: Event) {
    e.preventDefault();

    if (!this.recipe) return;
    const recipe = recipeById.get(this.recipe);
    if (!recipe) return;

    const charm: CellImpl<Charm> = run(recipe, {});
    addCharms([charm]);

    this.dispatchEvent(
      new CustomEvent("open-charm", {
        detail: { charmId: charm.entityId },
        bubbles: true,
        composed: true,
      })
    );
  }

  override render() {
    return html`
      <a
        href="#open-recipe-${this.recipe ?? "unknown"}"
        @click="${this.handleClick}"
      >
        <slot></slot>
      </a>
    `;
  }
}
