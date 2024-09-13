import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { render } from "@commontools/common-ui";
import { addGems, RecipeManifest, ID } from "../data.js";
import { run } from "@commontools/common-runner";

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

  @property({ type: Object })
  recipe: RecipeManifest | undefined = undefined;

  handleClick(e: Event) {
    e.preventDefault();

    if (!this.recipe) return;

    const saga = run(this.recipe.recipe, {});
    addGems([saga]);

    this.dispatchEvent(
      new CustomEvent("open-saga", {
        detail: { sagaId: saga.get()[ID] },
        bubbles: true,
        composed: true,
      })
    );
  }

  override render() {
    if (!this.recipe?.name) return html``;
    return html`
      <a href="#" @click="${this.handleClick}">👨‍🍳 ${this.recipe.name}</a>
    `;
  }
}
