import { html } from "@commontools/common-html";
import { recipe, lift, ID, UI } from "@commontools/common-builder";
import { Gem, RecipeManifest } from "../data.js";

const getIDsForSagasWithUI = lift<
  { sagas: Gem[]; homeId: number },
  { id: number }[]
>(
  ({ sagas, homeId }) =>
    sagas
      .filter((saga) => saga[UI]) // Only show sagas with UI
      .map((saga) => ({ id: saga[ID] }))
      .filter((saga) => saga.id != homeId) // Don't include the home screen
);

export const home = recipe<{
  sagas: Gem[];
  recipes: RecipeManifest[];
  [ID]: number;
}>("home screen", ({ sagas, recipes, [ID]: homeId }) => {
  return {
    [UI]: html`<common-vstack
      >${getIDsForSagasWithUI({ sagas, homeId }).map(
        (saga) => html`<div><common-saga-link saga=${saga.id}></sagaLink></div>`
      )}
      ${recipes.map(
        (recipe) =>
          html`<div>
            <common-recipe-link foo="bar" recipe=${recipe}></common-recipe-link>
          </div>`
      )}<common-annotation
        query="dream fun things to explore"
        target="-1"
        data=${{ sagas, recipes }}
      />
    </common-vstack>`,
  };
});
