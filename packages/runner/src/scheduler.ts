import { getLogger } from "@commontools/utils/logger";
import { isRecord } from "@commontools/utils/types";
import type { MemorySpace, URI } from "@commontools/memory/interface";
import { getTopFrame } from "./builder/recipe.ts";
import { type Frame, type Module, type Recipe, TYPE } from "./builder/types.ts";
import type { Cancel } from "./cancel.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import { ConsoleEvent } from "./harness/console.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  Runtime,
} from "./runtime.ts";
import {
  areNormalizedLinksSame,
  type NormalizedFullLink,
} from "./link-utils.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageSubscription,
  MediaType,
  MemoryAddressPathComponent,
  Metadata,
} from "./storage/interface.ts";
import {
  addressesToPathByEntity,
  arraysOverlap,
  determineTriggeredActions,
  sortAndCompactPaths,
  type SortedAndCompactPaths,
} from "./reactive-dependencies.ts";
import { ensurePieceRunning } from "./ensure-piece-running.ts";
import type {
  ActionStats,
  SchedulerActionInfo,
  SchedulerGraphEdge,
  SchedulerGraphNode,
  SchedulerGraphSnapshot,
} from "./telemetry.ts";
import { ensureNotRenderThread } from "@commontools/utils/env";
import { attachTaintContext, detachTaintContext } from "./cfc/taint-tracking.ts";
ensureNotRenderThread();

const logger = getLogger("scheduler", {
  enabled: false,
  level: "debug",
});

// Re-export types that tests expect from scheduler
export type { ErrorWithContext };

export interface TelemetryAnnotations {
  recipe: Recipe;
  module: Module;
  reads: NormalizedFullLink[];
  writes: NormalizedFullLink[];
}

export type Action = (tx: IExtendedStorageTransaction) => any;
export type AnnotatedAction = Action & TelemetryAnnotations;
export type EventHandler =
  & ((tx: IExtendedStorageTransaction, event: any) => any)
  & {
    /**
     * Optional callback to populate a transaction with the handler's read dependencies.
     * Called by the scheduler to discover what cells the handler will read.
     * The callback should read all cells (using .get({ traverseCells: true })) that
     * the handler will access, so the transaction captures all dependencies.
     * The event is passed so dependencies can be resolved from links in the event.
     */
    populateDependencies?: (
      tx: IExtendedStorageTransaction,
      event: any,
    ) => void;
  };
export type AnnotatedEventHandler = EventHandler & TelemetryAnnotations;

/**
 * Callback to populate a transaction with an action's read dependencies.
 * Called by the scheduler to discover what cells the action will read.
 * The callback should read all cells (using .get({ traverseCells: true })) that
 * the action will access, so the transaction captures all dependencies.
 * The transaction will be aborted after this callback returns, so it's safe
 * to simulate writes.
 */
export type PopulateDependencies = (tx: IExtendedStorageTransaction) => void;
type PopulateDependenciesEntry = PopulateDependencies | ReactivityLog;

/**
 * Reactivity log.
 *
 * Used to log reads and writes to docs. Used by scheduler to keep track of
 * dependencies and to topologically sort pending actions before executing them.
 */
export type ReactivityLog = {
  reads: IMemorySpaceAddress[];
  writes: IMemorySpaceAddress[];
  /** Reads marked as potential writes (e.g., for diffAndUpdate which reads then conditionally writes) */
  potentialWrites?: IMemorySpaceAddress[];
};

const ignoreReadForSchedulingMarker: unique symbol = Symbol(
  "ignoreReadForSchedulingMarker",
);

const markReadAsPotentialWriteMarker: unique symbol = Symbol(
  "markReadAsPotentialWriteMarker",
);

export const ignoreReadForScheduling: Metadata = {
  [ignoreReadForSchedulingMarker]: true,
};

export const markReadAsPotentialWrite: Metadata = {
  [markReadAsPotentialWriteMarker]: true,
};

export type SpaceAndURI = `${MemorySpace}/${URI}`;
export type SpaceURIAndType = `${MemorySpace}/${URI}/${MediaType}`;

const MAX_ITERATIONS_PER_RUN = 100;
const DEFAULT_RETRIES_FOR_EVENTS = 5;
const MAX_RETRIES_FOR_REACTIVE = 10;
const AUTO_DEBOUNCE_THRESHOLD_MS = 50;
const AUTO_DEBOUNCE_MIN_RUNS = 3;
const AUTO_DEBOUNCE_DELAY_MS = 100;

// Cycle-aware debounce: applies adaptive debounce to actions cycling within one execute()
const CYCLE_DEBOUNCE_THRESHOLD_MS = 100; // Min iteration time to trigger cycle debounce
const CYCLE_DEBOUNCE_MIN_RUNS = 3; // Action must run this many times to be considered cycling
const CYCLE_DEBOUNCE_MULTIPLIER = 2; // Debounce delay = multiplier × iteration time

export class Scheduler {
  private eventQueue: {
    action: Action;
    handler: EventHandler;
    event: any;
    retriesLeft: number;
    onCommit?: (tx: IExtendedStorageTransaction) => void;
  }[] = [];
  private eventHandlers: [NormalizedFullLink, EventHandler][] = [];

  private pending = new Set<Action>();
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private cancels = new WeakMap<Action, Cancel>();
  private triggers = new Map<SpaceAndURI, Map<Action, SortedAndCompactPaths>>();
  private actionChangeGroups = new WeakMap<Action, ChangeGroup>();
  private retries = new WeakMap<Action, number>();

  // Effect/computation tracking for pull-based scheduling
  private effects = new Set<Action>();
  private computations = new Set<Action>();
  private dependents = new WeakMap<Action, Set<Action>>();
  private reverseDependencies = new WeakMap<Action, Set<Action>>();
  // Track which actions are effects persistently (survives unsubscribe/re-subscribe)
  private isEffectAction = new WeakMap<Action, boolean>();
  private dirty = new Set<Action>();
  private pullMode = false;

  // Compute time tracking for cycle-aware scheduling
  // Keyed by action ID (source location) to persist stats across action recreation
  private actionStats = new Map<string, ActionStats>();
  private anonymousActionIds = new WeakMap<Action | EventHandler, string>();
  private anonymousActionCounter = 0;
  // Cycle detection during dependency collection
  private collectStack = new Set<Action>();

  // Cycle-aware debounce: track runs per action within current execute() call
  private runsThisExecute = new Map<Action, number>();
  private executeStartTime = 0;

  // Debounce infrastructure for throttling slow actions
  private debounceTimers = new WeakMap<
    Action,
    ReturnType<typeof setTimeout>
  >();
  // Track all active debounce timers for cleanup during dispose
  private activeDebounceTimers = new Set<ReturnType<typeof setTimeout>>();
  private actionDebounce = new WeakMap<Action, number>();
  // Actions that opt out of auto-debounce (inverted: true means NO auto-debounce)
  private noDebounce = new WeakMap<Action, boolean>();

  // Throttle infrastructure - "value can be stale by T ms"
  private actionThrottle = new WeakMap<Action, number>();

  // Track what each action has ever written (grows over time, includes potentialWrites).
  // Unlike dependencies.writes (current run only), mightWrite is cumulative and used
  // for building the dependency graph conservatively - if an action ever wrote to a path,
  // we assume it might write there again. This prevents missed dependencies when an
  // action's write behavior varies between runs.
  private mightWrite = new WeakMap<Action, IMemorySpaceAddress[]>();
  // Index: entity -> actions that write to it (for fast dependency lookup)
  // Updated when mightWrite changes
  private writersByEntity = new Map<SpaceAndURI, Set<Action>>();
  // Reverse index: action -> entities it writes to (for cleanup)
  private actionWriteEntities = new WeakMap<Action, Set<SpaceAndURI>>();
  // Track actions scheduled for first time (bypass filter)
  private scheduledFirstTime = new Set<Action>();
  // Filter stats for diagnostics
  private filterStats = { filtered: 0, executed: 0 };

  // Parent-child action tracking for proper execution ordering
  // When a child action is created during parent execution, parent must run first
  private executingAction: Action | null = null;
  private actionParent = new WeakMap<Action, Action>();
  private actionChildren = new WeakMap<Action, Set<Action>>();

  /**
   * Temporarily set the executing action so that any child actions created
   * during `fn` are registered as children of `action`. Restores the previous
   * executing action afterwards (stack-like nesting).
   */
  withExecutingAction<T>(action: Action, fn: () => T): T {
    const prev = this.executingAction;
    this.executingAction = action;
    try {
      return fn();
    } finally {
      this.executingAction = prev;
    }
  }

  // Dependency population callbacks for first-time subscriptions
  // Called in execute() to discover what cells the action will read
  private populateDependenciesCallbacks = new WeakMap<
    Action,
    PopulateDependenciesEntry
  >();
  // Actions that need dependency population before first run
  private pendingDependencyCollection = new Set<Action>();

  private idlePromises: (() => void)[] = [];
  private loopCounter = new WeakMap<Action, number>();
  private errorHandlers = new Set<ErrorHandler>();
  private consoleHandler: ConsoleHandler;
  private _running: Promise<unknown> | undefined = undefined;
  private scheduled = false;

  get runningPromise(): Promise<unknown> | undefined {
    return this._running;
  }

  set runningPromise(promise: Promise<unknown> | undefined) {
    if (this._running !== undefined) {
      throw new Error(
        "Cannot set running while another promise is in progress",
      );
    }
    if (promise !== undefined) {
      this._running = promise.finally(() => {
        this._running = undefined;
      });
    }
  }

  constructor(
    readonly runtime: Runtime,
    consoleHandler?: ConsoleHandler,
    errorHandlers?: ErrorHandler[],
  ) {
    this.consoleHandler = consoleHandler ||
      function (data) {
        // Default console handler returns arguments unaffected.
        return data.args;
      };

    if (errorHandlers) {
      errorHandlers.forEach((handler) => this.errorHandlers.add(handler));
    }

    // Subscribe to storage notifications
    this.runtime.storageManager.subscribe(this.createStorageSubscription());

    // Set up harness event listeners
    this.runtime.harness.addEventListener("console", (e: Event) => {
      // Called synchronously when `console` methods are
      // called within the runtime.
      const { method, args } = e as ConsoleEvent;
      const metadata = getPieceMetadataFromFrame();
      const result = this.consoleHandler({ metadata, method, args });
      console[method].apply(console, result);
    });
  }

