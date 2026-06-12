import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { NodeRegistry } from "./node-record.ts";
import type { Action, ReactivityLog } from "./types.ts";

export interface PullDemandState {
  readonly computations: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly nodes: NodeRegistry;
  readonly pullDemandedFirstRunComputations: WeakSet<Action>;
  readonly pullDemandedContinuationComputations: WeakSet<Action>;
  readonly hasActionRun: (action: Action) => boolean;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
}

export function hasDependentPath(
  state: Pick<PullDemandState, "dependents">,
  from: Action,
  to: Action,
  visited = new Set<Action>(),
): boolean {
  if (from === to) return true;
  if (visited.has(from)) return false;
  visited.add(from);

  const dependents = state.dependents.get(from);
  if (!dependents) return false;

  for (const dependent of dependents) {
    if (hasDependentPath(state, dependent, to, visited)) {
      return true;
    }
  }

  return false;
}

export function isDemandedPullComputation(
  state: PullDemandState,
  action: Action,
  visited = new Set<Action>(),
): boolean {
  if (
    !state.computations.has(action) || isLiveEffect(state, action)
  ) {
    return false;
  }
  if (visited.has(action)) return false;
  visited.add(action);

  return hasTransitiveEffectDependent(state, action) ||
    hasDemandedParentContext(state, action, visited);
}

export function isLiveEffect(
  state: Pick<
    PullDemandState,
    "effects" | "nodes" | "dependencies"
  >,
  action: Action,
): boolean {
  if (state.effects.has(action)) return true;

  // During resubscribe, dependencies can be registered before all effect
  // bookkeeping is restored. Treat only dependency-bearing historical effects
  // as live so unsubscribed effects do not keep old pull graphs demanded.
  return state.nodes.isKnownEffect(action) &&
    state.dependencies.has(action);
}

export function isPullDemandRootEffect(
  state: Pick<
    PullDemandState,
    "effects" | "getSchedulingWrites"
  >,
  action: Action,
): boolean {
  return state.effects.has(action) &&
    (state.getSchedulingWrites(action)?.length ?? 0) === 0;
}

export function shouldRunFirstPullComputationInDemandContext(
  state: Pick<
    PullDemandState,
    | "computations"
    | "effects"
    | "hasActionRun"
    | "pullDemandedFirstRunComputations"
    | "pullDemandedContinuationComputations"
  >,
  action: Action,
): boolean {
  if (!state.computations.has(action) || state.effects.has(action)) {
    return false;
  }

  if (state.pullDemandedContinuationComputations.has(action)) return true;
  if (state.hasActionRun(action)) return false;

  return state.pullDemandedFirstRunComputations.has(action);
}

function hasTransitiveEffectDependent(
  state: PullDemandState,
  action: Action,
  visited = new Set<Action>(),
): boolean {
  if (visited.has(action)) return false;
  visited.add(action);

  const dependents = state.dependents.get(action);
  if (!dependents) return false;

  for (const dependent of dependents) {
    if (isLiveEffect(state, dependent)) return true;
    if (hasTransitiveEffectDependent(state, dependent, visited)) {
      return true;
    }
  }

  return false;
}

function hasDemandedParentContext(
  state: PullDemandState,
  action: Action,
  visited = new Set<Action>(),
): boolean {
  if (state.nodes.get(action)?.provisionalDemand !== true) return false;

  const parent = state.nodes.parentOf(action)?.action;
  if (!parent) return false;

  if (isLiveEffect(state, parent)) {
    return (state.getSchedulingWrites(parent)?.length ?? 0) === 0;
  }

  return isDemandedPullComputation(state, parent, visited);
}
