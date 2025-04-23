import type { DocImpl } from "./doc.ts";
import type { Cancel } from "./cancel.ts";
import { type CellLink } from "./cell.ts";
import { getTopFrame, TYPE } from "@commontools/builder";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";
import { runtime } from "./runtime/index.ts";
import { ConsoleEvent, ConsoleMethod } from "./runtime/console.ts";

export type Action = (log: ReactivityLog) => any;
export type EventHandler = (event: any) => any;

const pending = new Set<Action>();
const eventQueue: (() => void)[] = [];
const eventHandlers: [CellLink, EventHandler][] = [];
const dirty = new Set<DocImpl<any>>();
const dependencies = new WeakMap<Action, ReactivityLog>();
const cancels = new WeakMap<Action, Cancel[]>();
const idlePromises: (() => void)[] = [];
let loopCounter = new WeakMap<Action, number>();
const errorHandlers = new Set<
  ((error: Error) => void) | ((error: ErrorWithContext) => void)
>();
let consoleHandler = function (
  _metadata: ReturnType<typeof getCharmMetadataFromFrame>,
  _method: ConsoleMethod,
  args: any[],
): any[] {
  // Default console handler returns arguments unaffected.
  // Call `onConsole` to override default handler.
  return args;
};
let running: Promise<void> | undefined = undefined;
let scheduled = false;

const MAX_ITERATIONS_PER_RUN = 100;

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

export function schedule(action: Action, log: ReactivityLog): Cancel {
  const reads = setDependencies(action, log);
  reads.forEach(({ cell: doc }) => dirty.add(doc));

  queueExecution();
  pending.add(action);

  return () => unschedule(action);
}

export function unschedule(fn: Action): void {
  cancels.get(fn)?.forEach((cancel) => cancel());
  cancels.delete(fn);
  dependencies.delete(fn);
  pending.delete(fn);
}

export function subscribe(action: Action, log: ReactivityLog): Cancel {
  const reads = setDependencies(action, log);

  cancels.set(
    action,
    reads.map(({ cell: doc, path }) =>
      doc.updates((_newValue, changedPath) => {
        if (pathAffected(changedPath, path)) {
          dirty.add(doc);
          queueExecution();
          pending.add(action);
        }
      })
    ),
  );

  return () => unschedule(action);
}

// Like schedule, but runs the action immediately to gather dependencies
export async function run(action: Action): Promise<any> {
  const log: ReactivityLog = { reads: [], writes: [] };

  if (running) await running;

  let result: any;
  running = new Promise((resolve) => {
    const finalizeAction = (error?: unknown) => {
      // handlerError() might throw, so let's make sure to resolve the promise.
      try {
        if (error) {
          if (error instanceof Error) handleError(error, action);
        }
      } finally {
        // Note: By adding the listeners after the call we avoid triggering a
        // re-run of the action if it changed a r/w doc. Note that this also
        // means that those actions can't loop on themselves.
        subscribe(action, log);
        running = undefined;
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

  return running;
}

export function idle() {
  return new Promise<void>((resolve) => {
    if (running) running.then(() => idle().then(resolve));
    else if (pending.size === 0 && eventQueue.length === 0) resolve();
    else idlePromises.push(resolve);
  });
}

export function onError(
  fn: ((error: Error) => void) | ((error: ErrorWithContext) => void),
) {
  errorHandlers.add(fn);
}

// Replace the default console hook with a function that accepts context metadata,
// console method name and the arguments.
export function onConsole(
  fn: (
    metadata: ReturnType<typeof getCharmMetadataFromFrame>,
    method: ConsoleMethod,
    args: any[],
  ) => any[],
) {
  consoleHandler = fn;
}

runtime.addEventListener("console", (e: Event) => {
  // Called synchronously when `console` methods are
  // called within the runtime.
  const { method, args } = e as ConsoleEvent;
  const metadata = getCharmMetadataFromFrame();
  const result = consoleHandler(metadata, method, args);
  console[method].apply(console, result);
});

export function queueEvent(eventRef: CellLink, event: any) {
  for (const [ref, handler] of eventHandlers) {
    if (
      ref.cell === eventRef.cell &&
      ref.path.length === eventRef.path.length &&
      ref.path.every((p, i) => p === eventRef.path[i])
    ) {
      queueExecution();
      eventQueue.push(() => handler(event));
    }
  }
}

export function addEventHandler(handler: EventHandler, ref: CellLink): Cancel {
  eventHandlers.push([ref, handler]);
  return () => {
    const index = eventHandlers.findIndex(([r, h]) =>
      r === ref && h === handler
    );
    if (index !== -1) eventHandlers.splice(index, 1);
  };
}

function queueExecution() {
  if (scheduled) return;
  queueMicrotask(execute);
  scheduled = true;
}

function setDependencies(action: Action, log: ReactivityLog) {
  const reads = compactifyPaths(log.reads);
  const writes = compactifyPaths(log.writes);
  dependencies.set(action, { reads, writes });
  return reads;
}

export type ErrorWithContext = Error & {
  action: Action;
  charmId: string;
  space: string;
  recipeId: string;
};

export function isErrorWithContext(error: unknown): error is ErrorWithContext {
  return error instanceof Error && "action" in error && "charmId" in error &&
    "space" in error && "recipeId" in error;
}

function handleError(error: Error, action: any) {
  // Since most errors come from `eval`ed code, let's fix the stack trace.
  if (error.stack) error.stack = runtime.mapStackTrace(error.stack);

  const { charmId, recipeId, space } = getCharmMetadataFromFrame() ?? {};

  const errorWithContext = error as ErrorWithContext;
  errorWithContext.action = action;
  if (charmId) errorWithContext.charmId = charmId;
  if (recipeId) errorWithContext.recipeId = recipeId;
  if (space) errorWithContext.space = space;

  console.error("caught error", errorWithContext);
  for (const handler of errorHandlers) handler(errorWithContext);
}

async function execute() {
  // In case a directly invoked `run` is still running, wait for it to finish.
  if (running) await running;

  // Process next event from the event queue. Will mark more docs as dirty.
  const handler = eventQueue.shift();
  if (handler) {
    try {
      running = Promise.resolve(handler()).catch((error) => {
        handleError(error as Error, handler);
      });
      await running;
    } catch (error) {
      handleError(error as Error, handler);
    } finally {
      running = undefined;
    }
  }

  const order = topologicalSort(pending, dependencies, dirty);

  // Clear pending and dirty sets, and cancel all listeners for docs on already
  // scheduled actions.
  pending.clear();
  dirty.clear();
  for (const fn of order) cancels.get(fn)?.forEach((cancel) => cancel());

  // Now run all functions. This will create new listeners to mark docs dirty
  // and schedule the next run.
  for (const fn of order) {
    loopCounter.set(fn, (loopCounter.get(fn) || 0) + 1);
    if (loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN) {
      handleError(
        new Error(
          `Too many iterations: ${loopCounter.get(fn)} ${fn.name ?? ""}`,
        ),
        fn,
      );
    } else await run(fn);
  }

  if (pending.size === 0 && eventQueue.length === 0) {
    const promises = idlePromises;
    for (const resolve of promises) resolve();
    idlePromises.length = 0;

    loopCounter = new WeakMap();

    scheduled = false;
  } else {
    queueMicrotask(execute);
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
    for (const write of writes) {
      for (const actionB of relevantActions) {
        if (actionA !== actionB) {
          const { reads } = dependencies.get(actionB)!;
          if (
            reads.some(({ cell, path }) =>
              cell === write.cell && pathAffected(write.path, path)
            )
          ) {
            graph.get(actionA)!.add(actionB);
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
