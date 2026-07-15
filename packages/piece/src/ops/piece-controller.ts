import {
  Cell,
  type CellPath,
  extractDefaultValues,
  getPatternIdentityRef,
  mergeSchemaDefaults,
  NAME,
  type Pattern,
  resolveCellPath,
  type RuntimeProgram,
  schemaAcceptsOpaqueCellValue,
} from "@commonfabric/runner";
import { validateSchemaValue } from "@commonfabric/runner/cfc";
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
    let committedTargetCell: Cell<unknown> | undefined;

    const { error } = await manager.runtime.editWithRetry((tx) => {
      // Resolve the target from the piece metadata inside every retry. A
      // concurrent setsrc may replace the argument link/schema after this
      // write starts; reusing a cell captured before the retry would then
      // write through the superseded contract.
      const piece = this.#cc.getCell().withTx(tx);
      const targetCell = this.#type === "input"
        ? manager.getArgument(piece)
        : manager.getResult(piece);
      committedTargetCell = targetCell;

      // Build the path with transaction context
      let txCell = targetCell.withTx(tx);
      for (const segment of (path ?? [])) {
        txCell = txCell.key(segment as keyof unknown) as Cell<unknown>;
      }

      const schema = targetCell.getAsNormalizedFullLink().schema ?? true;
      const nextValue = (path?.length ?? 0) === 0 && this.#type === "input"
        ? mergeSchemaDefaults<Record<string, unknown>>(
          value as Record<string, unknown> | undefined,
          extractDefaultValues(schema),
          schema,
        )
        : value;
      txCell.set(nextValue);

      if (this.#type === "input") {
        const materialized = targetCell.asSchema(undefined).withTx(tx).get();
        const issue = validateSchemaValue(
          schema,
          materialized,
          schema,
          { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
        );
        if (issue !== undefined) {
          throw new Error(`updated input does not match its schema: ${issue}`);
        }
      }
    });
    if (error) {
      if ("reason" in error && error.reason instanceof Error) {
        throw error.reason;
      }
      throw error;
    }

    const targetCell = committedTargetCell ?? await this.#getTargetCell();

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
  #mutationVersion = 0;
  #latestSuccessfulMutationVersion = 0;
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
    const mutationVersion = ++this.#mutationVersion;
    await this.#runMutation(mutationVersion, async () => {
      while (true) {
        const { pattern, ref } = await this.#loadCurrentPattern();
        try {
          // Use setup/start so we can update inputs without forcing reschedule.
          // The identity guard prevents a concurrent setsrc from being
          // overwritten by this already-loaded pattern.
          return await execute(
            this.#manager,
            this.id,
            pattern,
            input,
            { start: true, expectedPatternIdentity: ref },
          ) as Cell<T>;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes(
              "piece pattern changed while the source update was compiling",
            )
          ) {
            throw error;
          }
          // Reload and reapply the input against the durable winner.
        }
      }
    });
  }

  async getPattern(): Promise<Pattern> {
    return (await this.#loadCurrentPattern()).pattern;
  }

  async #loadCurrentPattern(): Promise<{
    pattern: Pattern;
    ref: { identity: string; symbol: string };
  }> {
    await this.#cell.sync();
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
    return { pattern, ref };
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
    const mutationVersion = ++this.#mutationVersion;
    await this.#runMutation(mutationVersion, async () => {
      const { pattern: previousPattern, ref: previousRef } = await this
        .#loadCurrentPattern();
      const pattern = await compileProgram(this.#manager, program);
      assertPatternSchemasBackwardCompatible(previousPattern, pattern);
      return await execute(this.#manager, this.id, pattern, undefined, {
        start: true,
        expectedPatternIdentity: previousRef,
      }) as Cell<T>;
    });
  }

  async #runMutation(
    mutationVersion: number,
    operation: () => Promise<Cell<T>>,
  ): Promise<void> {
    try {
      const cell = await operation();
      this.#latestSuccessfulMutationVersion = Math.max(
        this.#latestSuccessfulMutationVersion,
        mutationVersion,
      );
      if (mutationVersion === this.#mutationVersion) {
        this.#cell = cell;
      } else if (
        this.#latestSuccessfulMutationVersion === mutationVersion
      ) {
        // A newer mutation may have committed while this one was doing
        // post-commit work. If no newer mutation succeeded, reconcile from
        // durable identity instead of installing this now-stale schema view.
        await this.#refreshCellSchema(this.#mutationVersion);
      }
    } catch (error) {
      // A rejection is not evidence that setup did not commit: syncPattern()
      // and result pull both run after the atomic setup. Keep mutation versions
      // monotonic and reload the schema attached to the durable winner.
      if (this.#latestSuccessfulMutationVersion <= mutationVersion) {
        await this.#refreshCellSchema(this.#mutationVersion);
      }
      throw error;
    }
  }

  async #refreshCellSchema(refreshVersion: number): Promise<void> {
    const cell = this.#cell;
    while (
      refreshVersion === this.#mutationVersion && cell === this.#cell
    ) {
      await cell.sync();
      const refBeforeLoad = getPatternIdentityRef(cell);
      if (!refBeforeLoad) return;
      const pattern = await this.#manager.runtime.patternManager
        .loadPatternByIdentity(
          refBeforeLoad.identity,
          refBeforeLoad.symbol,
          this.#manager.getSpace(),
        );
      if (!pattern) return;
      await cell.sync();
      const refAfterLoad = getPatternIdentityRef(cell);
      if (
        !refAfterLoad ||
        refBeforeLoad.identity !== refAfterLoad.identity ||
        refBeforeLoad.symbol !== refAfterLoad.symbol
      ) {
        continue;
      }
      if (
        refreshVersion === this.#mutationVersion && cell === this.#cell
      ) {
        this.#cell = cell.asSchema(pattern.resultSchema);
      }
      return;
    }
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
): Promise<Cell<unknown>> {
  return await manager.runWithPattern(pattern, pieceId, input, options);
}
