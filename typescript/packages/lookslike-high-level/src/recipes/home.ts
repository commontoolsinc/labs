import { html } from "@commontools/common-html";
import { recipe, lift, ID, UI } from "@commontools/common-builder";
import { Charm, RecipeManifest } from "../data.js";

const getIDsForCharmsWithUI = lift<
  { charms: Charm[]; homeId: number },
  { id: number }[]
>(
  ({ charms, homeId }) =>
    charms
      .filter((charm) => charm[UI]) // Only show charms with UI
      .map((charm) => ({ id: charm[ID] }))
      .filter((charm) => charm.id != homeId) // Don't include the home screen
);

export const home = recipe<{
  charms: Charm[];
  recipes: RecipeManifest[];
  [ID]: number;
}>("home screen", ({ charms, recipes, [ID]: homeId }) => {
  return {
    [UI]: html`<common-vstack
      >${getIDsForCharmsWithUI({ charms: charms, homeId }).map(
        (charm) =>
          html`<div>
            <common-charm-link charm=${charm.id}></common-charm-link>
          </div>`
      )}
      ${recipes.map(
        (recipe) =>
          html`<div>
            <common-recipe-link recipe=${recipe.recipeId}>
              👨‍🍳 ${recipe.name}</common-recipe-link
            >
          </div>`
      )}
      <common-annotation-toggle />
      <common-annotation
        query="dream fun things to explore"
        target="-1"
        data=${{ charms, recipes }}
      />
    </common-vstack>`,
  };
});
