import { recipe, NAME } from "../recipe.js";

export const routine = recipe("routine", (bindings) => ({
  [NAME]: bindings.title,
  ...bindings,
}));
