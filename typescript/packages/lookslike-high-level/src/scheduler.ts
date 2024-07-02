import { Cancel } from "@commontools/common-frp";
import { Cell, ReactivityLog } from "./cell.js";

export type Action = (log: ReactivityLog) => void;

const pending = new Set<Action>();
const dirty = new Set<Cell<any>>();
const dependencies = new WeakMap<Action, ReactivityLog>();
const cancels = new WeakMap<Action, Cancel[]>();
const idlePromises: (() => void)[] = [];
let loopCounter = new WeakMap<Action, number>();
const errorHandlers = new Set<(error: Error) => void>();

const MAX_ITERATIONS_PER_RUN = 100;

export function run(fn: Action): void {
  const log = { reads: new Set<Cell<any>>(), writes: new Set<Cell<any>>() };
  fn(log);
  cancels.set(fn, schedule(fn, log));
}

export function remove(fn: Action): void {
  cancels.get(fn)?.forEach((cancel) => cancel());
  cancels.delete(fn);
  dependencies.delete(fn);
}

export async function idle() {
  return new Promise<void>((resolve) => {
    if (pending.size === 0) resolve();
    idlePromises.push(resolve);
  });
}

export function onError(fn: (error: Error) => void) {
  errorHandlers.add(fn);
}

function handleError(error: Error) {
  if (errorHandlers.size === 0) throw error;
  for (const handler of errorHandlers) handler(error);
}

function schedule(fn: Action, log: ReactivityLog): Cancel[] {
  dependencies.set(fn, log);
  const cancels = Array.from(log.reads).map((cell) =>
    cell.updates({
      send: () => {
        dirty.add(cell);
        if (pending.size === 0) queueMicrotask(execute);
        pending.add(fn);
      },
    })
  );
  log.writes.forEach((cell) => {
    if (log.reads.has(cell)) dirty.add(cell);
  });
  return cancels;
}

function execute() {
  const order = topologicalSort(pending, dependencies, dirty);

  // Clear pending and dirty sets, and cancel all listeners for cells on already
  // scheduled actions.
  pending.clear();
  dirty.clear();
  for (const fn of order) cancels.get(fn)?.forEach((cancel) => cancel());

  // Now run all functions. This will create new listeners to mark cells dirty
  // and schedule the next run.
  //
  // It will also mark cells as dirty that were both read and written by the
  // same action, but without that alone triggering a new run. This ensures that
  // they run whenever the next runs are scheduled.
  for (const fn of order) {
    loopCounter.set(fn, (loopCounter.get(fn) || 0) + 1);
    console.log(loopCounter.get(fn));
    if (loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN)
      handleError(new Error("Too many iterations"));
    else run(fn);
  }

  if (pending.size === 0) {
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
  dirty: Set<Cell<any>>
): Action[] {
  const relevantActions = new Set<Action>();
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();

  // First pass: identify relevant actions
  for (const action of actions) {
    const { reads } = dependencies.get(action)!;
    if (Array.from(reads).some((cell) => dirty.has(cell))) {
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
              dependencies.get(relevantAction)!.reads.has(write)
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
          if (reads.has(write)) {
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
