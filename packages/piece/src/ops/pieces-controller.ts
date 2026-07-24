import {
  type Cell,
  entityIdFrom,
  type EnvReader,
  experimentalOptionsFromEnv,
  getPatternIdentityRef,
  type JSONSchema,
  type MemorySpace,
  type ModuleByteCache,
  type PatternCoverageCollector,
  type PatternUpdateOutcome,
  Runtime,
  runtimePresets,
  RuntimeProgram,
  type Schema,
  setPatternRepository,
  setPatternSource,
} from "@commonfabric/runner";
import type { CellScope } from "@commonfabric/api";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { type NameSchema, nameSchema } from "@commonfabric/runner/schemas";
import { CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON } from "@commonfabric/runner/cfc/migration-reason";
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

// System space-root patterns, served as raw TSX by the toolshed patterns route.
export const HOME_PATTERN_URL = "/api/patterns/system/home.tsx";
export const DEFAULT_APP_PATTERN_URL = "/api/patterns/system/default-app.tsx";

// Default roots have a stronger update policy than ordinary pieces: an
// existing root is reconciled before start, while a new root is compiled from
// the current source immediately before creation. Keep the runner's watcher,
// but do not schedule its duplicate fire-and-forget source check.
const DEFAULT_ROOT_RUN_OPTIONS = { schedulePatternUpdate: false } as const;

/**
 * The official system space-root pattern URL for a space type — the home DID
 * gets home.tsx, every other space gets the default app. This derivation only
 * selects the identity to check; it never proves that a sourceless root tracks
 * that URL. Exact equality with the official content identity supplies
 * that proof below.
 */
export function deriveSystemPatternUrl(
  space: MemorySpace,
  runtime: Runtime,
): string {
  return space === runtime.userIdentityDID
    ? HOME_PATTERN_URL
    : DEFAULT_APP_PATTERN_URL;
}

// Same logger as manager.ts's timePiecePhase: timing stats record even while
// the logger is disabled, so controller phases show up in the load summaries
// (browser worker included) as `piece/phase/<label>`.
const pieceTimingLogger = getLogger("piece", { enabled: false });
const pieceUpdateLogger = getLogger("piece.update", {
  enabled: true,
  level: "warn",
});

/** Backward-compatible name for the result of a pattern update check. */
export type UpdateOutcome = PatternUpdateOutcome;

/**
 * A cold-start setup repair failed specifically because the CFC SCHEMA
 * MIGRATION rejected the commit — the pinned pattern loads but cannot migrate
 * the reused doc onto a now-required field that carries no default (the estuary
 * `favorites` case). This is the ONLY repair-failure class the runnability
 * backstop ({@link PiecesController.healDefaultRootByRollForward}) acts on;
 * every other failure stays fail-closed.
 *
 * The bare `CFC enforcement rejected commit` prefix is NOT a safe trigger: the
 * runner emits it for prepared-digest races, unprepared transactions, and
 * policy/provenance rejections too (`extended-storage-transaction.ts`), none of
 * which are repaired by repointing the root's pattern identity. So we require
 * the machine-stable migration token the CFC prepare tags onto this class
 * (`migration-reason.ts`). Matching a token in the message — not the error
 * class — is what survives the plain-`Error` re-wrap the runner applies at its
 * setup-commit boundary (`runner.ts`), keeping producer and consumer in
 * lockstep across that boundary and across packages.
 *
 * Crucially we match the token only in its FRAMED reason position — `: <token>:
 * ` — the exact shape the prepare catch emits (`${token}: ${message}` recorded
 * as a reason, surfaced by the commit as `…not prepared: ${reason}`). A bare
 * `includes(token)` would also match the token appearing incidentally inside an
 * UNRELATED, user-influenced error — e.g. an ordinary incompatible-type merge
 * failure at a property path literally named `/cfc-schema-migration-incompatible`
 * — and wrongly authorize a root replacement for a non-additive incompatibility.
 * The `: … : ` framing cannot be produced by a path or value that merely
 * contains the token string.
 */
const FRAMED_MIGRATION_REASON =
  `: ${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: `;
const isCfcMigrationRejection = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.startsWith("CFC enforcement rejected commit") &&
  error.message.includes(FRAMED_MIGRATION_REASON);

