import type { Action } from "./types.ts";

export interface StalenessState {
  readonly dirty: Set<Action>;
  readonly stale: Set<Action>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  upstreamStaleWriters: WeakMap<Action, Set<Action>>;
  upstreamStaleCount: WeakMap<Action, number>;
}

export interface DirtySchedulingState {
  readonly stalenessState: StalenessState;
  readonly computations: ReadonlySet<Action>;
  readonly scheduleComputationDebounce: (action: Action) => void;
  readonly clearComputationDebounceState: (action: Action) => void;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly queueExecution: () => void;
}

export function isActionStale(
  state: Pick<StalenessState, "stale">,
  action: Action,
): boolean {
  return state.stale.has(action);
}

export function getUpstreamStaleCount(
  state: Pick<StalenessState, "upstreamStaleCount">,
  action: Action,
): number {
  return state.upstreamStaleCount.get(action) ?? 0;
}

export function markDirectDirty(
  state: StalenessState,
  action: Action,
): boolean {
  if (state.dirty.has(action)) return false;

  state.dirty.add(action);
  setStaleFromInputs(state, action);
  return true;
}

export function markSchedulerDirty(
  state: DirtySchedulingState,
  action: Action,
): void {
  markDirectDirty(state.stalenessState, action);
  state.scheduleComputationDebounce(action);
  if (state.isDemandedPullComputation(action)) {
    state.queueExecution();
  }
}

export function clearDirectDirty(
  state: StalenessState,
  action: Action,
): boolean {
  if (!state.dirty.delete(action)) return false;
  setStaleFromInputs(state, action);
  return true;
}

export function clearSchedulerDirectDirty(
  state: DirtySchedulingState,
  action: Action,
): boolean {
  if (!state.stalenessState.dirty.has(action)) return false;
  if (state.computations.has(action)) {
    state.clearComputationDebounceState(action);
  }
  return clearDirectDirty(state.stalenessState, action);
}

export function clearSchedulerDirty(
  state: DirtySchedulingState,
  action: Action,
): void {
  clearSchedulerDirectDirty(state, action);
}

export function forceClearStale(
  state: StalenessState,
  action: Action,
): void {
  state.upstreamStaleWriters.delete(action);
  state.upstreamStaleCount.delete(action);
  if (!state.stale.delete(action)) return;
  propagateStaleTransition(state, action, false);
}

export function setStaleFromInputs(
  state: StalenessState,
  action: Action,
): void {
  const shouldBeStale = state.dirty.has(action) ||
    getUpstreamStaleCount(state, action) > 0;
  const isCurrentlyStale = state.stale.has(action);
  if (shouldBeStale === isCurrentlyStale) return;

  if (shouldBeStale) {
    state.stale.add(action);
  } else {
    state.stale.delete(action);
  }
  propagateStaleTransition(state, action, shouldBeStale);
}

export function addStaleUpstream(
  state: StalenessState,
  writer: Action,
  dependent: Action,
): void {
  let writers = state.upstreamStaleWriters.get(dependent);
  if (!writers) {
    writers = new Set();
    state.upstreamStaleWriters.set(dependent, writers);
  }
  if (writers.has(writer)) return;

  writers.add(writer);
  state.upstreamStaleCount.set(dependent, writers.size);
  setStaleFromInputs(state, dependent);
}

export function removeStaleUpstream(
  state: StalenessState,
  writer: Action,
  dependent: Action,
): void {
  const writers = state.upstreamStaleWriters.get(dependent);
  if (!writers?.delete(writer)) return;

  if (writers.size === 0) {
    state.upstreamStaleWriters.delete(dependent);
    state.upstreamStaleCount.delete(dependent);
  } else {
    state.upstreamStaleCount.set(dependent, writers.size);
  }
  setStaleFromInputs(state, dependent);
}

function propagateStaleTransition(
  state: StalenessState,
  action: Action,
  becameStale: boolean,
): void {
  const dependents = state.dependents.get(action);
  if (!dependents) return;

  const delta = becameStale ? 1 : -1;
  for (const dependent of dependents) {
    if (delta > 0) {
      addStaleUpstream(state, action, dependent);
    } else {
      removeStaleUpstream(state, action, dependent);
    }
  }
}
