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
export type EventHandler = (tx: IExtendedStorageTransaction, event: any) => any;
export type AnnotatedEventHandler = EventHandler & TelemetryAnnotations;

/**
 * Reactivity log.
 *
 * Used to log reads and writes to docs. Used by scheduler to keep track of
 * dependencies and to topologically sort pending actions before executing them.
 */
export type ReactivityLog = {
  reads: IMemorySpaceAddress[];
  writes: IMemorySpaceAddress[];
};

const ignoreReadForSchedulingMarker: unique symbol = Symbol(
  "ignoreReadForSchedulingMarker",
);

export const ignoreReadForScheduling: Metadata = {
  [ignoreReadForSchedulingMarker]: true,
};

export type SpaceAndURI = `${MemorySpace}/${URI}`;
export type SpaceURIAndType = `${MemorySpace}/${URI}/${MediaType}`;

const MAX_ITERATIONS_PER_RUN = 100;
const DEFAULT_RETRIES_FOR_EVENTS = 5;
const MAX_RETRIES_FOR_REACTIVE = 10;

export class Scheduler {
  private eventQueue: {
    action: Action;
    retriesLeft: number;
    onCommit?: (tx: IExtendedStorageTransaction) => void;
  }[] = [];
  private eventHandlers: [NormalizedFullLink, EventHandler][] = [];

  private pending = new Set<Action>();
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private cancels = new WeakMap<Action, Cancel>();
  private triggers = new Map<SpaceAndURI, Map<Action, SortedAndCompactPaths>>();
  private retries = new WeakMap<Action, number>();

  // Phase 1: Effect/computation tracking for pull-based scheduling
  private effects = new Set<Action>();
  private computations = new Set<Action>();
  private dependents = new WeakMap<Action, Set<Action>>();
  // Track which actions are effects persistently (survives unsubscribe/re-subscribe)
  private isEffectAction = new WeakMap<Action, boolean>();

  // Phase 2: Pull-based scheduling
  private dirty = new Set<Action>();
  private pullMode = false;

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

