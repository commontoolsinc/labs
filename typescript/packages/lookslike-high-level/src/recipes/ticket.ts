import { recipe, NAME } from "../recipe.js";

export const ticket = recipe("ticket", (bindings) => ({
  [NAME]: bindings.title,
  ...bindings,
}));
