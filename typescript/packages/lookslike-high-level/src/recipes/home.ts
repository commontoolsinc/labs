import { html } from "@commontools/common-html";
import { recipe, lift, NAME, UI } from "@commontools/common-builder";
import { Charm, RecipeManifest } from "../data.js";

const getCharmsWithNameAndUI = lift<Charm[], { charm: Charm }[]>((charms) =>
  (charms ?? [])
    .filter((charm) => charm && charm[UI] && charm[NAME])
    .map((charm) => ({ charm })),
);

export const home = recipe<{
  charms: Charm[];
  recipes: RecipeManifest[];
}>("Home Screen", ({ charms, recipes }) => {
  return {
    [NAME]: "Home",
    [UI]: html`<common-vstack
      >${getCharmsWithNameAndUI(charms).map(
        ({ charm }) =>
          html`<div>
            <common-droppable
              $droppable=${charm["action/drop/handler"]}
              $schema=${charm["action/drop/schema"]}
            >
              <common-charm-link $charm=${charm}></common-charm-link>
            </common-droppable>
          </div>`,
      )}
      ${recipes.map(
        (recipe) =>
          html`<div>
            <common-recipe-link recipe=${recipe.recipeId}>
              👨‍🍳 ${recipe.name}</common-recipe-link
            >
          </div>`,
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
