import { html } from "@commontools/common-html";
import { recipe, lift, ID, UI } from "../builder/index.js";
import { Gem, RecipeManifest } from "../data.js";

export const home = recipe<{
  sagas: Gem[];
  recipes: RecipeManifest[];
}>("home screen", ({ sagas, recipes }) => {
  const sagasWithIDs = lift((sagas: Gem[]) =>
    sagas
      .filter((saga) => saga.UI) // Only show sagas with UI
      .map((saga) => ({
        id: saga[ID],
        saga,
      }))
  )(sagas);

  return {
    [UI]: html`<vstack
      >${sagasWithIDs.map(
        (saga) => html`<div><common-saga-link .saga=${saga}></sagaLink></div>`
      )}
      ${recipes.map(
        (recipe) =>
          html`<div>
            <common-recipe-link foo="bar" recipe=${recipe}></common-recipe-link>
          </div>`
      )}<annotation
        query="dream fun things to explore"
        target="-1"
        data=${{ sagas, recipes }}
      />
    </vstack>`,
  };
});
