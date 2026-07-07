import {
  type Cell,
  entityIdFrom,
  type JSONSchema,
  type ModuleByteCache,
  Runtime,
  RuntimeProgram,
  type Schema,
} from "@commonfabric/runner";
import type { CellScope } from "@commonfabric/api";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { type NameSchema, nameSchema } from "@commonfabric/runner/schemas";
import { PieceManager } from "../index.ts";
import { PieceController } from "./piece-controller.ts";
import { compileProgram } from "./utils.ts";
import { createSession, Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { ACLManager } from "./acl-manager.ts";
import { homeSchema } from "@commonfabric/home-schemas";

const PIECE_TRACE_TIMINGS = typeof Deno !== "undefined" &&
  Deno.env.get("CF_CLI_TRACE_TIMINGS") === "1";

// Same logger as manager.ts's timePiecePhase: timing stats record even while
// the logger is disabled, so controller phases show up in the load summaries
// (browser worker included) as `piece/phase/<label>`.
const pieceTimingLogger = getLogger("piece", { enabled: false });

async function timePiecesPhase<T>(
  label: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    pieceTimingLogger.time(start, "phase", label);
    if (PIECE_TRACE_TIMINGS) {
      const elapsed = Math.round(performance.now() - start);
      console.error(`[piece-phase] ${elapsed}ms :: ${label}`);
    }
  }
}

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
    const start = options.start ?? true;
    const pattern = await compileProgram(this.#manager, program);
    const piece = await this.#manager.runPersistent<U>(
      pattern,
      options.input,
      cause,
      { start },
    );
    if (!start) {
      await this.#manager.runtime.idle();
      await this.#manager.synced();
    }
    return new PieceController<U>(this.#manager, piece);
  }

  async get<S extends JSONSchema = JSONSchema>(
    pieceId: string,
    runIt: boolean,
    schema: S,
    scope?: CellScope,
  ): Promise<PieceController<Schema<S>>>;
  async get<T = unknown>(
    pieceId: string,
    runIt?: boolean,
    schema?: JSONSchema,
    scope?: CellScope,
  ): Promise<PieceController<T>>;
  async get(
    pieceId: string,
    runIt: boolean = false,
    schema?: JSONSchema,
    scope?: CellScope,
  ): Promise<PieceController> {
    this.disposeCheck();
    const cell = await (await this.#manager.get(pieceId, runIt, schema, scope))
      .sync();
    return new PieceController(this.#manager, cell);
  }

  async getAllPieces() {
    this.disposeCheck();
    const piecesCell = await this.#manager.getPieces();
    const pieces = await this.#manager.syncPieces(piecesCell);
    return pieces.map((piece) =>
      new PieceController(this.#manager, piece.asSchema(undefined))
    );
  }

  async remove(pieceId: string): Promise<boolean> {
    this.disposeCheck();
    const piece = this.#manager.runtime.getCellFromEntityId(
      this.#manager.getSpace(),
      entityIdFrom(pieceId),
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

  static async initialize({ apiUrl, identity, spaceName, moduleByteCache }: {
    apiUrl: URL;
    identity: Identity;
    spaceName: string;
    // Optional compiled-module-byte cache to share across controllers. Supplied
    // only by test code (see the integration suite's compile-byte-cache helper);
    // unset in production, so no cache is installed.
    moduleByteCache?: ModuleByteCache;
  }): Promise<PiecesController> {
    const session = await createSession({ identity, spaceName });
    const runtime = new Runtime({
      apiUrl: new URL(apiUrl),
      storageManager: StorageManager.open({
        as: session.as,
        memoryHost: new URL(apiUrl),
        spaceIdentity: session.spaceIdentity,
      }),
      cfcEnforcementMode: "enforce-explicit",
      moduleByteCache,
      trustSnapshotProvider: () => ({
        id: `principal:${session.as.did()}`,
        actingPrincipal: session.as.did(),
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
   * Read the default app URL from the home space's configuration.
   * Returns empty string if not configured or if home space is not accessible.
   */
  private async getDefaultAppUrlFromHome(): Promise<string> {
    try {
      const homeSpaceCell = this.#manager.runtime.getHomeSpaceCell();
      await timePiecesPhase(
        "getDefaultAppUrlFromHome.homeSpaceCell.sync",
        () => homeSpaceCell.sync(),
      );

      const url = await timePiecesPhase(
        "getDefaultAppUrlFromHome.defaultAppUrl.get",
        () =>
          homeSpaceCell.key("defaultPattern")
            .asSchema(homeSchema).key("defaultAppUrl").get(),
      );
      return typeof url === "string" ? url.trim() : "";
    } catch (error) {
      console.warn("Failed to read defaultAppUrl from home space:", error);
      return "";
    }
  }

  /**
   * Recreates the default pattern from scratch.
   * Stops and unlinks the existing default pattern, then creates a new one.
   * This is useful for resetting the space's default pattern state.
   *
   * @param options.customProgram - A pre-compiled program to use instead of the default URL-based pattern
   * @returns The newly created default pattern piece
   */
  async recreateDefaultPattern(
    options?: { customProgram?: RuntimeProgram },
  ): Promise<PieceController<NameSchema>> {
    this.disposeCheck();

    // Stop and unlink the existing default pattern first (before any operations that might fail)
    // We need to stop it to prevent resource leaks or duplicate behavior from the old pattern
    // Access the space cell directly to get the pattern reference without running it
    const spaceCellContents = this.#manager.getSpaceCellContents();
    await spaceCellContents.sync();
    const defaultPatternRef = spaceCellContents.key("defaultPattern").get();
    if (defaultPatternRef) {
      // Stop the existing pattern (no-op if not running)
      this.#manager.runtime.runner.stop(defaultPatternRef);
    }
    await this.#manager.unlinkDefaultPattern();

    // Determine which pattern to use based on space type
    const isHomeSpace =
      this.#manager.getSpace() === this.#manager.runtime.userIdentityDID;

    let patternConfig: { name: string; urlPath: string; cause: string };
    let pattern;

    if (options?.customProgram) {
      patternConfig = {
        name: isHomeSpace ? "Home" : "DefaultPieceList",
        urlPath: "custom",
        cause: isHomeSpace
          ? `home-pattern-${Date.now()}`
          : `space-root-${Date.now()}`,
      };
      pattern = await this.#manager.runtime.patternManager.compilePattern(
        options.customProgram,
        { space: this.#manager.getSpace() },
      );
    } else {
      if (isHomeSpace) {
        patternConfig = {
          name: "Home",
          urlPath: "/api/patterns/system/home.tsx",
          cause: `home-pattern-${Date.now()}`,
        };
      } else {
        const customUrl = await this.getDefaultAppUrlFromHome();
        patternConfig = {
          name: "DefaultPieceList",
          urlPath: customUrl || "/api/patterns/system/default-app.tsx",
          cause: `space-root-${Date.now()}`,
        };
      }

      const patternUrl = new URL(
        patternConfig.urlPath,
        this.#manager.runtime.apiUrl,
      );

      // Load and compile the pattern (cache in the target space — CT-1623).
      const program = await this.#manager.runtime.harness.resolve(
        new HttpProgramResolver(patternUrl.href),
      );
      pattern = await this.#manager.runtime.patternManager.compilePattern(
        program,
        { space: this.#manager.getSpace() },
      );
    }

    // Create new piece cell
    let pieceCell: Cell<NameSchema>;

    const { error } = await this.#manager.runtime.editWithRetry((tx) => {
      // Create piece cell within this transaction
      pieceCell = this.#manager.runtime.getCell<NameSchema>(
        this.#manager.getSpace(),
        patternConfig.cause,
        nameSchema,
        tx,
      );

      // Run pattern setup within same transaction
      this.#manager.runtime.run(tx, pattern, {}, pieceCell);

      // Link as default pattern within same transaction
      const spaceCellWithTx = spaceCellContents.withTx(tx);
      const defaultPatternCell = spaceCellWithTx.key("defaultPattern");
      defaultPatternCell.set(pieceCell.withTx(tx));
    });
    if (error) {
      throw new Error(
        `Updating the default pattern failed because storage returned ${error.name}: ${error.message}`,
        { cause: error },
      );
    }

    // Fetch the final result
    const finalPattern = await this.#manager.getDefaultPattern(false);
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

    let patternConfig: { name: string; urlPath: string; cause: string };

    if (isHomeSpace) {
      patternConfig = {
        name: "Home",
        urlPath: "/api/patterns/system/home.tsx",
        cause: "home-pattern",
      };
    } else {
      const customUrl = await timePiecesPhase(
        "ensureDefaultPattern.getDefaultAppUrlFromHome",
        () => this.getDefaultAppUrlFromHome(),
      );
      patternConfig = {
        name: "DefaultPieceList",
        urlPath: customUrl || "/api/patterns/system/default-app.tsx",
        cause: "space-root",
      };
    }

    const patternUrl = new URL(
      patternConfig.urlPath,
      this.#manager.runtime.apiUrl,
    );

    // Load and compile the pattern (async work outside transaction)
    const program = await timePiecesPhase(
      "ensureDefaultPattern.resolveProgram",
      () =>
        this.#manager.runtime.harness.resolve(
          new HttpProgramResolver(patternUrl.href),
        ),
    );
    const pattern = await timePiecesPhase(
      "ensureDefaultPattern.compilePattern",
      () =>
        this.#manager.runtime.patternManager.compilePattern(
          program,
          // Route the space-root compile through the content-addressed cell
          // cache so the reload (fresh worker) reuses the compiled module set
          // instead of cold-compiling the home/default-app pattern (CT-1623).
          { space: this.#manager.getSpace() },
        ),
    );

    // Atomic creation with automatic retry on conflicts.
    // The transaction system provides optimistic concurrency control:
    // - Reading defaultPattern inside the transaction creates an invariant
    // - If another process creates it first, the commit fails and retries
    // - On retry, we'll see the existing pattern and return early
    let pieceCell: Cell<NameSchema>;

    await timePiecesPhase(
      "ensureDefaultPattern.editWithRetry",
      () =>
        this.#manager.runtime.editWithRetry((tx) => {
          // Double-check pattern doesn't exist (read establishes invariant)
          const spaceCellWithTx = this.#manager.getSpaceCellContents().withTx(
            tx,
          );
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
          this.#manager.runtime.run(tx, pattern, {}, pieceCell);

          // Link as default pattern within same transaction
          defaultPatternCell.set(pieceCell.withTx(tx));
        }),
    );

    // After transaction commits, fetch the final result
    // (either we created it, or another process did)
    const finalPattern = await timePiecesPhase(
      "ensureDefaultPattern.getDefaultPattern(false)",
      () => this.#manager.getDefaultPattern(false),
    );
    if (!finalPattern) {
      throw new Error("Failed to create or find default pattern");
    }

    // Start the piece after successful creation/discovery
    await timePiecesPhase(
      "ensureDefaultPattern.startPiece",
      () => this.#manager.startPiece(finalPattern),
    );
    await timePiecesPhase(
      "ensureDefaultPattern.runtime.idle",
      () => this.#manager.runtime.idle(),
    );
    await timePiecesPhase(
      "ensureDefaultPattern.synced",
      () => this.#manager.synced(),
    );

    return new PieceController<NameSchema>(this.#manager, finalPattern);
  }
}
