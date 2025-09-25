import {
  Cell,
  NAME,
  Recipe,
  RecipeMeta,
  RuntimeProgram,
  TYPE,
} from "@commontools/runner";
import {
  charmId,
  CharmManager,
  nameSchema,
  processSchema,
} from "../manager.ts";
import { CellPath, compileProgram, resolveCellPath } from "./utils.ts";
import { injectUserCode } from "../iframe/static.ts";
import {
  buildFullRecipe,
  getIframeRecipe,
  IFrameRecipe,
} from "../iframe/recipe.ts";

interface CharmCellIo {
  get(path?: CellPath): unknown;
  set(value: unknown, path?: CellPath): Promise<void>;
}

type CharmPropIoType = "result" | "input";

class CharmPropIo implements CharmCellIo {
  #cc: CharmController;
  #type: CharmPropIoType;
  constructor(cc: CharmController, type: CharmPropIoType) {
    this.#cc = cc;
    this.#type = type;
  }

  get(path?: CellPath) {
    const targetCell = this.#getTargetCell();
    return resolveCellPath(targetCell, path ?? []);
  }

  async set(value: unknown, path?: CellPath) {
    const manager = this.#cc.manager();

    await manager.runtime.editWithRetry((tx) => {
      const targetCell = this.#getTargetCell();

      // Build the path with transaction context
      let txCell = targetCell.withTx(tx);
      for (const segment of (path ?? [])) {
        txCell = txCell.key(segment as keyof unknown) as Cell<unknown>;
      }

      txCell.set(value);
    });

    await manager.runtime.idle();
    await manager.synced();
  }

  #getTargetCell(): Cell<unknown> {
    if (this.#type === "input") {
      return this.#cc.manager().getArgument(this.#cc.getCell());
    } else if (this.#type === "result") {
      return this.#cc.manager().getResult(this.#cc.getCell());
    }
    throw new Error(`Unknown property type "${this.#type}"`);
  }
}

export class CharmController<T = unknown> {
  #cell: Cell<T>;
  #manager: CharmManager;
  readonly id: string;

  input: CharmCellIo;
  result: CharmCellIo;

  constructor(manager: CharmManager, cell: Cell<T>) {
    const id = charmId(cell);
    if (!id) {
      throw new Error("Could not get an ID from a Cell<Charm>");
    }
    this.id = id;
    this.#manager = manager;
    this.#cell = cell;
    this.input = new CharmPropIo(this, "input");
    this.result = new CharmPropIo(this, "result");
  }

  name(): string | undefined {
    return this.#cell.asSchema(nameSchema).get()[NAME];
  }

  getCell(): Cell<T> {
    return this.#cell;
  }

  async setInput(input: object): Promise<void> {
    const recipe = await this.getRecipe();
    // Use setup/start so we can update inputs without forcing reschedule
    await execute(this.#manager, this.id, recipe, input, { start: true });
  }

  async getRecipe(): Promise<Recipe> {
    const recipeId = getRecipeIdFromCharm(this.#cell);
    const runtime = this.#manager.runtime;
    const recipe = await runtime.recipeManager.loadRecipe(
      recipeId,
      this.#manager.getSpace(),
    );
    return recipe;
  }

  getRecipeMeta(): Promise<RecipeMeta> {
    return this.#manager.runtime.recipeManager.loadRecipeMeta(
      getRecipeIdFromCharm(this.#cell),
      this.#manager.getSpace(),
    );
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

  readingFrom(): CharmController[] {
    return this.#manager.getReadingFrom(this.#cell).map((cell) =>
      new CharmController(this.#manager, cell)
    );
  }

  readBy(): CharmController[] {
    return this.#manager.getReadByCharms(this.#cell).map((cell) =>
      new CharmController(this.#manager, cell)
    );
  }

  manager(): CharmManager {
    return this.#manager;
  }
}

async function execute(
  manager: CharmManager,
  charmId: string,
  recipe: Recipe,
  input?: object,
  options?: { start?: boolean },
): Promise<void> {
  await manager.runWithRecipe(recipe, charmId, input, options);
  await manager.runtime.idle();
  await manager.synced();
}

export const getRecipeIdFromCharm = (charm: Cell<unknown>): string => {
  const sourceCell = charm.getSourceCell(processSchema);
  if (!sourceCell) throw new Error("charm missing source cell");
  return sourceCell.get()?.[TYPE];
};
