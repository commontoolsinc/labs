import {
  Cell,
  NAME,
  Pattern,
  PatternMeta,
  RuntimeProgram,
  TYPE,
} from "@commontools/runner";
import { pieceId, PieceManager } from "../manager.ts";
import { nameSchema, processSchema } from "@commontools/runner/schemas";
import { CellPath, compileProgram, resolveCellPath } from "./utils.ts";
import { injectUserCode } from "../iframe/static.ts";
import {
  buildFullPattern,
  getIframePattern,
  IFramePattern,
} from "../iframe/pattern.ts";

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
      throw new Error("Could not get an ID from a Cell<Piece>");
    }
    this.id = id;
    this.#manager = manager;
    this.#cell = cell;
    this.input = new PiecePropIo(this, "input");
    this.result = new PiecePropIo(this, "result");
  }

  name(): string | undefined {
    return this.#cell.asSchema(nameSchema).get()?.[NAME];
  }

  getCell(): Cell<T> {
    return this.#cell;
  }

  async setInput(input: object): Promise<void> {
    const pattern = await this.getPattern();
    // Use setup/start so we can update inputs without forcing reschedule
    await execute(this.#manager, this.id, pattern, input, { start: true });
  }

  async getPattern(): Promise<Pattern> {
    const patternId = getPatternIdFromPiece(this.#cell);
    const runtime = this.#manager.runtime;
    const pattern = await runtime.patternManager.loadPattern(
      patternId,
      this.#manager.getSpace(),
    );
    return pattern;
  }

  async getPatternMeta(): Promise<PatternMeta> {
    const patternId = getPatternIdFromPiece(this.#cell);
    const space = this.#manager.getSpace();
    // Ensure the pattern is loaded first - this populates the metadata
    await this.#manager.runtime.patternManager.loadPattern(patternId, space);
    return this.#manager.runtime.patternManager.loadPatternMeta(patternId, space);
  }

  // Returns an `IFramePattern` for the piece, or `undefined`
  // if not an iframe pattern.
  getIframePattern(): IFramePattern | undefined {
    return getIframePattern(this.#cell, this.#manager.runtime).iframe;
  }

  async setPattern(program: RuntimeProgram): Promise<void> {
    const pattern = await compileProgram(this.#manager, program);
    await execute(this.#manager, this.id, pattern);
  }

  // Update piece's pattern with usercode for an iframe pattern.
  // Throws if pattern is not an iframe pattern.
  async setIframePattern(src: string): Promise<void> {
    const iframePattern = getIframePattern(this.#cell, this.#manager.runtime);
    if (!iframePattern.iframe) {
      throw new Error(`Expected piece "${this.id}" to be an iframe pattern.`);
    }
    iframePattern.iframe.src = injectUserCode(src);
    const pattern = await compileProgram(
      this.#manager,
      buildFullPattern(iframePattern.iframe),
    );
    await execute(this.#manager, this.id, pattern);
  }

  async readingFrom(): Promise<PieceController[]> {
    const cells = await this.#manager.getReadingFrom(this.#cell);
    return cells.map((cell) => new PieceController(this.#manager, cell));
  }

  async readBy(): Promise<PieceController[]> {
    const cells = await this.#manager.getReadByPieces(this.#cell);
    return cells.map((cell) => new PieceController(this.#manager, cell));
  }

  manager(): PieceManager {
    return this.#manager;
  }
}

async function execute(
  manager: PieceManager,
  pieceId: string,
  pattern: Pattern,
  input?: object,
  options?: { start?: boolean },
): Promise<void> {
  await manager.runWithPattern(pattern, pieceId, input, options);
  await manager.runtime.idle();
  await manager.synced();
}

export const getPatternIdFromPiece = (piece: Cell<unknown>): string => {
  const sourceCell = piece.getSourceCell(processSchema);
  if (!sourceCell) throw new Error("piece missing source cell");
  return sourceCell.get()?.[TYPE];
};
