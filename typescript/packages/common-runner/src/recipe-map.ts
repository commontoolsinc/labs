import { Recipe } from "@commontools/common-builder";
import { createRef } from "./cell-map.js";

const recipeById = new Map<string, Recipe>();
const recipeByName = new Map<string, Recipe>();
const idByRecipe = new Map<Recipe, string>();
const srcById = new Map<string, string>();
const specById = new Map<string, string>();

export function addRecipe(recipe: Recipe, src?: string, spec?: string): string {
  if (idByRecipe.has(recipe)) return idByRecipe.get(recipe)!;

  const id = src
    ? createRef(src, "recipe source").toString()
    : createRef(recipe, "recipe").toString();
  recipeById.set(id, recipe);
  idByRecipe.set(recipe, id);

  if (src) srcById.set(id, src);
  if (spec) specById.set(id, spec);
  const name = (recipe.argumentSchema as { description: string })?.description;
  if (name) recipeByName.set(name, recipe);

  return id;
}

export function getRecipe(id: string) {
  return recipeById.get(id);
}

export function getRecipeId(recipe: Recipe) {
  return idByRecipe.get(recipe);
}

export function getRecipeSrc(id: string) {
  return srcById.get(id);
}

export function getRecipeSpec(id: string) {
  return specById.get(id);
}

export function allRecipesByName() {
  return recipeByName;
}
