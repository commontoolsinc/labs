import {
  isDirtyPullActionRunnable,
  isPendingPullActionRunnable,
} from "./execution.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import type { Action } from "./types.ts";

export type PendingPullRunnableState = Parameters<
  typeof isPendingPullActionRunnable
>[0];
export type DirtyPullRunnableState = Parameters<
  typeof isDirtyPullActionRunnable
>[0];
export type DirtyPullRunnableStateWithDebounce = DirtyPullRunnableState & {
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
};

export interface PullSchedulingState {
  readonly nodes: NodeRegistry;
  // `pending` now means an explicit run request that is not derivable from
  // invalid status alone: event preflight, retry, or an expired debounce flush.
  readonly pending: Set<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly materializerIndex: MaterializerIndexState;
  readonly pendingPullRunnableState: PendingPullRunnableState;
  readonly dirtyPullRunnableState: DirtyPullRunnableState;
  readonly dirtyPullRunnableStateWithDebounce:
    DirtyPullRunnableStateWithDebounce;
  readonly isLiveAction: (action: Action) => boolean;
  readonly hasActiveDebounceTimer: (action: Action) => boolean;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  // True while ANY initial rehydration is in flight (resume from persisted
  // state). On this branch the runnable-seed set is status-based, and reload
  // sync-fills mark resuming never-ran/invalid nodes — so without a barrier the
  // settle runs them fresh (racing/aborting their resume) and re-renders
  // downstream effects in waves. Holding ALL pull work until resumes resolve
  // reproduces main's ordering (rehydrate first, then a single settle): the
  // race and the render storm both disappear. idle() already awaits the resume
  // background tasks, so this never reports idle early.
  readonly hasPendingInitialRehydrations: () => boolean;
}

/**
 * In pull mode, invalid live nodes are primary runnable seeds. The idle
 * materializer path remains for explicit materializer flush requests that
 * survive after primary work is empty.
 *
 * Inline idempotency mode intentionally does not widen this to computations:
 * it rechecks computations that already run due to explicit demand or an
 * effect pull, rather than turning pull mode back into eager push mode.
 */
export function collectPullIterationSeeds(
  state: PullSchedulingState,
  workSet: Set<Action>,
): void {
  // Rehydration barrier: hold every pull seed until all in-flight resumes
  // resolve (see PullSchedulingState.hasPendingInitialRehydrations).
  if (state.hasPendingInitialRehydrations()) return;
  const initialSize = workSet.size;
  collectPrimaryPullIterationSeeds(state, workSet);

  if (workSet.size > initialSize || initialSize > 0) {
    return;
  }

  collectIdleMaterializerSeeds(state, workSet);
}

function collectPrimaryPullIterationSeeds(
  state: PullSchedulingState,
  workSet: Set<Action>,
): void {
  for (const action of state.pending) {
    const record = state.nodes.get(action);
    if (
      record &&
      isRunnableSchedulingSeed(state, record) &&
      isPendingPullActionRunnable(state.pendingPullRunnableState, action)
    ) {
      workSet.add(action);
    }
  }

  // Every runnable seed is invalid/never-ran (isRunnableSchedulingSeed gates
  // on isInvalidOrNeverRan), so the invalid-node index is exactly the
  // candidate set — iterate it instead of every registered node.
  for (const action of state.nodes.getInvalidNodes()) {
    const record = state.nodes.get(action);
    if (record && isRunnableSchedulingSeed(state, record)) {
      workSet.add(action);
    }
  }
}

function collectIdleMaterializerSeeds(
  state: PullSchedulingState,
  workSet: Set<Action>,
): void {
  for (const action of state.pending) {
    const record = state.nodes.get(action);
    if (record && isIdleMaterializerRunnable(state, record)) {
      workSet.add(action);
    }
  }

  for (const record of state.nodes.nodes()) {
    if (isIdleMaterializerRunnable(state, record)) {
      workSet.add(record.action);
    }
  }
}

export function hasRunnablePullWork(state: PullSchedulingState): boolean {
  // Rehydration barrier (see collectPullIterationSeeds): no pull work runs
  // until in-flight resumes resolve. idle() awaits those background tasks
  // separately, so this does not report idle prematurely.
  if (state.hasPendingInitialRehydrations()) return false;
  return hasRunnablePrimaryPullWork(state) ||
    hasRunnableIdleMaterializerWork(state);
}

function hasRunnablePrimaryPullWork(state: PullSchedulingState): boolean {
  for (const action of state.pending) {
    const record = state.nodes.get(action);
    if (
      record &&
      isRunnableSchedulingSeed(state, record) &&
      isPendingPullActionRunnable(state.pendingPullRunnableState, action)
    ) {
      return true;
    }
  }

  for (const action of state.nodes.getInvalidNodes()) {
    const record = state.nodes.get(action);
    if (
      record &&
      isRunnableSchedulingSeed(state, record) &&
      isDirtyPullActionRunnable(
        state.dirtyPullRunnableStateWithDebounce,
        action,
      )
    ) {
      return true;
    }
  }

  return false;
}

function hasRunnableIdleMaterializerWork(
  state: PullSchedulingState,
): boolean {
  for (const action of state.pending) {
    const record = state.nodes.get(action);
    if (record && isIdleMaterializerRunnable(state, record)) {
      return true;
    }
  }

  for (const record of state.nodes.nodes()) {
    if (isIdleMaterializerRunnable(state, record)) {
      return true;
    }
  }

  return false;
}

function isIdleMaterializerRunnable(
  state: PullSchedulingState,
  record: SchedulerNode,
): boolean {
  const action = record.action;
  return state.materializerIndex.isMaterializer(action) &&
    isRunnableSchedulingSeed(state, record) &&
    !state.effects.has(action) &&
    state.dirtyPullRunnableStateWithDebounce
        .isDebouncedComputationWaiting(action) !== true;
}

export function hasDeferredDirtyEffectWork(
  state: PullSchedulingState,
): boolean {
  const now = performance.now();
  for (const record of state.nodes.nodes("effect")) {
    if (
      isInvalidOrNeverRan(record) &&
      (
        state.hasActiveDebounceTimer(record.action) ||
        state.dirtyPullRunnableStateWithDebounce.isThrottled(record.action) ||
        isTimeGated(state, record.action, now)
      )
    ) {
      return true;
    }
  }
  return false;
}

export function isRunnableSchedulingSeed(
  state: PullSchedulingState,
  record: SchedulerNode,
): boolean {
  const action = record.action;
  const now = performance.now();
  return isInvalidOrNeverRan(record) &&
    (state.isLiveAction(action) || state.pending.has(action)) &&
    !state.dirtyPullRunnableStateWithDebounce.isThrottled(action) &&
    !isTimeGated(state, action, now) &&
    !state.hasActiveDebounceTimer(action) &&
    state.dirtyPullRunnableStateWithDebounce
        .isDebouncedComputationWaiting(action) !== true;
}

export function isInvalidOrNeverRan(record: SchedulerNode): boolean {
  return record.status === "invalid" || record.status === "never-ran";
}

function isTimeGated(
  state: PullSchedulingState,
  action: Action,
  now: number,
): boolean {
  const nextEligibleAt = state.getNextEligibleRunTime(action);
  return nextEligibleAt !== undefined && nextEligibleAt > now;
}
