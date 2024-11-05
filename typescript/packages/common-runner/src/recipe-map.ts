import { Recipe } from "@commontools/common-builder";
import { createRef } from "./cell-map.js";

const recipeById = new Map<string, Recipe>();
const recipeByName = new Map<string, Recipe>();

export function addRecipe(recipe: Recipe) {
  const id = createRef(recipe, "recipe").toString();
  recipeById.set(id, recipe);

  const name = (recipe.schema as { description: string })?.description;
  if (name) recipeByName.set(name, recipe);

  return id;
}

export function getRecipe(id: string) {
  return recipeById.get(id);
}

export function allRecipesByName() {
  return recipeByName;
}
