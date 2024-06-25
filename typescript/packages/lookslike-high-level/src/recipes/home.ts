import { view, tags } from "@commontools/common-ui";
import { signal } from "@commontools/common-frp";
import { recipe, Gem, ID } from "../recipe.js";
import { sagaLink } from "../components/saga-link.js";
import { recipeLink } from "../components/recipe-link.js";
const { binding, repeat } = view;
const { vstack } = tags;

export const home = recipe("home screen", ({ sagas, recipes }) => {
  const sagasWithIDs = signal.computed(
    [sagas],
    (sagas: { [key: string]: Gem }) =>
      Object.values(sagas)
        .filter((saga) => saga.UI) // Only show sagas with UI
        .map((saga) => ({
          id: saga[ID],
          saga,
        }))
  );

  const recipesWithIDs = signal.computed(
    [recipes],
    (recipes: { [key: string]: Gem }) =>
      Object.values(recipes).map((recipe) => ({
        id: recipe[ID],
        recipe,
      }))
  );

  return {
    UI: vstack({}, [
      vstack({}, repeat(sagasWithIDs, sagaLink({ saga: binding("saga") }))),
      vstack(
        {},
        repeat(recipesWithIDs, recipeLink({ recipe: binding("recipe") }))
      ),
    ]),
  };
});
