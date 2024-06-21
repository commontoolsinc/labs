import { view, tags } from "@commontools/common-ui";
import { signal } from "@commontools/common-frp";
import { recipe, Gem, ID } from "../recipe.js";
import { sagaLink } from "../components/saga-link.js";
const { binding, repeat } = view;
const { vstack, list } = tags;

export const sagaList = recipe("saga list", ({ sagas }) => {
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
      list({}, repeat("sagas", sagaLink({ saga: binding("saga") }))),
      { sagas: sagasWithIDs },
    ],
  };
});