  subscribe(
    action: Action,
    log: ReactivityLog,
    options: {
      scheduleImmediately?: boolean;
      isEffect?: boolean;
    } | boolean = {},
  ): Cancel {
    // Support legacy boolean signature for backwards compatibility
    const opts = typeof options === "boolean"
      ? { scheduleImmediately: options }
      : options;
    const { scheduleImmediately = false, isEffect = false } = opts;

    const reads = this.setDependencies(action, log);

    // Track action type for pull-based scheduling
    // Once an action is marked as an effect, it stays an effect (persists across re-subscriptions)
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

    // Update reverse dependency graph
    this.updateDependents(action, log);

    logger.debug(
      "schedule",
      () => ["Subscribing to action:", action, reads, scheduleImmediately, isEffect ? "effect" : "computation"],
    );

    if (scheduleImmediately) {
      this.queueExecution();
      this.pending.add(action);
    } else {
      const pathsByEntity = addressesToPathByEntity(reads);

      logger.debug("schedule", () => [
        `[SUBSCRIBE] Action: ${action.name || "anonymous"}`,
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
          `[SUBSCRIBE] Registered action for ${spaceAndURI}`,
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

    return () => this.unsubscribe(action);
  }

  unsubscribe(action: Action): void {
    this.cancels.get(action)?.();
    this.cancels.delete(action);
    this.dependencies.delete(action);
    this.pending.delete(action);
    // Clean up effect/computation tracking
    this.effects.delete(action);
    this.computations.delete(action);
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

    let result: any;
    this.runningPromise = new Promise((resolve) => {
      const finalizeAction = (error?: unknown) => {
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
                // Must re-subscribe to ensure dependencies are set before
                // topologicalSort runs in execute(). Use the log from below
                // which has the correct dependencies from the previous run.
                this.subscribe(action, log, true);
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
          ]);

          this.subscribe(action, log);
          resolve(result);
        }
      };

      try {
        const actionStartTime = performance.now();
        Promise.resolve(action(tx))
          .then((actionResult) => {
            result = actionResult;
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
          .catch((error) => finalizeAction(error));
      } catch (error) {
        finalizeAction(error);
      }
    });

    return this.runningPromise;
  }

  idle(): Promise<void> {
    return new Promise<void>((resolve) => {
      // NOTE: This relies on the finally clause to set runningPromise to
      // undefined to prevent infinite loops.
      if (this.runningPromise) {
        this.runningPromise.then(() => this.idle().then(resolve));
      } // Once nothing is running, see if more work is queued up. If not, then
      // resolve the idle promise, otherwise add it to the idle promises list
      // that will be resolved once all the work is done.
      // IMPORTANT: Also check !this.scheduled to wait for any queued macro task execution
      else if (
        this.pending.size === 0 && this.eventQueue.length === 0 &&
        !this.scheduled
      ) {
        resolve();
      } else {
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

  addEventHandler(handler: EventHandler, ref: NormalizedFullLink): Cancel {
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
                  `Type: ${this.effects.has(action) ? "effect" : "computation"}`,
                ]);

                if (this.pullMode) {
                  // Pull mode: only schedule effects, mark computations as dirty
                  if (this.effects.has(action)) {
                    this.queueExecution();
                    this.pending.add(action);
                  } else {
                    // Mark computation as dirty and schedule affected effects
                    this.markDirty(action);
                    this.scheduleAffectedEffects(action);
                  }
                } else {
                  // Push mode: existing behavior - schedule all triggered actions
                  this.queueExecution();
                  this.pending.add(action);
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

  private queueExecution(): void {
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
    return reads;
  }

  /**
   * Updates the reverse dependency graph (dependents map).
   * For each action that writes to paths this action reads, add this action as a dependent.
   */
  private updateDependents(action: Action, log: ReactivityLog): void {
    const reads = log.reads;

    // For each read of the new action, find other actions that write to it
    for (const read of reads) {
      // Check all registered actions (via triggers) for ones that write to this read
      for (const [_spaceAndURI, actionPaths] of this.triggers) {
        for (const [otherAction] of actionPaths) {
          if (otherAction === action) continue;

          const otherLog = this.dependencies.get(otherAction);
          if (!otherLog) continue;

          // Check if otherAction writes to this entity we're reading
          for (const write of otherLog.writes) {
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
            }
          }
        }
      }
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
  // Phase 2: Pull-based scheduling methods
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
   */
  private collectDirtyDependencies(action: Action, workSet: Set<Action>): void {
    const log = this.dependencies.get(action);
    if (!log) return;

    // Find dirty computations that write to entities this action reads
    for (const computation of this.dirty) {
      if (workSet.has(computation)) continue; // Already added
      if (computation === action) continue;

      const computationLog = this.dependencies.get(computation);
      if (!computationLog) continue;

      // Check if computation writes to something action reads (document-level match)
      let found = false;
      for (const write of computationLog.writes) {
        for (const read of log.reads) {
          if (write.space === read.space && write.id === read.id) {
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
      this.queueExecution();
      this.pending.add(effect);
    }
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

    // Process next event from the event queue.

    // TODO(seefeld): This should maybe run _after_ all pending actions, so it's
    // based on the newest state. OTOH, if it has no dependencies and changes
    // data, then this causes redundant runs. So really we should add this to
    // the topological sort in the right way.
    const event = this.eventQueue.shift();
    if (event) {
      const { action, retriesLeft, onCommit } = event;
      this.runtime.telemetry.submit({
        type: "scheduler.invocation",
        handler: action,
      });
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
    }

    // Build the work set based on scheduling mode
    let workSet: Set<Action>;

    if (this.pullMode) {
      // Pull mode: collect pending effects + their dirty computation dependencies
      workSet = new Set<Action>();

      // Add all pending effects
      for (const effect of this.pending) {
        workSet.add(effect);
      }

      // Find all dirty computations that the effects depend on (transitively)
      for (const effect of this.pending) {
        this.collectDirtyDependencies(effect, workSet);
      }

      logger.debug("schedule", () => [
        `[EXECUTE PULL MODE] Effects: ${this.pending.size}, Dirty deps added: ${workSet.size - this.pending.size}`,
      ]);
    } else {
      // Push mode: as-is - work set is just the pending actions
      workSet = this.pending;
    }

    const order = topologicalSort(workSet, this.dependencies);

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

      // Clean up from pending/dirty before running
      this.pending.delete(fn);
      if (this.pullMode) {
        this.clearDirty(fn);
      }
      this.unsubscribe(fn);

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

    if (this.pending.size === 0 && this.eventQueue.length === 0) {
      const promises = this.idlePromises;
      for (const resolve of promises) resolve();
      this.idlePromises.length = 0;
      this.loopCounter = new WeakMap();
      this.scheduled = false;
    } else {
      // Keep scheduled = true since we're queuing another execution
      queueTask(() => this.execute());
    }
  }
}

function topologicalSort(
  actions: Set<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
): Action[] {
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();

  // Initialize graph and inDegree for relevant actions
  for (const action of actions) {
    graph.set(action, new Set());
    inDegree.set(action, 0);
  }

  // Build the graph
  for (const actionA of actions) {
    const { writes } = dependencies.get(actionA)!;
    const graphA = graph.get(actionA)!;
    for (const write of writes) {
      for (const actionB of actions) {
        if (actionA !== actionB && !graphA.has(actionB)) {
          const { reads } = dependencies.get(actionB)!;
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
      log.reads.push({
        space: activity.read.space,
        id: activity.read.id,
        type: activity.read.type,
        path: activity.read.path.slice(1), // Remove the "value" prefix
      });
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
