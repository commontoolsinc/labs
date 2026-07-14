import {
  Cell,
  type CellPath,
  getPatternIdentityRef,
  NAME,
  type Pattern,
  resolveCellPath,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { pieceId, PieceManager } from "../manager.ts";
import { nameSchema } from "@commonfabric/runner/schemas";
import { compileProgram } from "./utils.ts";
import { assertPatternSchemasBackwardCompatible } from "../schema-compatibility.ts";

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
    await targetCell.pull();
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

    if (this.#type === "input") {
      await manager.getResult(this.#cc.getCell()).pull();
    } else {
      await targetCell.pull();
    }
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
    const ref = getPatternIdentityRef(this.#cell);
    if (!ref) throw new Error("piece missing pattern identity");
    const runtime = this.#manager.runtime;
    const pattern = await runtime.patternManager.loadPatternByIdentity(
      ref.identity,
      ref.symbol,
      this.#manager.getSpace(),
    );
    if (!pattern) {
      throw new Error(
        `could not load pattern ${ref.identity}#${ref.symbol}`,
      );
    }
    return pattern;
  }

  /**
   * The pattern's authored source program (`{ main, mainExport?, files }`),
   * recovered from the content-addressed `pattern:<identity>` source-doc closure
   * in the piece's space. Replaces the deleted meta cell's `program`. `main` is
   * the entry filename; `mainExport` is the pattern pointer's export symbol.
   * Returns undefined when no verified source closure exists (the source docs
   * are written by every cold compile).
   */
  async getPatternSourceProgram(): Promise<
    | {
      main: string;
      mainExport?: string;
      files: { name: string; contents: string }[];
    }
    | undefined
  > {
    const ref = getPatternIdentityRef(this.#cell);
    if (!ref) throw new Error("piece missing pattern identity");
    const program = await this.#manager.runtime.patternManager
      .getPatternSourceProgramByIdentity(
        ref.identity,
        this.#manager.getSpace(),
      );
    if (!program) return undefined;
    return { ...program, mainExport: ref.symbol };
  }

  /**
   * The pattern's authored source files (see {@link getPatternSourceProgram}).
   * Returns undefined when no verified source closure exists.
   */
  async getPatternSourceFiles(): Promise<
    { name: string; contents: string }[] | undefined
  > {
    return (await this.getPatternSourceProgram())?.files;
  }

  async setPattern(program: RuntimeProgram): Promise<void> {
    const previousRef = getPatternIdentityRef(this.#cell);
    if (!previousRef) throw new Error("piece missing pattern identity");
    const previousPattern = await this.#manager.runtime.patternManager
      .loadPatternByIdentity(
        previousRef.identity,
        previousRef.symbol,
        this.#manager.getSpace(),
      );
    if (!previousPattern) {
      throw new Error(
        `could not load pattern ${previousRef.identity}#${previousRef.symbol}`,
      );
    }
    const pattern = await compileProgram(this.#manager, program);
    assertPatternSchemasBackwardCompatible(previousPattern, pattern);
    await execute(this.#manager, this.id, pattern, undefined, {
      start: true,
      expectedPatternIdentity: previousRef,
    });
    this.#cell = this.#cell.asSchema(pattern.resultSchema);
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
  options?: {
    start?: boolean;
    expectedPatternIdentity?: { identity: string; symbol: string };
  },
): Promise<void> {
  await manager.runWithPattern(pattern, pieceId, input, options);
}