  /**
   * Gets a stable identifier for an action based on its source location.
   * Prefers .src (set as backup) over .name, falls back to a generated ID.
   * This ID is used for stats tracking to persist across action recreation.
   */
  private getActionId(action: Action | EventHandler): string {
    const namedAction = action as Action & { src?: string };
    if (namedAction.src) return namedAction.src;
    if (action.name && action.name !== "anonymous") return action.name;

    const existingId = this.anonymousActionIds.get(action);
    if (existingId) return existingId;

    const generatedId = `anon-${++this.anonymousActionCounter}`;
    this.anonymousActionIds.set(action, generatedId);
    return generatedId;
  }

  private formatTelemetryLink(link: NormalizedFullLink): string {
    const path = link.path.length ? `/${link.path.join("/")}` : "";
    return `${link.space}/${link.id}${path}`;
  }

  private getActionTelemetryInfo(
    action: Action | EventHandler,
  ): SchedulerActionInfo | undefined {
    const annotated = action as Partial<TelemetryAnnotations>;

    const recipeName = this.getOptionalName(annotated.recipe);
    const moduleName = this.getOptionalName(annotated.module);
    const reads = Array.isArray(annotated.reads)
      ? annotated.reads.map((link) => this.formatTelemetryLink(link))
      : undefined;
    const writes = Array.isArray(annotated.writes)
      ? annotated.writes.map((link) => this.formatTelemetryLink(link))
      : undefined;

    if (!recipeName && !moduleName && !reads?.length && !writes?.length) {
      return undefined;
    }

    return {
      recipeName,
      moduleName,
      reads: reads?.length ? reads : undefined,
      writes: writes?.length ? writes : undefined,
    };
  }

  private getOptionalName(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined;
    const name = value.name;
    return typeof name === "string" ? name : undefined;
  }

  private updateActionType(
    action: Action,
    isEffect: boolean | undefined,
    options: { queueExecution?: boolean } = {},
  ): boolean {
    if (isEffect) {
      this.isEffectAction.set(action, true);
    }

    const actionIsEffect = this.isEffectAction.get(action) ?? false;

    if (actionIsEffect) {
      this.effects.add(action);
      this.computations.delete(action);
      if (options.queueExecution) {
        this.queueExecution();
      }
    } else {
      this.computations.add(action);
      this.effects.delete(action);
      if (options.queueExecution && !this.pullMode) {
        this.queueExecution();
      }
    }

    return actionIsEffect;
  }

  private updateChangeGroup(
    action: Action,
    options: { changeGroup?: ChangeGroup },
  ): void {
    if (
      !Object.prototype.hasOwnProperty.call(options, "changeGroup")
    ) {
      return;
    }
    if (options.changeGroup === undefined) {
      this.actionChangeGroups.delete(action);
    } else {
      this.actionChangeGroups.set(action, options.changeGroup);
    }
  }

  private registerParentChild(
    action: Action,
    options: { allowExisting?: boolean } = {},
  ): void {
    const { allowExisting = true } = options;
    if (!this.executingAction || this.executingAction === action) return;
    if (!allowExisting && this.actionParent.has(action)) return;

    const parent = this.executingAction;
    this.actionParent.set(action, parent);

    let children = this.actionChildren.get(parent);
    if (!children) {
      children = new Set();
      this.actionChildren.set(parent, children);
    }
    children.add(action);
  }

  /**
   * Subscribes an action to run when its dependencies change.
   *
   * The action will be scheduled to run immediately. Before running, the
   * populateDependencies callback will be called to discover what cells the
   * action will read. After running, the scheduler automatically re-subscribes
   * using the reactivity log from the run.
   *
   * @param action The action to subscribe
   * @param populateDependencies Callback to discover the action's read dependencies,
   *   or a ReactivityLog for backwards compatibility (deprecated)
   * @param options Configuration options for the subscription
   * @returns A cancel function to unsubscribe
   */
  subscribe(
    action: Action,
    populateDependencies: PopulateDependencies | ReactivityLog,
    options: {
      isEffect?: boolean;
      debounce?: number;
      noDebounce?: boolean;
      throttle?: number;
      changeGroup?: ChangeGroup;
    } = {},
  ): Cancel {
    // Handle backwards-compatible ReactivityLog argument
    let populateDependenciesEntry: PopulateDependenciesEntry;
    let immediateLog: ReactivityLog | undefined;
    if (typeof populateDependencies === "function") {
      populateDependenciesEntry = populateDependencies;
    } else {
      // ReactivityLog provided directly - set up dependencies immediately
      // (for backwards compatibility with code that passes reads/writes)
      immediateLog = populateDependencies;
      populateDependenciesEntry = immediateLog;
    }
    const {
      isEffect = false,
      debounce,
      noDebounce,
      throttle,
    } = options;

    this.updateChangeGroup(action, options);

    // Apply debounce settings if provided
    if (debounce !== undefined) {
      this.setDebounce(action, debounce);
    }
    if (noDebounce !== undefined) {
      this.setNoDebounce(action, noDebounce);
    }
    // Apply throttle setting if provided
    if (throttle !== undefined) {
      this.setThrottle(action, throttle);
    }

    const actionIsEffect = this.updateActionType(action, isEffect, {
      queueExecution: true,
    });

    // Track parent-child relationship if action is created during another action's execution
    this.registerParentChild(action);

    logger.debug(
      "schedule",
      () => [
        "Subscribing to action:",
        action,
        actionIsEffect ? "effect" : "computation",
      ],
    );

    // Store the populateDependencies callback for use in execute()
    this.populateDependenciesCallbacks.set(action, populateDependenciesEntry);

    // If a ReactivityLog was provided directly, set up dependencies immediately.
    // This ensures writes are tracked right away for reverse dependency graph.
    if (immediateLog) {
      const reads = this.setDependencies(action, immediateLog);
      this.updateDependents(action, immediateLog);
      const { entities } = this.addTriggerPaths(action, reads);

      // Register the cancel function for the latest trigger set.
      this.setCancelForEntities(action, entities);
    } else {
      // Mark action for dependency collection before first run
      this.pendingDependencyCollection.add(action);
    }

    // Mark as dirty and pending for first-time execution
    // In pull mode this still doesn't mean execution: There needs to be an effect to trigger it.
    this.dirty.add(action);
    this.pending.add(action);
    this.scheduledFirstTime.add(action);

    // Emit telemetry for new subscription
    const actionId = this.getActionId(action);
    this.runtime.telemetry.submit({
      type: "scheduler.subscribe",
      actionId,
      isEffect: actionIsEffect,
    });

    return () => this.unsubscribe(action);
  }

  /**
   * Re-subscribes an action after it has already run, using the reactivity log
   * from the completed run. This sets up triggers for future changes without
   * scheduling the action to run immediately.
   *
   * Use this method when:
   * - An action has just completed running and you have its reactivity log
   * - You want to register triggers for future changes
   *
   * @param action The action to re-subscribe
   * @param log The reactivity log from the action's previous run
   * @param options Optional configuration (e.g., isEffect to mark as side-effectful)
   */
  resubscribe(
    action: Action,
    log: ReactivityLog,
    options: { isEffect?: boolean; changeGroup?: ChangeGroup } = {},
  ): void {
    const { isEffect } = options;

    this.updateChangeGroup(action, options);

    const reads = this.setDependencies(action, log);

    // Update reverse dependency graph
    if (this.pullMode) this.updateDependents(action, log);

    // Track action type for pull-based scheduling
    // Once an action is marked as an effect, it stays an effect
    const actionIsEffect = this.updateActionType(action, isEffect);
    const actionId = this.getActionId(action);

    // Track parent-child relationship if action is created during another action's execution
    // Only set if not already set (resubscribe can be called multiple times)
    this.registerParentChild(action, { allowExisting: false });

    const { entities, pathsWithValuesByEntity } = this.addTriggerPaths(
      action,
      reads,
    );

    logger.debug("schedule-resubscribe", () => [
      `Action: ${actionId}`,
      `Entities: ${pathsWithValuesByEntity.size}`,
      `Reads: ${reads.length}`,
    ]);

    for (const [spaceAndURI, pathsWithValues] of pathsWithValuesByEntity) {
      logger.debug("schedule-resubscribe-path", () => [
        `Registered action for ${spaceAndURI}`,
        `Paths: ${pathsWithValues.map((p) => p.join("/")).join(", ")}`,
      ]);
    }

    this.setCancelForEntities(action, entities);

    // In pull mode: When an effect resubscribes, check if any non-throttled dirty
    // computations write to what it reads. If so, mark the effect dirty so it can
    // pull those computations and see fresh data.
    // Skip throttled computations - they'll trigger via storage changes when unthrottled.
    // Use isEffectAction instead of effects because unsubscribe() clears effects before run()
    if (this.pullMode && actionIsEffect && this.dirty.size > 0) {
      const effectReads = log.reads ?? [];
      let shouldMarkDirty = false;

      // If there are pending computations whose dependencies haven't been collected yet,
      // we can't know what they write. Be conservative and assume they might affect this effect.
      if (this.pendingDependencyCollection.size > 0) {
        shouldMarkDirty = true;
      }

      // Use writersByEntity index for efficient lookup
      if (!shouldMarkDirty) {
        for (const read of effectReads) {
          const entity = `${read.space}/${read.id}` as SpaceAndURI;
          const writers = this.writersByEntity.get(entity);
          if (!writers) continue;

          for (const writer of writers) {
            if (writer === action) continue;
            if (!this.dirty.has(writer)) continue;
            if (this.effects.has(writer)) continue; // Only check computations
            if (this.isThrottled(writer)) continue; // Skip throttled - they trigger via storage

            // Check path overlap
            const writerWrites = this.mightWrite.get(writer) ?? [];
            for (const write of writerWrites) {
              if (
                write.space === read.space &&
                write.id === read.id &&
                arraysOverlap(write.path, read.path)
              ) {
                shouldMarkDirty = true;
                break;
              }
            }
            if (shouldMarkDirty) break;
          }
          if (shouldMarkDirty) break;
        }
      }

      if (shouldMarkDirty && !this.dirty.has(action)) {
        this.dirty.add(action);
        this.pending.add(action);
        this.queueExecution();
      }
    }
  }

