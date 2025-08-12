import { getLogger } from "@commontools/utils/logger";
import {
  JSONSchema,
  Module,
  Recipe,
  Schema,
  unsafe_originalRecipe,
} from "./builder/types.ts";
import { Cell } from "./cell.ts";
import type { IRecipeManager, IRuntime, MemorySpace } from "./runtime.ts";
import { createRef } from "./doc-map.ts";
import { RuntimeProgram } from "./harness/types.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

const logger = getLogger("recipe-manager");

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
  // Maps keyed by recipeId for consistent lookups
  private recipeMetaCellById = new Map<string, Cell<RecipeMeta>>();
  private recipeProgramById = new Map<string, string | RuntimeProgram>();
  private recipeIdMap = new Map<string, Recipe>();
  // Map from recipe object instance to recipeId
  private recipeToIdMap = new WeakMap<Recipe, string>();
  // Pending metadata set before the meta cell exists (e.g., spec, parents)
  private pendingMetaById = new Map<string, Partial<RecipeMeta>>();

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

  private findOriginalRecipe(recipe: Recipe): Recipe {
    while (recipe[unsafe_originalRecipe]) {
      recipe = recipe[unsafe_originalRecipe];
    }
    return recipe;
  }

  getRecipeMeta(
    input: Recipe | Module | { recipeId: string },
  ): RecipeMeta {
    let recipeId: string | undefined;
    if ("recipeId" in input) {
      recipeId = input.recipeId;
    } else if (input && typeof input === "object") {
      recipeId = this.recipeToIdMap.get(
        this.findOriginalRecipe(input as Recipe),
      );
    }

    if (!recipeId) throw new Error("Recipe is not registered");

    const cell = this.recipeMetaCellById.get(recipeId);
    if (cell) return cell.get();

    // If we don't have a stored cell yet, return whatever pending/meta we have
    const pending = this.pendingMetaById.get(recipeId) ?? {};
    const source = this.recipeProgramById.get(recipeId);
    if (!source && Object.keys(pending).length === 0) {
      throw new Error(`Recipe ${recipeId} has no metadata available`);
    }
    const meta: RecipeMeta = {
      id: recipeId,
      ...(typeof source === "string" ? { src: source } : {}),
      ...(typeof source === "object" ? { program: source } : {}),
      ...(pending as Partial<RecipeMeta>),
    } as RecipeMeta;
    return meta;
  }

  registerRecipe(
    recipe: Recipe | Module,
    src?: string | RuntimeProgram,
  ): string {
    // Walk up derivation copies to original
    recipe = this.findOriginalRecipe(recipe as Recipe);

    // If this recipe object was already registered, return its id
    const existingId = this.recipeToIdMap.get(recipe);
    if (existingId) return existingId;

    const generatedId = src
      ? createRef({ src }, "recipe source").toString()
      : createRef(recipe, "recipe").toString();

    // If an id already exists for this source/recipe, reuse it
    if (this.recipeIdMap.has(generatedId)) return generatedId;

    // Register fresh
    this.recipeIdMap.set(generatedId, recipe as Recipe);
    this.recipeToIdMap.set(recipe as Recipe, generatedId);
    if (src) this.recipeProgramById.set(generatedId, src);

    return generatedId;
  }

  saveRecipe(
    { recipeId, space }: {
      recipeId: string;
      space: MemorySpace;
    },
    providedTx?: IExtendedStorageTransaction,
  ): boolean {
    // HACK(seefeld): Let's always use a new transaction for now. The reason is
    // that this will fail when saving the same recipe again, even though it's
    // identical (it's effecively content addresed). So let's just parallelize
    // and eat the conflict, until we support these kinds of writes properly.
    providedTx = undefined;

    const tx = providedTx ?? this.runtime.edit();

    // Already saved
    if (this.recipeMetaCellById.has(recipeId)) {
      return true;
    }

    const srcOrProgram = this.recipeProgramById.get(recipeId);
    if (!srcOrProgram) return false;

    const pending = this.pendingMetaById.get(recipeId) ?? {};
    const recipeMeta: RecipeMeta = {
      id: recipeId,
      ...(typeof srcOrProgram === "string"
        ? { src: srcOrProgram }
        : { program: srcOrProgram }),
      ...(pending as Partial<RecipeMeta>),
    } as RecipeMeta;

    const recipeMetaCell = this.getRecipeMetaCell({ recipeId, space }, tx);
    recipeMetaCell.set(recipeMeta);

    if (!providedTx) {
      tx.commit().then((result) => {
        if (result.error) {
          logger.warn("Recipe already existed", recipeId);
        }
      });
    }

    this.recipeMetaCellById.set(recipeId, recipeMetaCell.withTx());
    // If we have a recipe object for this id, ensure the back mapping exists
    const recipe = this.recipeIdMap.get(recipeId);
    if (recipe) this.recipeToIdMap.set(recipe, recipeId);
    // Clear pending once persisted
    this.pendingMetaById.delete(recipeId);
    return true;
  }

  async saveAndSyncRecipe(
    { recipeId, space }: {
      recipeId: string;
      space: MemorySpace;
    },
    tx?: IExtendedStorageTransaction,
  ) {
    if (this.saveRecipe({ recipeId, space }, tx)) {
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
    this.recipeToIdMap.set(recipe, recipeId);
    this.recipeMetaCellById.set(recipeId, metaCell.withTx());
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

  /**
   * Set or update metadata fields for a recipe before or after saving.
   * If the metadata cell already exists, it updates it in-place.
   * Otherwise, it stores the fields to be applied on the next save.
   */
  setRecipeMetaFields(recipeId: string, fields: Partial<RecipeMeta>): void {
    const cell = this.recipeMetaCellById.get(recipeId);
    if (cell) {
      const current = cell.get();
      cell.set({ ...current, ...fields, id: recipeId });
    } else {
      const pending = this.pendingMetaById.get(recipeId) ?? {};
      this.pendingMetaById.set(recipeId, { ...pending, ...fields });
    }
  }
}
