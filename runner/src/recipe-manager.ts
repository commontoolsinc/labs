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
 * - For new code, prefer the `recipeManager` object
 */

import { JSONSchema, Module, Recipe, Schema } from "@commontools/builder";
import { storage } from "./storage.ts";
import { Cell } from "./cell.ts";
import { createRef } from "./doc-map.ts";
import { getCell } from "./cell.ts";
import { buildRecipe } from "./local-build.ts";
import { getBlobbyServerUrl } from "./blobby-storage.ts";

// Schema definitions
export const recipeMetaSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    src: { type: "string" },
    spec: { type: "string" },
    parents: { type: "array", items: { type: "string" } },
    recipeName: { type: "string" },
  },
  required: ["id"],
} as const satisfies JSONSchema;

export type RecipeMeta = Schema<typeof recipeMetaSchema>;

// Type guard to check if an object is a Recipe
function isRecipe(obj: Recipe | Module): obj is Recipe {
  return "result" in obj && "nodes" in obj;
}

// FIXME(ja): what happens when we have multiple active spaces... how do we make
// sure we register the same recipeMeta in multiple spaces?
const recipeMetaMap = new WeakMap<Recipe, Cell<RecipeMeta>>();
const recipeIdMap = new Map<string, Recipe>();

class RecipeManager {
  private async getRecipeMetaCell(
    { recipeId, space }: { recipeId: string; space: string },
  ) {
    const cell = getCell(
      space,
      { recipeId, type: "recipe" },
      recipeMetaSchema,
    );

    await storage.syncCell(cell);
    await storage.synced();
    return cell;
  }

  // returns the recipeMeta for a loaded recipe
  getRecipeMeta(
    input: Recipe | Module | { recipeId: string },
  ): RecipeMeta | undefined {
    if ("recipeId" in input) {
      const recipe = this.recipeById(input.recipeId);
      return recipe ? recipeMetaMap.get(recipe)?.get() : undefined;
    }
    return recipeMetaMap.get(input as Recipe)?.get();
  }

  generateRecipeId(recipe: Recipe | Module, src?: string) {
    let id = recipeMetaMap.get(recipe as Recipe)?.get()?.id;
    if (id) {
      console.log("generateRecipeId: existing recipe id", id);
      return id;
    }

    id = src
      ? createRef({ src }, "recipe source").toString()
      : createRef(recipe, "recipe").toString();

    console.log("generateRecipeId: generated id", id);

    return id;
  }

  async registerRecipe(
    { recipeId, space, recipe, recipeMeta }: {
      recipeId: string;
      space: string;
      recipe: Recipe | Module;
      recipeMeta: RecipeMeta;
    },
  ): Promise<boolean> {
    console.log("registerRecipe", recipeId, space);

    // FIXME(ja): is there a reason to save if we don't have src?
    // mostly wondering about modules...
    if (!recipeMeta.src) {
      console.error(
        "registerRecipe: no reason to save recipe, missing src",
        recipeId,
      );
      return false;
    }

    // FIXME(ja): should we update the recipeMeta if it already exists? when does this happen?
    if (recipeMetaMap.has(recipe as Recipe)) {
      return true;
    }

    const recipeMetaCell = await this.getRecipeMetaCell({ recipeId, space });
    recipeMetaCell.set(recipeMeta);
    recipeMetaMap.set(recipe as Recipe, recipeMetaCell);
    await storage.syncCell(recipeMetaCell);
    await storage.synced();

    recipeIdMap.set(recipeId, recipe as Recipe);
    recipeMetaMap.set(recipe as Recipe, recipeMetaCell);

    return true;
  }

  // returns a recipe already loaded
  recipeById(recipeId: string): Recipe | undefined {
    return recipeIdMap.get(recipeId);
  }

