import { html } from "@commontools/common-html";
import { recipe, lift, ID, UI } from "@commontools/common-builder";
import { Gem, RecipeManifest } from "../data.js";

const getSagasWithUI = lift(
  (sagas: Gem[]) => sagas.filter((saga) => UI in saga) // Only show sagas with UI
);

export const home = recipe<{
  sagas: Gem[];
  recipes: RecipeManifest[];
}>("home screen", ({ sagas, recipes }) => {
  return {
    [UI]: html`<common-vstack
      >${getSagasWithUI(sagas).map(
        (saga) =>
          html`<div><common-saga-link saga=${saga[ID]}></sagaLink></div>`
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