  unsubscribe(action: Action): void {
    this.cancels.get(action)?.();
    this.cancels.delete(action);
    this.dependencies.delete(action);
    this.actionChangeGroups.delete(action);
    this.pending.delete(action);
    const dependencies = this.reverseDependencies.get(action);
    if (dependencies) {
      for (const dependency of dependencies) {
        const dependents = this.dependents.get(dependency);
        dependents?.delete(action);
        if (dependents && dependents.size === 0) {
          this.dependents.delete(dependency);
        }
      }
      this.reverseDependencies.delete(action);
    }
    this.dependents.delete(action);
    // Clean up effect/computation tracking
    this.effects.delete(action);
    this.computations.delete(action);
    // Clean up dirty tracking
    this.dirty.delete(action);
    // Clean up writersByEntity index
    const writeEntities = this.actionWriteEntities.get(action);
    if (writeEntities) {
      for (const entity of writeEntities) {
        const writers = this.writersByEntity.get(entity);
        writers?.delete(action);
        if (writers && writers.size === 0) {
          this.writersByEntity.delete(entity);
        }
      }
      // Clear actionWriteEntities so resubscribe will re-register the action
      this.actionWriteEntities.delete(action);
    }
    // NOTE: We intentionally keep parent-child relationships intact.
    // They're needed for cycle detection (identifying obsolete children
    // when parent is re-running). They'll be cleaned up when parent is
    // garbage collected (WeakMap).
    // Cancel any pending debounce timer
    this.cancelDebounceTimer(action);
    // Clean up dependency collection tracking
    this.populateDependenciesCallbacks.delete(action);
    this.pendingDependencyCollection.delete(action);
  }

  async run(action: Action): Promise<any> {
    logger.timeStart("scheduler", "run");
    const actionId = this.getActionId(action);
    this.runtime.telemetry.submit({
      type: "scheduler.run",
      actionId,
      actionInfo: this.getActionTelemetryInfo(action),
    });

    logger.debug("schedule-run-start", () => [
      `[RUN] Starting action: ${actionId}`,
      `Pull mode: ${this.pullMode}`,
    ]);

    if (this.runningPromise) await this.runningPromise;

    const tx = this.runtime.edit();

    // CFC taint tracking: attach context to transaction
    if (this.runtime.cfcEnabled) {
      const ctx = this.runtime.cfc.createActionContext({
        userDid: this.runtime.userIdentityDID ?? "anonymous",
        space: "default", // TODO: derive from action's target cell
      });
      attachTaintContext(tx, ctx);
    }

    const actionStartTime = performance.now();

    let result: any;
    this.runningPromise = new Promise((resolve) => {
      const finalizeAction = (error?: unknown) => {
        // Record action execution time for cycle-aware scheduling
        const elapsed = performance.now() - actionStartTime;
        this.recordActionTime(action, elapsed);

        try {
          if (error) {
            logger.error("schedule-error", () => [
              `[RUN] Action failed: ${actionId}`,
              `Error: ${error}`,
            ]);
            this.handleError(error as Error, action);
          }
        } finally {
          // CFC taint tracking: detach context from transaction
          detachTaintContext(tx);

          // Set up new reactive subscriptions after the action runs

          // Commit the transaction. The code continues synchronously after
          // kicking off the commit, i.e. it assumes the commit will be
          // successful. If it isn't, the data will be rolled back and all other
          // reactive functions based on it will be retriggered. But also, the
          // retry logic below will have re-scheduled this action, so
          // topological sorting should move it before the dependencies.
          logger.timeStart("scheduler", "run", "commit");
          const commitPromise = tx.commit();
          logger.timeEnd("scheduler", "run", "commit");
          commitPromise.then(({ error }) => {
            // On error, retry up to MAX_RETRIES_FOR_REACTIVE times. Note that
            // on every attempt we still call the re-subscribe below, so that
            // even after we run out of retries, this will be re-triggered when
            // input data changes.
            if (error) {
              logger.info(
                "schedule-run-error",
                "Error committing transaction",
                error,
              );

              this.retries.set(action, (this.retries.get(action) ?? 0) + 1);
              if (this.retries.get(action)! < MAX_RETRIES_FOR_REACTIVE) {
                // Re-schedule the action to run again on conflict failure.
                // Use resubscribe to set up dependencies/triggers from the log,
                // then mark as dirty/pending to ensure it runs again.
                this.resubscribe(action, log);
                this.dirty.add(action);
                this.pending.add(action);
                this.queueExecution();
              }
            } else {
              // Clear retries after successful commit.
              this.retries.delete(action);
            }
          });
          const log = txToReactivityLog(tx);

          logger.debug("schedule-run-complete", () => [
            `[RUN] Action completed: ${actionId}`,
            `Reads: ${log.reads.length}`,
            `Writes: ${log.writes.length}`,
            `Elapsed: ${elapsed.toFixed(2)}ms`,
          ]);

          this.resubscribe(action, log);
          resolve(result);
        }
      };

      try {
        // Track executing action for parent-child relationship tracking
        this.executingAction = action;
        logger.timeStart("scheduler", "run", "action");
        Promise.resolve(action(tx))
          .then((actionResult) => {
            logger.timeEnd("scheduler", "run", "action");
            result = actionResult;
            this.executingAction = null;
            logger.debug("schedule-action-timing", () => {
              const duration = ((performance.now() - actionStartTime) / 1000)
                .toFixed(3);
              return [
                `Action ${actionId} completed in ${duration}s`,
              ];
            });
            finalizeAction();
          })
          .catch((error) => {
            logger.timeEnd("scheduler", "run", "action");
            this.executingAction = null;
            finalizeAction(error);
          });
      } catch (error) {
        logger.timeEnd("scheduler", "run", "action");
        this.executingAction = null;
        finalizeAction(error);
      }
    });

    return this.runningPromise.then((result) => {
      logger.timeEnd("scheduler", "run");
      return result;
    });
  }