// This module can load outside Deno (browser-safe storage import above), so
// env reads are guarded like PIECE_TRACE_TIMINGS: absent env ⇒ defaults.
const readEnv: EnvReader = (key) =>
  typeof Deno !== "undefined" ? Deno.env.get(key) : undefined;

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
  repository?: string;
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
      { repository: options.repository, start },
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

  static async initialize(
    { apiUrl, identity, spaceName, moduleByteCache, patternCoverage }: {
      apiUrl: URL;
      identity: Identity;
      spaceName: string;
      // Optional compiled-module-byte cache to share across controllers. Supplied
      // only by test code (see the integration suite's compile-byte-cache helper);
      // unset in production, so no cache is installed.
      moduleByteCache?: ModuleByteCache;
      // Collect statement coverage for the patterns this controller compiles.
      // Test/CI only. Beyond the coverage itself, this decides which cached
      // variant the pieces it creates are stored under, so a browser collecting
      // coverage against the same space warm-loads them instead of recompiling
      // every pattern for itself.
      patternCoverage?: PatternCoverageCollector;
    },
  ): Promise<PiecesController> {
    const session = await createSession({ identity, spaceName });
    // Shared first-party posture for client runtimes against a deployed API
    // (CT-1814); the CFC pin this site previously restated lives in the
    // preset core. Trust provenance stays a visible delta of this controller.
    const runtime = new Runtime(runtimePresets.remoteClient({
      apiUrl: new URL(apiUrl),
      storageManager: StorageManager.open({
        as: session.as,
        memoryHost: new URL(apiUrl),
        spaceIdentity: session.spaceIdentity,
      }),
      experimental: experimentalOptionsFromEnv(readEnv),
      moduleByteCache,
      patternCoverage,
      trustSnapshotProvider: () => ({
        id: `principal:${session.as.did()}`,
        actingPrincipal: session.as.did(),
      }),
    }));

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
    options?: { customProgram?: RuntimeProgram; repository?: string },
  ): Promise<PieceController<NameSchema>> {
    this.disposeCheck();
    if (
      options?.repository !== undefined && options.customProgram === undefined
    ) {
      throw new Error(
        "A repository locator can only be supplied with a custom program",
      );
    }

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
          urlPath: HOME_PATTERN_URL,
          cause: `home-pattern-${Date.now()}`,
        };
      } else {
        const customUrl = await this.getDefaultAppUrlFromHome();
        patternConfig = {
          name: "DefaultPieceList",
          urlPath: customUrl || DEFAULT_APP_PATTERN_URL,
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
      this.#manager.runtime.run(
        tx,
        pattern,
        {},
        pieceCell,
        DEFAULT_ROOT_RUN_OPTIONS,
      );

      // Stamp the provenance the piece tracks for updates, mirroring
      // ensureDefaultPattern (CT-1890). Without this, every recreated root
      // is born unprovenanced and checkAndUpdateDefaultPattern can only admit
      // it while its ref exactly equals the current official identity — the
      // repair path would otherwise mint roots with no durable update source.
      // A custom program has no URL the
      // auto-updater could re-fetch (stamping the "custom" placeholder
      // would poison URL resolution — it would resolve relative to the
      // host); its locator, when supplied, is recorded via
      // setPatternRepository below, so a custom root without a repository
      // intentionally stays unstamped.
      if (options?.customProgram === undefined) {
        setPatternSource(pieceCell, tx, patternConfig.urlPath);
      }

      if (options?.repository !== undefined) {
        setPatternRepository(pieceCell, tx, options.repository);
      }

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
    await this.#manager.startPiece(finalPattern, DEFAULT_ROOT_RUN_OPTIONS);
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

    // Fast path: resolve the existing root WITHOUT starting it. The updater
    // must get a chance to replace an obsolete patternIdentity before
    // bootstrap tries to load that identity; otherwise an unloadable old root
    // prevents the very repair that would make it loadable.
    const existingPattern = await this.#manager.getDefaultPattern(false);
    if (existingPattern) {
      return await this.startEnsuredDefaultPattern(existingPattern, true);
    }

    // Determine which pattern to use based on space type
    const isHomeSpace =
      this.#manager.getSpace() === this.#manager.runtime.userIdentityDID;

    let patternConfig: { name: string; urlPath: string; cause: string };

    if (isHomeSpace) {
      patternConfig = {
        name: "Home",
        urlPath: HOME_PATTERN_URL,
        cause: "home-pattern",
      };
    } else {
      const customUrl = await timePiecesPhase(
        "ensureDefaultPattern.getDefaultAppUrlFromHome",
        () => this.getDefaultAppUrlFromHome(),
      );
      patternConfig = {
        name: "DefaultPieceList",
        urlPath: customUrl || DEFAULT_APP_PATTERN_URL,
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
    const creationResult = await timePiecesPhase(
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
            return false;
          }

          // Create piece cell within this transaction
          const pieceCell = this.#manager.runtime.getCell<NameSchema>(
            this.#manager.getSpace(),
            patternConfig.cause,
            nameSchema,
            tx,
          );

          // Run pattern setup within same transaction
          this.#manager.runtime.run(
            tx,
            pattern,
            {},
            pieceCell,
            DEFAULT_ROOT_RUN_OPTIONS,
          );

          // Stamp the provenance the piece tracks for updates (the source it
          // was born from) — the same transaction, one extra meta write.
          setPatternSource(pieceCell, tx, patternConfig.urlPath);

          // Link as default pattern within same transaction
          defaultPatternCell.set(pieceCell.withTx(tx));
          return true;
        }),
    );
    const createdByThisCall = creationResult.ok === true;

    // After transaction commits, fetch the final result
    // (either we created it, or another process did)
    const finalPattern = await timePiecesPhase(
      "ensureDefaultPattern.getDefaultPattern(false)",
      () => this.#manager.getDefaultPattern(false),
    );
    if (!finalPattern) {
      throw new Error("Failed to create or find default pattern");
    }

    // A root created by this successful attempt was compiled from the current
    // source immediately above. If another writer won the race, treat the
    // discovered root like every other persisted root and reconcile it before
    // start.
    return await this.startEnsuredDefaultPattern(
      finalPattern,
      !createdByThisCall,
    );
  }

  private async startEnsuredDefaultPattern(
    root: Cell<NameSchema>,
    reconcileBeforeStart: boolean,
  ): Promise<PieceController<NameSchema>> {
    let rootToStart = root;
    if (reconcileBeforeStart) {
      await timePiecesPhase(
        "ensureDefaultPattern.checkAndUpdateDefaultPattern",
        () => this.checkAndUpdateDefaultPattern(root),
      );
      // The metadata swap committed through a transaction view. Resolve the
      // root again so start() observes the committed patternIdentity rather
      // than the pre-transaction snapshot held by the caller's cell.
      rootToStart = await this.#manager.getDefaultPattern(false) ?? root;
    }

    try {
      await timePiecesPhase(
        "ensureDefaultPattern.startPiece",
        () => this.#manager.startPiece(rootToStart, DEFAULT_ROOT_RUN_OPTIONS),
      );
    } catch (startError) {
      // Cold-start setup repair. checkAndUpdateDefaultPattern moves
      // patternIdentity WITHOUT running the setup phase ("Never calls run()"),
      // and Runner.start() of a not-running piece instantiates the stored
      // identity directly — also without setup. A root whose identity moved
      // while it was not running (the bricked-space heal: no watcher existed
      // to swap it in place) therefore boots over a doc that never
      // materialized the pattern's internal cells — handler
      // `{ "$stream": true }` markers included — and dies at instantiation
      // ("Handler used as lift", the 2026-07-22 estuary failure). This also
      // covers docs ALREADY left in that state by an earlier session: their
      // identity compares current, so no further swap will ever fire.
      //
      // run() (setup + start) is the sanctioned repair: with an unchanged
      // pattern pointer the setup phase is idempotent — it only materializes
      // missing internal cells and writes no argument (none supplied). Fail
      // closed: if the repair cannot proceed or fails, surface the ORIGINAL
      // start error; nothing is torn down or overwritten.
      const runtime = this.#manager.runtime;
      const ref = getPatternIdentityRef(rootToStart);
      if (ref === undefined) throw startError;
      let pattern;
      try {
        pattern = await runtime.patternManager.loadPatternByIdentity(
          ref.identity,
          ref.symbol,
          this.#manager.getSpace(),
        );
      } catch {
        throw startError;
      }
      if (pattern === undefined) throw startError;
      pieceUpdateLogger.warn(
        "cold-start-setup-repair",
        () => [
          "startEnsuredDefaultPattern: start failed; re-running setup for",
          `${ref.identity}#${ref.symbol}`,
          startError,
        ],
      );
      const repairPattern = pattern;
      // Detach any transaction view the resolved root carries: getDefault-
      // Pattern hands back a cell bound to a read-only tx, and runSynced
      // would otherwise adopt it for the setup writes.
      const writableRoot = rootToStart.withTx();
      // runSynced does not plumb schedulePatternUpdate, so the repair may let
      // the lazy updater schedule one redundant check post-start. Benign: the
      // awaited checkAndUpdateDefaultPattern above already reconciled, so the
      // check observes a current identity and no-ops.
      //
      // expectedPatternIdentity is the repair precondition, not a formality:
      // it atomically rejects a repair superseded by a concurrent source
      // update (the identity is re-asserted inside every setup retry), and it
      // makes runSynced THROW on a setup-commit failure instead of logging
      // and continuing — without it this catch never sees commit-level
      // failures and a dead root would be reported as a successful start.
      try {
        await timePiecesPhase(
          "ensureDefaultPattern.coldStartSetupRepair",
          () =>
            runtime.runSynced(writableRoot, repairPattern, undefined, {
              expectedPatternIdentity: ref,
            }),
        );
      } catch (repairError) {
        // Escalate to the RUNNABILITY backstop on EXACTLY one signal: the
        // pinned pattern LOADS but its setup-commit was REJECTED BY THE CFC
        // MIGRATION — the estuary case, where an old root's required field
        // predates its `Default<>` or a handler stream predates its exemption.
        // "Loadable" is not "runnable"; re-running the same identity can only
        // fail identically, so roll the root forward to the space's CURRENT
        // official pattern (which migrates the reused doc cleanly). This fires
        // only on a failed migration, so a root that already runs — current
        // official, or a custom root that migrates cleanly — never reaches it,
        // and custom-root protection is preserved for free.
        //
        // Any OTHER repair failure (transient storage/commit error, backend
        // unavailable, …) is NOT evidence the pinned pattern is wrong. It stays
        // FAIL-CLOSED: surface the ORIGINAL start error, change nothing, let
        // the next boot retry. This gate is what keeps a transient blip from
        // swapping a healthy root's identity out from under it.
        if (!isCfcMigrationRejection(repairError)) {
          throw startError;
        }
        pieceUpdateLogger.warn(
          "cold-start-setup-repair-failed",
          () => [
            "startEnsuredDefaultPattern: setup repair rejected by CFC " +
            "migration; rolling forward",
            `${ref.identity}#${ref.symbol}`,
            repairError,
          ],
        );
        rootToStart = await this.healDefaultRootByRollForward(
          rootToStart,
          ref,
          repairError,
        );
      }
    }
    await timePiecesPhase(
      "ensureDefaultPattern.runtime.idle",
      () => this.#manager.runtime.idle(),
    );
    await timePiecesPhase(
      "ensureDefaultPattern.synced",
      () => this.#manager.synced(),
    );

    return new PieceController<NameSchema>(this.#manager, rootToStart);
  }

  /**
   * Runnability backstop for {@link startEnsuredDefaultPattern}'s cold-start
   * repair. Reached only when the pinned pattern's OWN setup repair was
   * REJECTED BY THE CFC MIGRATION (gated by {@link isCfcMigrationRejection}) —
   * a root that loads but cannot run (the estuary `favorites`/handler-stream
   * case). Rolls the root forward to the space's CURRENT official pattern and
   * materializes THAT over the reused doc.
   *
   * Outcome is one of exactly two, each legible — no operator left
   * reverse-engineering scattered `$stream`/`needs a default` messages:
   *
   *   1. Healed: identity now points at the official pattern, its setup
   *      committed, the reused doc materialized against it.
   *   2. A single CLEAR error naming WHY — the pinned pattern's migration
   *      failure and where the roll-forward stopped (compile, identity, swap,
   *      or the official pattern's own materialize).
   *
   * On atomicity: the identity swap and the materialize are two commits, not
   * one (runSynced owns its own setup transaction and asserts the identity is
   * already pinned, so the swap must precede it). If the swap commits but the
   * materialize then fails, the root is left pinned to the official identity
   * but un-setup — the SAME "already moved" state the same-identity repair
   * heals on the next boot (see the cold-start "already moved" test), never a
   * worse state than the pinned-and-unmigratable root we started from. The
   * error still surfaces, so the failed boot is not silent.
   *
   * Returns the healed root cell so the caller starts/returns the swapped-in
   * pattern rather than the stale pinned view.
   */
  private async healDefaultRootByRollForward(
    rootToStart: Cell<NameSchema>,
    pinnedRef: { identity: string; symbol: string },
    migrationError: unknown,
  ): Promise<Cell<NameSchema>> {
    const runtime = this.#manager.runtime;
    const space = this.#manager.getSpace();
    // Reuse the canonical official-URL derivation (home.tsx for the home DID,
    // default-app.tsx otherwise) — never hard-code home here.
    const officialUrlPath = deriveSystemPatternUrl(space, runtime);
    const msg = (error: unknown) =>
      error instanceof Error ? error.message : String(error);
    const clearError = (reason: string, cause: unknown) =>
      new Error(
        `default-root heal failed for ${space}: pinned pattern ` +
          `${pinnedRef.identity}#${pinnedRef.symbol} failed CFC migration ` +
          `(${msg(migrationError)}) and roll-forward to official ` +
          `${officialUrlPath} ${reason}`,
        { cause },
      );

    // Fetch + compile the official source, mirroring pattern-updater's #check.
    // Force ETag revalidation (`cache: "no-cache"`): the roll-forward exists to
    // ESCAPE a stale pinned pattern, so compiling a stale HTTP-cached source
    // would defeat the heal — it could "roll forward" to the same aged bytes.
    // A 304 still reuses unchanged bytes; we just never trust the cache blind.
    const revalidatingFetch: typeof globalThis.fetch = (input, init) =>
      runtime.fetch(input, { ...init, cache: "no-cache" });
    const officialUrl = new URL(officialUrlPath, runtime.apiUrl);
    let officialPattern;
    let officialRef;
    try {
      const resolved = await runtime.harness.resolve(
        new HttpProgramResolver(officialUrl.href, revalidatingFetch),
      );
      officialPattern = await runtime.patternManager.compilePattern(
        // Default-root routes select the official `default` export.
        { ...resolved, mainExport: "default" },
        { space },
      );
      officialRef = runtime.patternManager.getArtifactEntryRef(officialPattern);
    } catch (compileError) {
      // Chain the ACTUAL compile failure as `cause` (not the migration error):
      // the migration reason is already named in the message, and the compile
      // stack is the new information here.
      throw clearError(
        `could not be compiled (${msg(compileError)})`,
        compileError,
      );
    }
    if (officialRef === undefined) {
      throw clearError("did not yield an entry identity", migrationError);
    }
    // Already current: the pinned pattern IS the official one but failed for
    // some other reason. Re-materializing the same identity would fail
    // identically, so do not loop — surface the clear error now.
    if (officialRef.identity === pinnedRef.identity) {
      throw clearError(
        `is already the pinned identity ${officialRef.identity}, so the ` +
          `migration cannot be repaired by rolling forward`,
        migrationError,
      );
    }

    // Atomic swap: record the displaced pinned ref for recovery, move
    // patternIdentity to the official entry, stamp official provenance. One
    // tx — it commits together or aborts, leaving the root untouched.
    //
    // Precondition guard (fail-closed): re-read the root's identity INSIDE the
    // transaction and proceed only if it still equals the pinned ref we
    // diagnosed. `editWithRetry` reruns this callback against fresh state on
    // conflict, so without the guard a concurrent heal (another boot, the
    // pattern updater) that already repointed the root would be blindly
    // clobbered by our stale `officialRef`. Returning `false` aborts the write
    // without committing — precedent: pattern-updater's `stillMatches`/
    // `canWrite`. `result.ok === false` (no error) then means "superseded".
    const swapResult = await runtime.editWithRetry((tx) => {
      const rootTx = rootToStart.withTx(tx);
      const currentRef = getPatternIdentityRef(rootTx);
      if (
        currentRef?.identity !== pinnedRef.identity ||
        currentRef?.symbol !== pinnedRef.symbol
      ) {
        return false;
      }
      rootTx.setMetaRaw("displacedPattern", {
        identity: pinnedRef.identity,
        symbol: pinnedRef.symbol,
        displacedAt: Date.now(),
      });
      rootTx.setMetaRaw("patternIdentity", officialRef);
      setPatternSource(rootToStart, tx, officialUrlPath);
      return true;
    });
    if (swapResult.error) {
      // Chain the actual commit failure as `cause` (the migration reason is
      // already in the message).
      throw clearError(
        `identity swap could not commit (${msg(swapResult.error)})`,
        swapResult.error,
      );
    }
    if (!swapResult.ok) {
      // The root was repointed by a concurrent heal between the failed repair
      // and this swap. We must NOT overwrite the newer identity (the whole
      // point of the precondition) — but we also must NOT return it as a
      // success: this is the cold-start path, so the caller does not start or
      // materialize what we hand back, and the concurrent heal may still be
      // mid-flight (the repoint commits BEFORE its own materialize). Claiming
      // success here would surface an unstarted, un-setup root. Fail closed
      // with a clear, accurate error; nothing was overwritten, and the next
      // boot observes the settled root and starts/repairs it through the
      // ordinary path.
      pieceUpdateLogger.warn(
        "default-root-roll-forward-superseded",
        () => [
          "startEnsuredDefaultPattern: root identity changed before roll-forward;",
          `leaving concurrent heal in place for ${space}`,
        ],
      );
      throw clearError(
        "was superseded by a concurrent heal (the root identity changed " +
          "before the swap); left in place for the next boot to start",
        migrationError,
      );
    }

    // Re-resolve so the materialize observes the committed patternIdentity
    // (the caller's cell is a pre-swap transaction view), then materialize the
    // OFFICIAL pattern. expectedPatternIdentity asserts the just-committed
    // identity and makes runSynced THROW on a setup-commit failure rather than
    // log-and-continue — so an official pattern that ALSO cannot migrate the
    // doc surfaces here as the clear error below, not a silently-dead root.
    const swappedRoot = await this.#manager.getDefaultPattern(false) ??
      rootToStart;
    try {
      await timePiecesPhase(
        "ensureDefaultPattern.rollForwardMaterialize",
        () =>
          runtime.runSynced(swappedRoot.withTx(), officialPattern, undefined, {
            expectedPatternIdentity: officialRef,
          }),
      );
    } catch (materializeError) {
      throw clearError(
        `also failed CFC migration (${msg(materializeError)})`,
        materializeError,
      );
    }

    pieceUpdateLogger.warn(
      "default-root-rolled-forward",
      () => [
        "startEnsuredDefaultPattern: healed by roll-forward to official",
        `${pinnedRef.identity}#${pinnedRef.symbol} ->`,
        `${officialRef.identity}#${officialRef.symbol}`,
      ],
    );
    return swappedRoot;
  }

  /**
   * Roll the space's system root pattern forward in place if its toolshed
   * serves a newer content identity. Best-effort: every failure logs and
   * returns without throwing. During {@link ensureDefaultPattern}, this runs
   * before the persisted root is started, so an eligible tracked root's
   * unloadable obsolete identity can be replaced before bootstrap. If the root
   * is already running, its watcher applies the same metadata swap in place.
   *
   * Never calls run()/stop()/recreateDefaultPattern.
   */
  async checkAndUpdateDefaultPattern(
    resolvedRoot?: Cell<NameSchema>,
  ): Promise<UpdateOutcome> {
    const runtime = this.#manager.runtime;
    const space = this.#manager.getSpace();
    if (!runtime.experimental?.systemPatternAutoUpdate) {
      return "skipped-disabled";
    }
    try {
      const root = resolvedRoot ?? await this.#manager.getDefaultPattern(false);
      if (!root) return "current";
      return await runtime.patternUpdater.checkDefaultPattern(
        root,
        deriveSystemPatternUrl(space, runtime),
      );
    } catch (error) {
      pieceUpdateLogger.warn("root-resolution-failed", () => [
        "checkAndUpdateDefaultPattern: root resolution failed",
        space,
        error,
      ]);
      return "current";
    }
  }
}
