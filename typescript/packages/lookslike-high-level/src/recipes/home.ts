import { html } from "@commontools/common-html";
import { recipe, lift, ID } from "../builder/index.js";
import { Gem } from "../data.js";
import { sagaLink } from "../components/saga-link.js";
import { recipeLink } from "../components/recipe-link.js";

export const home = recipe<{
  sagas: { [key: string]: Gem };
  recipes: { [key: string]: Gem };
}>("home screen", ({ sagas, recipes }) => {
  const sagasWithIDs = lift((sagas: { [key: string]: Gem }) =>
    Object.values(sagas)
      .filter((saga) => saga.UI) // Only show sagas with UI
      .map((saga) => ({
        id: saga[ID],
        saga,
      }))
  )(sagas);

  const recipesWithIDs = lift((recipes: { [key: string]: Gem }) =>
    Object.values(recipes).map((recipe) => ({
      id: recipe[ID],
      recipe,
    }))
  )(recipes);

  return {
    UI: html`<vstack
      >${sagasWithIDs.map((saga) => sagaLink({ saga }))}
      ${recipesWithIDs.map((recipe) => recipeLink({ recipe }))}<annotation
        query="dream fun things to explore"
        target="-1"
        data=${{ sagas, recipes }}
      />
    </vstack>`,
  };
});
