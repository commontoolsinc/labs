import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { recipe } from "../recipe.js";
import { annotation } from "../components/annotation.js";
const { binding, repeat } = view;
const { vstack, hstack, div, include } = tags;
const { state } = signal;

export const recipeList = recipe("recipe list", ({ items }) => {
  return {
    UI: [
      vstack({}, [
        vstack({}, repeat("items", include({ content: binding("itemUI") }))),
      ]),
      { items },
    ],
    items,
  };
});

export const recipeItem = recipe("recipe list item", ({ title }) => {
  return {
    itemUI: state([
      vstack({}, [
        hstack({}, [div({}, binding("title"))]),
        annotation({
          query: title,
          data: { recipeName: title },
        }),
      ]),
      { title },
    ]),
    title,
  };
});
