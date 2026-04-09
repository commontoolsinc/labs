import {
  fabricFromNativeValue,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import { getLogger } from "@commonfabric/utils/logger";
import { isRecord } from "@commonfabric/utils/types";
import { rendererVDOMSchema } from "./schemas.ts";
import {
  type Frame,
  isModule,
  isPattern,
  isStreamValue,
  type Module,
  NAME,
  type NodeFactory,
  type Pattern,
  TYPE,
  UI,
  unsafe_materializeFactory,
  unsafe_originalPattern,
} from "./builder/types.ts";
import {
  patternFromFrame,
  popFrame,
  pushFrameFromCause,
} from "./builder/pattern.ts";
import { type Cell, isCell } from "./cell.ts";
import { type Action } from "./scheduler.ts";
import { diffAndUpdate } from "./data-updating.ts";
import {
  findAllWriteRedirectCells,
  unsafe_noteParentOnPatterns,
  unwrapOneLevelAndBindtoDoc,
} from "./pattern-binding.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  createSigilLinkFromParsedLink,
  isCellLink,
  isSigilLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { sendValueToBinding } from "./pattern-binding.ts";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import type { SigilLink } from "./sigil-types.ts";
import type { Runtime } from "./runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageSubscription,
  MemorySpace,
  URI,
} from "./storage/interface.ts";
import { TransactionWrapper } from "./storage/extended-storage-transaction.ts";
import {
  ignoreReadForScheduling,
  markReadAsPotentialWrite,
} from "./scheduler.ts";
import { FunctionCache } from "./function-cache.ts";
import { isRawBuiltinResult, type RawBuiltinReturnType } from "./module.ts";
import "./builtins/index.ts";
import { isCellResult } from "./query-result-proxy.ts";
import {
  cellAwareDeepCopy,
  describePatternOrModule,
  extractDefaultValues,
  getSpellLink,
  mergeObjects,
  sanitizeDebugLabel,
  setRunnableName,
  validateAndCheckOpaqueRefs,
} from "./runner-utils.ts";
import { setVerifiedFunctionRegistrar } from "./sandbox/function-hardening.ts";
export {
  cellAwareDeepCopy,
  extractDefaultValues,
  mergeObjects,
  validateAndCheckOpaqueRefs,
} from "./runner-utils.ts";

const logger = getLogger("runner", { enabled: true, level: "warn" });
const triggerFlowLogger = getLogger("runner.trigger-flow", {
  enabled: true,
  level: "warn",
  logCountEvery: 0,
});
const sourceLocationLogger = getLogger("runner.source-location", {
  enabled: false,
  level: "warn",
  logCountEvery: 0,
});

type ProcessCellData<T> = {
  [TYPE]: string;
  spell?: SigilLink;
  argument?: T;
  internal?: FabricValue;
  resultRef: SigilLink;
};

type SetupResult<R> = {
  resultCell: Cell<R>;
  pattern?: Pattern;
  processCell?: Cell<any>;
  needsStart: boolean;
};

type BoundNodeIO = {
  inputs: FabricValue;
  outputs: FabricValue;
  reads: NormalizedFullLink[];
  writes: NormalizedFullLink[];
};

type ResolvedJavaScriptModule = {
  fn: (...args: any[]) => any;
  name: string | undefined;
  verifiedLoadId: string | undefined;
};

type JavaScriptNodeContext = BoundNodeIO & {
  tx: IExtendedStorageTransaction;
  module: Module;
  processCell: Cell<any>;
  addCancel: AddCancel;
  pattern: Pattern;
  fn: (...args: any[]) => any;
  name: string | undefined;
  verifiedLoadId: string | undefined;
};

export class Runner {
  readonly cancels = new Map<`${MemorySpace}/${URI}`, Cancel>();
  private allCancels = new Set<Cancel>();
  private functionCache = new FunctionCache();
  private locallyPreparedResults = new Set<`${MemorySpace}/${URI}`>();
  // Map whose key is the result cell's full key, and whose values are the
  // patterns as strings
  private resultPatternCache = new Map<`${MemorySpace}/${URI}`, string>();

  constructor(readonly runtime: Runtime) {
    this.runtime.storageManager.subscribe(this.createStorageSubscription());
  }

  /**
   * Creates and returns a new storage subscription.
   *
   * This will be used to remove the cached pattern information when the result
   * cell changes. As a result, if we are scheduled, we will run that pattern
   * and regenerate the result.
   *
   * @returns A new IStorageSubscription instance
   */
  private createStorageSubscription(): IStorageSubscription {
    return {
      next: (notification) => {
        const space = notification.space;
        if ("changes" in notification) {
          for (const change of notification.changes) {
            if (change.address.type === "application/json") {
              this.resultPatternCache.delete(`${space}/${change.address.id}`);
            }
          }
        } else if (notification.type === "reset") {
          // copy keys, since we'll mutate the collection while iterating
          const cacheKeys = [...this.resultPatternCache.keys()];
          cacheKeys.filter((key) => key.startsWith(`${notification.space}/`))
            .forEach((key) => this.resultPatternCache.delete(key));
        }
        return { done: false };
      },
    };
  }

  /**
   * Prepare a piece for running by creating/updating its process and result
   * cells, registering the pattern, and applying defaults/arguments.
   * This does not schedule any nodes. Use start() to schedule execution.
   * If the piece is already running and the pattern changes, it will stop the
   * piece.
   */
  setup<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>> {
    if (providedTx) {
      this.setupInternal(providedTx, patternOrModule, argument, resultCell);
      return Promise.resolve(resultCell);
    } else {
      // Ignore retry/commit errors after retrying for now, as outside the tx,
      // we'll see the latest true value; it just lost the race against someone
      // else changing the pattern or argument. Correct action is anyhow similar
      // to what would have happened if the write succeeded and was immediately
      // overwritten. Still surface real callback failures from setupInternal so
      // callers don't silently continue after a broken setup.
      return this.runtime.editWithRetry((tx) => {
        this.setupInternal(tx, patternOrModule, argument, resultCell);
      }).then(({ error }) => {
        if (error) {
          if (
            error.name === "StorageTransactionAborted" &&
            error.message.startsWith("editWithRetry action threw:")
          ) {
            throw error.reason instanceof Error
              ? error.reason
              : new Error(error.message);
          }
        }

        return resultCell;
      });
    }
  }

