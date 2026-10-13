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
  // should win once a parent actually reads a child's result. The parents
  // within the work set are kept for the cycle fallback below, which prefers
  // an action whose parent has run.
  const parents = new Map<Action, Action>();
  const children = new Map<Action, Action[]>();
  if (nodes) {
    for (const child of actions) {
      const parent = nodes.parentActionOf(child);
      if (parent && actions.has(parent)) {
        parents.set(child, parent);
        const siblings = children.get(parent);
        if (siblings === undefined) children.set(parent, [child]);
        else siblings.push(child);
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

  // A read/write cycle leaves the queue empty with actions unvisited. The
  // break prefers an action with no unvisited parent, so a parent runs
  // before its child even when the two form a cycle, then the lowest
  // remaining in-degree, then registration order. The candidates are kept
  // in a heap under that key from the first break on, since a work set of
  // thousands of actions can break thousands of cycles in one pass and a
  // sort of the unvisited set at each break is quadratic in the pass.
  let candidates: CycleBreakCandidates | undefined;
  while (queue.length > 0 || visited.size < actions.size) {
    if (queue.length === 0) {
      candidates ??= new CycleBreakCandidates(
        actions,
        visited,
        inDegree,
        parents,
        byRegistrationOrder,
      );
      queue.push(candidates.take());
    }

    const current = queue.shift()!;
    if (visited.has(current)) continue;

    result.push(current);
    visited.add(current);

    for (const neighbor of graph.get(current) || []) {
      const degree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, degree);
      if (degree === 0) {
        insertReadyAction(queue, neighbor, byRegistrationOrder);
      } else {
        candidates?.refresh(neighbor);
      }
    }
    for (const child of children.get(current) ?? []) {
      candidates?.refresh(child);
    }
  }

  return result;
}

/** One candidate for a cycle break, under the key it was pushed with. */
type CycleBreakEntry = {
  readonly action: Action;
  /** Whether the action's parent in the work set was unvisited. */
  readonly blocked: boolean;
  readonly degree: number;
};

/**
 * The unvisited actions a cycle break chooses among, ordered by the break's
 * preference. An action's key only falls as the sort visits actions: its
 * in-degree drops, and its parent goes from unvisited to visited. So the
 * action is pushed again under its new key whenever one changes, and an
 * entry whose key is no longer the action's current one, or whose action
 * has since been visited, is dropped when it reaches the top. The first
 * current entry at the top is then the least unvisited action, since every
 * entry an action still has sorts at or above its current one.
 */
class CycleBreakCandidates {
  readonly #heap: CycleBreakEntry[] = [];
  readonly #visited: ReadonlySet<Action>;
  readonly #inDegree: ReadonlyMap<Action, number>;
  readonly #parents: ReadonlyMap<Action, Action>;
  readonly #byRegistrationOrder: (a: Action, b: Action) => number;

  constructor(
    actions: ReadonlySet<Action>,
    visited: ReadonlySet<Action>,
    inDegree: ReadonlyMap<Action, number>,
    parents: ReadonlyMap<Action, Action>,
    byRegistrationOrder: (a: Action, b: Action) => number,
  ) {
    this.#visited = visited;
    this.#inDegree = inDegree;
    this.#parents = parents;
    this.#byRegistrationOrder = byRegistrationOrder;
    for (const action of actions) this.refresh(action);
  }

  /** Records `action` under its current key, unless it has been visited. */
  refresh(action: Action): void {
    if (this.#visited.has(action)) return;
    this.#push({
      action,
      blocked: this.#blocked(action),
      degree: this.#inDegree.get(action)!,
    });
  }

  /** The least unvisited action, which the caller then visits. */
  take(): Action {
    for (;;) {
      const top = this.#pop();
      if (top === undefined) {
        throw new Error("Cycle break found no unvisited action.");
      }
      if (
        this.#visited.has(top.action) ||
        top.blocked !== this.#blocked(top.action) ||
        top.degree !== this.#inDegree.get(top.action)
      ) {
        continue;
      }
      return top.action;
    }
  }

  #blocked(action: Action): boolean {
    const parent = this.#parents.get(action);
    return parent !== undefined && !this.#visited.has(parent);
  }

  #before(a: CycleBreakEntry, b: CycleBreakEntry): boolean {
    if (a.blocked !== b.blocked) return !a.blocked;
    if (a.degree !== b.degree) return a.degree < b.degree;
    return this.#byRegistrationOrder(a.action, b.action) < 0;
  }

  #push(entry: CycleBreakEntry): void {
    const heap = this.#heap;
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      if (!this.#before(entry, heap[parentIndex])) break;
      heap[index] = heap[parentIndex];
      index = parentIndex;
    }
    heap[index] = entry;
  }

  #pop(): CycleBreakEntry | undefined {
    const heap = this.#heap;
    const top = heap[0];
    const last = heap.pop();
    if (last === undefined || heap.length === 0) return top;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && this.#before(heap[right], heap[left])
        ? right
        : left;
      if (!this.#before(heap[child], last)) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
    return top;
  }
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
