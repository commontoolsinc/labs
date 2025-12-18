import { getLogger } from "@commontools/utils/logger";
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
import { ensureCharmRunning } from "./ensure-charm-running.ts";

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
const MAX_CYCLE_ITERATIONS = 20;
const FAST_CYCLE_THRESHOLD_MS = 16;
const AUTO_DEBOUNCE_THRESHOLD_MS = 50;
const AUTO_DEBOUNCE_MIN_RUNS = 3;
const AUTO_DEBOUNCE_DELAY_MS = 100;

/**
 * Statistics tracked for each action's execution performance.
 */
export interface ActionStats {
  runCount: number;
  totalTime: number;
  averageTime: number;
  lastRunTime: number;
  lastRunTimestamp: number; // When the action last ran (performance.now())
}

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
  private retries = new WeakMap<Action, number>();

  // Effect/computation tracking for pull-based scheduling
  private effects = new Set<Action>();
  private computations = new Set<Action>();
  private dependents = new WeakMap<Action, Set<Action>>();
  private reverseDependencies = new WeakMap<Action, Set<Action>>();
  // Track which actions are effects persistently (survives unsubscribe/re-subscribe)
  private isEffectAction = new WeakMap<Action, boolean>();
  private dirty = new Set<Action>();
  private pullMode = true;

  // Compute time tracking for cycle-aware scheduling
  private actionStats = new WeakMap<Action, ActionStats>();
  // Cycle detection during dependency collection
  private collectStack = new Set<Action>();
  // Slow cycle state for yielding between iterations
  private slowCycleState = new WeakMap<
    Action,
    { iteration: number; lastYield: number }
  >();

  // Debounce infrastructure for throttling slow actions
  private debounceTimers = new WeakMap<
    Action,
    ReturnType<typeof setTimeout>
  >();
  private actionDebounce = new WeakMap<Action, number>();
  private autoDebounceEnabled = new WeakMap<Action, boolean>();

  // Throttle infrastructure - "value can be stale by T ms"
  private actionThrottle = new WeakMap<Action, number>();

  // Push-triggered filtering
  // Track what each action has ever written (grows over time)
  private mightWrite = new WeakMap<Action, IMemorySpaceAddress[]>();
  // Track actions scheduled for first time (bypass filter)
  private scheduledFirstTime = new Set<Action>();
  // Filter stats for diagnostics
  private filterStats = { filtered: 0, executed: 0 };

  // Parent-child action tracking for proper execution ordering
  // When a child action is created during parent execution, parent must run first
  private executingAction: Action | null = null;
  private actionParent = new WeakMap<Action, Action>();
  private actionChildren = new WeakMap<Action, Set<Action>>();

  // Dependency population callbacks for first-time subscriptions
  // Called in execute() to discover what cells the action will read
  private populateDependenciesCallbacks = new WeakMap<
    Action,
    PopulateDependencies
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
      const metadata = getCharmMetadataFromFrame();
      const result = this.consoleHandler({ metadata, method, args });
      console[method].apply(console, result);
    });
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
      autoDebounce?: boolean;
      throttle?: number;
    } = {},
  ): Cancel {
    // Handle backwards-compatible ReactivityLog argument
    let populateDependenciesCallback: PopulateDependencies;
    let immediateLog: ReactivityLog | undefined;
    if (typeof populateDependencies === "function") {
      populateDependenciesCallback = populateDependencies;
    } else {
      // ReactivityLog provided directly - set up dependencies immediately
      // (for backwards compatibility with code that passes reads/writes)
      immediateLog = populateDependencies;
      populateDependenciesCallback = (depTx: IExtendedStorageTransaction) => {
        for (const read of immediateLog!.reads) {
          depTx.readOrThrow(read);
        }
      };
    }
    const {
      isEffect = false,
      debounce,
      autoDebounce,
      throttle,
    } = options;

    // Apply debounce settings if provided
    if (debounce !== undefined) {
      this.setDebounce(action, debounce);
    }
    if (autoDebounce !== undefined) {
      this.setAutoDebounce(action, autoDebounce);
    }
    // Apply throttle setting if provided
    if (throttle !== undefined) {
      this.setThrottle(action, throttle);
    }

    // Track action type for pull-based scheduling
    // Once an action is marked as an effect, it stays an effect (persists across re-subscriptions)
    if (isEffect) {
      this.isEffectAction.set(action, true);
    }

    // Use the persistent effect status for tracking
    if (this.isEffectAction.get(action)) {
      this.effects.add(action);
      this.computations.delete(action);
      this.queueExecution(); // Always trigger execution when scheduling an effect
    } else {
      this.computations.add(action);
      this.effects.delete(action);
    }

    // Track parent-child relationship if action is created during another action's execution
    if (this.executingAction && this.executingAction !== action) {
      const parent = this.executingAction;
      this.actionParent.set(action, parent);

      // Add to parent's children set
      let children = this.actionChildren.get(parent);
      if (!children) {
        children = new Set();
        this.actionChildren.set(parent, children);
      }
      children.add(action);

      logger.debug("schedule", () => [
        `[PARENT-CHILD] Action ${action.name || "anonymous"} is child of ${
          parent.name || "anonymous"
        }`,
      ]);
    }

    logger.debug(
      "schedule",
      () => [
        "Subscribing to action:",
        action,
        isEffect ? "effect" : "computation",
      ],
    );

    // Store the populateDependencies callback for use in execute()
    this.populateDependenciesCallbacks.set(
      action,
      populateDependenciesCallback,
    );

    // If a ReactivityLog was provided directly, set up dependencies immediately.
    // This ensures writes are tracked right away for reverse dependency graph.
    // The callback will still be called in execute() to potentially discover more reads.
    if (immediateLog) {
      this.setDependencies(action, immediateLog);
      this.updateDependents(action, immediateLog);
    } else {
      // Mark action for dependency collection before first run
      this.pendingDependencyCollection.add(action);
    }

    // Mark as dirty and pending for first-time execution
    // In pull mode this still doesn't mean execution: There needs to be an effect to trigger it.
    this.dirty.add(action);
    this.pending.add(action);
    this.scheduledFirstTime.add(action);

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
    options: { isEffect?: boolean } = {},
  ): void {
    const { isEffect } = options;

    const reads = this.setDependencies(action, log);

    // Update reverse dependency graph
    this.updateDependents(action, log);

    // Track action type for pull-based scheduling
    // Once an action is marked as an effect, it stays an effect
    if (isEffect) {
      this.isEffectAction.set(action, true);
    }

    // Use the persistent effect status for tracking
    if (this.isEffectAction.get(action)) {
      this.effects.add(action);
      this.computations.delete(action);
    } else {
      this.computations.add(action);
      this.effects.delete(action);
    }

    const pathsByEntity = addressesToPathByEntity(reads);

    logger.debug("schedule", () => [
      `[RESUBSCRIBE] Action: ${action.name || "anonymous"}`,
      `Entities: ${pathsByEntity.size}`,
      `Reads: ${reads.length}`,
    ]);

    const entities = new Set<SpaceAndURI>();

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

      logger.debug("schedule", () => [
        `[RESUBSCRIBE] Registered action for ${spaceAndURI}`,
        `Paths: ${pathsWithValues.map((p) => p.join("/")).join(", ")}`,
      ]);
    }

    this.cancels.set(action, () => {
      logger.debug("schedule", () => [
        `[UNSUBSCRIBE] Action: ${action.name || "anonymous"}`,
        `Entities: ${entities.size}`,
      ]);
      for (const spaceAndURI of entities) {
        this.triggers.get(spaceAndURI)?.delete(action);
      }
    });
  }

  unsubscribe(action: Action): void {
    this.cancels.get(action)?.();
    this.cancels.delete(action);
    this.dependencies.delete(action);
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
    // Clean up parent-child relationships
    const parent = this.actionParent.get(action);
    if (parent) {
      const siblings = this.actionChildren.get(parent);
      siblings?.delete(action);
      this.actionParent.delete(action);
    }
    this.actionChildren.delete(action);
    // Cancel any pending debounce timer
    this.cancelDebounceTimer(action);
    // Clean up dependency collection tracking
    this.populateDependenciesCallbacks.delete(action);
    this.pendingDependencyCollection.delete(action);
  }

  async run(action: Action): Promise<any> {
    this.runtime.telemetry.submit({
      type: "scheduler.run",
      action,
    });

    logger.debug("schedule-run-start", () => [
      `[RUN] Starting action: ${action.name || "anonymous"}`,
      `Pull mode: ${this.pullMode}`,
    ]);

    if (this.runningPromise) await this.runningPromise;

    const tx = this.runtime.edit();
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
              `[RUN] Action failed: ${action.name || "anonymous"}`,
              `Error: ${error}`,
            ]);
            this.handleError(error as Error, action);
          }
        } finally {
          // Set up new reactive subscriptions after the action runs

          // Commit the transaction. The code continues synchronously after
          // kicking off the commit, i.e. it assumes the commit will be
          // successful. If it isn't, the data will be rolled back and all other
          // reactive functions based on it will be retriggered. But also, the
          // retry logic below will have re-scheduled this action, so
          // topological sorting should move it before the dependencies.
          tx.commit().then(({ error }) => {
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
            `[RUN] Action completed: ${action.name || "anonymous"}`,
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
        Promise.resolve(action(tx))
          .then((actionResult) => {
            result = actionResult;
            this.executingAction = null;
            logger.debug("schedule-action-timing", () => {
              const duration = ((performance.now() - actionStartTime) / 1000)
                .toFixed(3);
              return [
                `Action ${
                  action.name || "anonymous"
                } completed in ${duration}s`,
              ];
            });
            finalizeAction();
          })
          .catch((error) => {
            this.executingAction = null;
            finalizeAction(error);
          });
      } catch (error) {
        this.executingAction = null;
        finalizeAction(error);
      }
    });

    return this.runningPromise;
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
    doNotLoadCharmIfNotRunning: boolean = false,
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

    // If no handler was found, try to start the charm that should handle this event
    if (!handlerFound && !doNotLoadCharmIfNotRunning) {
      // Use an async IIFE to handle the async operation without blocking
      (async () => {
        const started = await ensureCharmRunning(this.runtime, eventLink);
        if (started) {
          // Charm was started, re-queue the event. Don't trigger loading again
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
        logger.debug("schedule", () => [
          `[NOTIFICATION] Type: ${notification.type}`,
          `Space: ${space}`,
          `Has source: ${
            "source" in notification ? notification.source : "none"
          }`,
          `Changes: ${
            "changes" in notification ? [...notification.changes].length : 0
          }`,
        ]);

        if ("changes" in notification) {
          let changeIndex = 0;
          for (const change of notification.changes) {
            changeIndex++;
            logger.debug("schedule", () => [
              `[CHANGE ${changeIndex}]`,
              `Address: ${change.address.id}/${change.address.path.join("/")}`,
              `Before: ${JSON.stringify(change.before)}`,
              `After: ${JSON.stringify(change.after)}`,
            ]);
            this.runtime.telemetry.submit({
              type: "cell.update",
              change: change,
            });

            if (change.address.type !== "application/json") {
              logger.debug("schedule", () => [
                `[CHANGE ${changeIndex}] Skipping non-JSON type: ${change.address.type}`,
              ]);
              continue;
            }

            const spaceAndURI = `${space}/${change.address.id}` as SpaceAndURI;
            const paths = this.triggers.get(spaceAndURI);

            if (paths) {
              logger.debug("schedule", () => [
                `[CHANGE ${changeIndex}] Found ${paths.size} registered actions for ${spaceAndURI}`,
              ]);

              const triggeredActions = determineTriggeredActions(
                paths,
                change.before,
                change.after,
                change.address.path,
              );

              logger.debug("schedule", () => [
                `[CHANGE ${changeIndex}] Triggered ${triggeredActions.length} actions`,
              ]);

              for (const action of triggeredActions) {
                logger.debug("schedule", () => [
                  `[TRIGGERED] Action for ${spaceAndURI}/${
                    change.address.path.join("/")
                  }`,
                  `Action name: ${action.name || "anonymous"}`,
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
    this.mightWrite.set(
      action,
      sortAndCompactPaths([
        ...existingMightWrite,
        ...writes,
        ...(log.potentialWrites ?? []),
      ]),
    );

    return reads;
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

    // For each read of the new action, find other actions that write to it
    for (const read of reads) {
      // Check all registered actions for ones that write to this read
      for (const otherAction of [...this.computations, ...this.effects]) {
        if (otherAction === action) continue;

        // Use mightWrite (accumulates all paths action has ever written)
        // This ensures dependency chain is built even if first run writes undefined
        const otherWrites = this.mightWrite.get(otherAction) ?? [];

        // Check if otherAction writes to this entity we're reading
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
          }
        }
      }
    }

    if (newDependencies.size > 0) {
      this.reverseDependencies.set(action, newDependencies);
    }
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
  }

  /**
   * Disables pull-based scheduling mode (returns to push mode).
   */
  disablePullMode(): void {
    this.pullMode = false;
    // Clear dirty set when switching back to push mode
    this.dirty.clear();
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
   * Returns a set of actions that were detected to be part of a cycle.
   */
  private collectDirtyDependencies(
    action: Action,
    workSet: Set<Action>,
    cycleMembers: Set<Action> = new Set(),
  ): Set<Action> {
    const log = this.dependencies.get(action);
    if (!log) {
      return cycleMembers;
    }

    // Check for cycle: if action is already in the collection stack, we've found a cycle
    if (this.collectStack.has(action)) {
      cycleMembers.add(action);
      return cycleMembers;
    }

    // Add to collection stack before processing
    this.collectStack.add(action);

    // Find dirty computations that write to entities this action reads
    for (const computation of this.dirty) {
      if (workSet.has(computation)) continue; // Already added
      if (computation === action) continue;

      const computationLog = this.dependencies.get(computation);
      const computationWrites = this.mightWrite.get(computation) ??
        computationLog?.writes ?? [];
      if (!computationLog) {
        continue;
      }

      // Check if computation writes to something action reads (document-level match)
      let found = false;
      for (const write of computationWrites) {
        for (const read of log.reads) {
          if (write.space === read.space && write.id === read.id) {
            workSet.add(computation);
            // Recursively collect deps of this computation
            this.collectDirtyDependencies(computation, workSet, cycleMembers);
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    // Remove from collection stack after processing
    this.collectStack.delete(action);

    return cycleMembers;
  }

  /**
   * Detects cycles (strongly connected components) in a work set of actions.
   * Uses Tarjan's algorithm to identify all SCCs.
   * Returns a list of cycle groups (each group is a set of actions forming a cycle).
   */
  detectCycles(workSet: Set<Action>): Set<Action>[] {
    const index = new Map<Action, number>();
    const lowlink = new Map<Action, number>();
    const onStack = new Set<Action>();
    const stack: Action[] = [];
    const sccs: Set<Action>[] = [];
    let currentIndex = 0;

    const strongconnect = (action: Action) => {
      index.set(action, currentIndex);
      lowlink.set(action, currentIndex);
      currentIndex++;
      stack.push(action);
      onStack.add(action);

      // Get successors: actions that depend on this action's output
      const successors = this.getSuccessorsInWorkSet(action, workSet);

      for (const successor of successors) {
        if (!index.has(successor)) {
          // Successor hasn't been visited yet
          strongconnect(successor);
          lowlink.set(
            action,
            Math.min(lowlink.get(action)!, lowlink.get(successor)!),
          );
        } else if (onStack.has(successor)) {
          // Successor is on the stack and hence in the current SCC
          lowlink.set(
            action,
            Math.min(lowlink.get(action)!, index.get(successor)!),
          );
        }
      }

      // If action is a root node, pop the stack and generate an SCC
      if (lowlink.get(action) === index.get(action)) {
        const scc = new Set<Action>();
        let w: Action;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.add(w);
        } while (w !== action);

        // Only include SCCs with more than one node (actual cycles)
        if (scc.size > 1) {
          sccs.push(scc);
        }
      }
    };

    // Run Tarjan's algorithm on all actions in the work set
    for (const action of workSet) {
      if (!index.has(action)) {
        strongconnect(action);
      }
    }

    return sccs;
  }

  /**
   * Gets actions in the work set that depend on this action's output.
   * Used by detectCycles to build the dependency graph.
   */
  private getSuccessorsInWorkSet(
    action: Action,
    workSet: Set<Action>,
  ): Action[] {
    const successors: Action[] = [];
    const actionLog = this.dependencies.get(action);
    if (!actionLog) return successors;

    for (const otherAction of workSet) {
      if (otherAction === action) continue;

      const otherLog = this.dependencies.get(otherAction);
      if (!otherLog) continue;

      // Check if otherAction reads what this action writes
      // We need to check both space/id AND path overlap
      let found = false;
      for (const write of actionLog.writes) {
        if (found) break;
        for (const read of otherLog.reads) {
          if (
            write.space === read.space &&
            write.id === read.id &&
            arraysOverlap(write.path, read.path)
          ) {
            successors.push(otherAction);
            found = true;
            break;
          }
        }
      }
    }

    return successors;
  }

  /**
   * Estimates the total time for one iteration of a cycle based on action stats.
   * Returns 0 if no stats are available (assumes fast).
   */
  private estimateCycleTime(cycle: Set<Action>): number {
    let total = 0;
    for (const action of cycle) {
      const stats = this.actionStats.get(action);
      if (stats) {
        total += stats.averageTime;
      }
    }
    return total;
  }

  /**
   * Determines if a cycle is "fast" (< 16ms estimated time).
   * Fast cycles converge completely before any effect sees a value.
   */
  private isFastCycle(cycle: Set<Action>): boolean {
    return this.estimateCycleTime(cycle) < FAST_CYCLE_THRESHOLD_MS;
  }

  /**
   * Converges a fast cycle by running all dirty members repeatedly until stable.
   * Returns true if the cycle converged, false if max iterations reached.
   */
  private async convergeFastCycle(cycle: Set<Action>): Promise<boolean> {
    let iterations = 0;

    while (iterations < MAX_CYCLE_ITERATIONS) {
      // Find dirty or pending members of the cycle
      // (actions may be re-added to pending when they write to cells that other cycle members read)
      const dirtyMembers = [...cycle].filter((action) =>
        this.dirty.has(action) || this.pending.has(action)
      );

      if (dirtyMembers.length === 0) {
        // Cycle has converged
        logger.debug("schedule-cycle", () => [
          `[CYCLE] Fast cycle converged after ${iterations} iterations`,
        ]);
        return true;
      }

      iterations++;

      // Sort dirty members topologically within the cycle
      const sorted = topologicalSort(
        new Set(dirtyMembers),
        this.dependencies,
        this.mightWrite,
        this.actionParent,
      );

      // Run each dirty member
      for (const action of sorted) {
        if (!this.dirty.has(action)) continue; // May have been cleared by earlier run

        this.dirty.delete(action);
        this.pending.delete(action);
        this.unsubscribe(action);
        await this.run(action);
      }
    }

    // Max iterations reached - cycle didn't converge
    const error = new Error(
      `Fast cycle did not converge after ${MAX_CYCLE_ITERATIONS} iterations`,
    );
    logger.warn("schedule-cycle", () => [`[CYCLE] ${error.message}`]);

    // Report error to handlers (pick first cycle member as representative)
    const representative = cycle.values().next().value;
    if (representative) {
      this.handleError(error, representative);
    }

    // Clean up: remove dirty/pending state for cycle members to prevent infinite loops
    for (const action of cycle) {
      this.dirty.delete(action);
      this.pending.delete(action);
    }

    return false;
  }

  /**
   * Runs one iteration of a slow cycle and re-queues dirty members.
   * Returns true if the cycle converged, false if more iterations needed.
   */
  private async runSlowCycleIteration(cycle: Set<Action>): Promise<boolean> {
    // Find dirty members of the cycle
    const dirtyMembers = [...cycle].filter((action) => this.dirty.has(action));

    if (dirtyMembers.length === 0) {
      // Cycle has converged
      return true;
    }

    // Update slow cycle state for tracking
    for (const action of cycle) {
      const state = this.slowCycleState.get(action);
      if (state) {
        state.iteration++;
        state.lastYield = performance.now();

        // Check if we've exceeded max iterations
        if (state.iteration > MAX_CYCLE_ITERATIONS) {
          this.handleError(
            new Error(
              `Slow cycle did not converge after ${MAX_CYCLE_ITERATIONS} iterations`,
            ),
            action,
          );
          // Clean up state
          for (const member of cycle) {
            this.slowCycleState.delete(member);
            this.dirty.delete(member);
          }
          return true; // Stop iterating
        }
      } else {
        this.slowCycleState.set(action, {
          iteration: 1,
          lastYield: performance.now(),
        });
      }
    }

    // Sort dirty members topologically within the cycle
    const sorted = topologicalSort(
      new Set(dirtyMembers),
      this.dependencies,
      this.mightWrite,
      this.actionParent,
    );

    // Run one iteration of dirty members
    for (const action of sorted) {
      if (!this.dirty.has(action)) continue;

      this.dirty.delete(action);
      this.pending.delete(action);
      this.unsubscribe(action);
      await this.run(action);
    }

    // Check if cycle converged after this iteration
    const stillDirty = [...cycle].some((action) => this.dirty.has(action));
    if (!stillDirty) {
      // Clean up state on convergence
      for (const action of cycle) {
        this.slowCycleState.delete(action);
      }
      logger.debug("schedule-cycle", () => [
        `[CYCLE] Slow cycle converged`,
      ]);
      return true;
    }

    // Re-queue effects from the cycle for next iteration
    for (const action of cycle) {
      if (this.dirty.has(action) && this.effects.has(action)) {
        this.pending.add(action);
      }
    }

    // Schedule affected effects for the next iteration
    for (const action of cycle) {
      if (this.dirty.has(action)) {
        this.scheduleAffectedEffects(action);
      }
    }

    return false;
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
   */
  private recordActionTime(action: Action, elapsed: number): void {
    const now = performance.now();
    const existing = this.actionStats.get(action);
    if (existing) {
      existing.runCount++;
      existing.totalTime += elapsed;
      existing.averageTime = existing.totalTime / existing.runCount;
      existing.lastRunTime = elapsed;
      existing.lastRunTimestamp = now;
    } else {
      this.actionStats.set(action, {
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
   */
  getActionStats(action: Action): ActionStats | undefined {
    return this.actionStats.get(action);
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
   * When enabled, slow actions (> 50ms avg after 3 runs) will automatically get debounced.
   */
  setAutoDebounce(action: Action, enabled: boolean): void {
    if (enabled) {
      this.autoDebounceEnabled.set(action, true);
    } else {
      this.autoDebounceEnabled.delete(action);
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
      this.pending.add(action);
      this.queueExecution();
    }, debounceMs);

    this.debounceTimers.set(action, timer);

    logger.debug("schedule-debounce", () => [
      `[DEBOUNCE] Action ${
        action.name || "anonymous"
      } debounced for ${debounceMs}ms`,
    ]);
  }

  /**
   * Checks if an action should be auto-debounced based on its performance stats.
   * Called after recording action time to potentially enable debouncing for slow actions.
   */
  private maybeAutoDebounce(action: Action): void {
    // Check if auto-debounce is enabled for this action
    if (!this.autoDebounceEnabled.get(action)) return;

    // Check if already has a manual debounce set
    if (this.actionDebounce.has(action)) return;

    const stats = this.actionStats.get(action);
    if (!stats) return;

    // Need minimum runs before auto-detecting
    if (stats.runCount < AUTO_DEBOUNCE_MIN_RUNS) return;

    // Check if action is slow enough to warrant debouncing
    if (stats.averageTime >= AUTO_DEBOUNCE_THRESHOLD_MS) {
      this.actionDebounce.set(action, AUTO_DEBOUNCE_DELAY_MS);
      logger.debug("schedule-debounce", () => [
        `[AUTO-DEBOUNCE] Action ${action.name || "anonymous"} ` +
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

    const stats = this.actionStats.get(action);
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
    const { charmId, spellId, recipeId, space } = getCharmMetadataFromFrame(
      (error as Error & { frame?: Frame }).frame,
    );

    const errorWithContext = error as ErrorWithContext;
    errorWithContext.action = action;
    if (charmId) errorWithContext.charmId = charmId;
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
    }
  }

  private async execute(): Promise<void> {
    // In case a directly invoked `run` is still running, wait for it to finish.
    if (this.runningPromise) await this.runningPromise;

    // Process pending dependency collection for newly subscribed actions.
    // This discovers what cells each action will read before it runs.
    for (const action of this.pendingDependencyCollection) {
      const populateDependencies = this.populateDependenciesCallbacks.get(
        action,
      );
      if (populateDependencies) {
        // Create a transaction to capture reads
        const depTx = this.runtime.edit();
        try {
          populateDependencies(depTx);
        } catch (error) {
          // If populateDependencies fails, log and continue
          // The action will still run and discover its real dependencies
          logger.debug("schedule", () => [
            `[DEP-COLLECT] Error populating dependencies for ${
              action.name || "anonymous"
            }: ${error}`,
          ]);
        }
        const log = txToReactivityLog(depTx);
        // Abort the transaction - we only wanted to capture reads
        depTx.abort();

        // Set up dependencies and update reverse dependency graph
        const reads = this.setDependencies(action, log);
        this.updateDependents(action, log);

        // Set up triggers so this action gets notified when its dependencies change
        // This is the same logic as in resubscribe() - we need triggers for storage
        // notifications to mark this action as dirty when inputs change.
        const pathsByEntity = addressesToPathByEntity(reads);
        const entities = new Set<SpaceAndURI>();

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
        }

        // Set up cancel function to clean up triggers
        this.cancels.set(action, () => {
          for (const spaceAndURI of entities) {
            this.triggers.get(spaceAndURI)?.delete(action);
          }
        });

        logger.debug("schedule", () => [
          `[DEP-COLLECT] Collected dependencies for ${
            action.name || "anonymous"
          }: ${log.reads.length} reads, ${log.writes.length} writes, ${entities.size} entities`,
        ]);
      }
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
    const newActionsWithoutDependencies = [...this.pendingDependencyCollection]
      .filter(
        (action) =>
          !this.dependencies.get(action)?.writes.length &&
          !this.effects.has(action),
      );

    // Clear the pending collection set - dependencies have been collected
    this.pendingDependencyCollection.clear();

    // Track dirty dependencies that block events - these must be added to workSet
    const eventBlockingDeps = new Set<Action>();

    // Process next event from the event queue.
    const queuedEvent = this.eventQueue.shift();
    if (queuedEvent) {
      const { action, handler, event: eventValue, retriesLeft, onCommit } =
        queuedEvent;
      this.runtime.telemetry.submit({
        type: "scheduler.invocation",
        handler: action,
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
                if (write.space === read.space && write.id === read.id) {
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
                `Action ${action.name || "anonymous"} completed in ${
                  duration.toFixed(3)
                }s`,
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

    // Process any newly subscribed actions that were added during event handling.
    // This handles cases like event handlers that create sub-recipes whose
    // computations need their dependencies discovered before we build the workSet.
    if (this.pendingDependencyCollection.size > 0) {
      for (const action of this.pendingDependencyCollection) {
        const populateDependencies = this.populateDependenciesCallbacks.get(
          action,
        );
        if (populateDependencies) {
          const depTx = this.runtime.edit();
          try {
            populateDependencies(depTx);
          } catch (error) {
            logger.debug("schedule", () => [
              `[DEP-COLLECT-POST-EVENT] Error populating dependencies for ${
                action.name || "anonymous"
              }: ${error}`,
            ]);
          }
          const log = txToReactivityLog(depTx);
          depTx.abort();

          const reads = this.setDependencies(action, log);
          this.updateDependents(action, log);

          // Set up triggers
          const pathsByEntity = addressesToPathByEntity(reads);
          const entities = new Set<SpaceAndURI>();

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
          }

          this.cancels.set(action, () => {
            for (const spaceAndURI of entities) {
              this.triggers.get(spaceAndURI)?.delete(action);
            }
          });

          logger.debug("schedule", () => [
            `[DEP-COLLECT-POST-EVENT] Collected dependencies for ${
              action.name || "anonymous"
            }`,
          ]);
        }
      }
      this.pendingDependencyCollection.clear();
    }

    // Build the work set based on scheduling mode
    let workSet: Set<Action>;

    if (this.pullMode) {
      // Pull mode: collect pending effects + their dirty computation dependencies
      workSet = new Set<Action>();

      // Add only pending effects (not computations) to workSet
      for (const action of this.pending) {
        if (this.effects.has(action)) {
          workSet.add(action);
        }
      }

      // Add any actions that need to write to capture possible writes
      for (const action of newActionsWithoutDependencies) {
        workSet.add(action);
      }

      // Add computations that are blocking deferred events
      for (const action of eventBlockingDeps) {
        workSet.add(action);
      }

      // Find all dirty computations that the effects depend on (transitively)
      for (const action of workSet) {
        this.collectDirtyDependencies(action, workSet);
      }

      logger.debug("schedule", () => [
        `[EXECUTE PULL MODE] Effects: ${this.pending.size}, Dirty deps added: ${
          workSet.size - this.pending.size
        }`,
      ]);

      // Detect and handle cycles in the work set
      const cycles = this.detectCycles(workSet);
      if (cycles.length > 0) {
        logger.debug("schedule-cycle", () => [
          `[EXECUTE] Detected ${cycles.length} cycles in work set`,
        ]);

        // Track which actions are part of cycles (to exclude from normal execution)
        const cycleActions = new Set<Action>();
        for (const cycle of cycles) {
          for (const action of cycle) {
            cycleActions.add(action);
          }
        }

        // Handle each cycle
        for (const cycle of cycles) {
          if (this.isFastCycle(cycle)) {
            // Fast cycle: converge completely before continuing
            logger.debug("schedule-cycle", () => [
              `[EXECUTE] Running fast cycle convergence (${cycle.size} members)`,
            ]);
            await this.convergeFastCycle(cycle);
          } else {
            // Slow cycle: run one iteration and yield
            logger.debug("schedule-cycle", () => [
              `[EXECUTE] Running slow cycle iteration (${cycle.size} members)`,
            ]);
            await this.runSlowCycleIteration(cycle);
          }
        }

        // Remove cycle actions from the work set (they've been handled)
        for (const action of cycleActions) {
          workSet.delete(action);
        }
      }
    } else {
      // Push mode: as-is - work set is just the pending actions
      workSet = this.pending;
    }

    const order = topologicalSort(
      workSet,
      this.dependencies,
      this.mightWrite,
      this.actionParent,
    );

    logger.debug("schedule", () => [
      `[EXECUTE] Running ${order.length} actions`,
    ]);

    // Now run all functions. This will resubscribe actions with their new
    // dependencies.
    for (const fn of order) {
      // Check if action is still valid (not unsubscribed since added)
      // In pull mode, check both pending (effects) and dirty (computations)
      const isInPending = this.pending.has(fn);
      const isInDirty = this.dirty.has(fn);

      if (this.pullMode) {
        // In pull mode: action must be in pending (effect) or dirty (computation)
        if (!isInPending && !isInDirty) continue;
      } else {
        // Push mode: action must be in pending
        if (!isInPending) continue;
      }

      // Check throttle: skip recently-run actions but keep them dirty
      // They'll be pulled next time an effect needs them (if throttle expired)
      if (this.isThrottled(fn)) {
        logger.debug("schedule-throttle", () => [
          `[THROTTLE] Skipping throttled action: ${fn.name || "anonymous"}`,
        ]);
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
      if (this.loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN) {
        this.handleError(
          new Error(
            `Too many iterations: ${this.loopCounter.get(fn)} ${fn.name ?? ""}`,
          ),
          fn,
        );
      } else {
        await this.run(fn);
      }
    }

    // In pull mode, process any newly subscribed actions and check if they
    // affect the effects we just ran. This handles dynamic sub-recipes created
    // during execution (e.g., lift nodes that return opaque refs).
    if (this.pullMode && this.pendingDependencyCollection.size > 0) {
      // Process dependency collection for new subscriptions
      for (const action of this.pendingDependencyCollection) {
        const populateDependencies = this.populateDependenciesCallbacks.get(
          action,
        );
        if (populateDependencies) {
          const depTx = this.runtime.edit();
          try {
            populateDependencies(depTx);
          } catch (error) {
            logger.debug("schedule", () => [
              `[DEP-COLLECT-POST-EXEC] Error: ${error}`,
            ]);
          }
          const log = txToReactivityLog(depTx);
          depTx.abort();

          // Set up dependencies and mightWrite
          this.setDependencies(action, log);
          this.updateDependents(action, log);

          // Set up triggers
          const reads = log.reads;
          const pathsByEntity = addressesToPathByEntity(reads);
          const entities = new Set<SpaceAndURI>();

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
          }

          this.cancels.set(action, () => {
            for (const spaceAndURI of entities) {
              this.triggers.get(spaceAndURI)?.delete(action);
            }
          });
        }
      }
      this.pendingDependencyCollection.clear();

      // Now re-run collectDirtyDependencies for effects to find the new computations
      const additionalWork = new Set<Action>();
      for (const effect of this.effects) {
        if (this.dependencies.has(effect)) {
          this.collectDirtyDependencies(effect, additionalWork);
        }
      }

      // If we found new work, execute it
      if (additionalWork.size > 0) {
        const additionalOrder = topologicalSort(
          additionalWork,
          this.dependencies,
          this.mightWrite,
          this.actionParent,
        );

        // Track actions that already ran in the main loop
        const alreadyRunThisCycle = new Set(order);

        for (const fn of additionalOrder) {
          if (!this.dirty.has(fn)) continue;
          if (alreadyRunThisCycle.has(fn)) continue;

          this.pending.delete(fn);
          this.clearDirty(fn);
          this.unsubscribe(fn);

          this.filterStats.executed++;
          await this.run(fn);
        }

        // After POST-LOOP, clear dirty flags for any computations that already
        // ran in the main loop but got re-dirtied by POST-LOOP storage writes.
        // This prevents cascading re-runs - the main loop computations have
        // already produced their outputs, so they don't need to run again.
        for (const fn of alreadyRunThisCycle) {
          if (this.dirty.has(fn) && !this.effects.has(fn)) {
            this.clearDirty(fn);
          }
        }
      }
    }

    // In pull mode, we consider ourselves done when there are no effects to execute
    // (pending computations won't run without an effect pulling them)
    const effectivePendingSize = this.pullMode
      ? [...this.pending].filter((a) => this.effects.has(a)).length
      : this.pending.size;

    if (effectivePendingSize === 0 && this.eventQueue.length === 0) {
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
    // Use mightWrite if available (includes declared writes even if first run writes undefined)
    const writes = mightWrite.get(actionA) ?? log.writes;
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
      // Handle cycle: choose an unvisited node with the lowest in-degree
      const unvisitedAction = Array.from(actions)
        .filter((action) => !visited.has(action))
        .reduce((a, b) => (inDegree.get(a)! < inDegree.get(b)! ? a : b));
      queue.push(unvisitedAction);
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

function getCharmMetadataFromFrame(frame?: Frame): {
  spellId?: string;
  recipeId?: string;
  space?: string;
  charmId?: string;
} {
  // TODO(seefeld): This is a rather hacky way to get the context, based on the
  // unsafe_binding pattern. Once we replace that mechanism, let's add nicer
  // abstractions for context here as well.
  frame ??= getTopFrame();

  const sourceAsProxy = frame?.unsafe_binding?.materialize([]);

  if (!isCellResultForDereferencing(sourceAsProxy)) {
    return {};
  }
  const result: ReturnType<typeof getCharmMetadataFromFrame> = {};
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
  result.charmId = JSON.parse(
    JSON.stringify(resultCell?.entityId ?? {}),
  )["/"];
  return result;
}

function queueTask(fn: () => void): void {
  setTimeout(fn, 0);
}
