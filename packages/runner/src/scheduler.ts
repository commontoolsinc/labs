import { getLogger } from "@commontools/utils/logger";
import type { MemorySpace, URI } from "@commontools/memory/interface";
import { getTopFrame } from "./builder/recipe.ts";
import { Module, Recipe, TYPE } from "./builder/types.ts";
import type { Cancel } from "./cancel.ts";
import {
  getCellOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { ConsoleEvent } from "./harness/console.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  IRuntime,
  IScheduler,
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

export class Scheduler implements IScheduler {
  private pending = new Set<Action>();
  private eventQueue: ((tx: IExtendedStorageTransaction) => any)[] = [];
  private eventHandlers: [NormalizedFullLink, EventHandler][] = [];
  private dirty = new Set<SpaceURIAndType>();
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private cancels = new WeakMap<Action, Cancel>();
  private triggers = new Map<SpaceAndURI, Map<Action, SortedAndCompactPaths>>();

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
    readonly runtime: IRuntime,
    consoleHandler?: ConsoleHandler,
    errorHandlers?: ErrorHandler[],
  ) {
    this.consoleHandler = consoleHandler ||
      function (_metadata, _method, args) {
        // Default console handler returns arguments unaffected.
        return args;
      };

    if (errorHandlers) {
      errorHandlers.forEach((handler) => this.errorHandlers.add(handler));
    }

    // Subscribe to storage notifications
    this.runtime.storage.subscribe(this.createStorageSubscription());

    // Set up harness event listeners
    this.runtime.harness.addEventListener("console", (e: Event) => {
      // Called synchronously when `console` methods are
      // called within the runtime.
      const { method, args } = e as ConsoleEvent;
      const metadata = getCharmMetadataFromFrame();
      const result = this.consoleHandler(metadata, method, args);
      console[method].apply(console, result);
    });
  }

  schedule(action: Action, log: ReactivityLog): Cancel {
    const reads = this.setDependencies(action, log);
    logger.debug(() => ["Scheduling action:", action, reads]);
    reads.forEach((addr) =>
      this.dirty.add(`${addr.space}/${addr.id}/${addr.type}`)
    );

    this.queueExecution();
    this.pending.add(action);

    return () => this.unschedule(action);
  }

  unschedule(action: Action): void {
    this.cancels.get(action)?.();
    this.cancels.delete(action);
    this.dependencies.delete(action);
    this.pending.delete(action);
  }

  subscribe(action: Action, log: ReactivityLog): Cancel {
    const reads = this.setDependencies(action, log);
    const pathsByEntity = addressesToPathByEntity(reads);

    logger.debug(() => [
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

      logger.debug(() => [
        `[SUBSCRIBE] Registered action for ${spaceAndURI}`,
        `Paths: ${pathsWithValues.map((p) => p.join("/")).join(", ")}`,
      ]);
    }

    this.cancels.set(action, () => {
      logger.debug(() => [
        `[UNSUBSCRIBE] Action: ${action.name || "anonymous"}`,
        `Entities: ${entities.size}`,
      ]);
      for (const spaceAndURI of entities) {
        this.triggers.get(spaceAndURI)?.delete(action);
      }
    });

    return () => this.unschedule(action);
  }

  async run(action: Action): Promise<any> {
    this.runtime.telemetry.submit({
      type: "scheduler.run",
      action,
    });

    logger.debug(() => [
      `[RUN] Starting action: ${action.name || "anonymous"}`,
    ]);

    if (this.runningPromise) await this.runningPromise;

    const tx = this.runtime.edit();

    let result: any;
    this.runningPromise = new Promise((resolve) => {
      const finalizeAction = (error?: unknown) => {
        try {
          if (error) {
            logger.error(() => [
              `[RUN] Action failed: ${action.name || "anonymous"}`,
              `Error: ${error}`,
            ]);
            this.handleError(error as Error, action);
          }
        } finally {
          // Set up reactive subscriptions after the action runs
          // This matches the original scheduler behavior
          tx.commit();
          const log = txToReactivityLog(tx);

          logger.debug(() => [
            `[RUN] Action completed: ${action.name || "anonymous"}`,
            `Reads: ${log.reads.length}`,
            `Writes: ${log.writes.length}`,
          ]);

          this.subscribe(action, log);
          resolve(result);
        }
      };

      try {
        Promise.resolve(action(tx))
          .then((actionResult) => {
            result = actionResult;
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
      else if (this.pending.size === 0 && this.eventQueue.length === 0) {
        resolve();
      } else {
        this.idlePromises.push(resolve);
      }
    });
  }

  queueEvent(eventLink: NormalizedFullLink, event: any): void {
    for (const [link, handler] of this.eventHandlers) {
      if (areNormalizedLinksSame(link, eventLink)) {
        this.queueExecution();
        this.eventQueue.push((tx: IExtendedStorageTransaction) =>
          handler(tx, event)
        );
      }
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
        logger.debug(() => [
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
            logger.debug(() => [
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
              logger.debug(() => [
                `[CHANGE ${changeIndex}] Skipping non-JSON type: ${change.address.type}`,
              ]);
              continue;
            }

            const spaceAndURI = `${space}/${change.address.id}` as SpaceAndURI;
            const paths = this.triggers.get(spaceAndURI);

            if (paths) {
              logger.debug(() => [
                `[CHANGE ${changeIndex}] Found ${paths.size} registered actions for ${spaceAndURI}`,
              ]);

              const triggeredActions = determineTriggeredActions(
                paths,
                change.before,
                change.after,
                change.address.path,
              );

              logger.debug(() => [
                `[CHANGE ${changeIndex}] Triggered ${triggeredActions.length} actions`,
              ]);

              for (const action of triggeredActions) {
                logger.debug(() => [
                  `[TRIGGERED] Action for ${spaceAndURI}/${
                    change.address.path.join("/")
                  }`,
                  `Action name: ${action.name || "anonymous"}`,
                ]);
                this.dirty.add(
                  `${spaceAndURI}/${change.address.type}` as SpaceURIAndType,
                );
                this.queueExecution();
                this.pending.add(action);
              }
            } else {
              logger.debug(() => [
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
    queueMicrotask(() => this.execute());
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

  private handleError(error: Error, action: any) {
    const { charmId, spellId, recipeId, space } = getCharmMetadataFromFrame() ??
      {};

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

    // Process next event from the event queue. Will mark more docs as dirty.
    const handler = this.eventQueue.shift();
    if (handler) {
      this.runtime.telemetry.submit({
        type: "scheduler.invocation",
        handler,
      });
      const finalize = (error?: unknown) => {
        try {
          if (error) this.handleError(error as Error, handler);
        } finally {
          tx.commit();
        }
      };
      const tx = this.runtime.edit();

      try {
        this.runningPromise = Promise.resolve(
          this.runtime.harness.invoke(() => handler(tx)),
        ).then(() => finalize()).catch((error) => finalize(error));
        await this.runningPromise;
      } catch (error) {
        finalize(error);
      }
    }

    const order = topologicalSort(
      this.pending,
      this.dependencies,
      this.dirty,
    );

    // Clear pending and dirty sets, and cancel all listeners for docs on already
    // scheduled actions.
    this.pending.clear();
    this.dirty.clear();

    logger.debug(() => [
      `[EXECUTE] Canceling subscriptions for ${order.length} actions before execution`,
    ]);

    for (const fn of order) {
      this.cancels.get(fn)?.();
    }

    // Now run all functions. This will create new listeners to mark docs dirty
    // and schedule the next run.
    for (const fn of order) {
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
      queueMicrotask(() => this.execute());
    }
  }
}

function topologicalSort(
  actions: Set<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
  dirty: Set<SpaceAndURI>,
): Action[] {
  const relevantActions = new Set<Action>();
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();

  // First pass: identify relevant actions
  for (const action of actions) {
    const { reads } = dependencies.get(action)!;
    // TODO(seefeld): Keep track of affected paths
    if (reads.length === 0) {
      // Actions with no dependencies are always relevant. Note that they must
      // be manually added to `pending`, which happens only once on `schedule`.
      relevantActions.add(action);
    } else if (
      reads.some((addr) => dirty.has(`${addr.space}/${addr.id}/${addr.type}`))
    ) {
      relevantActions.add(action);
    }
  }

  // Second pass: add downstream actions
  let size;
  do {
    size = relevantActions.size;
    for (const action of actions) {
      if (!relevantActions.has(action)) {
        const { writes } = dependencies.get(action)!;
        for (const write of writes) {
          if (
            Array.from(relevantActions).some((relevantAction) =>
              dependencies
                .get(relevantAction)!
                .reads.some(
                  (addr) =>
                    addr.space === write.space &&
                    addr.id === write.id &&
                    arraysOverlap(write.path, addr.path),
                )
            )
          ) {
            relevantActions.add(action);
            break;
          }
        }
      }
    }
  } while (relevantActions.size > size);

  // Initialize graph and inDegree for relevant actions
  for (const action of relevantActions) {
    graph.set(action, new Set());
    inDegree.set(action, 0);
  }

  // Build the graph
  for (const actionA of relevantActions) {
    const { writes } = dependencies.get(actionA)!;
    const graphA = graph.get(actionA)!;
    for (const write of writes) {
      for (const actionB of relevantActions) {
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

  while (queue.length > 0 || visited.size < relevantActions.size) {
    if (queue.length === 0) {
      // Handle cycle: choose an unvisited node with the lowest in-degree
      const unvisitedAction = Array.from(relevantActions)
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

function getCharmMetadataFromFrame(): {
  spellId?: string;
  recipeId?: string;
  space?: string;
  charmId?: string;
} | undefined {
  // TODO(seefeld): This is a rather hacky way to get the context, based on the
  // unsafe_binding pattern. Once we replace that mechanism, let's add nicer
  // abstractions for context here as well.
  const frame = getTopFrame();

  const sourceAsProxy = frame?.unsafe_binding?.materialize([]);

  if (!isQueryResultForDereferencing(sourceAsProxy)) {
    return;
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
