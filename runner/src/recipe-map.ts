import type { Module, Recipe } from "@commontools/builder";
import { createRef } from "./doc-map.ts";
import { recipeManager } from "./recipe-manager.ts";

// This file now delegetes to the recipeManager
// All functions are preserved for backward compatibility

export function registerNewRecipe(
  recipe: Recipe,
  src?: string,
  spec?: string,
  parents?: string[],
): string {
  return recipeManager.registerNewRecipe(recipe, src, spec, parents);
}

export function registerRecipe(
  id: string,
  recipe: Recipe | Module,
  src?: string,
  spec?: string,
  parents?: string[],
): string {
  return recipeManager.registerRecipe(id, recipe, src, spec, parents);
}

export function getRecipe(id: string) {
  return recipeManager.getRecipe(id);
}

export function getRecipeId(recipe: Recipe | Module) {
  return recipeManager.getRecipeId(recipe);
}

export function getRecipeName(id: string) {
  return recipeManager.getRecipeName(id);
}

export function getRecipeSrc(id: string) {
  return recipeManager.getRecipeSrc(id);
}

export function getRecipeSpec(id: string) {
  return recipeManager.getRecipeSpec(id);
}

export function getRecipeParents(id: string) {
  return recipeManager.getRecipeParents(id);
}

export function allRecipesByName() {
  return recipeManager.allRecipesByName();
}
