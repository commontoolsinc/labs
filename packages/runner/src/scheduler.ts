import type { DocImpl } from "./doc.ts";
import type { Cancel } from "./cancel.ts";
import { type CellLink } from "./cell.ts";
import { getTopFrame, TYPE } from "@commontools/builder";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { ConsoleEvent, ConsoleMethod } from "./harness/console.ts";
import type {
  CharmMetadata,
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  IRuntime,
  IScheduler,
} from "./runtime.ts";

// Re-export types that tests expect from scheduler
export type { ErrorWithContext };

export type Action = (log: ReactivityLog) => any;
export type EventHandler = (event: any) => any;

export type ReactivityLog = {
  reads: CellLink[];
  writes: CellLink[];
};

const MAX_ITERATIONS_PER_RUN = 100;

function pathAffected(
  changedPath: PropertyKey[],
  subscribedPath: PropertyKey[],
): boolean {
  // If changedPath is shorter than subscribedPath, check if changedPath is a prefix
  if (changedPath.length <= subscribedPath.length) {
    return changedPath.every((segment, i) => subscribedPath[i] === segment);
  }
  // If changedPath is longer, check if subscribedPath is a prefix of changedPath
  return subscribedPath.every((segment, i) => changedPath[i] === segment);
}

export function compactifyPaths(links: CellLink[]): CellLink[] {
  const compacted: CellLink[] = [];

  for (const link of links) {
    // Check if any existing compacted link covers this link
    const isCovered = compacted.some((c) =>
      c.cell === link.cell &&
      link.path.length >= c.path.length &&
      c.path.every((segment, i) => link.path[i] === segment)
    );

    if (!isCovered) {
      // Remove any existing links that this link covers
      for (let i = compacted.length - 1; i >= 0; i--) {
        const existing = compacted[i];
        if (
          existing.cell === link.cell &&
          existing.path.length >= link.path.length &&
          link.path.every((segment, j) => existing.path[j] === segment)
        ) {
          compacted.splice(i, 1);
        }
      }

      compacted.push(link);
    }
  }

  return compacted;
}

function getCharmMetadataFromFrame(): {
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
  const { cell: source } = getCellLinkOrThrow(sourceAsProxy);
  result.recipeId = source?.get()?.[TYPE];
  const resultDoc = source?.get()?.resultRef?.cell;
  result.space = resultDoc?.space;
  result.charmId = JSON.parse(
    JSON.stringify(resultDoc?.entityId ?? {}),
  )["/"];
  return result;
}

export class Scheduler implements IScheduler {
  private pending = new Set<Action>();
  private eventQueue: (() => void)[] = [];
  private eventHandlers: [CellLink, EventHandler][] = [];
  private dirty = new Set<DocImpl<any>>();
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private cancels = new WeakMap<Action, Cancel[]>();
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
    reads.forEach(({ cell: doc }) => this.dirty.add(doc));

    this.queueExecution();
    this.pending.add(action);

