import { Cancel } from "@commontools/common-frp";
import { CellImpl, CellReference, ReactivityLog } from "./cell.js";
import { compactifyPaths, pathAffected } from "./utils.js";

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

const MAX_ITERATIONS_PER_RUN = 100;

export function schedule(action: Action, log: ReactivityLog) {
  setDependencies(action, log);
  log.reads.forEach(({ cell }) => dirty.add(cell));

  queueExecution();
  pending.add(action);
}

export function unschedule(fn: Action): void {
  cancels.get(fn)?.forEach((cancel) => cancel());
  cancels.delete(fn);
  dependencies.delete(fn);
}

// Like schedule, but runs the action immediately to gather dependencies
export function run(action: Action): any {
  const log: ReactivityLog = { reads: [], writes: [] };

  const result = action(log);
  console.log("run", log, result);

  // Note: By adding the listeners after the call we avoid triggering a re-run
  // of the action if it changed a r/w cell. Note that this also means that
  // those actions can't loop on themselves.
  setDependencies(action, log);
  cancels.set(
    action,
    Array.from(log.reads).map(({ cell, path }) =>
      cell.updates((_newValue, changedPath) => {
        console.log("dirty", cell, path, changedPath);
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
      eventQueue.push(() => {
        const nextEvent = handler(event);
        if (nextEvent) queueEvent(ref, nextEvent);
      });
    }
  }
}

export function addEventHandler(
  handler: EventHandler,
  ref: CellReference
): () => void {
  eventHandlers.push([ref, handler]);
  return () => {
    const index = eventHandlers.findIndex(([r, _]) => r === ref);
    if (index !== -1) eventHandlers.splice(index, 1);
  };
}

function queueExecution() {
  if (pending.size === 0 && eventQueue.length === 0) queueMicrotask(execute);
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

function execute() {
  // Process next event from the event queue. Will mark more cells as dirty.
  eventQueue.shift()?.();

  const order = topologicalSort(pending, dependencies, dirty);
  console.log("execute", order, pending, dirty.size);

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
    else run(fn);
  }

  if (pending.size === 0 && eventQueue.length === 0) {
    const promises = idlePromises;
    for (const resolve of promises) resolve();
    idlePromises.length = 0;

    loopCounter = new WeakMap();
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
    if (Array.from(reads).some(({ cell }) => dirty.has(cell))) {
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
