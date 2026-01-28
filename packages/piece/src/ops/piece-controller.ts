import {
  Cell,
  NAME,
  Recipe,
  RecipeMeta,
  RuntimeProgram,
  TYPE,
} from "@commontools/runner";
import { pieceId, PieceManager } from "../manager.ts";
import { nameSchema, processSchema } from "@commontools/runner/schemas";
import { CellPath, compileProgram, resolveCellPath } from "./utils.ts";
import { injectUserCode } from "../iframe/static.ts";
import {
  buildFullRecipe,
  getIframeRecipe,
  IFrameRecipe,
} from "../iframe/recipe.ts";

interface PieceCellIo {
  get(path?: CellPath): Promise<unknown>;
  set(value: unknown, path?: CellPath): Promise<void>;
  getCell(): Promise<Cell<unknown>>;
}

type PiecePropIoType = "result" | "input";

class PiecePropIo implements PieceCellIo {
  #cc: PieceController;
  #type: PiecePropIoType;
  constructor(cc: PieceController, type: PiecePropIoType) {
    this.#cc = cc;
    this.#type = type;
  }

  async get(path?: CellPath) {
    const targetCell = await this.#getTargetCell();
    return resolveCellPath(targetCell, path ?? []);
  }

  getCell(): Promise<Cell<unknown>> {
    return this.#getTargetCell();
  }

  async set(value: unknown, path?: CellPath) {
    const manager = this.#cc.manager();
    const targetCell = await this.#getTargetCell();

    await manager.runtime.editWithRetry((tx) => {
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

  #getTargetCell(): Promise<Cell<unknown>> {
    if (this.#type === "input") {
      return Promise.resolve(
        this.#cc.manager().getArgument(this.#cc.getCell()),
      );
    } else if (this.#type === "result") {
      return Promise.resolve(this.#cc.manager().getResult(this.#cc.getCell()));
    }
    throw new Error(`Unknown property type "${this.#type}"`);
  }
}

export class PieceController<T = unknown> {
  #cell: Cell<T>;
  #manager: PieceManager;
  readonly id: string;

  input: PieceCellIo;
  result: PieceCellIo;

  constructor(manager: PieceManager, cell: Cell<T>) {
    const id = pieceId(cell);
    if (!id) {
      throw new Error("Could not get an ID from a Cell<Charm>");
    }
    this.id = id;
    this.#manager = manager;
    this.#cell = cell;
    this.input = new PiecePropIo(this, "input");
    this.result = new PiecePropIo(this, "result");
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
    const recipeId = getRecipeIdFromPiece(this.#cell);
    const runtime = this.#manager.runtime;
    const recipe = await runtime.recipeManager.loadRecipe(
      recipeId,
      this.#manager.getSpace(),
    );
    return recipe;
  }

  async getRecipeMeta(): Promise<RecipeMeta> {
    const recipeId = getRecipeIdFromPiece(this.#cell);
    const space = this.#manager.getSpace();
    // Ensure the recipe is loaded first - this populates the metadata
    await this.#manager.runtime.recipeManager.loadRecipe(recipeId, space);
    return this.#manager.runtime.recipeManager.loadRecipeMeta(recipeId, space);
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

  async readingFrom(): Promise<PieceController[]> {
    const cells = await this.#manager.getReadingFrom(this.#cell);
    return cells.map((cell) => new PieceController(this.#manager, cell));
  }

  async readBy(): Promise<PieceController[]> {
    const cells = await this.#manager.getReadByCharms(this.#cell);
    return cells.map((cell) => new PieceController(this.#manager, cell));
  }

  manager(): PieceManager {
    return this.#manager;
  }
}

async function execute(
  manager: PieceManager,
  pieceId: string,
  recipe: Recipe,
  input?: object,
  options?: { start?: boolean },
): Promise<void> {
  await manager.runWithRecipe(recipe, pieceId, input, options);
  await manager.runtime.idle();
  await manager.synced();
}

export const getRecipeIdFromPiece = (charm: Cell<unknown>): string => {
  const sourceCell = charm.getSourceCell(processSchema);
  if (!sourceCell) throw new Error("charm missing source cell");
  return sourceCell.get()?.[TYPE];
};
