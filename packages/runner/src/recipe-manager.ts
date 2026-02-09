import { getLogger } from "@commontools/utils/logger";
import {
  JSONSchema,
  Module,
  Recipe,
  Schema,
  unsafe_originalRecipe,
} from "./builder/types.ts";
import { Cell } from "./cell.ts";
import type { MemorySpace, Runtime } from "./runtime.ts";
import { createRef } from "./create-ref.ts";
import { RuntimeProgram } from "./harness/types.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

const logger = getLogger("recipe-manager");

/**
 * Maximum number of recipes to cache in memory.
 * When exceeded, oldest (least recently used) recipes are evicted.
 * Set conservatively to prevent OOM in long-running processes and tests.
 */
const MAX_RECIPE_CACHE_SIZE = 100;

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

export class RecipeManager {
  private inProgressCompilations = new Map<string, Promise<Recipe>>();
  // Maps keyed by recipeId for consistent lookups
  private recipeMetaCellById = new Map<string, Cell<RecipeMeta>>();
  private recipeIdMap = new Map<string, Recipe>();
  // Map from recipe object instance to recipeId
  private recipeToIdMap = new WeakMap<Recipe, string>();
  // Pending metadata set before the meta cell exists (e.g., spec, parents)
  private pendingMetaById = new Map<string, Partial<RecipeMeta>>();
  // Pending recipe save commits (fire-and-forget in saveRecipe).
  private pendingRecipeCommits: Promise<unknown>[] = [];

  constructor(readonly runtime: Runtime) {}

  /**
   * Wait for all pending recipe metadata commits to complete.
   * Call this to ensure recipe data is persisted (especially important
   * for v2 remote transport where commits are async WebSocket roundtrips).
   */
  async flush(): Promise<void> {
    if (this.pendingRecipeCommits.length > 0) {
      await Promise.all(this.pendingRecipeCommits);
      this.pendingRecipeCommits = [];
    }
  }

  /**
   * Evict oldest recipes if cache exceeds MAX_RECIPE_CACHE_SIZE.
   * Uses Map insertion order for LRU - oldest entries are first.
   */
  private evictIfNeeded(): void {
    while (this.recipeIdMap.size > MAX_RECIPE_CACHE_SIZE) {
      const oldestId = this.recipeIdMap.keys().next().value;
      if (oldestId === undefined) break;

      // Remove from all caches
      this.recipeIdMap.delete(oldestId);
      this.recipeMetaCellById.delete(oldestId);
      // Note: recipeToIdMap is WeakMap, will be GC'd when recipe is collected

      logger.debug(
        "recipe-manager",
        `Evicted recipe ${oldestId} (cache size: ${this.recipeIdMap.size})`,
      );
    }
  }

  /**
   * Touch a recipe to mark it as recently used (moves to end of Map).
   * Call this on cache hits to maintain LRU order.
   */
  private touchRecipe(recipeId: string): void {
    const recipe = this.recipeIdMap.get(recipeId);
    if (recipe) {
      // Re-insert to move to end (most recently used)
      this.recipeIdMap.delete(recipeId);
      this.recipeIdMap.set(recipeId, recipe);
    }

    const metaCell = this.recipeMetaCellById.get(recipeId);
    if (metaCell) {
      this.recipeMetaCellById.delete(recipeId);
      this.recipeMetaCellById.set(recipeId, metaCell);
    }
  }

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

