import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
} from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
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
  a: Map<string, unknown>,
  b: Map<string, unknown>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, val] of a) {
    if (!b.has(key)) return false;
    // TODO(danfuzz): `mapsEqual` compares map values with `deepEqual`, which
    // mishandles `FabricValue`; this helper is used on stored read-value maps,
    // so two same-class `FabricPrimitive`s (state in private `#fields`, zero
    // own-props) compare equal regardless of value. Use a Fabric-aware
    // equality.
    if (!deepEqual(val, b.get(key))) return false;
  }
  return true;
}

export function topologicalSort(
  actions: Set<Action>,
  dependencies: WeakMap<Action, ReactivityLog>,
  mightWrite: WeakMap<Action, IMemorySpaceAddress[]>,
  nodes?: Pick<NodeRegistry, "parentActionOf">,
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

  // Build the graph based on read/write dependencies.
  // In pull mode we maintain this incrementally in `dependents`, so we can
  // avoid rebuilding the graph from scratch on every settle iteration.
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
  } else {
    for (const actionA of actions) {
      const log = dependencies.get(actionA);
      if (!log) continue;
      const writes = mightWrite.get(actionA) ?? [];
      const graphA = graph.get(actionA)!;
      for (const write of writes) {
        for (const actionB of actions) {
          if (actionA !== actionB && !graphA.has(actionB)) {
            const logB = dependencies.get(actionB);
            if (!logB) continue;
            if (
              logB.reads.some(
                (addr) =>
                  addressesShareEntity(addr, write) &&
                  arraysOverlap(write.path, addr.path),
              ) ||
              logB.shallowReads.some(
                (addr) =>
                  addressesShareEntity(addr, write) &&
                  nonRecursiveReadMayOverlapWrite(addr.path, write.path),
              )
            ) {
              graphA.add(actionB);
              inDegree.set(actionB, (inDegree.get(actionB) || 0) + 1);
            }
          }
        }
      }
    }
  }

  if (getAdditionalWrites) {
    addAdditionalWriteEdges({
      actions,
      dependencies,
      graph,
      inDegree,
      getAdditionalWrites,
    });
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

        // Fall back to in-degree
        return (inDegree.get(a) || 0) - (inDegree.get(b) || 0);
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
        queue.push(neighbor);
      }
    }
  }

  return result;
}

function addAdditionalWriteEdges(state: {
  readonly actions: Set<Action>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly graph: Map<Action, Set<Action>>;
  readonly inDegree: Map<Action, number>;
  readonly getAdditionalWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
}): void {
  for (const actionA of state.actions) {
    const writes = state.getAdditionalWrites(actionA) ?? [];
    if (writes.length === 0) continue;

    const graphA = state.graph.get(actionA)!;
    for (const actionB of state.actions) {
      if (actionA === actionB || graphA.has(actionB)) continue;
      const logB = state.dependencies.get(actionB);
      if (!logB) continue;
      if (
        logB.reads.some(
          (addr) =>
            writes.some((write) =>
              addressesShareEntity(addr, write) &&
              arraysOverlap(write.path, addr.path)
            ),
        ) ||
        logB.shallowReads.some(
          (addr) =>
            writes.some((write) =>
              addressesShareEntity(addr, write) &&
              nonRecursiveReadMayOverlapWrite(addr.path, write.path)
            ),
        )
      ) {
        graphA.add(actionB);
        state.inDegree.set(actionB, (state.inDegree.get(actionB) || 0) + 1);
      }
    }
  }
}

function addressesShareEntity(
  a: IMemorySpaceAddress,
  b: IMemorySpaceAddress,
): boolean {
  return a.space === b.space &&
    a.id === b.id &&
    normalizeCellScope(a.scope) === normalizeCellScope(b.scope);
}
