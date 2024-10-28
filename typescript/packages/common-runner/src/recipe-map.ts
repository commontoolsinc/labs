import { Recipe } from "@commontools/common-builder";

// TODO: Make this a map of hashes that get persisted
export const recipeById = new Map<string, Recipe>();

let unknownCounter = 0;
export function addRecipe(recipe: Recipe) {
  const id =
    (recipe.schema as { description: string })?.description ??
    `unknown-${unknownCounter++}`;

  recipeById.set(id, recipe);

  return id;
}

export function getRecipe(id: string) {
  return recipeById.get(id);
}
