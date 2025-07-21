import { JSONSchema, Module, Recipe, Schema } from "./builder/types.ts";
import { Cell } from "./cell.ts";
import type { IRecipeManager, IRuntime, MemorySpace } from "./runtime.ts";
import { createRef } from "./doc-map.ts";
import { RuntimeProgram } from "./harness/types.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

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
    tx?: IExtendedStorageTransaction,
  ): Cell<RecipeMeta> {
    const cell = this.runtime.getCell(
      space,
      { recipeId, type: "recipe" },
      recipeMetaSchema,
      tx,
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
    providedTx?: IExtendedStorageTransaction,
  ): boolean {
    const tx = providedTx ?? this.runtime.edit();

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

    const recipeMetaCell = this.getRecipeMetaCell({ recipeId, space }, tx);
    recipeMetaCell.set(recipeMeta);

    if (!providedTx) tx.commit();

    this.recipeMetaMap.set(recipe as Recipe, recipeMetaCell.withTx());
    return true;
  }

  async saveAndSyncRecipe(
    { recipeId, space, recipe, recipeMeta }: {
      recipeId: string;
      space: MemorySpace;
      recipe: Recipe | Module;
      recipeMeta: RecipeMeta;
    },
    tx?: IExtendedStorageTransaction,
  ) {
    if (this.saveRecipe({ recipeId, space, recipe, recipeMeta }, tx)) {
      await this.getRecipeMetaCell({ recipeId, space }, tx).sync();
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
    tx?: IExtendedStorageTransaction,
  ): Promise<Recipe> {
    const metaCell = this.getRecipeMetaCell({ recipeId, space }, tx);
    await metaCell.sync();
    const recipeMeta = metaCell.get();

    if (!recipeMeta.src && !recipeMeta.program) {
      throw new Error(`Recipe ${recipeId} has no stored source`);
    }

    const source = recipeMeta.program
      ? (recipeMeta.program as RuntimeProgram)
      : recipeMeta.src!;
    const recipe = await this.compileRecipe(source);
    this.recipeIdMap.set(recipeId, recipe);
    this.recipeMetaMap.set(recipe, metaCell.withTx());
    return recipe;
  }

  async loadRecipe(
    id: string,
    space: MemorySpace,
    tx?: IExtendedStorageTransaction,
  ): Promise<Recipe> {
    const existing = this.recipeIdMap.get(id);
    if (existing) {
      return existing;
    }

    if (this.inProgressCompilations.has(id)) {
      return this.inProgressCompilations.get(id)!;
    }

    // single-flight compilation
    const compilationPromise = this.compileRecipeOnce(id, space, tx)
      .finally(() => this.inProgressCompilations.delete(id)); // tidy up

    this.inProgressCompilations.set(id, compilationPromise);

    return await compilationPromise;
  }
}
