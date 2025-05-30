import { JSONSchema, Module, Recipe, Schema } from "@commontools/builder";
import { Cell } from "./cell.ts";
import type { IRecipeManager, IRuntime } from "./runtime.ts";
import { createRef } from "./doc-map.ts";

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

export class RecipeManager implements IRecipeManager {
  private inProgressCompilations = new Map<string, Promise<Recipe>>();
  private recipeMetaMap = new WeakMap<Recipe, Cell<RecipeMeta>>();
  private recipeIdMap = new Map<string, Recipe>();

  constructor(readonly runtime: IRuntime) {}

  private async getRecipeMetaCell(
    { recipeId, space }: { recipeId: string; space: string },
  ): Promise<Cell<RecipeMeta>> {
    const cell = this.runtime.getCell(
      space,
      { recipeId, type: "recipe" },
      recipeMetaSchema,
    );

    await this.runtime.storage.syncCell(cell);
    await this.runtime.scheduler.idle();
    return cell;
  }

  getRecipeMeta(
    input: Recipe | Module | { recipeId: string },
  ): RecipeMeta {
    if ("recipeId" in input) {
      const recipe = this.recipeById(input.recipeId);
      if (!recipe) throw new Error(`Recipe ${input.recipeId} not loaded`);
      return this.recipeMetaMap.get(recipe)?.get()!;
    }
    return this.recipeMetaMap.get(input as Recipe)?.get()!;
  }

  generateRecipeId(recipe: Recipe | Module, src?: string): string {
    const id = this.recipeMetaMap.get(recipe as Recipe)?.get()?.id;
    if (id) {
      console.log("generateRecipeId: existing recipe id", id);
      return id;
    }

    const generatedId = src
      ? createRef({ src }, "recipe source").toString()
      : createRef(recipe, "recipe").toString();

    return generatedId;
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
    if (this.recipeMetaMap.has(recipe as Recipe)) {
      return true;
    }

    const recipeMetaCell = await this.getRecipeMetaCell({ recipeId, space });
    recipeMetaCell.set(recipeMeta);
    await this.runtime.storage.syncCell(recipeMetaCell);
    await this.runtime.storage.synced();

    this.recipeIdMap.set(recipeId, recipe as Recipe);
    this.recipeMetaMap.set(recipe as Recipe, recipeMetaCell);

    // FIXME(ja): in a week we should remove auto-publishing to blobby
    // if this patch doesn't need to be reverted
    await this.publishToBlobby(recipeId);

    return true;
  }

  // returns a recipe already loaded
  recipeById(recipeId: string): Recipe | undefined {
    return this.recipeIdMap.get(recipeId);
  }

  // we need to ensure we only compile once otherwise we get ~12 +/- 4
  // compiles of each recipe
  private async compileRecipeOnce(
    recipeId: string,
    space: string,
  ): Promise<Recipe> {
    const metaCell = await this.getRecipeMetaCell({ recipeId, space });
    let recipeMeta = metaCell.get();

    // 1. Fallback to Blobby if cell missing or stale
    if (recipeMeta?.id !== recipeId) {
      const imported = await this.importFromBlobby({ recipeId });
      recipeMeta = imported.recipeMeta;
      metaCell.set(recipeMeta);
      await this.runtime.storage.syncCell(metaCell);
      await this.runtime.storage.synced();
      this.recipeIdMap.set(recipeId, imported.recipe);
      this.recipeMetaMap.set(imported.recipe, metaCell);
      return imported.recipe;
    }

    // 2. Compile from stored source
    if (!recipeMeta.src) {
      throw new Error(`Recipe ${recipeId} has no stored source`);
    }
    const recipe = await this.runtime.harness.runSingle(recipeMeta.src);

    this.recipeIdMap.set(recipeId, recipe);
    this.recipeMetaMap.set(recipe, metaCell);
    return recipe;
  }

  async loadRecipe(id: string, space: string): Promise<Recipe> {
    const existing = this.recipeIdMap.get(id);
    if (existing) {
      return existing;
    }

    if (this.inProgressCompilations.has(id)) {
      return this.inProgressCompilations.get(id)!;
    }

    // single-flight compilation
    const compilationPromise = this.compileRecipeOnce(id, space)
      .finally(() => this.inProgressCompilations.delete(id)); // tidy up

    this.inProgressCompilations.set(id, compilationPromise);

    return await compilationPromise;
  }

  /**
   * Load a recipe from Blobby, returning the recipe and recipeMeta
   */
  // FIXME(ja): move this back to blobby!
  private async importFromBlobby(
    { recipeId }: { recipeId: string },
  ): Promise<{ recipe: Recipe; recipeMeta: RecipeMeta }> {
    const response = await fetch(
      `${this.runtime.blobbyServerUrl}/spell-${recipeId}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch recipe ${recipeId} from blobby`);
    }

    let recipeJson:
      | { src: string; spec?: string; parents?: string[] }
      | undefined;
    try {
      recipeJson = await response.json() as {
        src: string;
        spec?: string;
        parents?: string[];
      };
    } catch (error) {
      console.error(
        "Failed to fetch recipe from blobby",
        error,
        await response.text(),
      );
      throw error;
    }

    const recipe = await this.runtime.harness.runSingle(recipeJson.src!);

    return {
      recipe,
      recipeMeta: {
        id: recipeId,
        src: recipeJson.src,
        spec: recipeJson.spec,
        parents: recipeJson.parents,
      },
    };
  }

  async publishToBlobby(
    recipeId: string,
  ): Promise<void> {
    try {
      const recipe = this.recipeIdMap.get(recipeId);
      if (!recipe) {
        throw new Error(`Recipe ${recipeId} not found for publishing`);
      }

      const meta = this.getRecipeMeta({ recipeId });
      if (!meta?.src) {
        throw new Error(`Recipe ${recipeId} has no source for publishing`);
      }

      const data = {
        src: meta.src,
        recipe: JSON.parse(JSON.stringify(recipe)),
        spec: meta.spec,
        parents: meta.parents,
        recipeName: meta.recipeName,
      };

      const response = await fetch(
        `${this.runtime.blobbyServerUrl}/spell-${recipeId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(data),
        },
      );

      if (!response.ok) {
        console.warn(
          `Failed to publish recipe to blobby: ${response.statusText}`,
        );
        return;
      }

    } catch (error) {
      console.warn("Failed to publish recipe to blobby:", error);
      // Don't throw - this is optional functionality
    }
  }
}
