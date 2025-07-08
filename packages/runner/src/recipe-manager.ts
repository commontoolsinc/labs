import { JSONSchema, Module, Recipe, Schema } from "./builder/types.ts";
import { Cell } from "./cell.ts";
import type { IRecipeManager, IRuntime, MemorySpace } from "./runtime.ts";
import { createRef } from "./doc-map.ts";
import { RuntimeProgram } from "./harness/types.ts";

export const recipeMetaSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    // @deprecated Represents a recipe with a single source file
    src: { type: "string" },
    spec: { type: "string" },
    parents: { type: "array", items: { type: "string" } },
    recipeName: { type: "string" },
    program: {
      type: "object",
      properties: {
        main: { type: "string" },
        mainExport: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              contents: { type: "string" },
            },
            required: ["name", "contents"],
          },
        },
      },
      required: ["main", "files"],
    },
  },
  required: ["id"],
} as const satisfies JSONSchema;

export type RecipeMeta = Schema<typeof recipeMetaSchema>;

export class RecipeManager implements IRecipeManager {
  private inProgressCompilations = new Map<string, Promise<Recipe>>();
  private recipeMetaMap = new WeakMap<Recipe, Cell<RecipeMeta>>();
  private recipeProgramMap = new WeakMap<Recipe, string | RuntimeProgram>();
  private recipeIdMap = new Map<string, Recipe>();

  constructor(readonly runtime: IRuntime) {}

  private getRecipeMetaCell(
    { recipeId, space }: { recipeId: string; space: MemorySpace },
  ): Cell<RecipeMeta> {
    const cell = this.runtime.getCell(
      space,
      { recipeId, type: "recipe" },
      recipeMetaSchema,
    );

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

  registerRecipe(
    recipe: Recipe | Module,
    src?: string | RuntimeProgram,
  ): string {
    const id = this.recipeMetaMap.get(recipe as Recipe)?.get()?.id;
    if (id) {
      return id;
    }

    const generatedId = src
      ? createRef({ src }, "recipe source").toString()
      : createRef(recipe, "recipe").toString();

    this.recipeIdMap.set(generatedId, recipe as Recipe);
    if (src) this.recipeProgramMap.set(recipe as Recipe, src);

    return generatedId;
  }

  saveRecipe(
    { recipeId, space, recipe, recipeMeta }: {
      recipeId: string;
      space: MemorySpace;
      recipe?: Recipe | Module;
      recipeMeta?: RecipeMeta;
    },
  ): boolean {
    // FIXME(ja): should we update the recipeMeta if it already exists? when does this happen?
    if (this.recipeMetaMap.has(recipe as Recipe)) {
      return true;
    }

    if (!recipe) {
      recipe = this.recipeById(recipeId);
      if (!recipe) {
        throw new Error(`Recipe ${recipeId} not loaded`);
      }
    }

    if (!recipeMeta) {
      const src = this.recipeProgramMap.get(recipe as Recipe);
      recipeMeta = {
        id: recipeId,
        src: typeof src === "string" ? src : undefined,
        program: typeof src === "object" ? src : undefined,
      };
    }

    if (!recipeMeta.src && !recipeMeta.program) {
      return false;
    }

    const recipeMetaCell = this.getRecipeMetaCell({ recipeId, space });
    recipeMetaCell.set(recipeMeta);
    this.recipeMetaMap.set(recipe as Recipe, recipeMetaCell);
    return true;
  }

  async saveAndSyncRecipe(
    { recipeId, space, recipe, recipeMeta }: {
      recipeId: string;
      space: MemorySpace;
      recipe: Recipe | Module;
      recipeMeta: RecipeMeta;
    },
  ) {
    if (this.saveRecipe({ recipeId, space, recipe, recipeMeta })) {
      await this.runtime.storage.syncCell(
        this.getRecipeMetaCell({ recipeId, space }),
      );
    }
  }

  // returns a recipe already loaded
  recipeById(recipeId: string): Recipe | undefined {
    return this.recipeIdMap.get(recipeId);
  }

  async compileRecipe(input: string | RuntimeProgram): Promise<Recipe> {
    let program: RuntimeProgram | undefined;
    if (typeof input === "string") {
      program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: input }],
      };
    } else {
      program = input;
    }
    return await this.runtime.harness.run(program);
  }

  // we need to ensure we only compile once otherwise we get ~12 +/- 4
  // compiles of each recipe
  private async compileRecipeOnce(
    recipeId: string,
    space: MemorySpace,
  ): Promise<Recipe> {
    const metaCell = this.getRecipeMetaCell({ recipeId, space });
    await this.runtime.storage.syncCell(metaCell);
    const recipeMeta = metaCell.get();

    if (!recipeMeta.src && !recipeMeta.program) {
      throw new Error(`Recipe ${recipeId} has no stored source`);
    }

    const source = recipeMeta.program
      ? (recipeMeta.program as RuntimeProgram)
      : recipeMeta.src!;
    const recipe = await this.compileRecipe(source);
    this.recipeIdMap.set(recipeId, recipe);
    this.recipeMetaMap.set(recipe, metaCell);
    return recipe;
  }

  async loadRecipe(id: string, space: MemorySpace): Promise<Recipe> {
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
}