  private getOrCreateProcessCell<T, R>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<R>,
  ): Cell<ProcessCellData<T>> {
    const sourceCell = resultCell.withTx(tx).getSourceCell();
    if (sourceCell !== undefined) {
      return sourceCell as Cell<ProcessCellData<T>>;
    }

    const processCell = this.runtime.getCell<ProcessCellData<T>>(
      resultCell.space,
      resultCell,
      undefined,
      tx,
    );
    resultCell.withTx(tx).setSourceCell(processCell);
    return processCell;
  }

  private resolveSetupPattern(
    patternOrModule: Pattern | Module | undefined,
    previousPatternId: string | undefined,
  ):
    | {
      pattern: Pattern;
      patternId: string;
      resolvedPatternOrModule: Pattern | Module;
    }
    | undefined {
    let resolvedPatternOrModule = patternOrModule;
    let patternId = patternOrModule ? undefined : previousPatternId;

    if (!resolvedPatternOrModule && patternId) {
      resolvedPatternOrModule = this.runtime.patternManager.patternById(
        patternId,
      );
      if (!resolvedPatternOrModule) {
        throw new Error(`Unknown pattern: ${patternId}`);
      }
    } else if (!resolvedPatternOrModule) {
      return undefined;
    }

    const pattern = isModule(resolvedPatternOrModule)
      ? this.moduleToPattern(resolvedPatternOrModule)
      : resolvedPatternOrModule;
    patternId ??= this.runtime.patternManager.registerPattern(pattern);

    return { pattern, patternId, resolvedPatternOrModule };
  }

  private updateProcessArgument<T>(
    tx: IExtendedStorageTransaction,
    processCell: Cell<ProcessCellData<T>>,
    argument: T,
  ): void {
    diffAndUpdate(
      this.runtime,
      tx,
      processCell.key("argument").getAsNormalizedFullLink(),
      argument,
      processCell.getAsNormalizedFullLink(),
    );
  }

  private maybeReuseRunningSetup<T, R>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<R>,
    processCell: Cell<ProcessCellData<T>>,
    argument: T,
    patternId: string,
    previousPatternId: string | undefined,
  ): SetupResult<R> | undefined {
    const key = this.getDocKey(resultCell);
    if (!this.cancels.has(key)) return undefined;

    if (argument === undefined && patternId === previousPatternId) {
      return { resultCell, needsStart: false };
    }

    if (previousPatternId === patternId) {
      this.updateProcessArgument(tx, processCell, argument);
      return { resultCell, needsStart: false };
    }

    return undefined;
  }

  private updateResultProjection<R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    processCell: Cell<any>,
    resultCell: Cell<R>,
    options: { preserveName: boolean },
  ): void {
    let result = unwrapOneLevelAndBindtoDoc<R, any>(
      pattern.result as R,
      processCell,
    );
    const previousResult = resultCell.withTx(tx).getRaw({
      meta: ignoreReadForScheduling,
    });
    if (
      options.preserveName &&
      isRecord(previousResult) &&
      previousResult[NAME]
    ) {
      result = { ...result, [NAME]: previousResult[NAME] };
    }
    if (!deepEqual(result, previousResult)) {
      resultCell.withTx(tx).setRawUntyped(
        fabricFromNativeValue(result, false),
      );
    }
  }

  private attachPatternMaterializer(
    pattern: Pattern,
    processCell: Cell<any>,
  ): void {
    if (!pattern[unsafe_originalPattern]) return;

    pattern[unsafe_materializeFactory] =
      (tx: IExtendedStorageTransaction) => (path: readonly PropertyKey[]) =>
        processCell.getAsQueryResult(path as PropertyKey[], tx);
  }

  private applySetupState<T, R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    patternId: string,
    previousPatternId: string | undefined,
    argument: T,
    resultCell: Cell<R>,
    processCell: Cell<ProcessCellData<T>>,
  ): void {
    const defaults = extractDefaultValues(pattern.argumentSchema) as Partial<T>;
    const previousInternal = processCell.key("internal").getRawUntyped({
      meta: ignoreReadForScheduling,
      frozen: false,
    });
    const internal = Object.assign(
      {},
      cellAwareDeepCopy(
        (defaults as unknown as { internal: FabricValue })?.internal,
      ),
      cellAwareDeepCopy(
        isRecord(pattern.initial) && isRecord(pattern.initial.internal)
          ? pattern.initial.internal
          : {},
      ),
      isRecord(previousInternal) ? previousInternal : {},
    ) as FabricValue;

    let nextArgument = argument;
    if (
      !processCell.key("argument").getRaw({ meta: ignoreReadForScheduling })
    ) {
      nextArgument = mergeObjects<T>(argument as any, defaults);
    }

    processCell.withTx(tx).setRawUntyped(fabricFromNativeValue({
      ...processCell.getRaw({ meta: ignoreReadForScheduling }),
      [TYPE]: patternId,
      resultRef: pattern.resultSchema !== undefined
        ? resultCell.asSchema(pattern.resultSchema).getAsLink({
          base: processCell,
          includeSchema: true,
          keepAsCell: true,
        })
        : resultCell.getAsLink({
          base: processCell,
        }),
      internal,
      spell: getSpellLink(patternId),
    }, false));

    if (nextArgument) {
      this.updateProcessArgument(tx, processCell, nextArgument);
    }

    this.updateResultProjection(tx, pattern, processCell, resultCell, {
      preserveName: previousPatternId === patternId,
    });
    this.attachPatternMaterializer(pattern, processCell);
  }

  /**
   * Internal setup that returns whether scheduling is required.
   */
  private setupInternal<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): SetupResult<R> {
    const tx = providedTx ?? this.runtime.edit();
    const sourceCell = resultCell.withTx(tx).getSourceCell();
    const processCell = this.getOrCreateProcessCell<T, R>(tx, resultCell);

    logger.debug("cell-info", () => [
      `resultCell: ${resultCell.getAsNormalizedFullLink().id}`,
      `processCell: ${
        resultCell.withTx(tx).getSourceCell()?.getAsNormalizedFullLink().id
      }`,
    ]);

    const previousPatternId = processCell.withTx(tx).key(TYPE).getRaw({
      meta: ignoreReadForScheduling,
    });
    const resolvedPattern = this.resolveSetupPattern(
      patternOrModule,
      previousPatternId,
    );

    if (!resolvedPattern) {
      console.warn(
        "No pattern provided and no pattern found in process doc. Not running.",
      );
      this.locallyPreparedResults.delete(this.getDocKey(resultCell));
      return { resultCell, needsStart: false };
    }

    const { pattern, patternId, resolvedPatternOrModule } = resolvedPattern;
    const sourceKey = getTxDebugActionId(tx) ?? "none";
    triggerFlowLogger.debug(`setup-internal/${sourceKey}`, () => [
      `[SETUP] source=${sourceKey}`,
      `result=${resultCell.getAsNormalizedFullLink().id}`,
      `process=${processCell.getAsNormalizedFullLink().id}`,
      `reusedSource=${sourceCell !== undefined}`,
      `pattern=${describePatternOrModule(resolvedPatternOrModule)}`,
      `previousPatternId=${previousPatternId ?? "none"}`,
      `nextPatternId=${patternId}`,
    ]);

    this.runtime.patternManager.savePattern({
      patternId,
      space: resultCell.space,
    }, tx);

    if (isCellLink(argument)) {
      argument = createSigilLinkFromParsedLink(
        parseLink(argument),
        { base: processCell, includeSchema: true, overwrite: "redirect" },
      ) as T;
    }

    const runningSetup = this.maybeReuseRunningSetup(
      tx,
      resultCell,
      processCell,
      argument,
      patternId,
      previousPatternId,
    );
    if (runningSetup) {
      return runningSetup;
    }

    this.applySetupState(
      tx,
      pattern,
      patternId,
      previousPatternId,
      argument,
      resultCell,
      processCell,
    );

    this.discoverAndCacheFunctions(pattern, new Set());

    const key = this.getDocKey(resultCell);
    this.locallyPreparedResults.add(key);
    tx.addCommitCallback((_tx, result) => {
      if (result.error) {
        this.locallyPreparedResults.delete(key);
      }
    });

    return { resultCell, pattern, processCell, needsStart: true };
  }

  /**
   * Start scheduling nodes for a previously set up piece.
   * If already started, this is a no-op.
   *
   * Returns a Promise that resolves to true on success, or rejects with an error.
   * Runs synchronously when data is available (important for tests).
   */
  start<T = any>(resultCell: Cell<T>): Promise<boolean> {
    return this.doStart(resultCell);
  }

  /** Convert a module to pattern format */
  private moduleToPattern(module: Module): Pattern {
    return {
      argumentSchema: module.argumentSchema ?? {},
      resultSchema: module.resultSchema ?? {},
      result: { $alias: { path: ["internal"] } },
      nodes: [
        {
          module,
          inputs: { $alias: { path: ["argument"] } },
          outputs: { $alias: { path: ["internal"] } },
        },
      ],
    } satisfies Pattern;
  }

  /** Resolve a Pattern or Module to a Pattern */
  private resolveToPattern(patternOrModule: Pattern | Module): Pattern {
    return isModule(patternOrModule)
      ? this.moduleToPattern(patternOrModule as Module)
      : (patternOrModule as Pattern);
  }

  /**
   * Core start implementation. Sets up cancel groups, instantiates nodes,
   * and watches for pattern changes.
   *
   * @param resultCell - The result cell to start
   * @param processCell - The process cell containing pattern state
   * @param options.tx - Transaction to use for initial setup (optional)
   * @param options.givenPattern - Pattern to use instead of looking up by ID
   * @param options.allowAsyncLoad - Whether to allow async pattern loading
   * @returns Promise for async mode, void for sync mode
   */
  private startCore<T = any>(
    resultCell: Cell<T>,
    processCell: Cell<any>,
    options: {
      tx?: IExtendedStorageTransaction;
      givenPattern?: Pattern;
      doNotUpdateOnPatternChange?: boolean;
    } = {},
  ): void {
    const { tx, givenPattern, doNotUpdateOnPatternChange } = options;
    const key = this.getDocKey(resultCell);
    this.locallyPreparedResults.delete(key);

    // Create cancel group early - before the $TYPE sink
    const [cancel, addCancel] = useCancelGroup();
    this.cancels.set(key, cancel);
    this.allCancels.add(cancel);

    // Helper to clean up on error
    const cleanup = () => {
      this.cancels.delete(key);
      this.allCancels.delete(cancel);
      cancel();
    };

    // Track pattern ID and node cancellation
    let currentPatternId: string | undefined;
    let cancelNodes: Cancel | undefined;

    // Helper to instantiate nodes for a pattern
    const instantiatePattern = (
      pattern: Pattern,
      useTx?: IExtendedStorageTransaction,
    ) => {
      // Create new cancel group for nodes
      const [nodeCancel, addNodeCancel] = useCancelGroup();
      cancelNodes = nodeCancel;
      addCancel(nodeCancel);

      // Instantiate nodes
      this.discoverAndCacheFunctions(pattern, new Set());
      const actualTx = useTx ?? this.runtime.edit();
      const shouldCommit = !useTx;
      try {
        for (const node of pattern.nodes) {
          this.instantiateNode(
            actualTx,
            node.module,
            node.inputs,
            node.outputs,
            processCell.withTx(actualTx),
            addNodeCancel,
            pattern,
          );
        }
      } finally {
        if (shouldCommit) actualTx.commit();
      }
    };

    // Helper to set up the $TYPE watcher
    const setupTypeWatcher = () => {
      const typeCell = processCell.key(TYPE).asSchema({ type: "string" });
      addCancel(
        typeCell.sink((newPatternId) => {
          if (!newPatternId) return;
          if (newPatternId === currentPatternId) return; // No change

          // Pattern changed
          const previousPatternId = currentPatternId;
          currentPatternId = newPatternId;

          const resolved = this.runtime.patternManager.patternById(
            newPatternId,
          );
          if (!resolved) {
            // Async load for pattern change after initial start.
            // Errors are logged here since there's no caller to propagate to.
            this.runtime.patternManager
              .loadPattern(newPatternId, processCell.space)
              .then((loaded) => {
                if (currentPatternId !== newPatternId) return;

                logger.info("pattern changed", {
                  from: {
                    id: previousPatternId,
                    pattern: this.runtime.patternManager.patternById(
                      previousPatternId!,
                    ),
                  },
                  to: { id: newPatternId, pattern: loaded },
                });

                // Cancel previous nodes (after we're sure it's a valid one)
                cancelNodes?.();

                instantiatePattern(loaded);
              })
              .catch((err) => {
                logger.error(
                  "pattern-load-error",
                  `Failed to load pattern ${newPatternId}`,
                  err,
                );
              });
          } else {
            cancelNodes?.();
            instantiatePattern(resolved);
          }
        }),
      );
    };

    // Get initial pattern ID
    const processCellForRead = tx ? processCell.withTx(tx) : processCell;
    const initialPatternId = processCellForRead.key(TYPE).getRaw({
      meta: ignoreReadForScheduling,
    }) as string | undefined;

    if (!initialPatternId) {
      cleanup();
      throw new Error("Cannot start: no pattern ID ($TYPE)");
    }

    // Determine initial pattern
    if (givenPattern) {
      currentPatternId = initialPatternId;
      if (
        this.runtime.patternManager.registerPattern(givenPattern) !==
          currentPatternId
      ) {
        cleanup();
        throw new Error("Pattern ID mismatch");
      }
      instantiatePattern(givenPattern, tx);
      if (!doNotUpdateOnPatternChange) {
        setupTypeWatcher();
      }
      return;
    }

    // Try sync lookup
    const initialResolved = this.runtime.patternManager.patternById(
      initialPatternId,
    );
    if (!initialResolved) {
      cleanup();
      throw new Error(`Unknown pattern: ${initialPatternId}`);
    }

    // Sync path - instantiate immediately
    currentPatternId = initialPatternId;
    instantiatePattern(this.resolveToPattern(initialResolved), tx);
    if (!doNotUpdateOnPatternChange) {
      setupTypeWatcher();
    }

    return;
  }

  /**
   * Internal start implementation with cascade of checks.
   * Each check: if it fails and needs async work, return a promise that
   * resolves the missing piece and retries.
   */
  private doStart<T = any>(
    resultCell: Cell<T>,
    seenCells: Set<Cell> = new Set(),
  ): Promise<boolean> {
    // `synced === true` means this cell was rehydrated from storage rather than
    // assembled purely from writes in the current runtime, so start() may need
    // to await dependency sync before process startup.
    const wasSyncedAtEntry =
      (resultCell as Cell<any> & { synced?: boolean }).synced === true;

    // Step 1: For subpath cells, resolve to root cell
    const link = resultCell.getAsNormalizedFullLink();
    const rootCell = link.path.length > 0
      ? this.runtime.getCellFromLink({ ...link, path: [] })
      : resultCell;

    const key = this.getDocKey(rootCell);
    const wasPreparedLocally = this.locallyPreparedResults.has(key);

    // Step 2: Already started? Return success
    if (this.cancels.has(key)) return Promise.resolve(true);

    // Step 3: Not synced yet? Sync and retry
    // Once getRaw() has a value, all properties including source are synced.
    if (rootCell.getRaw() === undefined) {
      return Promise.resolve(rootCell.sync()).then(() => {
        if (rootCell.getRaw() === undefined) {
          return Promise.reject(new Error("No data at cell"));
        } else {
          return this.doStart(rootCell, seenCells);
        }
      });
    }

    // Step 4: Check for process cell, or follow link if there is one
    const processCell = rootCell.getSourceCell();
    if (!processCell) {
      const maybeLink = parseLink(resultCell.getRaw(), resultCell);
      if (maybeLink) {
        // Follow link. This happens when the id is for a handle that pointed to
        // the actual pattern instance, sometimes because it was passed along.
        const nextCell = this.runtime.getCellFromLink(maybeLink);
        if (seenCells.has(nextCell)) {
          return Promise.reject(new Error("Circular link detected"));
        }
        seenCells.add(nextCell);
        logger.info("start: followed link", {
          from: resultCell.getAsNormalizedFullLink(),
          to: nextCell.getAsNormalizedFullLink(),
        });
        return this.doStart(nextCell, seenCells);
      } else {
        return Promise.reject(new Error("Cannot start: no process cell"));
      }
    }

    // Step 5: Check whether the pattern is available, otherwise load it
    const patternId = processCell.key(TYPE).getRaw() as string | undefined;
    if (!patternId) {
      return Promise.reject(
        new Error(`Cannot start: no pattern ID ($TYPE)`),
      );
    }
    const pattern = this.runtime.patternManager.patternById(patternId);
    if (!pattern) {
      return this.runtime.patternManager.loadPattern(
        patternId,
        processCell.space,
      )
        .then((loaded) => {
          if (loaded) {
            return this.doStart(rootCell, seenCells);
          } else {
            return Promise.reject(
              new Error(`Could not load pattern ${patternId}`),
            );
          }
        });
    }

    const resolvedPattern = this.resolveToPattern(pattern);

    // Fast path for pieces prepared in the current runtime via setup()/run().
    // Those writes are already present locally, so we should preserve the
    // historical synchronous start() behavior even if an earlier read flipped
    // the cell's generic `synced` flag. The dependency sync below is
    // specifically for resumed pieces that came from storage.
    if (!wasSyncedAtEntry || wasPreparedLocally) {
      try {
        this.startCore(rootCell, processCell, {
          givenPattern: resolvedPattern,
        });
      } catch (err) {
        return Promise.reject(err);
      }

      return Promise.resolve(true);
    }

    // Step 6: Sync the cells this running pattern depends on before wiring the
    // scheduler back up in a fresh runtime. Without this, resumed pieces can
    // observe the last persisted result but miss subsequent input updates.
    return this.syncCellsForRunningPattern(rootCell, resolvedPattern)
      .then(() => {
        try {
          this.startCore(rootCell, processCell, {
            givenPattern: resolvedPattern,
          });
        } catch (err) {
          return Promise.reject(err);
        }

        return true;
      });
  }

  private startWithTx<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    givenPattern?: Pattern,
    options: { doNotUpdateOnPatternChange?: boolean } = {},
  ): void {
    const key = this.getDocKey(resultCell);
    if (this.cancels.has(key)) return; // Already started

    const processCell = resultCell.withTx(tx).getSourceCell();
    if (!processCell) {
      throw new Error("Cannot start: no process cell");
    }

    this.startCore(resultCell, processCell, {
      tx,
      givenPattern,
      doNotUpdateOnPatternChange: options.doNotUpdateOnPatternChange,
    });
  }

  /**
   * Run a pattern.
   *
   * resultCell is required and should have an id. processCell is created if not
   * already set.
   *
   * If no pattern is provided, the previous one is used, and the pattern is
   * started if it isn't already started.
   *
   * If no argument is provided, the previous one is used, and the pattern is
   * started if it isn't already running.
   *
   * If a new pattern or any argument value is provided, a currently running
   * pattern is stopped, the pattern and argument replaced and the pattern
   * restarted.
   *
   * @param patternFactory - Function that takes the argument and returns a
   * pattern.
   * @param argument - The argument to pass to the pattern. Can be static data
   * and/or cell references, including cell value proxies, docs and regular
   * cells.
   * @param resultCell - Cell to run the pattern off.
   * @returns The result cell.
   */
  run<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
    options?: { doNotUpdateOnPatternChange?: boolean },
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: { doNotUpdateOnPatternChange?: boolean },
  ): Cell<R>;
  run<T, R = any>(
    providedTx: IExtendedStorageTransaction,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options: { doNotUpdateOnPatternChange?: boolean } = {},
  ): Cell<R> {
    const tx = providedTx ?? this.runtime.edit();
    const sourceKey = getTxDebugActionId(tx) ?? "none";

    triggerFlowLogger.debug(`runner-run/${sourceKey}`, () => [
      `[RUN] source=${sourceKey}`,
      `result=${resultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(patternOrModule)}`,
      `providedTx=${Boolean(providedTx)}`,
    ]);

    const { needsStart, pattern } = this.setupInternal(
      tx,
      patternOrModule,
      argument,
      resultCell,
    );

    if (needsStart) {
      this.startWithTx(tx, resultCell, pattern, options);
    }

    if (!providedTx) tx.commit();

    return resultCell;
  }

  async runSynced(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs?: any,
  ) {
    await resultCell.sync();

    const synced = await this.syncCellsForRunningPattern(
      resultCell,
      pattern,
      inputs,
    );

    // Run the pattern.
    //
    // If the result cell has a transaction attached, and it is still open,
    // we'll use it for all reads and writes as it might be a pending read.
    //
    // TODO(seefeld): There is currently likely a race condition with the
    // scheduler if the transaction isn't committed before the first functions
    // run. Though most likely the worst case is just extra invocations.
    const givenTx = resultCell.tx?.status().status === "ready" && resultCell.tx;
    let setupRes: ReturnType<typeof this.setupInternal> | undefined;
    if (givenTx) {
      // If tx is given, i.e. result cell was part of a tx that is still open,
      // caller manages retries
      setupRes = this.setupInternal(
        givenTx,
        pattern,
        inputs,
        resultCell.withTx(givenTx),
      );
    } else {
      const { error } = await this.runtime.editWithRetry((tx) => {
        setupRes = this.setupInternal(
          tx,
          pattern,
          inputs,
          resultCell.withTx(tx),
        );
      });
      if (error) {
        logger.error("pattern-setup-error", "Error setting up pattern", error);
        setupRes = undefined;
      }
    }

    // If a new pattern was specified, make sure to sync any new cells
    if (pattern || !synced) {
      await this.syncCellsForRunningPattern(resultCell, pattern);
    }

    if (setupRes?.needsStart) {
      const tx = givenTx || this.runtime.edit();
      this.startWithTx(tx, resultCell.withTx(tx), setupRes.pattern);
      if (!givenTx) {
        // Should be unnecessary as the start itself is read-only
        // TODO(seefeld): Enforce this by adding a read-only flag for tx
        await tx.commit().then(({ error }) => {
          if (error) {
            logger.error(
              "tx-commit-error",
              () => [
                "Error committing transaction",
                "\nError:",
                JSON.stringify(error, null, 2),
                error.name === "ConflictError"
                  ? [
                    "\nConflict details:",
                    JSON.stringify(error.conflict, null, 2),
                    "\nTransaction:",
                    JSON.stringify(error.transaction, null, 2),
                  ]
                  : [],
              ],
            );
          }
        });
      }
    }

    return pattern?.resultSchema
      ? resultCell.asSchema(pattern.resultSchema)
      : resultCell;
  }

  private getDocKey(cell: Cell<any>): `${MemorySpace}/${URI}` {
    const { space, id } = cell.getAsNormalizedFullLink();
    return `${space}/${id}`;
  }

  private async syncCellsForRunningPattern(
    resultCell: Cell<any>,
    pattern: Module | Pattern,
    inputs?: any,
  ): Promise<boolean> {
    const seen = new Set<Cell<any>>();
    const promises = new Set<Promise<any>>();

    const syncAllMentionedCells = (value: any) => {
      if (seen.has(value)) return;
      seen.add(value);

      const link = parseLink(value, resultCell);

      if (link) {
        const maybePromise = this.runtime.getCellFromLink(link).sync();
        if (maybePromise instanceof Promise) promises.add(maybePromise);
      } else if (isRecord(value)) {
        for (const key in value) syncAllMentionedCells(value[key]);
      }
    };

    syncAllMentionedCells(inputs);
    await Promise.all(promises);

    // TODO(@ubik2): Move this to a more general method in schema.ts or cfc.ts
    const processCellSchema: any = {
      type: "object",
      properties: {
        [TYPE]: { type: "string" },
        argument: pattern.argumentSchema ?? true,
      },
      required: [TYPE],
    };

    if (
      isRecord(processCellSchema) && "properties" in processCellSchema &&
      isRecord(pattern.argumentSchema)
    ) {
      // extract $defs and definitions and remove them from argumentSchema
      const { $defs, definitions, ...rest } = pattern.argumentSchema;
      (processCellSchema as any).properties.argument = rest ?? true;
      if (isRecord($defs)) {
        processCellSchema.$defs = { ...$defs };
      }
      if (isRecord(definitions)) {
        processCellSchema.definitions = { ...definitions };
      }
    }

    const sourceCell = resultCell.getSourceCell(processCellSchema);
    if (!sourceCell) return false;

    await sourceCell.sync();

    // We could support this by replicating what happens in runner, but since
    // we're calling this again when returning false, this is good enough for now.
    if (isModule(pattern)) return false;

    const cells: Cell<any>[] = [];

    // Sync all the inputs and outputs of the pattern nodes.
    for (const node of pattern.nodes) {
      const inputs = findAllWriteRedirectCells(node.inputs, sourceCell);
      const outputs = findAllWriteRedirectCells(node.outputs, sourceCell);

      // TODO(seefeld): This ignores schemas provided by modules, so it might
      // still fetch a lot.
      [...inputs, ...outputs].forEach((link) => {
        cells.push(this.runtime.getCellFromLink(link));
      });
    }

    // Sync all the previously computed results.
    if (pattern.resultSchema !== undefined) {
      cells.push(resultCell.asSchema(pattern.resultSchema));
    }

    // If the result has a UI and it wasn't already included in the result
    // schema, sync it as well. This prevents the UI from flashing, because it's
    // first locally computed, then conflicts on write and only then properly
    // received from the server.
    if (
      isRecord(pattern.result) &&
      pattern.result[UI] &&
      (!isRecord(pattern.resultSchema) ||
        !pattern.resultSchema.properties?.[UI])
    ) {
      cells.push(resultCell.key(UI).asSchema(rendererVDOMSchema));
    }

    await Promise.all(cells.map((c) => c.sync()));

    return true;
  }

  /**
   * Stop a pattern. This will cancel the pattern and all its children.
   *
   * TODO: This isn't a good strategy, as other instances might depend on behavior
   * provided here, even if the user might no longer care about e.g. the UI here.
   * A better strategy would be to schedule based on effects and unregister the
   * effects driving execution, e.g. the UI.
   *
   * @param resultCell - The result doc or cell to stop.
   */
  stop<T>(resultCell: Cell<T>): void {
    const key = this.getDocKey(resultCell);
    this.cancels.get(key)?.();
    this.cancels.delete(key);
    this.locallyPreparedResults.delete(key);
  }

  stopAll(): void {
    // Cancel all tracked operations
    for (const cancel of this.allCancels) {
      try {
        cancel();
      } catch (error) {
        console.warn("Error canceling operation:", error);
      }
    }
    this.allCancels.clear();
    // Clear the result pattern cache as well, since the actions have been
    // canceled
    this.resultPatternCache.clear();
    this.locallyPreparedResults.clear();
  }

  /**
   * Discover and cache JavaScript functions from a pattern.
   * This recursively traverses the pattern structure to find all JavaScript modules
   * with string implementations and evaluates them for caching.
   *
   * @param pattern The pattern to discover functions from
   */
  private discoverAndCacheFunctions(
    pattern: Pattern,
    seen: Set<object>,
  ): void {
    if (seen.has(pattern)) return;
    seen.add(pattern);

    for (const node of pattern.nodes) {
      this.discoverAndCacheFunctionsFromModule(node.module, seen);

      // Also check inputs for nested patterns (e.g., in map operations)
      this.discoverAndCacheFunctionsFromValue(node.inputs, seen);
    }
  }

  /**
   * Discover and cache functions from a module.
   *
   * @param module The module to process
   */
  private discoverAndCacheFunctionsFromModule(
    module: Module,
    seen: Set<object>,
  ): void {
    if (seen.has(module)) return;
    seen.add(module);

    if (!isModule(module)) return;

    switch (module.type) {
      case "javascript":
        // Only prewarm the cache from functions that were already registered
        // by the SES verification/evaluation pipeline. Host callbacks must not
        // enter the execution cache directly.
        if (module.implementationRef && !this.functionCache.has(module)) {
          const executable = this.runtime.harness.getExecutableFunction(
            module.implementationRef,
          );
          if (executable) {
            this.functionCache.set(module, executable);
          }
        }
        break;

      case "pattern":
        // Recursively discover functions in nested patterns
        if (isPattern(module.implementation)) {
          this.discoverAndCacheFunctions(module.implementation, seen);
        }
        break;

      case "ref":
        // Resolve reference and process the referenced module
        try {
          const referencedModule = this.runtime.moduleRegistry.getModule(
            module.implementation as string,
          );
          this.discoverAndCacheFunctionsFromModule(referencedModule, seen);
        } catch (error) {
          console.warn(
            `Failed to resolve module reference for implementation "${module.implementation}":`,
            error,
          );
        }
        break;
    }
  }

  /**
   * Discover and cache functions from a value that might contain patterns.
   * This handles cases where patterns are passed as inputs (e.g., to map operations).
   *
   * @param value The value to search for patterns
   */
  private discoverAndCacheFunctionsFromValue(
    value: FabricValue,
    seen: Set<object>,
  ): void {
    if (isPattern(value)) {
      this.discoverAndCacheFunctions(value, seen);
      return;
    }

    if (isModule(value)) {
      this.discoverAndCacheFunctionsFromModule(value, seen);
      return;
    }

    if (
      !isRecord(value) || isCell(value) || isCellResult(value)
    ) {
      return;
    }

    if (seen.has(value)) return;
    seen.add(value);

    // Recursively search in objects and arrays
    if (Array.isArray(value)) {
      for (const item of value as FabricValue[]) {
        this.discoverAndCacheFunctionsFromValue(item, seen);
      }
      return;
    }

    for (const key in value as Record<string, any>) {
      this.discoverAndCacheFunctionsFromValue(
        value[key] as FabricValue,
        seen,
      );
    }
  }

  private instantiateNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    processCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    moduleRefName?: string,
  ) {
    if (isModule(module)) {
      switch (module.type) {
        case "ref": {
          const refName = module.implementation as string;
          this.instantiateNode(
            tx,
            this.runtime.moduleRegistry.getModule(
              refName,
            ),
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            pattern,
            refName,
          );
          break;
        }
        case "javascript":
          this.instantiateJavaScriptNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            pattern,
          );
          break;
        case "raw":
          this.instantiateRawNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            pattern,
            moduleRefName,
          );
          break;
        case "passthrough":
          this.instantiatePassthroughNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            pattern,
          );
          break;
        case "pattern":
          this.instantiatePatternNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            pattern,
          );
          break;
        default:
          throw new Error(`Unknown module type: ${module.type}`);
      }
    } else if (isWriteRedirectLink(module)) {
      // TODO(seefeld): Implement, a dynamic node
    } else {
      throw new Error(`Unknown module: ${JSON.stringify(module)}`);
    }
  }

  private bindNodeIO(
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    processCell: Cell<any>,
  ): BoundNodeIO {
    const inputs = unwrapOneLevelAndBindtoDoc(inputBindings, processCell);
    const outputs = unwrapOneLevelAndBindtoDoc(outputBindings, processCell);
    return {
      inputs,
      outputs,
      reads: findAllWriteRedirectCells(inputs, processCell),
      writes: findAllWriteRedirectCells(outputs, processCell),
    };
  }

  private resolveJavaScriptFunction(
    module: Module,
    pattern: Pattern,
  ): ResolvedJavaScriptModule {
    let fn: (...args: any[]) => any;
    const patternId = this.runtime.patternManager.getPatternId(pattern);
    const verifiedLoadId = module.implementationRef
      ? this.runtime.harness.getVerifiedLoadId?.(
        module.implementationRef,
        patternId,
      )
      : undefined;

    if (module.implementationRef) {
      const cached = this.functionCache.get(module);
      if (cached) {
        fn = cached;
      } else {
        const executable = this.runtime.harness.getExecutableFunction(
          module.implementationRef,
          patternId,
        );
        fn = executable
          ? executable as (...args: any[]) => any
          : this.getFallbackJavaScriptImplementation(module);
        this.functionCache.set(module, fn);
      }
    } else {
      const cached = this.functionCache.get(module);
      if (cached) {
        fn = cached;
      } else {
        fn = this.getFallbackJavaScriptImplementation(module);
        this.functionCache.set(module, fn);
      }
    }

    const namedFn = fn as {
      src?: string;
      name?: string;
      sourceLocationSample?: Record<string, unknown>;
    };
    const name = namedFn.src || fn.name;
    if (name && namedFn.sourceLocationSample) {
      sourceLocationLogger.flag("sample", name, true, {
        name,
        ...namedFn.sourceLocationSample,
      });
    }

    return { fn, name, verifiedLoadId };
  }

  private resolveJavaScriptStreamLink(
    inputs: FabricValue,
    processCell: Cell<any>,
    tx: IExtendedStorageTransaction,
  ): NormalizedFullLink | undefined {
    if (!isRecord(inputs) || !("$event" in inputs)) return undefined;

    let value: FabricValue = inputs.$event as FabricValue;
    while (isWriteRedirectLink(value)) {
      const maybeStreamLink = resolveLink(
        this.runtime,
        tx,
        parseLink(value, processCell),
        "writeRedirect",
      );
      value = tx.readValueOrThrow(maybeStreamLink);
    }

    return isStreamValue(value)
      ? parseLink(inputs.$event, processCell)
      : undefined;
  }

  private createPatternFrame(
    cause: unknown,
    pattern: Pattern,
    processCell: Cell<any>,
    tx: IExtendedStorageTransaction,
    inHandler: boolean,
    verifiedLoadId?: string,
  ): Frame {
    return pushFrameFromCause(cause, {
      unsafe_binding: {
        pattern,
        materialize: (path: readonly PropertyKey[]) =>
          processCell.getAsQueryResult(path, tx),
        space: processCell.space,
        tx,
      },
      inHandler,
      runtime: this.runtime,
      space: processCell.space,
      tx,
      ...(verifiedLoadId ? { verifiedLoadId } : {}),
    });
  }

  private readJavaScriptArgument(
    module: Module,
    inputsCell: Cell<any>,
    tx: IExtendedStorageTransaction,
    options: { bindTxToSchema?: boolean; writableProxy?: boolean } = {},
  ): { argument: any; isValidArgument: boolean } {
    const argument = module.argumentSchema !== undefined
      ? options.bindTxToSchema
        ? inputsCell.asSchema(module.argumentSchema).withTx(tx).get()
        : inputsCell.asSchema(module.argumentSchema).get()
      : inputsCell.getAsQueryResult([], tx, options.writableProxy);

    return {
      argument,
      isValidArgument: module.argumentSchema === false ||
        argument !== undefined,
    };
  }

  private serializeQueryResult(
    inputsCell: Cell<any>,
    tx: IExtendedStorageTransaction,
  ): string {
    try {
      return JSON.stringify(inputsCell.getAsQueryResult([], tx));
    } catch (_error) {
      return "(Can't serialize to JSON)";
    }
  }

  private getJavaScriptInputState(
    module: Module,
    inputsCell: Cell<any>,
    tx: IExtendedStorageTransaction,
  ): { schema: Module["argumentSchema"]; raw: unknown; queryResult: string } {
    return {
      schema: module.argumentSchema,
      raw: inputsCell.getRaw(),
      queryResult: this.serializeQueryResult(inputsCell, tx),
    };
  }

  private updateInvalidInputFlag(
    name: string | undefined,
    isValidArgument: boolean,
    module: Module,
    inputsCell: Cell<any>,
    tx: IExtendedStorageTransaction,
  ): void {
    if (!name) return;

    if (!isValidArgument) {
      logger.flag(
        "action invalid input",
        `action:${name}`,
        true,
        this.getJavaScriptInputState(module, inputsCell, tx),
      );
      return;
    }

    logger.flag(
      "action invalid input",
      `action:${name}`,
      false,
    );
  }

  private handleJavaScriptHandlerResult(
    tx: IExtendedStorageTransaction,
    result: any,
    name: string | undefined,
    frame: Frame,
    processCell: Cell<any>,
    addCancel: AddCancel,
    cause: Record<string, any>,
  ): any {
    if (
      !validateAndCheckOpaqueRefs(result, name) &&
      frame.opaqueRefs.size === 0
    ) {
      return result;
    }

    const resultPattern = patternFromFrame(() => result);
    const resultCell = this.run(
      tx,
      resultPattern,
      undefined,
      this.runtime.getCell(
        processCell.space,
        { resultFor: cause },
        undefined,
        tx,
      ),
    );

    const rawResult = tx.readValueOrThrow(
      resultCell.getAsNormalizedFullLink(),
      { meta: ignoreReadForScheduling },
    );
    const resultRedirects = findAllWriteRedirectCells(rawResult, processCell);
    const readResultAction: Action = (tx) =>
      resultRedirects.forEach((link) => tx.readValueOrThrow(link));

    if (name) {
      setRunnableName(readResultAction, `readResult:${name}`, { setSrc: true });
    }

    const cancel = this.runtime.scheduler.subscribe(
      readResultAction,
      readResultAction,
      { isEffect: true },
    );
    addCancel(() => {
      cancel();
      this.stop(resultCell);
    });

    return result;
  }

  private writeJavaScriptActionResult(
    tx: IExtendedStorageTransaction,
    result: any,
    name: string | undefined,
    frame: Frame,
    processCell: Cell<any>,
    outputs: FabricValue,
    addCancel: AddCancel,
    resultFor: { inputs: FabricValue; outputs: FabricValue; fn: string },
    previousResultCellRef: { current?: Cell<any> },
    recordIgnoredSchedulingWrite?: (link: NormalizedFullLink) => void,
  ): any {
    if (
      !validateAndCheckOpaqueRefs(result, name) &&
      frame.opaqueRefs.size === 0
    ) {
      sendValueToBinding(tx, processCell, outputs, result);
      return result;
    }

    const resultPattern = patternFromFrame(() => result);
    const resultCell = previousResultCellRef.current ??
      this.runtime.getCell(
        processCell.space,
        { resultFor },
        undefined,
        tx,
      );

    const resultPatternAsString = JSON.stringify(resultPattern);
    const cacheKey = `${resultCell.space}/${resultCell.sourceURI}` as const;
    const previousResultPatternAsString = this.resultPatternCache.get(cacheKey);
    const patternUnchanged =
      previousResultPatternAsString === resultPatternAsString;

    if (!patternUnchanged) {
      this.resultPatternCache.set(cacheKey, resultPatternAsString);

      const childSetupTx = new TransactionWrapper(tx, {
        nonReactive: true,
      });
      this.run(
        childSetupTx,
        resultPattern,
        undefined,
        resultCell,
      );
      const childProcessCell = resultCell.withTx(tx).getSourceCell();
      if (childProcessCell) {
        recordIgnoredSchedulingWrite?.(
          childProcessCell.getAsNormalizedFullLink(),
        );
      }
      addCancel(() => this.stop(resultCell));

      tx.addCommitCallback((_committedTx, result) => {
        if (result.error) {
          this.stop(resultCell);
        }
      });
    }

    previousResultCellRef.current ??= resultCell;
    sendValueToBinding(
      tx,
      processCell,
      outputs,
      resultCell.getAsLink({ base: processCell }),
    );
    return result;
  }

  private instantiateJavaScriptHandlerNode(
    {
      module,
      processCell,
      addCancel,
      pattern,
      fn,
      name,
      inputs,
      reads,
      writes,
      verifiedLoadId,
      streamLink,
    }: JavaScriptNodeContext & { streamLink: NormalizedFullLink },
  ): void {
    const handler = (tx: IExtendedStorageTransaction, event: any) => {
      if (event?.preventDefault) event.preventDefault();

      const eventInputs = {
        ...(inputs as Record<string, any>),
        $event: event,
      };
      const cause = {
        ...(inputs as Record<string, any>),
        $event: crypto.randomUUID(),
      };
      const frame = this.createPatternFrame(
        cause,
        pattern,
        processCell,
        tx,
        true,
        verifiedLoadId,
      );

      try {
        const inputsCell = this.runtime.getImmutableCell(
          processCell.space,
          eventInputs,
          undefined,
          tx,
        );
        const { argument, isValidArgument } = this.readJavaScriptArgument(
          module,
          inputsCell,
          tx,
          {
            writableProxy:
              (module as { writableProxy?: boolean }).writableProxy,
          },
        );

        this.updateInvalidInputFlag(
          name,
          isValidArgument,
          module,
          inputsCell,
          tx,
        );

        if (!isValidArgument) {
          const inputState = this.getJavaScriptInputState(
            module,
            inputsCell,
            tx,
          );
          logger.error(
            "stream",
            () => [
              "action argument is undefined (potential schema mismatch) -- not running",
              {
                schema: inputState.schema,
                raw: inputState.raw,
                asQueryResult: inputState.queryResult,
              },
            ],
          );
        }

        const result = isValidArgument
          ? this.invokeJavaScriptImplementation(
            module,
            fn,
            argument,
            verifiedLoadId,
          )
          : undefined;
        const postRun = (result: any) => {
          logger.timeStart("stream", "postRun");
          try {
            return this.handleJavaScriptHandlerResult(
              tx,
              result,
              name,
              frame,
              processCell,
              addCancel,
              cause,
            );
          } finally {
            logger.timeEnd("stream", "postRun");
          }
        };

        return result instanceof Promise
          ? result.then(postRun)
          : postRun(result);
      } catch (error) {
        (error as Error & { frame?: Frame }).frame = frame;
        throw error;
      } finally {
        popFrame(frame);
      }
    };

    if (name) {
      setRunnableName(handler, `handler:${name}`);
    }

    const wrappedHandler = Object.assign(handler, {
      reads,
      writes,
      module,
      pattern,
    });

    const populateDependencies = module.argumentSchema
      ? (depTx: IExtendedStorageTransaction, event: any) => {
        const eventInputs = {
          ...(inputs as Record<string, any>),
          $event: event,
        };
        const inputsCell = this.runtime.getImmutableCell(
          processCell.space,
          eventInputs,
          undefined,
          depTx,
        );
        inputsCell.asSchema(module.argumentSchema!).get({
          traverseCells: true,
        });
      }
      : undefined;

    addCancel(
      this.runtime.scheduler.addEventHandler(
        wrappedHandler,
        streamLink,
        populateDependencies,
      ),
    );
  }

  private instantiateJavaScriptActionNode(
    {
      tx,
      module,
      processCell,
      addCancel,
      pattern,
      fn,
      name,
      inputs,
      outputs,
      reads,
      writes,
      verifiedLoadId,
    }: JavaScriptNodeContext,
  ): void {
    if (isRecord(inputs) && "$event" in inputs) {
      throw new Error(
        "Handler used as lift, because $stream: true was overwritten",
      );
    }

    const inputsCell = this.runtime.getImmutableCell(
      processCell.space,
      inputs,
      undefined,
      tx,
    );
    const previousResultCellRef: { current?: Cell<any> } = {};
    let previouslyInvalidArgument = false;
    const fnSource = fn.toString();

    const action: Action & {
      ignoredSchedulingWrites?: NormalizedFullLink[];
    } = (tx: IExtendedStorageTransaction) => {
      action.ignoredSchedulingWrites = [];
      const resultFor = { inputs, outputs, fn: fnSource };
      const frame = this.createPatternFrame(
        resultFor,
        pattern,
        processCell,
        tx,
        false,
        verifiedLoadId,
      );
      (action as Action & { lastFrame?: Frame }).lastFrame = frame;

      const handleErrorOutput = (error: unknown) => {
        if (
          error !== null &&
          (typeof error === "object" || typeof error === "function")
        ) {
          (error as Error & { frame?: Frame }).frame = frame;
        }
        try {
          sendValueToBinding(tx, processCell, outputs, undefined);
        } catch (bindingError) {
          logger.error(
            "runner",
            "Failed to write undefined to binding on error",
            bindingError,
          );
        }
        throw error;
      };

      try {
        logger.timeStart("action", "readInputs");
        const { argument, isValidArgument } = (() => {
          try {
            return this.readJavaScriptArgument(
              module,
              inputsCell,
              tx,
              { bindTxToSchema: true },
            );
          } finally {
            logger.timeEnd("action", "readInputs");
          }
        })();

        this.updateInvalidInputFlag(
          name,
          isValidArgument,
          module,
          inputsCell,
          tx,
        );

        if (!isValidArgument || previouslyInvalidArgument) {
          const inputState = this.getJavaScriptInputState(
            module,
            inputsCell,
            tx,
          );
          logger.info(
            "action",
            () => [
              isValidArgument
                ? "action argument is valid now -- running"
                : "action argument is undefined (potential schema mismatch) -- not running",
              {
                schema: inputState.schema,
                raw: inputState.raw,
                asQueryResult: inputState.queryResult,
              },
            ],
          );
          previouslyInvalidArgument = !isValidArgument;
        }

        const result = isValidArgument
          ? this.invokeJavaScriptImplementation(
            module,
            fn,
            argument,
            verifiedLoadId,
          )
          : undefined;
        const postRun = (result: any) => {
          logger.timeStart("action", "postRun");
          try {
            return this.writeJavaScriptActionResult(
              tx,
              result,
              name,
              frame,
              processCell,
              outputs,
              addCancel,
              resultFor,
              previousResultCellRef,
              (link) => action.ignoredSchedulingWrites?.push(link),
            );
          } finally {
            logger.timeEnd("action", "postRun");
          }
        };

        return result instanceof Promise
          ? result.then(postRun).catch(handleErrorOutput)
          : postRun(result);
      } catch (error) {
        handleErrorOutput(error);
      } finally {
        popFrame(frame);
      }
    };

    if (name) {
      setRunnableName(action, `action:${name}`, { setSrc: true });
    }

    const wrappedAction = Object.assign(action, {
      reads,
      writes,
      module,
      pattern,
    });

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      logger.timeStart("action", "populateDependencies");
      try {
        if (module.argumentSchema !== undefined) {
          const inputsCell = this.runtime.getImmutableCell(
            processCell.space,
            inputs,
            undefined,
            depTx,
          );
          inputsCell.asSchema(module.argumentSchema!).get({
            traverseCells: true,
          });
        } else {
          for (const read of reads) {
            this.runtime.getCellFromLink(read, undefined, depTx)?.get();
          }
        }

        for (const output of writes) {
          this.runtime.getCellFromLink(output, undefined, depTx)?.getRaw({
            meta: markReadAsPotentialWrite,
          });
        }
      } finally {
        logger.timeEnd("action", "populateDependencies");
      }
    };

    addCancel(
      this.runtime.scheduler.subscribe(wrappedAction, populateDependencies),
    );
  }

  private instantiateJavaScriptNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    processCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
  ) {
    const io = this.bindNodeIO(inputBindings, outputBindings, processCell);
    const { fn, name, verifiedLoadId } = this.resolveJavaScriptFunction(
      module,
      pattern,
    );
    const context: JavaScriptNodeContext = {
      tx,
      module,
      processCell,
      addCancel,
      pattern,
      fn,
      name,
      verifiedLoadId,
      ...io,
    };

    const streamLink = this.resolveJavaScriptStreamLink(
      io.inputs,
      processCell,
      tx,
    );
    if (streamLink) {
      this.instantiateJavaScriptHandlerNode({ ...context, streamLink });
      return;
    }

    this.instantiateJavaScriptActionNode(context);
  }

  private getFallbackJavaScriptImplementation(
    module: Module,
  ): (...args: any[]) => any {
    if (typeof module.implementation === "function") {
      return this.runtime.harness.getInvocation(
        Function.prototype.toString.call(module.implementation),
      ) as (...args: any[]) => any;
    }
    if (typeof module.implementation === "string") {
      return this.runtime.harness.getInvocation(module.implementation) as (
        ...args: any[]
      ) => any;
    }
    throw new Error(
      "JavaScript module is missing an executable implementation",
    );
  }

  private invokeJavaScriptImplementation(
    module: Module,
    fn: (...args: any[]) => any,
    argument: unknown,
    verifiedLoadId?: string,
  ): unknown {
    const invoke = () => {
      if (module.wrapper === "handler") {
        const event = isRecord(argument) && "$event" in argument
          ? argument.$event
          : undefined;
        const context = isRecord(argument) && "$ctx" in argument
          ? argument.$ctx
          : undefined;
        return fn(event, context);
      }

      return fn(argument);
    };

    if (!verifiedLoadId || !this.runtime.harness.registerVerifiedFunction) {
      return invoke();
    }

    const restoreVerifiedFunctionRegistrar = setVerifiedFunctionRegistrar(
      (implementationRef, implementation) => {
        this.runtime.harness.registerVerifiedFunction!(
          verifiedLoadId,
          implementationRef,
          implementation as (input: any) => void,
        );
      },
    );
    try {
      return invoke();
    } finally {
      restoreVerifiedFunctionRegistrar();
    }
  }

  private instantiateRawNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    processCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    moduleRefName?: string,
  ) {
    if (typeof module.implementation !== "function") {
      throw new Error(
        `Raw module is not a function, got: ${module.implementation}`,
      );
    }

    // CT-1230: Pass bindPatterns: false to prevent premature alias binding in pattern
    // arguments. When a subpattern is passed to map(), its aliases should not be
    // bound to the current doc yet - they need to remain unbound until the pattern
    // is actually instantiated for each mapped item.
    const mappedInputBindings = unwrapOneLevelAndBindtoDoc(
      inputBindings,
      processCell,
      { bindPatterns: false },
    );
    const mappedOutputBindings = unwrapOneLevelAndBindtoDoc(
      outputBindings,
      processCell,
    );

    // For `map` and future other node types that take closures, we need to
    // note the parent pattern on the closure patterns.
    unsafe_noteParentOnPatterns(pattern, mappedInputBindings);

    const inputCells = findAllWriteRedirectCells(
      mappedInputBindings,
      processCell,
    );
    // outputCells tracks what cells this action writes to. This is needed for
    // pull-based scheduling so collectDirtyDependencies() can find computations
    // that write to cells being read by effects.
    const outputCells = findAllWriteRedirectCells(
      mappedOutputBindings,
      processCell,
    );

    const inputsCell = this.runtime.getImmutableCell(
      processCell.space,
      mappedInputBindings,
      undefined,
      tx,
    );

    const builtinResult: RawBuiltinReturnType = module.implementation(
      inputsCell,
      (tx: IExtendedStorageTransaction, result: any) => {
        sendValueToBinding(
          tx,
          processCell,
          mappedOutputBindings,
          result,
        );
      },
      addCancel,
      { inputs: inputsCell, parents: processCell.entityId },
      processCell,
      this.runtime,
    );

    // Handle both legacy (just Action) and new (RawBuiltinResult) return formats
    const action = isRawBuiltinResult(builtinResult)
      ? builtinResult.action
      : builtinResult;
    const builtinIsEffect = isRawBuiltinResult(builtinResult)
      ? builtinResult.isEffect
      : undefined;
    const builtinPopulateDependencies = isRawBuiltinResult(builtinResult)
      ? builtinResult.populateDependencies
      : undefined;

    // Name the raw action for debugging - use implementation name or fallback to "raw"
    const impl = module.implementation as ((...args: unknown[]) => Action) & {
      src?: string;
      name?: string;
    };
    const rawTargetName = sanitizeDebugLabel(
      moduleRefName,
    ) ??
      sanitizeDebugLabel(
        (module as { debugName?: string }).debugName,
      ) ??
      sanitizeDebugLabel(impl.src) ??
      sanitizeDebugLabel(impl.name) ??
      "anonymous";
    const rawName = `raw:${rawTargetName}`;
    setRunnableName(action, rawName, { setSrc: true });

    // Seed raw actions with their pattern/module/write metadata so pull-mode
    // scheduling can discover pending computations before their first run.
    Object.assign(action, {
      reads: inputCells,
      writes: outputCells,
      module,
      pattern,
    });

    // Create populateDependencies callback.
    // If builtin provides custom reads, use that; otherwise read all inputs.
    // Always register output writes so collectDirtyDependencies() can find this
    // computation when an effect needs its outputs.
    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      logger.timeStart("raw", "populateDependencies");
      try {
        // Capture read dependencies - use custom if provided, otherwise read all inputs
        if (builtinPopulateDependencies) {
          if (typeof builtinPopulateDependencies === "function") {
            builtinPopulateDependencies(depTx);
          } else {
            // It's a ReactivityLog - reads are already captured, nothing to do
            for (const read of builtinPopulateDependencies.reads) {
              depTx.readOrThrow(read);
            }
          }
        } else {
          // Default: read all inputs
          for (const input of inputCells) {
            this.runtime.getCellFromLink(input, undefined, depTx)?.get();
          }
        }
        // Always capture write dependencies by marking outputs as potential writes
        for (const output of outputCells) {
          // Reading with markReadAsPotentialWrite registers this as a write dependency
          this.runtime.getCellFromLink(output, undefined, depTx)?.getRaw({
            meta: markReadAsPotentialWrite,
          });
        }
      } finally {
        logger.timeEnd("raw", "populateDependencies");
      }
    };

    // isEffect can come from module options or from the builtin result
    const isEffect = module.isEffect ?? builtinIsEffect;

    addCancel(
      this.runtime.scheduler.subscribe(action, populateDependencies, {
        isEffect,
      }),
    );
  }

  private instantiatePassthroughNode(
    tx: IExtendedStorageTransaction,
    _module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    processCell: Cell<any>,
    _addCancel: AddCancel,
    _pattern: Pattern,
  ) {
    const inputs = unwrapOneLevelAndBindtoDoc(inputBindings, processCell);

    sendValueToBinding(tx, processCell, outputBindings, inputs);
  }

  private instantiatePatternNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    processCell: Cell<any>,
    addCancel: AddCancel,
    _pattern: Pattern,
  ) {
    if (!isPattern(module.implementation)) throw new Error(`Invalid pattern`);
    const patternImpl = unwrapOneLevelAndBindtoDoc(
      module.implementation,
      processCell,
    );
    const inputs = unwrapOneLevelAndBindtoDoc(inputBindings, processCell);

    // If output bindings is a link to a non-redirect cell,
    // use that instead of creating a new cell.
    let resultCell;
    let sendToBindings: boolean;
    if (isSigilLink(outputBindings) && !isWriteRedirectLink(outputBindings)) {
      resultCell = this.runtime.getCellFromLink(
        parseLink(outputBindings, processCell),
        patternImpl.resultSchema,
        tx,
      );
      sendToBindings = false;
    } else {
      resultCell = this.runtime.getCell(
        processCell.space,
        {
          pattern: module.implementation,
          parent: processCell.entityId,
          inputBindings,
          outputBindings,
        },
        patternImpl.resultSchema,
        tx,
      );
      sendToBindings = true;
    }

    const sourceKey = getTxDebugActionId(tx) ?? "none";
    triggerFlowLogger.debug(`instantiate-pattern-node/${sourceKey}`, () => [
      `[PATTERN-NODE] source=${sourceKey}`,
      `parent=${processCell.getAsNormalizedFullLink().id}`,
      `result=${resultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(patternImpl)}`,
      `sendToBindings=${sendToBindings}`,
    ]);

    this.run(tx, patternImpl, inputs, resultCell);

    if (sendToBindings) {
      sendValueToBinding(
        tx,
        processCell,
        outputBindings,
        resultCell.getAsLink({ base: processCell }),
      );
    }

    // TODO(seefeld): Make sure to not cancel after a pattern is elevated to a
    // piece, e.g. via navigateTo. Nothing is cancelling right now, so leaving
    // this as TODO.
    addCancel(() => this.stop(resultCell));
  }
}

function getTxDebugActionId(
  tx?: IExtendedStorageTransaction,
): string | undefined {
  return tx ? (tx.tx as { debugActionId?: string }).debugActionId : undefined;
}