  async loadRecipeMeta(
    recipeId: string,
    space: MemorySpace,
  ): Promise<RecipeMeta> {
    const cell = this.getRecipeMetaCell({ recipeId, space });
    await cell.sync();
    return cell.get();
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
    const source = this.recipeIdMap.get(recipeId)?.program;
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

    if (src && !recipe.program) {
      if (typeof src === "string") {
        recipe.program = {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: src }],
        };
      } else {
        recipe.program = src;
      }
    }

    // If this recipe object was already registered, return its id
    const existingId = this.recipeToIdMap.get(recipe);
    if (existingId) return existingId;

    const generatedId = src
      ? createRef({ src }, "recipe source").toString()
      : createRef(recipe, "recipe").toString();

    this.recipeToIdMap.set(recipe as Recipe, generatedId);

    if (!this.recipeIdMap.has(generatedId)) {
      this.recipeIdMap.set(generatedId, recipe as Recipe);
      this.evictIfNeeded();
    } else {
      // Recipe exists - touch to mark as recently used
      this.touchRecipe(generatedId);
    }

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

    const program = this.recipeIdMap.get(recipeId)?.program;
    if (!program) return false;

    const pending = this.pendingMetaById.get(recipeId) ?? {};
    const recipeMeta: RecipeMeta = {
      id: recipeId,
      program,
      ...(pending as Partial<RecipeMeta>),
    } as RecipeMeta;

    const recipeMetaCell = this.getRecipeMetaCell({ recipeId, space }, tx);
    recipeMetaCell.set(recipeMeta);

    if (!providedTx) {
      const commitPromise = tx.commit().then((result) => {
        if (result.error) {
          logger.warn("recipe", "Recipe already existed", recipeId);
        }
      });
      this.pendingRecipeCommits.push(commitPromise);
    }

    this.recipeMetaCellById.set(recipeId, recipeMetaCell.withTx());
    // If we have a recipe object for this id, ensure the back mapping exists
    const recipe = this.recipeIdMap.get(recipeId);
    if (recipe) this.recipeToIdMap.set(recipe, recipeId);
    // Clear pending once persisted
    this.pendingMetaById.delete(recipeId);
    // Evict if cache is full
    this.evictIfNeeded();
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
    const recipe = this.recipeIdMap.get(recipeId);
    if (recipe) {
      // Touch to mark as recently used
      this.touchRecipe(recipeId);
    }
    return recipe;
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
    const recipe = await this.runtime.harness.run(program);
    recipe.program = program;
    return recipe;
  }

  /**
   * Compile a recipe from source, or return a cached/in-flight result.
   * Provides single-flight deduplication based on program content.
   *
   * @param input - Source code string or RuntimeProgram to compile
   * @returns The compiled recipe (from cache, in-flight compilation, or new)
   */
  compileOrGetRecipe(input: string | RuntimeProgram): Promise<Recipe> {
    // Normalize to RuntimeProgram
    let program: RuntimeProgram;
    if (typeof input === "string") {
      program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: input }],
      };
    } else {
      program = input;
    }

    // Compute deterministic recipeId (matches registerRecipe's ID generation)
    const recipeId = createRef({ src: program }, "recipe source").toString();

    // Check cache
    const existing = this.recipeIdMap.get(recipeId);
    if (existing) {
      this.touchRecipe(recipeId);
      return Promise.resolve(existing);
    }

    // Check in-flight compilation (single-flight deduplication)
    const inProgress = this.inProgressCompilations.get(recipeId);
    if (inProgress) {
      return inProgress;
    }

    // Compile with single-flight pattern
    const compilationPromise = this.compileRecipe(program)
      .then((recipe) => {
        // Register directly with pre-computed recipeId to avoid double-hashing
        // (registerRecipe would recompute the same hash from program)
        recipe = this.findOriginalRecipe(recipe);
        this.recipeToIdMap.set(recipe, recipeId);
        if (!this.recipeIdMap.has(recipeId)) {
          this.recipeIdMap.set(recipeId, recipe);
          this.evictIfNeeded();
        }
        return recipe;
      })
      .finally(() => {
        this.inProgressCompilations.delete(recipeId);
      });

    this.inProgressCompilations.set(recipeId, compilationPromise);
    return compilationPromise;
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
    this.evictIfNeeded();
    return recipe;
  }

  async loadRecipe(
    id: string,
    space: MemorySpace,
    tx?: IExtendedStorageTransaction,
  ): Promise<Recipe> {
    const existing = this.recipeIdMap.get(id);
    if (existing) {
      // Touch to mark as recently used
      this.touchRecipe(id);
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
  async setRecipeMetaFields(
    recipeId: string,
    fields: Partial<RecipeMeta>,
  ): Promise<void> {
    const cell = this.recipeMetaCellById.get(recipeId);
    if (cell) {
      const current = cell.get();
      await this.runtime.editWithRetry((tx) => {
        cell.withTx(tx).set({ ...current, ...fields, id: recipeId });
      });
    } else {
      const pending = this.pendingMetaById.get(recipeId) ?? {};
      this.pendingMetaById.set(recipeId, { ...pending, ...fields });
    }
  }
}
