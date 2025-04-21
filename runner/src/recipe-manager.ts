/**
 * RecipeManager: Unified Recipe Storage and Sync System
 *
 * Design goals:
 * 1. Single storage model: Uses cells in the storage layer for persistent storage
 * 2. Preserves recipe IDs: Maintains consistency between local and remote IDs
 * 3. Clear publishing flow: Only syncs with Blobby when explicitly requested
 * 4. Attempts to download recipes from Blobby if no cell is found
 * 5. Minimize requirements that Blobby is available for a space to run recipes
 *
 * Storage layers:
 * - In-memory cache: Fast access during runtime
 * - Cell storage: Persistent local storage
 * - Blobby storage: Remote storage for sharing recipes
 *
 * Usage:
 * - Use the singleton instance exported as `recipeManager`
 * - For backward compatibility, individual methods are also exported
 * - For new code, prefer the `recipeManager` object
 */

import { JSONSchema, Module, Recipe, Schema } from "@commontools/builder";
import { storage } from "./storage.ts";
import { createRef } from "./doc-map.ts";
import { getCell } from "./cell.ts";
import { buildRecipe } from "./local-build.ts";
import {
  createItemsKnownToStorageSet,
  loadFromBlobby,
  saveToBlobby,
} from "./blobby-storage.ts";

// Schema definitions
export const recipeSrcSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    src: { type: "string" },
    spec: { type: "string" },
    parents: { type: "array", items: { type: "string" } },
    recipeName: { type: "string" },
  },
  required: ["id", "src"],
} as const satisfies JSONSchema;

export type RecipeSrc = Schema<typeof recipeSrcSchema>;

export const recipeSrcListSchema = {
  type: "array",
  items: { ...recipeSrcSchema, asCell: true },
} as const satisfies JSONSchema;

// Type guard to check if an object is a Recipe
function isRecipe(obj: Recipe | Module): obj is Recipe {
  return "result" in obj && "nodes" in obj;
}

class RecipeManager {
  // In-memory caches
  private recipeById = new Map<string, Recipe | Module>();
  private recipeNameById = new Map<string, string>();
  private recipeByName = new Map<string, Recipe | Module>();
  private idByRecipe = new Map<Recipe | Module, string>();
  private srcById = new Map<string, string>();
  private specById = new Map<string, string>();
  private parentsById = new Map<string, string[]>();

  // Track recipes known to storage to avoid redundant saves
  private recipesKnownToStorage = createItemsKnownToStorageSet();

  // Local operations

  /**
   * Get a recipe by its ID
   */
  getRecipe(id: string): Recipe | Module | undefined {
    return this.recipeById.get(id);
  }

  /**
   * Get a recipe's ID by reference
   */
  getRecipeId(recipe: Recipe | Module): string | undefined {
    return this.idByRecipe.get(recipe);
  }

  /**
   * Get a recipe's name by ID
   */
  getRecipeName(id: string): string | undefined {
    return this.recipeNameById.get(id);
  }

  /**
   * Get a recipe's source by ID
   */
  getRecipeSrc(id: string): string | undefined {
    return this.srcById.get(id);
  }

  /**
   * Get a recipe's spec by ID
   */
  getRecipeSpec(id: string): string | undefined {
    return this.specById.get(id);
  }

  /**
   * Get a recipe's parents by ID
   */
  getRecipeParents(id: string): string[] | undefined {
    return this.parentsById.get(id);
  }

  /**
   * Get all recipes by name
   */
  allRecipesByName(): Map<string, Recipe | Module> {
    return this.recipeByName;
  }

  /**
   * Register a new recipe and generate a stable ID
   */
  registerNewRecipe(
    recipe: Recipe,
    src?: string,
    spec?: string,
    parents?: string[],
  ): string {
    if (this.idByRecipe.has(recipe)) return this.idByRecipe.get(recipe)!;

    const id = src
      ? createRef({ src }, "recipe source").toString()
      : createRef(recipe, "recipe").toString();

    return this.registerRecipe(id, recipe, src, spec, parents);
  }

  /**
   * Register a recipe with a specific ID
   */
  registerRecipe(
    id: string,
    recipe: Recipe | Module,
    src?: string,
    spec?: string,
    parents?: string[],
  ): string {
    if (this.idByRecipe.has(recipe)) return this.idByRecipe.get(recipe)!;

    this.recipeById.set(id, recipe);
    this.idByRecipe.set(recipe, id);

    if (src) this.srcById.set(id, src);
    if (spec) this.specById.set(id, spec);
    if (parents) this.parentsById.set(id, parents);

    const name = (recipe.argumentSchema as { description: string })
      ?.description;
    if (name) {
      this.recipeByName.set(name, recipe);
      this.recipeNameById.set(id, name);
    }

    return id;
  }

  // Cell storage operations

