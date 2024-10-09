import { CellImpl, CellReference, ReactivityLog } from "./cell.js";
import { compactifyPaths, pathAffected } from "./utils.js";
import { type Cancel } from "./cancel.js";

export type Action = (log: ReactivityLog) => any;
export type EventHandler = (event: any) => any;

const pending = new Set<Action>();
const eventQueue: (() => void)[] = [];
const eventHandlers: [CellReference, EventHandler][] = [];
const dirty = new Set<CellImpl<any>>();
const dependencies = new WeakMap<Action, ReactivityLog>();
const cancels = new WeakMap<Action, Cancel[]>();
const idlePromises: (() => void)[] = [];
let loopCounter = new WeakMap<Action, number>();
const errorHandlers = new Set<(error: Error) => void>();
let running: Promise<void> | undefined = undefined;
let scheduled = false;

const MAX_ITERATIONS_PER_RUN = 100;

export function schedule(action: Action, log: ReactivityLog): Cancel {
  setDependencies(action, log);
  log.reads.forEach(({ cell }) => dirty.add(cell));

  queueExecution();
  pending.add(action);

  return () => unschedule(action);
}

export function unschedule(fn: Action): void {
  cancels.get(fn)?.forEach((cancel) => cancel());
  cancels.delete(fn);
  dependencies.delete(fn);
}

// Like schedule, but runs the action immediately to gather dependencies
export async function run(action: Action): Promise<any> {
  const log: ReactivityLog = { reads: [], writes: [] };

  if (running) await running;

  running = new Promise(async (resolve) => {
    const result = await action(log);
    running = undefined;
    resolve(result);
  });

  const result = await running;

  // Note: By adding the listeners after the call we avoid triggering a re-run
  // of the action if it changed a r/w cell. Note that this also means that
  // those actions can't loop on themselves.
  setDependencies(action, log);
  cancels.set(
    action,
    Array.from(log.reads).map(({ cell, path }) =>
      cell.updates((_newValue, changedPath) => {
        if (pathAffected(changedPath, path)) {
          dirty.add(cell);
          queueExecution();
          pending.add(action);
        }
      })
    )
  );

  return result;
}

export async function idle() {
  return new Promise<void>((resolve) => {
    if (pending.size === 0 && eventQueue.length === 0) resolve();
    idlePromises.push(resolve);
  });
}

export function onError(fn: (error: Error) => void) {
  errorHandlers.add(fn);
}

export function queueEvent(eventRef: CellReference, event: any) {
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

export function addEventHandler(
  handler: EventHandler,
  ref: CellReference
): Cancel {
  eventHandlers.push([ref, handler]);
  return () => {
    const index = eventHandlers.findIndex(
      ([r, h]) => r === ref && h === handler
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
  dependencies.set(action, {
    reads: compactifyPaths(log.reads),
    writes: compactifyPaths(log.writes),
  });
}

function handleError(error: Error) {
  if (errorHandlers.size === 0) throw error;
  for (const handler of errorHandlers) handler(error);
}

async function execute() {
  // In case a directly invoked `run` is still running, wait for it to finish.
  if (running) await running;

  // Process next event from the event queue. Will mark more cells as dirty.
  eventQueue.shift()?.();

  const order = topologicalSort(pending, dependencies, dirty);

  // Clear pending and dirty sets, and cancel all listeners for cells on already
  // scheduled actions.
  pending.clear();
  dirty.clear();
  for (const fn of order) cancels.get(fn)?.forEach((cancel) => cancel());

  // Now run all functions. This will create new listeners to mark cells dirty
  // and schedule the next run.
  for (const fn of order) {
    loopCounter.set(fn, (loopCounter.get(fn) || 0) + 1);
    if (loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN)
      handleError(new Error("Too many iterations"));
    else await run(fn);
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
  dirty: Set<CellImpl<any>>
): Action[] {
  const relevantActions = new Set<Action>();
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();

  // First pass: identify relevant actions
  for (const action of actions) {
    const { reads } = dependencies.get(action)!;
    // TODO: Keep track of affected paths
    if (reads.length === 0) {
      // Actions with no dependencies are always relevant. Note that they must
      // be manually added to `pending`, which happens only once on `schedule`.
      relevantActions.add(action);
    } else if (reads.some(({ cell }) => dirty.has(cell))) {
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
                    cell === write.cell && pathAffected(write.path, path)
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
            reads.some(
              ({ cell, path }) =>
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