  async loadRecipe(
    { space, recipeId }: { space: string; recipeId: string },
  ): Promise<Recipe | undefined> {
    if (recipeIdMap.has(recipeId)) {
      return recipeIdMap.get(recipeId);
    }

    const metaCell = await this.getRecipeMetaCell({ recipeId, space });

    const recipeMeta = metaCell.get();
    // if we don't have the recipeMeta, we should try to import from blobby
    // as it might be from before we started saving recipes in cells
    if (recipeMeta.id !== recipeId) {
      const { recipe, recipeMeta } = await this.importFromBlobby({ recipeId });
      if (recipe) {
        metaCell.set(recipeMeta);
        await storage.syncCell(metaCell);
        await storage.synced();
        recipeIdMap.set(recipeId, recipe);
        recipeMetaMap.set(recipe, metaCell);
        return recipe;
      }
      return undefined;
    }

    const { src } = recipeMeta;

    const { recipe, errors } = await buildRecipe(src!);
    if (errors || !recipe) {
      console.error(`Failed to build recipe ${recipeId}:`, errors);
      return undefined;
    }

    metaCell.set(recipeMeta);
    await storage.syncCell(metaCell);
    await storage.synced();
    recipeIdMap.set(recipeId, recipe);
    recipeMetaMap.set(recipe, metaCell);
    return recipe;
  }

  /**
   * Load a recipe from Blobby, returning the recipe and recipeMeta
   */
  // FIXME(ja): move this back to blobby!
  private async importFromBlobby(
    { recipeId }: { recipeId: string },
  ): Promise<
    { recipe: Recipe; recipeMeta: RecipeMeta } | Record<string, never>
  > {
    const response = await fetch(`${getBlobbyServerUrl()}/spell-${recipeId}`);
    if (!response.ok) {
      return {};
    }

    const recipeJson = await response.json() as {
      src: string;
      spec?: string;
      parents?: string[];
    };

    try {
      const { recipe, errors } = await buildRecipe(recipeJson.src!);
      if (errors || !recipe) {
        console.error(
          `Failed to build recipe ${recipeId} from Blobby:`,
          errors,
        );
        return {};
      }

      return {
        recipe,
        recipeMeta: {
          id: recipeId,
          src: recipeJson.src,
          spec: recipeJson.spec,
          parents: recipeJson.parents,
        },
      };
    } catch (error) {
      console.error(`Error loading recipe ${recipeId} from Blobby:`, error);
      return {};
    }
  }

  // FIXME(ja): move this back to blobby!
  async publishToBlobby(
    recipeId: string,
    spellbookTitle?: string,
    spellbookTags?: string[],
  ) {
    const recipe = recipeIdMap.get(recipeId);
    if (!recipe) {
      throw new Error(`Recipe ${recipeId} not found`);
    }
    const recipeMeta = recipeMetaMap.get(recipe)?.get();
    if (!recipeMeta) {
      throw new Error(`Recipe meta for recipe ${recipeId} not found`);
    }

    if (!recipeMeta.src) {
      throw new Error(`Source for recipe ${recipeId} not found`);
    }

    const data = {
      src: recipeMeta.src,
      recipe: JSON.parse(JSON.stringify(recipe)),
      spec: recipeMeta.spec,
      parents: recipeMeta.parents,
      recipeName: recipeMeta.recipeName,
      spellbookTitle,
      spellbookTags,
    };

    console.log(`Saving spell-${recipeId}`);
    const response = await fetch(`${getBlobbyServerUrl()}/spell-${recipeId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    return response.ok;
  }

  /**
   * Ensure a recipe is available, trying cell storage first then Blobby
   */
  async ensureRecipeAvailable({
    space,
    recipeId,
  }: {
    space: string;
    recipeId: string;
  }): Promise<Recipe | Module> {
    // First check if it's already in memory
    let recipe = recipeIdMap.get(recipeId);
    if (recipe) return recipe;

    // Try to load from cell storage
    const loadedFromCell = await this.loadRecipe({ space, recipeId });
    if (loadedFromCell) {
      recipe = loadedFromCell;
      if (recipe) return recipe;
    }

    // Try to load from Blobby
    const loadedFromBlobby = await this.importFromBlobby({ recipeId });
    if (loadedFromBlobby) {
      recipe = loadedFromBlobby.recipe;
      if (recipe) {
        // Save to cell for future use
        await this.registerRecipe({
          recipeId,
          space,
          recipe,
          recipeMeta: loadedFromBlobby.recipeMeta,
        });
        return recipe;
      }
    }

    throw new Error(
      `Could not find recipe ${recipeId} in any storage location`,
    );
  }
}

export const recipeManager = new RecipeManager();
export const {
  getRecipeMeta,
  generateRecipeId,
  registerRecipe,
  loadRecipe,
  ensureRecipeAvailable,
  publishToBlobby,
  recipeById,
} = recipeManager;
