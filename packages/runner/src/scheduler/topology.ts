import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import {
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
} from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
} from "../storage/interface.ts";
import type { NodeRegistry } from "./node-record.ts";
import type { Action, ReactivityLog } from "./types.ts";

export function collectTransitiveEffects(state: {
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
}, action: Action): Action[] {
  const visited = new Set<Action>();
  const effects: Action[] = [];

  const visit = (current: Action) => {
    if (visited.has(current)) return;
    visited.add(current);

    if (state.effects.has(current)) {
      effects.push(current);
    }

    const dependents = state.dependents.get(current);
    if (!dependents) return;
    for (const dependent of dependents) {
      visit(dependent);
    }
  };

  visit(action);
  return effects;
}

export function mapsEqual(
  a: Map<string, FabricValue>,
  b: Map<string, FabricValue>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, val] of a) {
    if (!b.has(key)) return false;
    if (!valueEqual(val, b.get(key))) return false;
  }
  return true;
}

export function topologicalSort(
  actions: Set<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
  mightWrite: WeakMap<Action, IMemorySpaceAddress[]>,
  nodes?: Pick<
    NodeRegistry,
    "get" | "parentActionOf" | "getRegistrationOrdinal"
  >,
  dependents?: WeakMap<Action, Set<Action>>,
  getAdditionalWrites?: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined,
): Action[] {
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();

  // Initialize graph and inDegree for relevant actions
  for (const action of actions) {
    graph.set(action, new Set());
    inDegree.set(action, 0);
  }

  // Build the graph based on read/write dependencies. The readers a writer
  // is ordered against are indexed by the document they read, built on first
  // use, so a writer's edges cost the readers of the documents it writes
  // rather than the whole set, and a pass that needs no index builds none.
  let declaredReaders: Map<string, IndexedRead[]> | undefined;
  let allReaders: Map<string, IndexedRead[]> | undefined;
  const addEdgesForWrites = (
    actionA: Action,
    writes: readonly IMemorySpaceAddress[],
    declaredOnly: boolean,
  ): void => {
    if (writes.length === 0) return;
    let readers: Map<string, IndexedRead[]>;
    if (declaredOnly) {
      declaredReaders ??= indexReaders(actions, dependencies, nodes, true);
      readers = declaredReaders;
    } else {
      allReaders ??= indexReaders(actions, dependencies, nodes, false);
      readers = allReaders;
    }
    const graphA = graph.get(actionA)!;
    for (const write of writes) {
      for (const reader of readers.get(documentKey(write)) ?? []) {
        const actionB = reader.action;
        if (actionA === actionB || graphA.has(actionB)) continue;
        const overlaps = reader.shallow
          ? nonRecursiveReadMayOverlapWrite(reader.path, write.path)
          : arraysOverlap(write.path, reader.path);
        if (!overlaps) continue;
        graphA.add(actionB);
        inDegree.set(actionB, (inDegree.get(actionB) || 0) + 1);
      }
    }
  };
  // In pull mode the data edges are maintained incrementally in
  // `dependents`, so the graph is not rebuilt from the read logs on every
  // settle iteration; a reader that has never run contributes the reads it
  // declares instead.
  if (dependents) {
    for (const actionA of actions) {
      const graphA = graph.get(actionA)!;
      const actionDependents = dependents.get(actionA);
      if (!actionDependents) continue;
      for (const actionB of actionDependents) {
        if (!actions.has(actionB) || graphA.has(actionB)) continue;
        graphA.add(actionB);
        inDegree.set(actionB, (inDegree.get(actionB) || 0) + 1);
      }
    }
    if (nodes) {
      for (const actionA of actions) {
        addEdgesForWrites(actionA, mightWrite.get(actionA) ?? [], true);
      }
    }
  } else {
    for (const actionA of actions) {
      if (!dependencies.get(actionA)) continue;
      addEdgesForWrites(actionA, mightWrite.get(actionA) ?? [], false);
    }
  }

  if (getAdditionalWrites) {
    for (const actionA of actions) {
      addEdgesForWrites(actionA, getAdditionalWrites(actionA) ?? [], false);
    }
  }

  // Add parent-child edges only when no opposing data dependency exists.
  // Structural creation order is a fallback; semantic read/write dependencies
  // should win once a parent actually reads a child's result.
  if (nodes) {
    for (const child of actions) {
      const parent = nodes.parentActionOf(child);
      if (parent && actions.has(parent)) {
        const graphParent = graph.get(parent)!;
        const graphChild = graph.get(child)!;
        if (!graphParent.has(child) && !graphChild.has(parent)) {
          graphParent.add(child);
          inDegree.set(child, (inDegree.get(child) || 0) + 1);
        }
      }
    }
  }

  // Perform topological sort with cycle handling.
  //
  // Once data edges (§7.4 rule 1) and parent tie-breaks (rule 2) are applied,
  // remaining ties fall back to REGISTRATION ORDER (rule 3) rather than
  // work-set / arrival order, so the run order — and last-writer-wins on any
  // shared address — is identical regardless of the order actions were
  // invalidated or arrived over the network.
  const byRegistrationOrder = makeTieBreakComparator(actions, nodes);
  const queue: Action[] = [];
  const result: Action[] = [];
  const visited = new Set<Action>();

  // Add all actions with no dependencies (in-degree 0) to the queue
  for (const [action, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(action);
    }
  }
  queue.sort(byRegistrationOrder);

  while (queue.length > 0 || visited.size < actions.size) {
    if (queue.length === 0) {
      // Handle cycle: prefer parents over children, then lowest in-degree
      // This ensures parent runs before child even when they form a read/write cycle
      const unvisited = Array.from(actions).filter(
        (action) => !visited.has(action),
      );

      // Sort by: prefer no unvisited parent, then by in-degree
      unvisited.sort((a, b) => {
        const aParent = nodes?.parentActionOf(a);
        const bParent = nodes?.parentActionOf(b);
        const aHasUnvisitedParent = aParent && !visited.has(aParent) &&
          actions.has(aParent);
        const bHasUnvisitedParent = bParent && !visited.has(bParent) &&
          actions.has(bParent);

        // Prefer nodes whose parent is already visited (or have no parent)
        if (aHasUnvisitedParent && !bHasUnvisitedParent) return 1; // b first
        if (!aHasUnvisitedParent && bHasUnvisitedParent) return -1; // a first

        // Fall back to in-degree, then registration order (rule 3)
        const byDegree = (inDegree.get(a) || 0) - (inDegree.get(b) || 0);
        if (byDegree !== 0) return byDegree;
        return byRegistrationOrder(a, b);
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
        insertReadyAction(queue, neighbor, byRegistrationOrder);
      }
    }
  }

  return result;
}

function insertReadyAction(
  queue: Action[],
  action: Action,
  compare: (a: Action, b: Action) => number,
): void {
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(queue[mid], action) <= 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  queue.splice(low, 0, action);
}

/** One read an action in the work set orders against writes to its document. */
type IndexedRead = {
  readonly action: Action;
  readonly path: readonly MemoryAddressPathComponent[];
  /** A shallow read, which a write below the read's own children misses. */
  readonly shallow: boolean;
};

/** The key two addresses share when they name the same document. */
function documentKey(address: IMemorySpaceAddress): string {
  return `${address.space}\0${address.id}\0${
    normalizeCellScope(address.scope)
  }`;
}

/**
 * The reads the work set's actions order against, grouped by the document
 * read: what `getOrderingReadLog` answers for each action, laid out so that
 * a writer finds the readers of a document without visiting the actions that
 * read something else. With `declaredOnly`, only the reads an action that has
 * never run declares, which is all a pull-mode pass orders by, since the data
 * edges of the actions that have run are maintained in `dependents`.
 */
function indexReaders(
  actions: ReadonlySet<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
  nodes: Pick<NodeRegistry, "get"> | undefined,
  declaredOnly: boolean,
): Map<string, IndexedRead[]> {
  const readers = new Map<string, IndexedRead[]>();
  const add = (read: IndexedRead, address: IMemorySpaceAddress) => {
    const key = documentKey(address);
    const list = readers.get(key);
    if (list === undefined) readers.set(key, [read]);
    else list.push(read);
  };
  for (const action of actions) {
    if (declaredOnly) {
      const record = nodes?.get(action);
      if (record?.status !== "never-ran" || record.declaredReads.length === 0) {
        continue;
      }
      for (const address of record.declaredReads) {
        add({ action, path: address.path, shallow: false }, address);
      }
      continue;
    }
    const log = getOrderingReadLog(action, dependencies, nodes);
    if (!log) continue;
    for (const address of log.reads) {
      add({ action, path: address.path, shallow: false }, address);
    }
    for (const address of log.shallowReads) {
      add({ action, path: address.path, shallow: true }, address);
    }
  }
  return readers;
}

function getOrderingReadLog(
  action: Action,
  dependencies: WeakMap<Action, ReactivityLog>,
  nodes?: Pick<NodeRegistry, "get">,
): Pick<ReactivityLog, "reads" | "shallowReads"> | undefined {
  const record = nodes?.get(action);
  if (record?.status === "never-ran" && record.declaredReads.length > 0) {
    return {
      reads: record.declaredReads,
      shallowReads: [],
    };
  }
  return dependencies.get(action);
}

/**
 * Deterministic tie-break comparator for topological ordering (§7.4 rule 3).
 *
 * Primary key is the stable REGISTRATION ORDINAL from the node registry, so
 * ties left by the read-edge DAG resolve to registration order rather than the
 * order actions happened to enter the work set (which for remote commits is
 * network-arrival order). Actions with no registration ordinal (e.g. bare
 * materializers, or any call with `nodes` undefined) fall back to their
 * work-set insertion index, preserving the pre-existing behavior for that case
 * and keeping unregistered actions ordered after registered ones.
 */
function makeTieBreakComparator(
  actions: Set<Action>,
  nodes?: Pick<NodeRegistry, "getRegistrationOrdinal">,
): (a: Action, b: Action) => number {
  const fallbackIndex = new Map<Action, number>();
  let index = 0;
  for (const action of actions) fallbackIndex.set(action, index++);

  const ordinalOf = (action: Action): number =>
    nodes?.getRegistrationOrdinal(action) ?? Number.POSITIVE_INFINITY;

  return (a, b) => {
    const oa = ordinalOf(a);
    const ob = ordinalOf(b);
    // `!==` (not subtraction) so two unregistered actions (both +Infinity)
    // compare equal and fall through to the stable insertion-order index
    // instead of yielding NaN.
    if (oa !== ob) return oa - ob;
    return (fallbackIndex.get(a) ?? 0) - (fallbackIndex.get(b) ?? 0);
  };
}
