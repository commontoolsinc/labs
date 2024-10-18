import { recipe, lift, NAME, UI } from "@commontools/common-builder";
import { Charm, RecipeManifest } from "../data.js";
import { h, Fragment } from "../jsx.js";

const getCharmsWithNameAndUI = lift<Charm[], { charm: Charm }[]>((charms) =>
  charms
    .filter((charm) => charm[UI] && charm[NAME])
    .map((charm) => ({ charm })),
);

export const home = recipe<{
  charms: Charm[];
  recipes: RecipeManifest[];
}>("home screen", ({ charms, recipes }) => {
  return {
    [NAME]: "Home",
    [UI]:
      <common-vstack>
        {getCharmsWithNameAndUI(charms).map(
          ({ charm }) =>
            <div><common-charm-link $charm={charm} /></div>,
        )}
        {recipes.map(
          (recipe) =>
            <div>
              <common-recipe-link recipe={recipe.recipeId}>
                👨‍🍳 {recipe.name}
              </common-recipe-link>
            </div>,
        )}
        <common-annotation-toggle />
        <common-annotation
          query="dream fun things to explore"
          target="-1"
          data={{ charms, recipes }}
        />
      </common-vstack>,
  };
});
