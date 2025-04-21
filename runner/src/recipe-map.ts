import type { Module, Recipe } from "@commontools/builder";
import { createRef } from "./doc-map.ts";

const recipeById = new Map<string, Recipe | Module>();
const recipeNameById = new Map<string, string>();
const recipeByName = new Map<string, Recipe | Module>();
const idByRecipe = new Map<Recipe | Module, string>();
const srcById = new Map<string, string>();
const specById = new Map<string, string>();
const parentsById = new Map<string, string[]>();

export function registerNewRecipe(
  recipe: Recipe,
  src?: string,
  spec?: string,
  parents?: string[],
): string {
  if (idByRecipe.has(recipe)) return idByRecipe.get(recipe)!;

  const id = src
    ? createRef({ src }, "recipe source").toString()
    : createRef(recipe, "recipe").toString();

  console.log("registerNewRecipe", id);
  return registerRecipe(id, recipe, src, spec, parents);
}

export function registerRecipe(
  id: string,
  recipe: Recipe,
  src?: string,
  spec?: string,
  parents?: string[],
): string {
  if (idByRecipe.has(recipe)) return idByRecipe.get(recipe)!;

  recipeById.set(id, recipe);
  idByRecipe.set(recipe, id);

  if (src) srcById.set(id, src);
  if (spec) specById.set(id, spec);
  if (parents) parentsById.set(id, parents);
  const name = (recipe.argumentSchema as { description: string })?.description;
  if (name) {
    recipeByName.set(name, recipe);
    recipeNameById.set(id, name);
  }

  return id;
}

export function getRecipe(id: string) {
  return recipeById.get(id);
}

export function getRecipeId(recipe: Recipe | Module) {
  return idByRecipe.get(recipe);
}

export function getRecipeName(id: string) {
  return recipeNameById.get(id);
}

export function getRecipeSrc(id: string) {
  return srcById.get(id);
}

export function getRecipeSpec(id: string) {
  return specById.get(id);
}

export function getRecipeParents(id: string) {
  return parentsById.get(id);
}

export function allRecipesByName() {
  return recipeByName;
}
