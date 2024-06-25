import { recipe, NAME } from "../recipe.js";

export const reservation = recipe("reservation", (bindings) => ({
  [NAME]: bindings.title,
  ...bindings,
}));
