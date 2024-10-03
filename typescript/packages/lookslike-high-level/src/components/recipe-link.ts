import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { render } from "@commontools/common-ui";
import { addCharms, RecipeManifest, ID, type Charm } from "../data.js";
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

  @property({ type: Object })
  recipe: RecipeManifest | undefined = undefined;

  handleClick(e: Event) {
    e.preventDefault();

    if (!this.recipe) return;

    const charm: CellImpl<Charm> = run(maybeUnwrap(this.recipe.recipe), {});
    addCharms([charm]);

    this.dispatchEvent(
      new CustomEvent("open-charm", {
        detail: { charmId: charm.get()[ID] },
        bubbles: true,
        composed: true,
      })
    );
  }

  override render() {
    if (!this.recipe?.name) return html``;
    return html`
      <a href="#" @click="${this.handleClick}"
        >👨‍🍳 ${maybeUnwrap(this.recipe.name)}</a
      >
    `;
  }
}

function maybeUnwrap(value: any) {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof value.get === "function"
  )
    return value.get();
  else return value;
}
