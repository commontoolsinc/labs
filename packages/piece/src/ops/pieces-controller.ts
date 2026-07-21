import {
  buildsMatch,
  type Cell,
  clientVersionFromEnv,
  entityIdFrom,
  type EnvReader,
  experimentalOptionsFromEnv,
  getPatternIdentityRef,
  getPatternSource,
  type JSONSchema,
  type MemorySpace,
  type ModuleByteCache,
  type PatternCoverageCollector,
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
const LOCAL_HOME_PATTERN_PATH = "/system/home.tsx";
const LOCAL_DEFAULT_APP_PATTERN_PATH = "/system/default-app.tsx";

/**
 * The official system space-root pattern URL for a space type — the home DID
 * gets home.tsx, every other space gets the default app. This derivation alone
 * is not proof that an existing sourceless root is a system root: legacy
 * recovery must first verify its stored source closure and exact entry path via
 * {@link inferLegacySystemPatternSource}.
 */
export function deriveSystemPatternUrl(
  space: MemorySpace,
  runtime: Runtime,
): string {
  return space === runtime.userIdentityDID
    ? HOME_PATTERN_URL
    : DEFAULT_APP_PATTERN_URL;
}

/**
 * Recover update provenance for a pre-`patternSource` root only when its
 * content-addressed source closure verifies and names the official system entry
 * appropriate to this space. The filename check is deliberately exact: a
 * custom or mismatched root must remain pinned rather than being replaced with
 * the default app.
 */
async function inferLegacySystemPatternSource(
  root: Cell<unknown>,
  runtime: Runtime,
  space: MemorySpace,
): Promise<string | undefined> {
  const ref = getPatternIdentityRef(root);
  if (ref === undefined) return undefined;
  const program = await runtime.patternManager
    .getPatternSourceProgramByIdentity(
      ref.identity,
      space,
    );
  const expected = deriveSystemPatternUrl(space, runtime);
  switch (program?.main) {
    case HOME_PATTERN_URL:
    case LOCAL_HOME_PATTERN_PATH:
      return expected === HOME_PATTERN_URL ? HOME_PATTERN_URL : undefined;
    case DEFAULT_APP_PATTERN_URL:
    case LOCAL_DEFAULT_APP_PATTERN_PATH:
      return expected === DEFAULT_APP_PATTERN_URL
        ? DEFAULT_APP_PATTERN_URL
        : undefined;
    default:
      return undefined;
  }
}

// Same logger as manager.ts's timePiecePhase: timing stats record even while
// the logger is disabled, so controller phases show up in the load summaries
// (browser worker included) as `piece/phase/<label>`.
const pieceTimingLogger = getLogger("piece", { enabled: false });
const pieceUpdateLogger = getLogger("piece.update", {
  enabled: true,
  level: "warn",
});

/** The result of a system-pattern update check. */
export type UpdateOutcome =
  | "updated"
  | "repaired-provenance"
  | "current"
  | "skipped-skew"
  | "skipped-unknown-build"
  | "skipped-disabled";

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
      clientVersion: clientVersionFromEnv(readEnv),
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
      this.#manager.runtime.run(tx, pattern, {}, pieceCell);

      // Stamp the provenance the piece tracks for updates, mirroring
      // ensureDefaultPattern (CT-1890). Without this, every recreated root
      // is born unprovenanced and checkAndUpdateDefaultPattern skips
      // sourceless non-home roots forever — the repair path would mint
      // roots that can never auto-migrate. A custom program has no URL the
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
          this.#manager.runtime.run(tx, pattern, {}, pieceCell);

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

    await timePiecesPhase(
      "ensureDefaultPattern.startPiece",
      () => this.#manager.startPiece(rootToStart),
    );
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
   * Roll the space's system root pattern forward in place if its toolshed
   * serves a newer content identity. Best-effort: every failure logs and
   * returns without throwing. During {@link ensureDefaultPattern}, this runs
   * before the persisted root is started, so an unloadable obsolete identity
   * can be replaced before bootstrap. If the root is already running, its
   * watcher applies the same metadata swap in place.
   *
   * Never calls run()/stop()/recreateDefaultPattern.
   */
  async checkAndUpdateDefaultPattern(
    resolvedRoot?: Cell<NameSchema>,
  ): Promise<UpdateOutcome> {
    const runtime = this.#manager.runtime;
    const space = this.#manager.getSpace();

    // 1. Flag gate. Home is held behind a second flag until its durable state
    //    is verified stable-key-addressed (spec § open question 4).
    if (!runtime.experimental?.systemPatternAutoUpdate) {
      return "skipped-disabled";
    }
    const isHomeSpace = space === runtime.userIdentityDID;
    if (isHomeSpace && !runtime.experimental?.systemPatternAutoUpdateHome) {
      return "skipped-disabled";
    }

    try {
      // 2. The root piece's result cell, resolved without starting it. Ensure
      // passes the cell it already found; explicit checks resolve it here.
      const root = resolvedRoot ??
        await this.#manager.getDefaultPattern(false);
      if (!root) return "current";

      // 3. Provenance + per-space host (NOT the global apiUrl — a foreign-homed
      //    space must resolve against its own toolshed). A root created before
      //    provenance stamping is eligible only when its content-addressed,
      //    verified source closure names the official system entry appropriate
      //    to this space. Blindly deriving by space type could replace a custom
      //    home or a non-home root seeded from home's custom defaultAppUrl.
      const storedSource = getPatternSource(root);
      const inferredSource = storedSource === undefined
        ? await inferLegacySystemPatternSource(root, runtime, space)
        : undefined;
      if (storedSource === undefined && inferredSource === undefined) {
        return "current";
      }
      const url = storedSource ?? inferredSource!;
      const host = runtime.mappedHostFor(space) ?? runtime.apiUrl.href;
      const repairInferredProvenance = async (): Promise<UpdateOutcome> => {
        const { error } = await runtime.editWithRetry((tx) => {
          setPatternSource(root, tx, url);
        });
        if (error) {
          pieceUpdateLogger.warn(
            "provenance-repair-failed",
            () => [
              "checkAndUpdateDefaultPattern: provenance repair failed",
              space,
              error,
            ],
          );
          return "current";
        }
        return "repaired-provenance";
      };

      // The version gate (step 4) validates `host`'s build, and ?identity is
      // only comparable within that build — so only act on a source served BY
      // `host`. A cross-origin patternSource (a published / custom-app source
      // on another host) would be gated against the wrong build; defer it to
      // the cross-host published-pattern flow.
      const target = new URL(url, host);
      if (target.origin !== new URL(host).origin) {
        return "current";
      }

      // 4. Version gate. This is a precondition for every update.
      const toolshedVersion = await runtime.toolshedGitSha(host);
      if (!buildsMatch(runtime.clientVersion, toolshedVersion)) {
        // An unknown sha on either side proves nothing — skip silently. The
        // skew signal raises the shell's "reload to update" banner, which must
        // only claim what is proven: both builds known and different.
        if (
          runtime.clientVersion === undefined || toolshedVersion === undefined
        ) {
          return "skipped-unknown-build";
        }
        runtime.reportVersionSkew({
          space,
          clientVersion: runtime.clientVersion,
          toolshedVersion,
        });
        return "skipped-skew";
      }

      // 5. Current identity from the toolshed (cached). This does not load the
      // persisted pattern, so a stale identity that cannot start can still be
      // replaced before bootstrap.
      const runningRef = getPatternIdentityRef(root);
      const currentId = await runtime.cachedPatternIdentity(host, url);
      if (currentId === undefined) return "current"; // unresolved → skip

      // 6. Compare to the persisted identity. A verified legacy root that is
      // already current needs only the missing provenance write.
      if (currentId === runningRef?.identity) {
        if (storedSource !== undefined) return "current";
        return await repairInferredProvenance();
      }

      // 7. Apply. Fetch and compile only after ?identity proves that the
      // toolshed serves a different pattern. Compilation failure leaves the
      // persisted root untouched.
      const program = await runtime.harness.resolve(
        new HttpProgramResolver(target.href),
      );
      const pattern = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const entryRef = runtime.patternManager.getArtifactEntryRef(pattern) ??
        { identity: currentId, symbol: "default" };
      if (
        entryRef.identity === runningRef?.identity &&
        entryRef.symbol === runningRef.symbol
      ) {
        if (storedSource === undefined) {
          return await repairInferredProvenance();
        }
        return "current";
      }
      const { error } = await runtime.editWithRetry((tx) => {
        root.withTx(tx).setMetaRaw("patternIdentity", {
          identity: entryRef.identity,
          symbol: entryRef.symbol,
        });
        setPatternSource(root, tx, url); // back-fill provenance
      });
      if (error) {
        pieceUpdateLogger.warn(
          "swap-failed",
          () => ["checkAndUpdateDefaultPattern: swap failed", space, error],
        );
        return "current";
      }
      return "updated";
    } catch (error) {
      pieceUpdateLogger.warn(
        "check-failed",
        () => ["checkAndUpdateDefaultPattern: check failed", space, error],
      );
      return "current";
    }
  }
}
