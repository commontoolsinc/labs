import {
  Cell,
  NAME,
  Recipe,
  RecipeMeta,
  RuntimeProgram,
  TYPE,
} from "@commontools/runner";
import { Charm, charmId, CharmManager, processSchema } from "../manager.ts";
import { compileProgram } from "./utils.ts";
import { injectUserCode } from "../iframe/static.ts";
import {
  buildFullRecipe,
  getIframeRecipe,
  IFrameRecipe,
} from "../iframe/recipe.ts";

export class CharmView {
  #cell: Cell<Charm>;
  #manager: CharmManager;
  readonly id: string;

  constructor(manager: CharmManager, cell: Cell<Charm>) {
    const id = charmId(cell);
    if (!id) {
      throw new Error("Could not get an ID from a Cell<Charm>");
    }
    this.id = id;
    this.#manager = manager;
    this.#cell = cell;
  }

  name(): string | undefined {
    return this.#cell.get()[NAME];
  }

  async setInput(input: object): Promise<void> {
    const recipe = await this.getRecipe();
    await execute(this.#manager, this.id, recipe, input);
  }

  getInput() {
    return this.#manager.getArgument(this.#cell).get();
  }

  getResult() {
    return this.#cell.get();
  }

  async getRecipe(): Promise<Recipe> {
    const recipeId = getRecipeIdFromCharm(this.#cell);
    return await this.#manager.runtime.recipeManager.loadRecipe(
      recipeId,
      this.#manager.getSpace(),
    );
  }

  async getRecipeMeta(): Promise<RecipeMeta> {
    return this.#manager.runtime.recipeManager.getRecipeMeta(
      await this.getRecipe(),
    ) as RecipeMeta;
  }

  // Returns an `IFrameRecipe` for the charm, or `undefined`
  // if not an iframe recipe.
  getIframeRecipe(): IFrameRecipe | undefined {
    return getIframeRecipe(this.#cell, this.#manager.runtime).iframe;
  }

  async setRecipe(program: RuntimeProgram): Promise<void> {
    const recipe = await compileProgram(this.#manager, program);
    await execute(this.#manager, this.id, recipe);
  }

  // Update charm's recipe with usercode for an iframe recipe.
  // Throws if recipe is not an iframe recipe.
  async setIframeRecipe(src: string): Promise<void> {
    const iframeRecipe = getIframeRecipe(this.#cell, this.#manager.runtime);
    if (!iframeRecipe.iframe) {
      throw new Error(`Expected charm "${this.id}" to be an iframe recipe.`);
    }
    iframeRecipe.iframe.src = injectUserCode(src);
    const recipe = await compileProgram(
      this.#manager,
      buildFullRecipe(iframeRecipe.iframe),
    );
    await execute(this.#manager, this.id, recipe);
  }

  readingFrom(): CharmView[] {
    return this.#manager.getReadingFrom(this.#cell).map((cell) =>
      new CharmView(this.#manager, cell)
    );
  }

  readBy(): CharmView[] {
    return this.#manager.getReadByCharms(this.#cell).map((cell) =>
      new CharmView(this.#manager, cell)
    );
  }
}

async function execute(
  manager: CharmManager,
  charmId: string,
  recipe: Recipe,
  input?: object,
): Promise<void> {
  await manager.runWithRecipe(recipe, charmId, input);
  await manager.runtime.idle();
  await manager.synced();
}

export const getRecipeIdFromCharm = (charm: Cell<Charm>): string => {
  const sourceCell = charm.getSourceCell(processSchema);
  if (!sourceCell) throw new Error("charm missing source cell");
  return sourceCell.get()?.[TYPE];
};