  idle(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.runningPromise) {
        // Something is currently running - wait for it then check again
        this.runningPromise.then(() => this.idle().then(resolve));
      } else if (!this.scheduled) {
        // Nothing is scheduled to run - we're idle.
        // In pull mode, pending computations won't run without an effect to pull them,
        // so we don't wait for them.
        resolve();
      } else {
        // Execution is scheduled - wait for it to complete
        this.idlePromises.push(resolve);
      }
    });
  }

  queueEvent(
    eventLink: NormalizedFullLink,
    event: any,
    retries: number = DEFAULT_RETRIES_FOR_EVENTS,
    onCommit?: (tx: IExtendedStorageTransaction) => void,
    doNotLoadPieceIfNotRunning: boolean = false,
  ): void {
    let handlerFound = false;

    for (const [link, handler] of this.eventHandlers) {
      if (areNormalizedLinksSame(link, eventLink)) {
        handlerFound = true;
        this.queueExecution();
        this.eventQueue.push({
          action: (tx: IExtendedStorageTransaction) => handler(tx, event),
          handler,
          event,
          retriesLeft: retries,
          onCommit,
        });
      }
    }

    // If no handler was found, try to start the piece that should handle this event
    if (!handlerFound && !doNotLoadPieceIfNotRunning) {
      // Use an async IIFE to handle the async operation without blocking
      (async () => {
        const started = await ensurePieceRunning(this.runtime, eventLink);
        if (started) {
          // Piece was started, re-queue the event. Don't trigger loading again
          // if this didn't result in registering a handler, as trying again
          // won't change this.
          this.queueEvent(eventLink, event, retries, onCommit, true);
        }
      })();
    }
  }

  addEventHandler(
    handler: EventHandler,
    ref: NormalizedFullLink,
    populateDependencies?: (
      tx: IExtendedStorageTransaction,
      event: any,
    ) => void,
  ): Cancel {
    if (populateDependencies) {
      handler.populateDependencies = populateDependencies;
    }
    this.eventHandlers.push([ref, handler]);
    return () => {
      const index = this.eventHandlers.findIndex(([r, h]) =>
        r === ref && h === handler
      );
      if (index !== -1) this.eventHandlers.splice(index, 1);
    };
  }

  onConsole(fn: ConsoleHandler): void {
    this.consoleHandler = fn;
  }

  onError(fn: ErrorHandler): void {
    this.errorHandlers.add(fn);
  }

  /**
   * Creates and returns a new storage subscription that can be used to receive storage notifications.
   *
   * @returns A new IStorageSubscription instance
   */
  private createStorageSubscription(): IStorageSubscription {
    return {
      next: (notification) => {
        const space = notification.space;

        // Log notification details
        logger.debug("schedule-notification", () => [
          `Type: ${notification.type}`,
          `Space: ${space}`,
          `Has source: ${
            "source" in notification ? notification.source : "none"
          }`,
          `Changes: ${
            "changes" in notification ? [...notification.changes].length : 0
          }`,
        ]);

        if ("changes" in notification) {
          const sourceChangeGroup = notification.type === "commit"
            ? notification.source?.changeGroup
            : undefined;
          const hasSourceChangeGroup = notification.type === "commit" &&
            sourceChangeGroup !== undefined;

          let changeIndex = 0;
          for (const change of notification.changes) {
            changeIndex++;
            logger.debug("schedule-change", () => [
              `Change #${changeIndex}`,
              `Address: ${change.address.id}/${change.address.path.join("/")}`,
              `Before: ${JSON.stringify(change.before)}`,
              `After: ${JSON.stringify(change.after)}`,
            ]);
            this.runtime.telemetry.submit({
              type: "cell.update",
              change: change,
            });

            if (change.address.type !== "application/json") {
              logger.debug("schedule-change-skip", () => [
                `Change #${changeIndex} skipping non-JSON type: ${change.address.type}`,
              ]);
              continue;
            }

            const spaceAndURI = `${space}/${change.address.id}` as SpaceAndURI;
            const paths = this.triggers.get(spaceAndURI);

            if (paths) {
              logger.debug("schedule-change-match", () => [
                `Change #${changeIndex} found ${paths.size} registered actions for ${spaceAndURI}`,
              ]);

              const triggeredActions = determineTriggeredActions(
                paths,
                change.before,
                change.after,
                change.address.path,
              );

              logger.debug("schedule-change-trigger", () => [
                `Change #${changeIndex} triggered ${triggeredActions.length} actions`,
              ]);

              for (const action of triggeredActions) {
                const actionChangeGroup = this.actionChangeGroups.get(action);
                if (
                  hasSourceChangeGroup &&
                  actionChangeGroup !== undefined &&
                  Object.is(actionChangeGroup, sourceChangeGroup)
                ) {
                  logger.debug("schedule-change-skip-group", () => [
                    `Change #${changeIndex} skipped action change group`,
                    `Action: ${this.getActionId(action)}`,
                  ]);
                  continue;
                }

                logger.debug("schedule-trigger", () => [
                  `Action for ${spaceAndURI}/${change.address.path.join("/")}`,
                  `Action: ${this.getActionId(action)}`,
                  `Mode: ${this.pullMode ? "pull" : "push"}`,
                  `Type: ${
                    this.effects.has(action) ? "effect" : "computation"
                  }`,
                ]);

                if (this.pullMode) {
                  // Pull mode: only schedule effects, mark computations as dirty
                  if (this.effects.has(action)) {
                    this.scheduleWithDebounce(action);
                  } else {
                    // Mark computation as dirty and schedule affected effects
                    this.markDirty(action);
                    this.scheduleAffectedEffects(action);
                  }
                } else {
                  // Push mode: existing behavior - schedule all triggered actions
                  this.scheduleWithDebounce(action);
                }
              }
            } else {
              logger.debug("schedule", () => [
                `[CHANGE ${changeIndex}] No registered actions for ${spaceAndURI}`,
              ]);
            }
          }
        }
        return { done: false };
      },
    } satisfies IStorageSubscription;
  }

  queueExecution(): void {
    if (this.scheduled) return;
    queueTask(() => this.execute());
    this.scheduled = true;
  }

  private setDependencies(
    action: Action,
    log: ReactivityLog,
  ): IMemorySpaceAddress[] {
    const reads = sortAndCompactPaths(log.reads);
    const writes = sortAndCompactPaths(log.writes);
    this.dependencies.set(action, { reads, writes });

    // Initialize/update mightWrite with declared writes
    // This ensures dependency chain can be built even before action runs
    const existingMightWrite = this.mightWrite.get(action) ?? [];
    const newMightWrite = sortAndCompactPaths([
      ...existingMightWrite,
      ...writes,
      ...(log.potentialWrites ?? []),
    ]);
    this.mightWrite.set(action, newMightWrite);

    const addedWrites = newMightWrite.filter((write) =>
      !existingMightWrite.some((existing) =>
        existing.space === write.space &&
        existing.id === write.id &&
        existing.type === write.type &&
        existing.path.length <= write.path.length &&
        arraysOverlap(existing.path, write.path)
      )
    );

    // Update writersByEntity index for fast dependency lookup
    // Collect new entities from writes
    const existingEntities = this.actionWriteEntities.get(action);
    const nextEntities = new Set<SpaceAndURI>();
    const addedEntities = new Set<SpaceAndURI>();
    for (const write of newMightWrite) {
      const entity: SpaceAndURI = `${write.space}/${write.id}`;
      nextEntities.add(entity);
      if (!existingEntities?.has(entity)) {
        addedEntities.add(entity);
      }
    }

    // Add action to writersByEntity for each newly discovered entity
    for (const entity of addedEntities) {
      // Skip if already registered
      let writers = this.writersByEntity.get(entity);
      if (!writers) {
        writers = new Set();
        this.writersByEntity.set(entity, writers);
      }
      writers.add(action);
    }
    this.actionWriteEntities.set(action, nextEntities);

    if (this.pullMode && addedWrites.length > 0) {
      // Backfill reverse edges when new writers appear after readers are already subscribed.
      this.backfillDependentsForNewWrites(action, addedWrites);
    }

    return reads;
  }

  private addTriggerPaths(
    action: Action,
    reads: IMemorySpaceAddress[],
  ): {
    entities: Set<SpaceAndURI>;
    pathsWithValuesByEntity: Map<SpaceAndURI, SortedAndCompactPaths>;
  } {
    this.clearActionTriggers(action);
    const pathsByEntity = addressesToPathByEntity(reads);
    const entities = new Set<SpaceAndURI>();
    const pathsWithValuesByEntity = new Map<
      SpaceAndURI,
      SortedAndCompactPaths
    >();

    for (const [spaceAndURI, paths] of pathsByEntity) {
      entities.add(spaceAndURI);
      if (!this.triggers.has(spaceAndURI)) {
        this.triggers.set(spaceAndURI, new Map());
      }
      const pathsWithValues = paths.map((path) =>
        [
          "value",
          ...path,
        ] as readonly MemoryAddressPathComponent[]
      );
      this.triggers.get(spaceAndURI)!.set(action, pathsWithValues);
      pathsWithValuesByEntity.set(spaceAndURI, pathsWithValues);
    }

    return { entities, pathsWithValuesByEntity };
  }

  private clearActionTriggers(action: Action): void {
    const cancel = this.cancels.get(action);
    if (!cancel) return;

    cancel();
    this.cancels.delete(action);
  }

  private setCancelForEntities(
    action: Action,
    entities: Set<SpaceAndURI>,
  ): void {
    const actionId = this.getActionId(action);
    this.cancels.set(action, () => {
      logger.debug("schedule-unsubscribe", () => [
        `Action: ${actionId}`,
        `Entities: ${entities.size}`,
      ]);
      for (const spaceAndURI of entities) {
        this.triggers.get(spaceAndURI)?.delete(action);
      }
    });
  }

  private collectDependenciesForAction(
    action: Action,
    populateDependencies: PopulateDependenciesEntry,
    options: {
      errorLogLabel: string;
      errorMessage: (action: Action, error: unknown) => string;
      updateDependents?: boolean;
      useRawReadsForTriggers?: boolean;
    },
  ): { log: ReactivityLog; entities: Set<SpaceAndURI> } {
    let log: ReactivityLog;
    if (typeof populateDependencies === "function") {
      const depTx = this.runtime.edit();
      try {
        populateDependencies(depTx);
      } catch (error) {
        logger.debug(options.errorLogLabel, () => [
          options.errorMessage(action, error),
        ]);
      }
      log = txToReactivityLog(depTx);
      depTx.abort();
    } else {
      log = populateDependencies;
    }

    const reads = this.setDependencies(action, log);
    if (options.updateDependents ?? true) {
      this.updateDependents(action, log);
    }

    const readsForTriggers = options.useRawReadsForTriggers ? log.reads : reads;
    const { entities } = this.addTriggerPaths(action, readsForTriggers);
    this.setCancelForEntities(action, entities);

    return { log, entities };
  }

  /**
   * Updates the reverse dependency graph (dependents map).
   * For each action that writes to paths this action reads, add this action as a dependent.
   */
  private updateDependents(action: Action, log: ReactivityLog): void {
    const previousDependencies = this.reverseDependencies.get(action);
    if (previousDependencies) {
      for (const dependency of previousDependencies) {
        const dependents = this.dependents.get(dependency);
        dependents?.delete(action);
        if (dependents && dependents.size === 0) {
          this.dependents.delete(dependency);
        }
      }
      this.reverseDependencies.delete(action);
    }

    const reads = log.reads;
    const newDependencies = new Set<Action>();

    // Group reads by entity for efficient lookup
    const readsByEntity = new Map<SpaceAndURI, IMemorySpaceAddress[]>();
    for (const read of reads) {
      const entity: SpaceAndURI = `${read.space}/${read.id}`;
      let entityReads = readsByEntity.get(entity);
      if (!entityReads) {
        entityReads = [];
        readsByEntity.set(entity, entityReads);
      }
      entityReads.push(read);
    }

    // For each entity we read from, find actions that write to it
    for (const [entity, entityReads] of readsByEntity) {
      const writers = this.writersByEntity.get(entity);
      if (!writers) continue;

      for (const otherAction of writers) {
        if (otherAction === action) continue;
        // Skip if we already found this dependency
        if (newDependencies.has(otherAction)) continue;

        // Get paths this action writes to
        const otherWrites = this.mightWrite.get(otherAction) ?? [];

        // Check if any write path overlaps with any read path
        outer: for (const read of entityReads) {
          for (const write of otherWrites) {
            if (
              read.space === write.space &&
              read.id === write.id &&
              arraysOverlap(write.path, read.path)
            ) {
              // otherAction writes → this action reads, so this action depends on otherAction
              let deps = this.dependents.get(otherAction);
              if (!deps) {
                deps = new Set();
                this.dependents.set(otherAction, deps);
              }
              deps.add(action);
              newDependencies.add(otherAction);
              break outer; // Found a match, no need to check more paths
            }
          }
        }
      }
    }

    if (newDependencies.size > 0) {
      this.reverseDependencies.set(action, newDependencies);
    }

    // Emit telemetry for dependency updates
    const actionId = this.getActionId(action);
    this.runtime.telemetry.submit({
      type: "scheduler.dependencies.update",
      actionId,
      reads: log.reads.map((r) => `${r.space}/${r.id}/${r.path.join("/")}`),
      writes: log.writes.map((w) => `${w.space}/${w.id}/${w.path.join("/")}`),
    });
  }

  private registerDependentEdge(writer: Action, dependent: Action): void {
    if (writer === dependent) return;

    let dependents = this.dependents.get(writer);
    if (!dependents) {
      dependents = new Set();
      this.dependents.set(writer, dependents);
    }
    dependents.add(dependent);

    let reverse = this.reverseDependencies.get(dependent);
    if (!reverse) {
      reverse = new Set();
      this.reverseDependencies.set(dependent, reverse);
    }
    reverse.add(writer);
  }

  private backfillDependentsForNewWrites(
    writer: Action,
    writes: IMemorySpaceAddress[],
  ): void {
    if (writes.length === 0) return;

    const scanAction = (action: Action) => {
      if (action === writer) return;
      const log = this.dependencies.get(action);
      if (!log?.reads?.length) return;
      if (!this.readsOverlapWrites(log.reads, writes)) return;
      this.registerDependentEdge(writer, action);
    };

    for (const effect of this.effects) scanAction(effect);
    for (const computation of this.computations) scanAction(computation);
  }

  private readsOverlapWrites(
    reads: IMemorySpaceAddress[],
    writes: IMemorySpaceAddress[],
  ): boolean {
    for (const read of reads) {
      for (const write of writes) {
        if (
          read.space === write.space &&
          read.id === write.id &&
          arraysOverlap(write.path, read.path)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Returns diagnostic statistics about the scheduler state.
   * Useful for debugging and monitoring pull-based scheduling behavior.
   */
  getStats(): { effects: number; computations: number; pending: number } {
    return {
      effects: this.effects.size,
      computations: this.computations.size,
      pending: this.pending.size,
    };
  }

  /**
   * Returns a snapshot of the current dependency graph for visualization.
   * Uses getActionId for the identifier (includes code location).
   */
  getGraphSnapshot(): SchedulerGraphSnapshot {
    const nodes: SchedulerGraphNode[] = [];
    const edges: SchedulerGraphEdge[] = [];
    const actionById = new Map<string, Action>();

    // Build nodes from all known actions (effects + computations)
    for (const action of [...this.effects, ...this.computations]) {
      const id = this.getActionId(action);
      actionById.set(id, action);

      // Get parent-child relationships
      const parent = this.actionParent.get(action);
      const parentId = parent ? this.getActionId(parent) : undefined;
      const children = this.actionChildren.get(action);
      const childCount = children ? children.size : undefined;

      // Get reads and writes for diagnostics
      const deps = this.dependencies.get(action);
      const reads = deps?.reads.map((r) =>
        `${r.space}/${r.id}/${r.path.join("/")}`
      );
      const writes = this.mightWrite.get(action)?.map((w) =>
        `${w.space}/${w.id}/${w.path.join("/")}`
      );

      // Get timing controls
      const debounceMs = this.actionDebounce.get(action);
      const throttleMs = this.actionThrottle.get(action);

      nodes.push({
        id,
        type: this.effects.has(action) ? "effect" : "computation",
        stats: this.actionStats.get(id),
        isDirty: this.dirty.has(action),
        isPending: this.pending.has(action),
        parentId,
        childCount: childCount && childCount > 0 ? childCount : undefined,
        preview: (action as Action & {
          module?: { implementation?: { preview?: string } };
        }).module?.implementation?.preview,
        reads,
        writes,
        debounceMs: debounceMs && debounceMs > 0 ? debounceMs : undefined,
        throttleMs: throttleMs && throttleMs > 0 ? throttleMs : undefined,
      });
    }

    // Build edges from dependents map
    for (const action of [...this.effects, ...this.computations]) {
      const actionId = this.getActionId(action);
      const deps = this.dependents.get(action);
      if (deps) {
        for (const dependent of deps) {
          const dependentId = this.getActionId(dependent);
          // Find overlapping cells between action's writes and dependent's reads
          const cells = this.findOverlappingCells(action, dependent);
          edges.push({
            from: actionId,
            to: dependentId,
            cells,
          });
        }
      }
    }

    // Find source entities (read but not written by any action)
    // These represent recipe inputs / external data
    const entityReaders = new Map<string, Set<string>>(); // entity -> action IDs that read it
    const writtenEntities = new Set<string>();

    for (const action of [...this.effects, ...this.computations]) {
      const actionId = this.getActionId(action);
      const deps = this.dependencies.get(action);
      if (deps) {
        for (const read of deps.reads) {
          const entity = `${read.space}/${read.id}`;
          if (!entityReaders.has(entity)) {
            entityReaders.set(entity, new Set());
          }
          entityReaders.get(entity)!.add(actionId);
        }
      }

      const writes = this.mightWrite.get(action);
      if (writes) {
        for (const write of writes) {
          writtenEntities.add(`${write.space}/${write.id}`);
        }
      }
    }

    // Add input nodes for source entities
    for (const [entity, readers] of entityReaders) {
      if (!writtenEntities.has(entity)) {
        const inputId = `input:${entity}`;
        nodes.push({
          id: inputId,
          type: "input",
          isDirty: false,
          isPending: false,
        });

        // Add edges from input to all actions that read it
        for (const readerId of readers) {
          edges.push({
            from: inputId,
            to: readerId,
            cells: [entity],
          });
        }
      }
    }

    // Add parent-child edges
    for (const action of [...this.effects, ...this.computations]) {
      const parent = this.actionParent.get(action);
      if (parent) {
        const parentId = this.getActionId(parent);
        const childId = this.getActionId(action);
        // Only add if both nodes exist in the graph
        if (actionById.has(parentId)) {
          edges.push({
            from: parentId,
            to: childId,
            cells: [],
            edgeType: "parent",
          });
        }
      }
    }

    // Add inactive nodes for actions that have stats but are no longer registered
    // This preserves visibility of actions that were unsubscribed
    for (const [actionId, stats] of this.actionStats) {
      if (!actionById.has(actionId)) {
        nodes.push({
          id: actionId,
          type: "inactive",
          stats,
          isDirty: false,
          isPending: false,
        });
      }
    }

    return {
      nodes,
      edges,
      pullMode: this.pullMode,
      timestamp: performance.now(),
    };
  }

  /**
   * Finds the cell IDs that create a dependency between producer and consumer.
   */
  private findOverlappingCells(producer: Action, consumer: Action): string[] {
    const producerWrites = this.mightWrite.get(producer) ?? [];
    const consumerDeps = this.dependencies.get(consumer);
    if (!consumerDeps) return [];

    const overlapping: string[] = [];
    for (const write of producerWrites) {
      for (const read of consumerDeps.reads) {
        if (
          write.space === read.space &&
          write.id === read.id &&
          arraysOverlap(write.path, read.path)
        ) {
          overlapping.push(`${write.space}/${write.id}`);
        }
      }
    }
    return [...new Set(overlapping)]; // Deduplicate
  }

  /**
   * Returns whether an action is registered as an effect.
   */
  isEffect(action: Action): boolean {
    return this.effects.has(action);
  }

  /**
   * Returns whether an action is registered as a computation.
   */
  isComputation(action: Action): boolean {
    return this.computations.has(action);
  }

  /**
   * Returns the set of actions that depend on this action's output.
   */
  getDependents(action: Action): Set<Action> {
    return this.dependents.get(action) ?? new Set();
  }

  // ============================================================
  // Pull-based scheduling methods
  // ============================================================

  /**
   * Enables pull-based scheduling mode.
   * In pull mode, only effects are scheduled; computations are marked dirty
   * and pulled on demand when effects need their values.
   */
  enablePullMode(): void {
    this.pullMode = true;

    // Rebuild reverse dependency graph (dependents map) from current dependencies.
    // In push mode, processRun() doesn't update dependents, so the map may be stale.
    // We need accurate dependents for markDirty() propagation and scheduleAffectedEffects().
    for (const action of [...this.effects, ...this.computations]) {
      const log = this.dependencies.get(action);
      if (log) {
        this.updateDependents(action, log);
      }
    }

    this.runtime.telemetry.submit({
      type: "scheduler.mode.change",
      pullMode: true,
    });
    this.queueExecution();
  }

  /**
   * Disables pull-based scheduling mode (returns to push mode).
   */
  disablePullMode(): void {
    this.pullMode = false;
    // Clear dirty set when switching back to push mode
    this.dirty.clear();
    this.runtime.telemetry.submit({
      type: "scheduler.mode.change",
      pullMode: false,
    });
    this.queueExecution();
  }

  /**
   * Returns whether pull mode is enabled.
   */
  isPullModeEnabled(): boolean {
    return this.pullMode;
  }

  /**
   * Marks an action as dirty and propagates to all dependents transitively.
   */
  private markDirty(action: Action): void {
    if (this.dirty.has(action)) return; // Already dirty, avoid infinite recursion

    this.dirty.add(action);

    // Propagate to dependents transitively
    const deps = this.dependents.get(action);
    if (deps) {
      for (const dependent of deps) {
        this.markDirty(dependent);
      }
    }
  }

  /**
   * Returns whether an action is marked as dirty.
   */
  isDirty(action: Action): boolean {
    return this.dirty.has(action);
  }

  /**
   * Clears the dirty flag for an action.
   */
  private clearDirty(action: Action): void {
    this.dirty.delete(action);
  }

  /**
   * Collects all dirty computations that an action depends on (transitively).
   * Used in pull mode to build the complete work set before execution.
   */
  private collectDirtyDependencies(
    action: Action,
    workSet: Set<Action>,
  ): void {
    const log = this.dependencies.get(action);
    if (!log) return;

    // Check for cycle: if action is already in the collection stack, skip
    if (this.collectStack.has(action)) return;

    // Add to collection stack before processing
    this.collectStack.add(action);

    // Find dirty computations that write to entities this action reads
    for (const computation of this.dirty) {
      if (workSet.has(computation)) continue; // Already added
      if (computation === action) continue;

      const computationWrites = this.mightWrite.get(computation) ?? [];
      if (computationWrites.length === 0) continue;

      // Check if computation writes to something action reads (with path overlap)
      let found = false;
      for (const write of computationWrites) {
        for (const read of log.reads) {
          if (
            write.space === read.space &&
            write.id === read.id &&
            arraysOverlap(write.path, read.path)
          ) {
            workSet.add(computation);
            // Recursively collect deps of this computation
            this.collectDirtyDependencies(computation, workSet);
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    // Remove from collection stack after processing
    this.collectStack.delete(action);
  }

  /**
   * Finds and schedules all effects that transitively depend on the given computation.
   */
  private scheduleAffectedEffects(computation: Action): void {
    const visited = new Set<Action>();
    const toSchedule: Action[] = [];

    const findEffects = (action: Action) => {
      if (visited.has(action)) return;
      visited.add(action);

      if (this.effects.has(action)) {
        toSchedule.push(action);
      }

      const deps = this.dependents.get(action);
      if (deps) {
        for (const dependent of deps) {
          findEffects(dependent);
        }
      }
    };

    findEffects(computation);

    for (const effect of toSchedule) {
      this.scheduleWithDebounce(effect);
    }
  }

  // ============================================================
  // Compute time tracking for cycle-aware scheduling
  // ============================================================

  /**
   * Records the execution time for an action.
   * Updates running statistics including run count, total time, and average time.
   * Stats are keyed by action ID (source location) to persist across action recreation.
   */
  private recordActionTime(action: Action, elapsed: number): void {
    const now = performance.now();
    const actionId = this.getActionId(action);
    const existing = this.actionStats.get(actionId);
    if (existing) {
      existing.runCount++;
      existing.totalTime += elapsed;
      existing.averageTime = existing.totalTime / existing.runCount;
      existing.lastRunTime = elapsed;
      existing.lastRunTimestamp = now;
    } else {
      this.actionStats.set(actionId, {
        runCount: 1,
        totalTime: elapsed,
        averageTime: elapsed,
        lastRunTime: elapsed,
        lastRunTimestamp: now,
      });
    }

    // Check if action should be auto-debounced based on performance
    this.maybeAutoDebounce(action);
  }

  /**
   * Returns the execution statistics for an action, if available.
   * Useful for diagnostics and determining cycle convergence strategy.
   * Accepts either an Action or an action ID string.
   */
  getActionStats(action: Action | string): ActionStats | undefined {
    const actionId = typeof action === "string"
      ? action
      : this.getActionId(action);
    return this.actionStats.get(actionId);
  }

  // ============================================================
  // Debounce infrastructure for throttling slow actions
  // ============================================================

  /**
   * Sets a debounce delay for an action.
   * When the action is triggered, it will wait for the specified delay before running.
   * If triggered again during the delay, the timer resets.
   */
  setDebounce(action: Action, ms: number): void {
    if (ms <= 0) {
      this.actionDebounce.delete(action);
    } else {
      this.actionDebounce.set(action, ms);
    }
  }

  /**
   * Gets the current debounce delay for an action, if set.
   */
  getDebounce(action: Action): number | undefined {
    return this.actionDebounce.get(action);
  }

  /**
   * Clears the debounce setting for an action.
   */
  clearDebounce(action: Action): void {
    this.actionDebounce.delete(action);
    this.cancelDebounceTimer(action);
  }

  /**
   * Enables or disables auto-debounce detection for an action.
   * When set to true, this action opts OUT of auto-debounce.
   * By default, slow actions (> 50ms avg after 3 runs) will automatically get debounced.
   */
  setNoDebounce(action: Action, optOut: boolean): void {
    if (optOut) {
      this.noDebounce.set(action, true);
    } else {
      this.noDebounce.delete(action);
    }
  }

  /**
   * Cancels any pending debounce timer for an action.
   */
  private cancelDebounceTimer(action: Action): void {
    const timer = this.debounceTimers.get(action);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(action);
      this.activeDebounceTimers.delete(timer);
    }
  }

  /**
   * Schedules an action with debounce support.
   * If the action has a debounce delay, it will wait before being added to pending.
   * Otherwise, it's added immediately.
   */
  private scheduleWithDebounce(action: Action): void {
    const debounceMs = this.actionDebounce.get(action);

    if (!debounceMs || debounceMs <= 0) {
      // No debounce - add immediately
      this.pending.add(action);
      this.queueExecution();
      return;
    }

    // Clear existing timer if any
    this.cancelDebounceTimer(action);

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(action);
      this.activeDebounceTimers.delete(timer);
      this.pending.add(action);
      this.queueExecution();
    }, debounceMs);

    this.debounceTimers.set(action, timer);
    this.activeDebounceTimers.add(timer);

    logger.debug("schedule-debounce", () => [
      `[DEBOUNCE] Action ${
        this.getActionId(action)
      } debounced for ${debounceMs}ms`,
    ]);
  }

  /**
   * Checks if an action should be auto-debounced based on its performance stats.
   * Called after recording action time to potentially enable debouncing for slow actions.
   * Auto-debounce is enabled by default; use noDebounce to opt out.
   */
  private maybeAutoDebounce(action: Action): void {
    // Check if action has opted out of auto-debounce
    if (this.noDebounce.get(action)) return;

    // Check if already has a manual debounce set
    if (this.actionDebounce.has(action)) return;

    const stats = this.actionStats.get(this.getActionId(action));
    if (!stats) return;

    // Need minimum runs before auto-detecting
    if (stats.runCount < AUTO_DEBOUNCE_MIN_RUNS) return;

    // Check if action is slow enough to warrant debouncing
    if (stats.averageTime >= AUTO_DEBOUNCE_THRESHOLD_MS) {
      this.actionDebounce.set(action, AUTO_DEBOUNCE_DELAY_MS);
      const actionId = this.getActionId(action);
      logger.debug("schedule-debounce", () => [
        `[AUTO-DEBOUNCE] Action ${actionId} ` +
        `auto-debounced (avg ${
          stats.averageTime.toFixed(1)
        }ms >= ${AUTO_DEBOUNCE_THRESHOLD_MS}ms)`,
      ]);
    }
  }

  // ============================================================
  // Throttle infrastructure - "value can be stale by T ms"
  // ============================================================

  /**
   * Sets a throttle period for an action.
   * The action won't run if it ran within the last `ms` milliseconds.
   * Unlike debounce, throttled actions stay dirty and will be pulled
   * by effects when the throttle period expires.
   */
  setThrottle(action: Action, ms: number): void {
    if (ms <= 0) {
      this.actionThrottle.delete(action);
    } else {
      this.actionThrottle.set(action, ms);
    }
  }

  /**
   * Gets the current throttle period for an action, if set.
   */
  getThrottle(action: Action): number | undefined {
    return this.actionThrottle.get(action);
  }

  /**
   * Clears the throttle setting for an action.
   */
  clearThrottle(action: Action): void {
    this.actionThrottle.delete(action);
  }

  /**
   * Checks if an action is currently throttled (ran too recently).
   * Returns true if the action should be skipped this execution cycle.
   */
  private isThrottled(action: Action): boolean {
    const throttleMs = this.actionThrottle.get(action);
    if (!throttleMs) return false;

    const stats = this.actionStats.get(this.getActionId(action));
    if (!stats) return false; // No stats yet, action hasn't run

    const elapsed = performance.now() - stats.lastRunTimestamp;
    return elapsed < throttleMs;
  }

  // ============================================================
  // Push-triggered filtering
  // ============================================================

  /**
   * Returns the accumulated "might write" set for an action.
   */
  getMightWrite(action: Action): IMemorySpaceAddress[] | undefined {
    return this.mightWrite.get(action);
  }

  /**
   * Returns filter statistics for the current/last execution cycle.
   */
  getFilterStats(): { filtered: number; executed: number } {
    return { ...this.filterStats };
  }

  /**
   * Resets filter statistics.
   */
  resetFilterStats(): void {
    this.filterStats = { filtered: 0, executed: 0 };
  }
  private handleError(error: Error, action: any) {
    const { pieceId, spellId, recipeId, space } = getPieceMetadataFromFrame(
      (error as Error & { frame?: Frame }).frame,
    );

    // Transform stack trace to show original source locations
    if (error.stack) {
      error.stack = this.runtime.harness.parseStack(error.stack);
    }

    const errorWithContext = error as ErrorWithContext;
    errorWithContext.action = action;
    if (pieceId) errorWithContext.pieceId = pieceId;
    if (spellId) errorWithContext.spellId = spellId;
    if (recipeId) errorWithContext.recipeId = recipeId;
    if (space) errorWithContext.space = space as MemorySpace;

    for (const handler of this.errorHandlers) {
      try {
        handler(errorWithContext);
      } catch (handlerError) {
        console.error("Error in error handler:", handlerError);
      }
    }

    if (this.errorHandlers.size === 0) {
      console.error("Uncaught error in action:", errorWithContext);
    } else {
      console.error("Error in action:", errorWithContext);
    }
  }

  private async execute(): Promise<void> {
    logger.timeStart("scheduler", "execute");

    // In case a directly invoked `run` is still running, wait for it to finish.
    if (this.runningPromise) await this.runningPromise;

    // Track timing for cycle-aware debounce
    this.executeStartTime = performance.now();
    this.runsThisExecute.clear();

    logger.timeStart("scheduler", "execute", "depCollect");
    // Process pending dependency collection for newly subscribed actions.
    // This discovers what cells each action will read before it runs.
    for (const action of this.pendingDependencyCollection) {
      const populateDependencies = this.populateDependenciesCallbacks.get(
        action,
      );
      if (!populateDependencies) continue;

      const { log, entities } = this.collectDependenciesForAction(
        action,
        populateDependencies,
        {
          errorLogLabel: "schedule-dep-error",
          errorMessage: (target, error) =>
            `Error populating dependencies for ${
              this.getActionId(target)
            }: ${error}`,
        },
      );

      logger.debug("schedule-dep-collect", () => [
        `Collected dependencies for ${
          this.getActionId(action)
        }: ${log.reads.length} reads, ${log.writes.length} writes, ${entities.size} entities`,
      ]);
    }

    // Now mark downstream nodes as dirty if we introduced new dependencies for them
    this.pendingDependencyCollection.forEach((action) => {
      this.scheduleAffectedEffects(action);
    });

    // Find computation actions with no dependencies. We run them on the first
    // run to capture any writes they might perform to cells pass into them.
    //
    // TODO(seefeld): Once we more reliably capture what they can write via
    // WriteableCell or so, then we can treat this more deliberately via the
    // dependency collection process above. We'll have to re-run it whenever
    // inputs change, as they might change what they can write to. We hope that
    // for now this will be sufficiently captured in mightWrite.
    // NOTE: Use .writes (current run) not mightWrite (historical) here.
    // We want to know if action currently writes, not if it ever wrote.
    const newActionsWithoutDependencies = [...this.pendingDependencyCollection]
      .filter(
        (action) =>
          !this.dependencies.get(action)?.writes.length &&
          !this.effects.has(action),
      );

    // Clear the pending collection set - dependencies have been collected
    this.pendingDependencyCollection.clear();
    logger.timeEnd("scheduler", "execute", "depCollect");

    // Track dirty dependencies that block events - these must be added to workSet
    const eventBlockingDeps = new Set<Action>();

    logger.timeStart("scheduler", "execute", "event");
    // Process next event from the event queue.
    const queuedEvent = this.eventQueue.shift();
    if (queuedEvent) {
      const { action, handler, event: eventValue, retriesLeft, onCommit } =
        queuedEvent;
      const handlerId = this.getActionId(handler);
      this.runtime.telemetry.submit({
        type: "scheduler.invocation",
        handlerId,
        handlerInfo: this.getActionTelemetryInfo(handler),
      });
      // In pull mode, ensure handler dependencies are computed before running
      let shouldSkipEvent = false;
      if (this.pullMode && handler.populateDependencies) {
        // Get the handler's dependencies (read-only, just capturing what will be read)
        const depTx = this.runtime.edit();
        handler.populateDependencies(depTx, eventValue);
        const deps = txToReactivityLog(depTx);
        // Commit even though we only read - the tx has no writes so this is safe
        depTx.commit();

        // Check if any dependencies are dirty (have pending computations)
        // We need to find dirty actions that WRITE to the entities we're reading
        const dirtyDeps: Action[] = [];
        for (const read of deps.reads) {
          for (const action of this.dirty) {
            const writes = this.mightWrite.get(action);
            if (writes) {
              for (const write of writes) {
                if (
                  write.space === read.space &&
                  write.id === read.id &&
                  arraysOverlap(write.path, read.path)
                ) {
                  if (!dirtyDeps.includes(action)) {
                    dirtyDeps.push(action);
                  }
                  break;
                }
              }
            }
          }
        }

        // If there are dirty dependencies, add them to pending and re-queue event
        if (dirtyDeps.length > 0) {
          for (const dep of dirtyDeps) {
            this.pending.add(dep);
            eventBlockingDeps.add(dep); // Track for workSet inclusion
          }
          // Re-queue the event to be processed after dependencies compute
          this.eventQueue.unshift(queuedEvent);
          shouldSkipEvent = true;
        }
      }

      // Skip running the event if we need to compute dependencies first
      if (shouldSkipEvent) {
        // Continue to process pending actions
        // The event will be processed in the next execute() cycle
      } else {
        const finalize = (error?: unknown) => {
          try {
            if (error) this.handleError(error as Error, action);
          } finally {
            // CFC taint tracking: detach context from transaction
            detachTaintContext(tx);

            tx.commit().then(({ error }) => {
              // If the transaction failed, and we have retries left, queue the
              // event again at the beginning of the queue. This isn't guaranteed
              // to be the same order as the original event, but it's close
              // enough, especially for a series of event that act on the same
              // conflicting data.
              if (error && retriesLeft > 0) {
                this.eventQueue.unshift({
                  action,
                  handler,
                  event: eventValue,
                  retriesLeft: retriesLeft - 1,
                  onCommit,
                });
                // Ensure the re-queued event gets processed even if the scheduler
                // finished this cycle before the commit completed.
                this.queueExecution();
              } else if (onCommit) {
                // Call commit callback when:
                // - Commit succeeds (!error), OR
                // - Commit fails but we're out of retries (retriesLeft === 0)
                try {
                  onCommit(tx);
                } catch (callbackError) {
                  logger.error(
                    "schedule-error",
                    "Error in event commit callback:",
                    callbackError,
                  );
                }
              }
            });
          }
        };
        const tx = this.runtime.edit();

        // CFC taint tracking: attach context to transaction
        if (this.runtime.cfcEnabled) {
          const ctx = this.runtime.cfc.createActionContext({
            userDid: this.runtime.userIdentityDID ?? "anonymous",
            space: "default", // TODO: derive from action's target cell
          });
          attachTaintContext(tx, ctx);
        }

        const actionId = this.getActionId(action);

        try {
          const actionStartTime = performance.now();
          this.runningPromise = Promise.resolve(
            this.runtime.harness.invoke(() => action(tx)),
          ).then(() => {
            const duration = (performance.now() - actionStartTime) / 1000;
            if (duration > 10) {
              console.warn(`Slow action: ${duration.toFixed(3)}s`, action);
            }
            logger.debug("action-timing", () => {
              return [
                `Action ${actionId} completed in ${duration.toFixed(3)}s`,
              ];
            });
            finalize();
          }).catch((error) => finalize(error));
          await this.runningPromise;
        } catch (error) {
          finalize(error);
        }
      } // Close else block for shouldSkipEvent
    }
    logger.timeEnd("scheduler", "execute", "event");

    // Process any newly subscribed actions that were added during event handling.
    // This handles cases like event handlers that create sub-recipes whose
    // computations need their dependencies discovered before we build the workSet.
    if (this.pendingDependencyCollection.size > 0) {
      for (const action of this.pendingDependencyCollection) {
        const populateDependencies = this.populateDependenciesCallbacks.get(
          action,
        );
        if (!populateDependencies) continue;

        this.collectDependenciesForAction(action, populateDependencies, {
          errorLogLabel: "schedule-dep-error-post-event",
          errorMessage: (target, error) =>
            `Error populating dependencies for ${
              this.getActionId(target)
            }: ${error}`,
        });

        logger.debug("schedule-dep-collect-post-event", () => [
          `Collected dependencies for ${this.getActionId(action)}`,
        ]);
      }
      this.pendingDependencyCollection.clear();
    }

    // Build initial seeds for pull mode (effects + special actions)
    const initialSeeds = new Set<Action>();
    if (this.pullMode) {
      // Add pending effects (not computations)
      for (const action of this.pending) {
        if (this.effects.has(action)) {
          initialSeeds.add(action);
        }
      }
      // Add dirty effects - these may have been skipped due to cycle detection
      // or throttling but still need to run
      for (const action of this.dirty) {
        if (this.effects.has(action)) {
          initialSeeds.add(action);
        }
      }
      // Add any actions that need to write to capture possible writes
      for (const action of newActionsWithoutDependencies) {
        initialSeeds.add(action);
      }
      // Add computations that are blocking deferred events
      for (const action of eventBlockingDeps) {
        initialSeeds.add(action);
      }
    }

    // Settle loop: runs until no more dirty work is found.
    // First iteration processes initial seeds + their dirty deps.
    // Subsequent iterations process new subscriptions and re-collect dirty deps.
    logger.timeStart("scheduler", "execute", "settle");
    const maxSettleIterations = this.pullMode ? 10 : 1;
    const EARLY_ITERATION_THRESHOLD = 5;
    const earlyIterationComputations = new Set<Action>(); // Track computations in first N iterations
    let lastWorkSet: Set<Action> = new Set();
    let settledEarly = false;

    for (let settleIter = 0; settleIter < maxSettleIterations; settleIter++) {
      // Process any newly subscribed actions from previous iteration.
      // This sets up their dependencies so collectDirtyDependencies can find them.
      if (this.pullMode && this.pendingDependencyCollection.size > 0) {
        for (const action of this.pendingDependencyCollection) {
          const populateDependencies = this.populateDependenciesCallbacks.get(
            action,
          );
          if (!populateDependencies) continue;

          this.collectDependenciesForAction(action, populateDependencies, {
            errorLogLabel: "schedule-dep-error-pre-run",
            errorMessage: (target, error) =>
              `Error collecting deps for ${this.getActionId(target)}: ${error}`,
            useRawReadsForTriggers: true,
          });
        }
        this.pendingDependencyCollection.clear();
      }

      // Build the work set for this iteration
      let workSet: Set<Action>;

      if (this.pullMode) {
        workSet = new Set<Action>();

        // On first iteration, add initial seeds and collect their dirty deps
        if (settleIter === 0) {
          for (const seed of initialSeeds) {
            workSet.add(seed);
          }
          // Collect dirty dependencies from initial seeds
          for (const seed of initialSeeds) {
            this.collectDirtyDependencies(seed, workSet);
          }
          logger.debug("schedule-execute-pull", () => [
            `Pull mode: Effects: ${initialSeeds.size}, Dirty deps added: ${
              workSet.size - initialSeeds.size
            }`,
          ]);
        } else {
          // On subsequent iterations, re-collect from all effects
          for (const effect of this.effects) {
            if (this.dependencies.has(effect)) {
              this.collectDirtyDependencies(effect, workSet);
            }
          }
        }
      } else {
        // Push mode: work set is just the pending actions
        workSet = this.pending;
      }

      if (workSet.size === 0) {
        settledEarly = true;
        break;
      }

      // Track computations in early iterations for cycle detection
      if (this.pullMode && settleIter < EARLY_ITERATION_THRESHOLD) {
        for (const fn of workSet) {
          if (!this.effects.has(fn)) {
            earlyIterationComputations.add(fn);
          }
        }
      }
      lastWorkSet = workSet;

      const order = topologicalSort(
        workSet,
        this.dependencies,
        this.mightWrite,
        this.actionParent,
      );

      logger.debug("schedule-execute", () => [
        `Running ${order.length} actions (settle iteration ${settleIter})`,
      ]);

      // Implicit cycle detection for effects:
      // Clear dirty flags for all effects upfront. If an effect becomes dirty again
      // by the time we run it, something in the execution re-dirtied it → cycle.
      if (this.pullMode) {
        for (const fn of order) {
          if (this.effects.has(fn)) {
            this.clearDirty(fn);
          }
        }
      }

      // Run all functions. This will resubscribe actions with their new dependencies.
      for (const fn of order) {
        // Check if action is still scheduled (not unsubscribed during this tick).
        // Running an action might unsubscribe other actions in the workSet.
        const isStillScheduled = this.computations.has(fn) ||
          this.effects.has(fn);
        if (!isStillScheduled) continue;

        // Check if action is still valid
        // In pull mode, check both pending (effects) and dirty (computations)
        const isInPending = this.pending.has(fn);
        const isInDirty = this.dirty.has(fn);

        if (this.pullMode) {
          // For effects: we cleared dirty upfront, so check if re-dirtied (cycle)
          if (this.effects.has(fn)) {
            if (this.dirty.has(fn)) {
              // Effect was re-dirtied during this tick → cycle detected
              logger.debug("schedule-cycle", () => [
                `[CYCLE] Effect ${
                  this.getActionId(fn)
                } re-dirtied, skipping (cycle detected)`,
              ]);
              // Skip this effect - it will run on a future tick after cycle settles
              this.pending.delete(fn);
              continue;
            }
            if (!isInPending) continue;
          } else {
            // For computations: must be pending or dirty
            if (!isInPending && !isInDirty) continue;
          }
        } else {
          // Push mode: action must be in pending
          if (!isInPending) continue;
        }

        // Check throttle: skip recently-run actions but keep them dirty
        // They'll be pulled next time an effect needs them (if throttle expired)
        if (this.isThrottled(fn)) {
          logger.debug("schedule-throttle", () => [
            `[THROTTLE] Skipping throttled action: ${this.getActionId(fn)}`,
          ]);
          this.filterStats.filtered++;
          // Don't clear from pending or dirty - action stays in its current state
          // but we remove from pending so it doesn't run this cycle
          this.pending.delete(fn);
          // Keep dirty flag so it can be pulled later
          continue;
        }

        // Clean up from pending/dirty before running
        this.pending.delete(fn);
        if (this.pullMode) {
          this.clearDirty(fn);
        }
        this.unsubscribe(fn);

        this.filterStats.executed++;
        this.loopCounter.set(fn, (this.loopCounter.get(fn) || 0) + 1);
        // Track runs for cycle-aware debounce
        this.runsThisExecute.set(fn, (this.runsThisExecute.get(fn) ?? 0) + 1);
        if (this.loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN) {
          this.handleError(
            new Error(
              `Too many iterations: ${this.loopCounter.get(fn)} ${
                this.getActionId(fn)
              }`,
            ),
            fn,
          );
        } else {
          await this.run(fn);
        }
      }
    }
    logger.timeEnd("scheduler", "execute", "settle");

    // If we hit max iterations without settling, break the cycle:
    // 1. Clear dirty/pending for computations that were in early iterations AND still in last workSet
    // 2. Run all remaining dirty effects so they don't get lost
    if (this.pullMode && !settledEarly && lastWorkSet.size > 0) {
      logger.debug("schedule-cycle", () => [
        `[CYCLE-BREAK] Hit max iterations (${maxSettleIterations}), breaking cycle`,
        `Early computations: ${earlyIterationComputations.size}, Last workSet: ${lastWorkSet.size}`,
      ]);

      // Clear computations that appear to be in the cycle
      // (present in early iterations AND still in the last workSet)
      // But don't clear throttled computations - they should stay dirty
      for (const comp of earlyIterationComputations) {
        if (
          lastWorkSet.has(comp) && this.dirty.has(comp) &&
          !this.isThrottled(comp)
        ) {
          logger.debug("schedule-cycle", () => [
            `[CYCLE-BREAK] Clearing cyclic computation: ${
              this.getActionId(comp)
            }`,
          ]);
          this.clearDirty(comp);
          this.pending.delete(comp);
        }
      }

      // Run all remaining dirty effects - these shouldn't be lost
      // But skip throttled effects - they should stay dirty for later
      for (const effect of this.effects) {
        if (this.dirty.has(effect) && !this.isThrottled(effect)) {
          logger.debug("schedule-cycle", () => [
            `[CYCLE-BREAK] Running dirty effect: ${this.getActionId(effect)}`,
          ]);
          this.clearDirty(effect);
          this.pending.delete(effect);
          this.unsubscribe(effect);
          this.filterStats.executed++;
          await this.run(effect);
        }
      }
    }

    // Apply cycle-aware debounce to actions that ran multiple times this execute()
    const executeElapsed = performance.now() - this.executeStartTime;
    if (this.pullMode && executeElapsed >= CYCLE_DEBOUNCE_THRESHOLD_MS) {
      for (const [action, runs] of this.runsThisExecute) {
        if (runs >= CYCLE_DEBOUNCE_MIN_RUNS && !this.noDebounce.get(action)) {
          // This action is cycling - apply adaptive debounce
          const adaptiveDelay = Math.round(
            CYCLE_DEBOUNCE_MULTIPLIER * executeElapsed,
          );
          const currentDebounce = this.actionDebounce.get(action) ?? 0;
          if (adaptiveDelay > currentDebounce) {
            this.actionDebounce.set(action, adaptiveDelay);
            logger.debug("schedule-cycle-debounce", () => [
              `[CYCLE-DEBOUNCE] Action ${this.getActionId(action)} ` +
              `ran ${runs}x in ${executeElapsed.toFixed(1)}ms, ` +
              `setting debounce to ${adaptiveDelay}ms`,
            ]);
          }
        }
      }
    }

    // In pull mode, we consider ourselves done when there are no effects to execute.
    // Check both pending AND dirty effects - dirty effects may exist from:
    // - Cycle detection (effect re-dirtied, skipped to prevent infinite loop)
    // - Throttling (effect throttled, kept dirty for later)
    const hasPendingEffects = this.pullMode
      ? [...this.pending].some((a) => this.effects.has(a))
      : this.pending.size > 0;
    const hasDirtyEffects = this.pullMode &&
      [...this.dirty].some((a) => this.effects.has(a));

    if (
      !hasPendingEffects && !hasDirtyEffects && this.eventQueue.length === 0
    ) {
      const promises = this.idlePromises;
      for (const resolve of promises) resolve();
      this.idlePromises.length = 0;
      this.loopCounter = new WeakMap();
      this.scheduled = false;

      this.scheduledFirstTime.clear();
    } else {
      // Keep scheduled = true since we're queuing another execution
      queueTask(() => this.execute());
    }
    logger.timeEnd("scheduler", "execute");
  }

  /**
   * Clean up all pending timers and resources.
   * Should be called when the scheduler is being torn down.
   */
  dispose(): void {
    // Clear all active debounce timers
    for (const timer of this.activeDebounceTimers) {
      clearTimeout(timer);
    }
    this.activeDebounceTimers.clear();
  }
}

function topologicalSort(
  actions: Set<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
  mightWrite: WeakMap<Action, IMemorySpaceAddress[]>,
  actionParent?: WeakMap<Action, Action>,
): Action[] {
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();

  // Initialize graph and inDegree for relevant actions
  for (const action of actions) {
    graph.set(action, new Set());
    inDegree.set(action, 0);
  }

  // Build the graph based on read/write dependencies
  for (const actionA of actions) {
    const log = dependencies.get(actionA);
    if (!log) continue;
    const writes = mightWrite.get(actionA) ?? [];
    const graphA = graph.get(actionA)!;
    for (const write of writes) {
      for (const actionB of actions) {
        if (actionA !== actionB && !graphA.has(actionB)) {
          const logB = dependencies.get(actionB);
          if (!logB) continue;
          const { reads } = logB;
          if (
            reads.some(
              (addr) =>
                addr.space === write.space &&
                addr.id === write.id &&
                arraysOverlap(write.path, addr.path),
            )
          ) {
            graphA.add(actionB);
            inDegree.set(actionB, (inDegree.get(actionB) || 0) + 1);
          }
        }
      }
    }
  }

  // Add parent-child edges: parent must execute before child
  if (actionParent) {
    for (const child of actions) {
      const parent = actionParent.get(child);
      if (parent && actions.has(parent)) {
        const graphParent = graph.get(parent)!;
        if (!graphParent.has(child)) {
          graphParent.add(child);
          inDegree.set(child, (inDegree.get(child) || 0) + 1);
        }
      }
    }
  }

  // Perform topological sort with cycle handling
  const queue: Action[] = [];
  const result: Action[] = [];
  const visited = new Set<Action>();

  // Add all actions with no dependencies (in-degree 0) to the queue
  for (const [action, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(action);
    }
  }

  while (queue.length > 0 || visited.size < actions.size) {
    if (queue.length === 0) {
      // Handle cycle: prefer parents over children, then lowest in-degree
      // This ensures parent runs before child even when they form a read/write cycle
      const unvisited = Array.from(actions).filter(
        (action) => !visited.has(action),
      );

      // Sort by: prefer no unvisited parent, then by in-degree
      unvisited.sort((a, b) => {
        const aParent = actionParent?.get(a);
        const bParent = actionParent?.get(b);
        const aHasUnvisitedParent = aParent && !visited.has(aParent) &&
          actions.has(aParent);
        const bHasUnvisitedParent = bParent && !visited.has(bParent) &&
          actions.has(bParent);

        // Prefer nodes whose parent is already visited (or have no parent)
        if (aHasUnvisitedParent && !bHasUnvisitedParent) return 1; // b first
        if (!aHasUnvisitedParent && bHasUnvisitedParent) return -1; // a first

        // Fall back to in-degree
        return (inDegree.get(a) || 0) - (inDegree.get(b) || 0);
      });

      queue.push(unvisited[0]);
    }

    const current = queue.shift()!;
    if (visited.has(current)) continue;

    result.push(current);
    visited.add(current);

    for (const neighbor of graph.get(current) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
      }
    }
  }

  return result;
}

export function txToReactivityLog(
  tx: IExtendedStorageTransaction,
): ReactivityLog {
  const log: ReactivityLog = { reads: [], writes: [] };
  for (const activity of tx.journal.activity()) {
    if ("read" in activity && activity.read) {
      if (activity.read.meta?.[ignoreReadForSchedulingMarker]) continue;
      const address = {
        space: activity.read.space,
        id: activity.read.id,
        type: activity.read.type,
        path: activity.read.path.slice(1), // Remove the "value" prefix
      };
      log.reads.push(address);
      // If marked as potential write, also add to potentialWrites
      if (activity.read.meta?.[markReadAsPotentialWriteMarker]) {
        if (!log.potentialWrites) {
          log.potentialWrites = [];
        }
        log.potentialWrites.push(address);
      }
    }
    if ("write" in activity && activity.write) {
      log.writes.push({
        space: activity.write.space,
        id: activity.write.id,
        type: activity.write.type,
        path: activity.write.path.slice(1),
      });
    }
  }
  return log;
}

function getPieceMetadataFromFrame(frame?: Frame): {
  spellId?: string;
  recipeId?: string;
  space?: string;
  pieceId?: string;
} {
  // TODO(seefeld): This is a rather hacky way to get the context, based on the
  // unsafe_binding pattern. Once we replace that mechanism, let's add nicer
  // abstractions for context here as well.
  frame ??= getTopFrame();

  const sourceAsProxy = frame?.unsafe_binding?.materialize([]);

  if (!isCellResultForDereferencing(sourceAsProxy)) {
    return {};
  }
  const result: ReturnType<typeof getPieceMetadataFromFrame> = {};
  const source = getCellOrThrow(sourceAsProxy).asSchema({
    type: "object",
    properties: {
      [TYPE]: { type: "string" },
      spell: { type: "object", asCell: true },
      resultRef: { type: "object", asCell: true },
    },
  });
  result.recipeId = source.get()?.[TYPE];
  const spellCell = source.get()?.spell;
  result.spellId = spellCell?.getAsNormalizedFullLink().id;
  const resultCell = source.get()?.resultRef;
  result.space = source.space;
  result.pieceId = JSON.parse(
    JSON.stringify(resultCell?.entityId ?? {}),
  )["/"];
  return result;
}

function queueTask(fn: () => void): void {
  setTimeout(fn, 0);
}