  /**
   * Save a recipe to a cell in the specified space
   */
  async saveRecipeToCell(space: string, recipeId: string): Promise<void> {
    const recipe = this.getRecipe(recipeId);
    if (!recipe) {
      throw new Error(`Recipe ${recipeId} not found`);
    }

    const src = this.getRecipeSrc(recipeId);
    if (!src) {
      throw new Error(`Source for recipe ${recipeId} not found`);
    }

    const cell = getCell(
      space,
      { recipeId, type: "recipe" },
      recipeSrcSchema,
    );

    cell.set({
      id: recipeId,
      src,
      spec: this.getRecipeSpec(recipeId),
      parents: this.getRecipeParents(recipeId),
      recipeName: this.getRecipeName(recipeId),
    });

    await storage.syncCell(cell);
    await storage.synced();
  }

  /**
   * Load a recipe from a cell in the specified space
   */
  async loadRecipeFromCell(space: string, recipeId: string): Promise<boolean> {
    const cell = getCell(
      space,
      { recipeId, type: "recipe" },
      recipeSrcSchema,
    );

    await storage.syncCell(cell);

    const recipeData = cell.get();
    if (!recipeData || recipeData.id !== recipeId) {
      return false;
    }

    const { src, spec, parents } = recipeData;

    try {
      const { recipe, errors } = await buildRecipe(src);
      if (errors || !recipe) {
        console.error(`Failed to build recipe ${recipeId}:`, errors);
        return false;
      }

      this.registerRecipe(recipeId, recipe, src, spec, parents);
      return true;
    } catch (error) {
      console.error(`Error loading recipe ${recipeId} from cell:`, error);
      return false;
    }
  }

  // Blobby operations

  /**
   * Load a recipe from Blobby
   */
  async loadFromBlobby(id: string): Promise<boolean> {
    // If we already have this recipe, no need to load it again
    if (this.getRecipe(id) && this.recipesKnownToStorage.has(id)) {
      return true;
    }

    const response = await loadFromBlobby<{
      src: string;
      spec?: string;
      parents?: string[];
    }>("spell", id);

    if (!response) return false;

    const { src, spec = "", parents = [] } = response;

    try {
      const { recipe, errors } = await buildRecipe(src);
      if (errors || !recipe) {
        console.error(`Failed to build recipe ${id} from Blobby:`, errors);
        return false;
      }

      this.registerRecipe(id, recipe, src, spec, parents);
      this.recipesKnownToStorage.add(id);
      return true;
    } catch (error) {
      console.error(`Error loading recipe ${id} from Blobby:`, error);
      return false;
    }
  }

  /**
   * Publish a recipe to Blobby
   */
  async publishToBlobby(
    id: string,
    spellbookTitle?: string,
    spellbookTags?: string[],
  ): Promise<boolean> {
    const recipe = this.getRecipe(id);
    if (!recipe) {
      throw new Error(`Recipe ${id} not found`);
    }

    const src = this.getRecipeSrc(id);
    if (!src) {
      throw new Error(`Source for recipe ${id} not found`);
    }

    // If the recipe is already known to storage and we're not adding metadata, skip
    if (
      this.recipesKnownToStorage.has(id) && !spellbookTitle && !spellbookTags
    ) {
      return true;
    }

    this.recipesKnownToStorage.add(id);

    const data = {
      src,
      recipe: JSON.parse(JSON.stringify(recipe)),
      spec: this.getRecipeSpec(id),
      parents: this.getRecipeParents(id),
      recipeName: this.getRecipeName(id),
      spellbookTitle,
      spellbookTags,
    };

    return saveToBlobby("spell", id, data);
  }

  // Combined operations

  /**
   * Ensure a recipe is available, trying cell storage first then Blobby
   */
  async ensureRecipeAvailable(
    space: string,
    recipeId: string,
  ): Promise<Recipe | Module> {
    // First check if it's already in memory
    let recipe = this.getRecipe(recipeId);
    if (recipe) return recipe;

    // Try to load from cell storage
    const loadedFromCell = await this.loadRecipeFromCell(space, recipeId);
    if (loadedFromCell) {
      recipe = this.getRecipe(recipeId);
      if (recipe) return recipe;
    }

    // Try to load from Blobby
    const loadedFromBlobby = await this.loadFromBlobby(recipeId);
    if (loadedFromBlobby) {
      recipe = this.getRecipe(recipeId);
      if (recipe) {
        // Save to cell for future use
        await this.saveRecipeToCell(space, recipeId);
        return recipe;
      }
    }

    throw new Error(
      `Could not find recipe ${recipeId} in any storage location`,
    );
  }
}

// Export a singleton instance
export const recipeManager = new RecipeManager();

// Export individual methods for backward compatibility
export const {
  getRecipe,
  getRecipeId,
  getRecipeName,
  getRecipeSrc,
  getRecipeSpec,
  getRecipeParents,
  allRecipesByName,
  registerNewRecipe,
  registerRecipe,
  ensureRecipeAvailable,
} = recipeManager;
