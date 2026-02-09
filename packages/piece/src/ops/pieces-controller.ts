import {
  type Cell,
  type JSONSchema,
  Runtime,
  RuntimeProgram,
  type Schema,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import { type NameSchema, nameSchema } from "@commontools/runner/schemas";
import { PieceManager } from "../index.ts";
import { PieceController } from "./piece-controller.ts";
import { compileProgram } from "./utils.ts";
import { createSession, Identity } from "@commontools/identity";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { ACLManager } from "./acl-manager.ts";

export interface CreatePieceOptions {
  input?: object;
  start?: boolean;
}

export class PiecesController<T = unknown> {
  #manager: PieceManager;
  #disposed = false;

  constructor(manager: PieceManager) {
    this.#manager = manager;
  }

  manager(): PieceManager {
    this.disposeCheck();
    return this.#manager;
  }

  async create<U = T>(
    program: RuntimeProgram | string,
    options: CreatePieceOptions = {},
    cause: string | undefined = undefined,
  ): Promise<PieceController<U>> {
    this.disposeCheck();
    const recipe = await compileProgram(this.#manager, program);
    const piece = await this.#manager.runPersistent<U>(
      recipe,
      options.input,
      cause,
      undefined,
      { start: options.start ?? true },
    );
    await this.#manager.runtime.idle();
    await this.#manager.synced();
    await this.#manager.runtime.recipeManager.flush();
    return new PieceController<U>(this.#manager, piece);
  }

  async get<S extends JSONSchema = JSONSchema>(
    pieceId: string,
    runIt: boolean,
    schema: S,
  ): Promise<PieceController<Schema<S>>>;
  async get<T = unknown>(
    pieceId: string,
    runIt?: boolean,
    schema?: JSONSchema,
  ): Promise<PieceController<T>>;
  async get(
    pieceId: string,
    runIt: boolean = false,
    schema?: JSONSchema,
  ): Promise<PieceController> {
    this.disposeCheck();
    const cell = await (await this.#manager.get(pieceId, runIt, schema)).sync();
    return new PieceController(this.#manager, cell);
  }

  async getAllPieces() {
    this.disposeCheck();
    const piecesCell = await this.#manager.getPieces();
    const pieces = piecesCell.get();
    return pieces.map((piece) => new PieceController(this.#manager, piece));
  }

  async remove(pieceId: string): Promise<boolean> {
    this.disposeCheck();
    const piece = this.#manager.runtime.getCellFromEntityId(
      this.#manager.getSpace(),
      { "/": pieceId },
    );
    const removed = await this.#manager.remove(piece);
    // Ensure full synchronization
    if (removed) {
      await this.#manager.runtime.idle();
      await this.#manager.synced();
    }
    return removed;
  }

  async start(pieceId: string): Promise<void> {
    this.disposeCheck();
    await this.#manager.startPiece(pieceId);
  }

  async stop(pieceId: string): Promise<void> {
    this.disposeCheck();
    await this.#manager.stopPiece(pieceId);
  }

  async dispose() {
    this.disposeCheck();
    this.#disposed = true;
    await this.#manager.runtime.dispose();
  }

  private disposeCheck() {
    if (this.#disposed) {
      throw new Error("PiecesController has been disposed.");
    }
  }

  static async initialize({ apiUrl, identity, spaceName }: {
    apiUrl: URL;
    identity: Identity;
    spaceName: string;
  }): Promise<PiecesController> {
    const session = await createSession({ identity, spaceName });
    const runtime = new Runtime({
      apiUrl: new URL(apiUrl),
      storageManager: StorageManager.open({
        as: session.as,
        address: new URL("/api/storage/memory", apiUrl),
        spaceIdentity: session.spaceIdentity,
      }),
    });

    const manager = new PieceManager(session, runtime);
    await manager.synced();
    return new PiecesController(manager);
  }

  acl(): ACLManager {
    return new ACLManager(this.#manager.runtime, this.#manager.getSpace());
  }

  /**
   * Recreates the default pattern from scratch.
   * Stops and unlinks the existing default pattern, then creates a new one.
   * This is useful for resetting the space's default pattern state.
   *
   * @returns The newly created default pattern piece
   */
  async recreateDefaultPattern(): Promise<PieceController<NameSchema>> {
    this.disposeCheck();

    // Stop and unlink the existing default pattern first (before any operations that might fail)
    // We need to stop it to prevent resource leaks or duplicate behavior from the old pattern
    // Access the space cell directly to get the pattern reference without running it
    const spaceCellContents = this.#manager.getSpaceCellContents();
    const defaultPatternRef = spaceCellContents.key("defaultPattern").get();
    if (defaultPatternRef) {
      // Stop the existing pattern (no-op if not running)
      this.#manager.runtime.runner.stop(defaultPatternRef);
    }
    await this.#manager.unlinkDefaultPattern();

    // Determine which pattern to use based on space type
    const isHomeSpace =
      this.#manager.getSpace() === this.#manager.runtime.userIdentityDID;

    const patternConfig = isHomeSpace
      ? {
        name: "Home",
        urlPath: "/api/patterns/system/home.tsx",
        cause: `home-pattern-${Date.now()}`, // Unique cause to create new cell
      }
      : {
        name: "DefaultPieceList",
        urlPath: "/api/patterns/system/default-app.tsx",
        cause: `space-root-${Date.now()}`, // Unique cause to create new cell
      };

    const patternUrl = new URL(
      patternConfig.urlPath,
      this.#manager.runtime.apiUrl,
    );

    // Load and compile the pattern
    const program = await this.#manager.runtime.harness.resolve(
      new HttpProgramResolver(patternUrl.href),
    );
    const recipe = await this.#manager.runtime.recipeManager.compileRecipe(
      program,
    );

    // Create new piece cell
    let pieceCell: Cell<NameSchema>;

    await this.#manager.runtime.editWithRetry((tx) => {
      // Create piece cell within this transaction
      pieceCell = this.#manager.runtime.getCell<NameSchema>(
        this.#manager.getSpace(),
        patternConfig.cause,
        nameSchema,
        tx,
      );

      // Run pattern setup within same transaction
      this.#manager.runtime.run(tx, recipe, {}, pieceCell);

      // Link as default pattern within same transaction
      const spaceCellWithTx = this.#manager.getSpaceCellContents().withTx(tx);
      const defaultPatternCell = spaceCellWithTx.key("defaultPattern");
      defaultPatternCell.set(pieceCell.withTx(tx));
    });

    // Fetch the final result
    const finalPattern = await this.#manager.getDefaultPattern();
    if (!finalPattern) {
      throw new Error("Failed to create default pattern");
    }

    // Start the piece
    await this.#manager.startPiece(finalPattern);
    await this.#manager.runtime.idle();
    await this.#manager.synced();

    return new PieceController<NameSchema>(this.#manager, finalPattern);
  }

  /**
   * Ensures a default pattern exists for this space, creating it if necessary.
   * For home spaces, uses home.tsx; for other spaces, uses default-app.tsx.
   * This makes CLI-created spaces work the same as Shell-created spaces.
   *
   * Uses the transaction system's optimistic concurrency control to handle
   * race conditions - if multiple processes try to create the pattern
   * simultaneously, the first successful commit wins and others gracefully
   * discover the existing pattern on retry.
   *
   * @returns The default pattern piece, either existing or newly created
   */
  async ensureDefaultPattern(): Promise<PieceController<NameSchema>> {
    this.disposeCheck();

    // Fast path: check if pattern already exists (outside transaction)
    const existingPattern = await this.#manager.getDefaultPattern();
    if (existingPattern) {
      return new PieceController<NameSchema>(this.#manager, existingPattern);
    }

    // Determine which pattern to use based on space type
    const isHomeSpace =
      this.#manager.getSpace() === this.#manager.runtime.userIdentityDID;

    const patternConfig = isHomeSpace
      ? {
        name: "Home",
        urlPath: "/api/patterns/system/home.tsx",
        cause: "home-pattern",
      }
      : {
        name: "DefaultPieceList",
        urlPath: "/api/patterns/system/default-app.tsx",
        cause: "space-root",
      };

    const patternUrl = new URL(
      patternConfig.urlPath,
      this.#manager.runtime.apiUrl,
    );

    // Load and compile the pattern (async work outside transaction)
    const program = await this.#manager.runtime.harness.resolve(
      new HttpProgramResolver(patternUrl.href),
    );
    const recipe = await this.#manager.runtime.recipeManager.compileRecipe(
      program,
    );

    // Atomic creation with automatic retry on conflicts.
    // The transaction system provides optimistic concurrency control:
    // - Reading defaultPattern inside the transaction creates an invariant
    // - If another process creates it first, the commit fails and retries
    // - On retry, we'll see the existing pattern and return early
    let pieceCell: Cell<NameSchema>;

    await this.#manager.runtime.editWithRetry((tx) => {
      // Double-check pattern doesn't exist (read establishes invariant)
      const spaceCellWithTx = this.#manager.getSpaceCellContents().withTx(tx);
      const defaultPatternCell = spaceCellWithTx.key("defaultPattern");
      const existingDefault = defaultPatternCell.get();

      if (existingDefault?.get()) {
        // Pattern was created by another process - we're done
        // The editWithRetry will complete successfully, and we'll
        // fetch the existing pattern below
        return;
      }

      // Create piece cell within this transaction
      pieceCell = this.#manager.runtime.getCell<NameSchema>(
        this.#manager.getSpace(),
        patternConfig.cause,
        nameSchema,
        tx,
      );

      // Run pattern setup within same transaction
      this.#manager.runtime.run(tx, recipe, {}, pieceCell);

      // Link as default pattern within same transaction
      defaultPatternCell.set(pieceCell.withTx(tx));
    });

    // After transaction commits, fetch the final result
    // (either we created it, or another process did)
    const finalPattern = await this.#manager.getDefaultPattern();
    if (!finalPattern) {
      throw new Error("Failed to create or find default pattern");
    }

    // Start the piece after successful creation/discovery
    await this.#manager.startPiece(finalPattern);
    await this.#manager.runtime.idle();
    await this.#manager.synced();

    return new PieceController<NameSchema>(this.#manager, finalPattern);
  }
}