    return () => this.unschedule(action);
  }

  unschedule(action: Action): void {
    this.cancels.get(action)?.forEach((cancel) => cancel());
    this.cancels.delete(action);
    this.dependencies.delete(action);
    this.pending.delete(action);
  }

  subscribe(action: Action, log: ReactivityLog): Cancel {
    const reads = this.setDependencies(action, log);

    this.cancels.set(
      action,
      reads.map(({ cell: doc, path }) =>
        doc.updates((_newValue: any, changedPath: PropertyKey[]) => {
          if (pathAffected(changedPath, path)) {
            this.dirty.add(doc);
            this.queueExecution();
            this.pending.add(action);
          }
        })
      ),
    );

    return () => this.unschedule(action);
  }

  async run(action: Action): Promise<any> {
    const log: ReactivityLog = { reads: [], writes: [] };

    if (this.runningPromise) await this.runningPromise;

    let result: any;
    this.runningPromise = new Promise((resolve) => {
      const finalizeAction = (error?: unknown) => {
        try {
          if (error) this.handleError(error as Error, action);
        } finally {
          // Set up reactive subscriptions after the action runs
          // This matches the original scheduler behavior
          this.subscribe(action, log);
          resolve(result);
        }
      };

      try {
        Promise.resolve(action(log))
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

  addAction(action: Action): void {
    this.pending.add(action);
    this.queueExecution();
  }

  removeAction(action: Action): void {
    this.unschedule(action);
  }

  idle(): Promise<void> {
    return new Promise<void>((resolve) => {
      // NOTE: This relies on the finally clause to set runningPromise to undefined to
      // prevent infinite loops.
      if (this.runningPromise) {
        this.runningPromise.then(() => this.idle().then(resolve));
      } // Once nothing is running, see if more work is queued up. If not, then
      // resolve the idle promise, otherwise add it to the idle promises list that
      // will be resolved once all the work is done.
      else if (this.pending.size === 0 && this.eventQueue.length === 0) {
        resolve();
      } else {
        this.idlePromises.push(resolve);
      }
    });
  }

  queueEvent(eventRef: CellLink, event: any): void {
    for (const [ref, handler] of this.eventHandlers) {
      if (
        ref.cell === eventRef.cell &&
        ref.path.length === eventRef.path.length &&
        ref.path.every((p, i) => p === eventRef.path[i])
      ) {
        this.queueExecution();
        this.eventQueue.push(() => handler(event));
      }
    }
  }

  addEventHandler(handler: EventHandler, ref: CellLink): Cancel {
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

  private queueExecution(): void {
    if (this.scheduled) return;
    queueMicrotask(() => this.execute());
    this.scheduled = true;
  }

  private setDependencies(action: Action, log: ReactivityLog): CellLink[] {
    const reads = compactifyPaths(log.reads);
    const writes = compactifyPaths(log.writes);
    this.dependencies.set(action, { reads, writes });
    return reads;
  }

  private handleError(error: Error, action: any): void {
    if (error.stack) {
      error.stack = this.runtime.harness.mapStackTrace(error.stack);
    }

    const metadata = getCharmMetadataFromFrame();
    const errorWithContext: ErrorWithContext = Object.assign(error, {
      action,
      charmId: metadata?.charmId || "unknown",
      space: metadata?.space || "unknown",
      recipeId: metadata?.recipeId || "unknown",
    });

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
      try {
        this.runningPromise = Promise.resolve(handler()).catch((error) => {
          this.handleError(error as Error, handler);
        });
        await this.runningPromise;
      } catch (error) {
        this.handleError(error as Error, handler);
      }
    }

    const order = this.topologicalSort(
      this.pending,
      this.dependencies,
      this.dirty,
    );

    // Clear pending and dirty sets, and cancel all listeners for docs on already
    // scheduled actions.
    this.pending.clear();
    this.dirty.clear();
    for (const fn of order) {
      this.cancels.get(fn)?.forEach((cancel) => cancel());
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

  private topologicalSort(
    actions: Set<Action>,
    dependencies: WeakMap<Action, ReactivityLog>,
    dirty: Set<DocImpl<any>>,
  ): Action[] {
    const relevantActions = new Set<Action>();
    const graph = new Map<Action, Set<Action>>();
    const inDegree = new Map<Action, number>();

    for (const action of actions) {
      const { reads } = dependencies.get(action)!;
      if (reads.length === 0) {
        // An action with no reads can be manually added to `pending`, which happens only once on `schedule`.
        relevantActions.add(action);
      } else if (reads.some(({ cell: doc }) => dirty.has(doc))) {
        relevantActions.add(action);
      }
    }

    for (const action of relevantActions) {
      graph.set(action, new Set());
      inDegree.set(action, 0);
    }

    for (const actionA of relevantActions) {
      const depsA = dependencies.get(actionA)!;
      for (const actionB of relevantActions) {
        if (actionA === actionB) continue;
        const depsB = dependencies.get(actionB)!;

        const hasConflict = depsA.writes.some((writeLink) =>
          depsB.reads.some((readLink) =>
            writeLink.cell === readLink.cell &&
            (writeLink.path.length <= readLink.path.length
              ? writeLink.path.every((segment, i) =>
                readLink.path[i] === segment
              )
              : readLink.path.every((segment, i) =>
                writeLink.path[i] === segment
              ))
          )
        );

        if (hasConflict) {
          graph.get(actionA)!.add(actionB);
          inDegree.set(actionB, inDegree.get(actionB)! + 1);
        }
      }
    }

    const queue: Action[] = [];
    for (const [action, degree] of inDegree) {
      if (degree === 0) queue.push(action);
    }

    const result: Action[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      for (const neighbor of graph.get(current)!) {
        const newDegree = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    return result;
  }
}

// Singleton wrapper functions removed to eliminate singleton pattern
// Use runtime.scheduler methods directly instead
