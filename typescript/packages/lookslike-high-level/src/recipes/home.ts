import { view, tags } from "@commontools/common-ui";
import { signal } from "@commontools/common-frp";
import { recipe, Gem, ID } from "../recipe.js";
import { sagaLink } from "../components/saga-link.js";
const { binding, repeat } = view;
const { list, vstack } = tags;

export const home = recipe("home screen", ({ sagas, recipes }) => {
  const sagasWithIDs = signal.computed(
    [sagas],
    (sagas: { [key: string]: Gem }) =>
      Object.values(sagas).map((saga) => ({
        id: saga[ID],
        saga,
      }))
  );

  return {
    UI: [
      list({}, [
        vstack({}, repeat("sagas", sagaLink({ saga: binding("saga") }))),
        //   vstack({}, repeat("recipes", recipeLink({ saga: binding("saga") }))),
      ]),
      { sagas: sagasWithIDs, recipes },
    ],
  };
});
