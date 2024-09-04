import { html } from "@commontools/common-html";
import { recipe, lift, ID, UI } from "../builder/index.js";
import { Gem, RecipeManifest } from "../data.js";

export const home = recipe<{
  sagas: Gem[];
  recipes: RecipeManifest[];
}>("home screen", ({ sagas, recipes }) => {
  const sagaIDs = lift((sagas: Gem[]) =>
    sagas
      .filter((saga) => saga[UI] ?? saga.get()[UI]) // Only show sagas with UI
      .map((saga) => ({ id: saga[ID] ?? saga.get()[ID] }))
  )(sagas);

  return {
    [UI]: html`<common-vstack
      >${sagaIDs.map(
        (saga) => html`<div><common-saga-link saga=${saga.id}></sagaLink></div>`
      )}
      ${recipes.map(
        (recipe) =>
          html`<div>
            <common-recipe-link foo="bar" recipe=${recipe}></common-recipe-link>
          </div>`
      )}<common-annotation
        query="dream fun things to explore, especially with tickets and reservations"
        target="-1"
        data=${{ sagas, recipes }}
      />
    </common-vstack>`,
  };
});
