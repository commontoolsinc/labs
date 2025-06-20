import { getTopFrame } from "./builder/recipe.ts";
import { TYPE } from "./builder/types.ts";
import type { DocImpl } from "./doc.ts";
import type { Cancel } from "./cancel.ts";
import { type CellLink } from "./sigil-types.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { ConsoleEvent } from "./harness/console.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  IRuntime,
  IScheduler,
  MemorySpace,
} from "./runtime.ts";

// Re-export types that tests expect from scheduler
export type { ErrorWithContext };

export type Action = (log: ReactivityLog) => any;
export type EventHandler = (event: any) => any;

/**
 * Reactivity log.
 *
 * Used to log reads and writes to docs. Used by scheduler to keep track of
 * dependencies and to topologically sort pending actions before executing them.
 */
export type ReactivityLog = {
  reads: CellLink[];
  writes: CellLink[];
};

const MAX_ITERATIONS_PER_RUN = 100;

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

  private handleError(error: Error, action: any) {
    // Since most errors come from `eval`ed code, let's fix the stack trace.
    if (error.stack) {
      error.stack = this.runtime.harness.mapStackTrace(error.stack);
    }

    const { charmId, recipeId, space } = getCharmMetadataFromFrame() ?? {};

    const errorWithContext = error as ErrorWithContext;
    errorWithContext.action = action;
    if (charmId) errorWithContext.charmId = charmId;
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
      try {
        this.runningPromise = Promise.resolve(handler()).catch((error) => {
          this.handleError(error as Error, handler);
        });
        await this.runningPromise;
      } catch (error) {
        this.handleError(error as Error, handler);
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
}

function topologicalSort(
  actions: Set<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
  dirty: Set<DocImpl<any>>,
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
    } else if (reads.some(({ cell: doc }) => dirty.has(doc))) {
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
                  ({ cell, path }) =>
                    cell === write.cell && pathAffected(write.path, path),
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
            reads.some(({ cell, path }) =>
              cell === write.cell && pathAffected(write.path, path)
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

// Remove longer paths already covered by shorter paths
export function compactifyPaths(entries: CellLink[]): CellLink[] {
  // First group by doc via a Map
  const docToPaths = new Map<DocImpl<any>, PropertyKey[][]>();
  for (const { cell: doc, path } of entries) {
    const paths = docToPaths.get(doc) || [];
    paths.push(path.map((key) => key.toString())); // Normalize to strings as keys
    docToPaths.set(doc, paths);
  }

  // For each cell, sort the paths by length, then only return those that don't
  // have a prefix earlier in the list
  const result: CellLink[] = [];
  for (const [doc, paths] of docToPaths.entries()) {
    paths.sort((a, b) => a.length - b.length);
    for (let i = 0; i < paths.length; i++) {
      const earlier = paths.slice(0, i);
      if (
        earlier.some((path) =>
          path.every((key, index) => key === paths[i][index])
        )
      ) {
        continue;
      }
      result.push({ cell: doc, path: paths[i] });
    }
  }
  return result;
}

function pathAffected(changedPath: PropertyKey[], path: PropertyKey[]) {
  changedPath = changedPath.map((key) => key.toString()); // Normalize to strings as keys
  return (
    (changedPath.length <= path.length &&
      changedPath.every((key, index) => key === path[index])) ||
    path.every((key, index) => key === changedPath[index])
  );
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
