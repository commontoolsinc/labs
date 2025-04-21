import { storage } from "./storage.ts";
import { Module, Recipe } from "@commontools/builder";
import {
  recipeManager,
  recipeSrcListSchema,
  recipeSrcSchema,
} from "./recipe-manager.ts";
import { getCell } from "./cell.ts";
import { getBlobbyServerUrl, setBlobbyServerUrl } from "./blobby-storage.ts";

// For backward compatibility
export { recipeSrcListSchema, recipeSrcSchema } from "./recipe-manager.ts";

// For backward compatibility
export function setBobbyServerUrl(url: string) {
  setBlobbyServerUrl(url);
}

export async function syncRecipeBlobby(id: string) {
  console.log("syncRecipeBlobby", id);
  const recipe = recipeManager.getRecipe(id);

  if (recipe) {
    console.log("recipe exists", id);
    // Use the new manager's publishToBlobby method
    await recipeManager.publishToBlobby(id);
    return;
  }

  console.log("loading from blobby", id);
  const loaded = await recipeManager.loadFromBlobby(id);
  if (!loaded) {
    console.log("failed to load recipe from blobby", id);
  }
}

export async function ensureRecipeSourceCell(space: string, recipeId: string) {
  if (!recipeId) return;
  console.log("syncing recipe cells", recipeId);

  try {
    // Use the combined method from RecipeManager
    await recipeManager.ensureRecipeAvailable(space, recipeId);
    console.log("recipe ensured", recipeId);
  } catch (error) {
    console.error("Failed to ensure recipe:", error);
    throw error;
  }
}

// Using a deprecated function name for backward compatibility
export async function saveRecipe(
  id: string,
  src: string,
  spec?: string,
  parents?: string[],
  spellbookTitle?: string,
  spellbookTags?: string[],
): Promise<boolean> {
  console.log("saveRecipe (deprecated)", id);

  // First try to build the recipe
  const recipeOrModule = recipeManager.getRecipe(id);

  // Register the recipe if it exists
  if (recipeOrModule) {
    recipeManager.registerRecipe(id, recipeOrModule, src, spec, parents);
  }

  // Publish to Blobby
  return recipeManager.publishToBlobby(id, spellbookTitle, spellbookTags);
}
