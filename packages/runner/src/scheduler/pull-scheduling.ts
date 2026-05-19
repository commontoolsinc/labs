import { getLogger } from "@commonfabric/utils/logger";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import {
  isDirtyPullActionRunnable,
  isPendingPullActionRunnable,
} from "./execution.ts";
import { readsOverlapWrites } from "./scheduling-writes.ts";
import { collectTransitiveEffects } from "./topology.ts";
import type {
  Action,
  ReactivityLog,
  TriggerTraceScheduledEffect,
} from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export type PendingPullRunnableState = Parameters<
  typeof isPendingPullActionRunnable
>[0];
export type DirtyPullRunnableState = Parameters<
  typeof isDirtyPullActionRunnable
>[0];
export type DirtyPullRunnableStateWithDebounce = DirtyPullRunnableState & {
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
};

export interface ConditionalEffectState {
  readonly changedWritesHistory: readonly IMemorySpaceAddress[];
  readonly conditionallyScheduledEffects: Map<Action, number>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
}

export interface PullSchedulingState extends ConditionalEffectState {
  readonly pending: Set<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly isMaterializer: (action: Action) => boolean;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly pendingPullRunnableState: PendingPullRunnableState;
  readonly dirtyPullRunnableState: DirtyPullRunnableState;
  readonly dirtyPullRunnableStateWithDebounce:
    DirtyPullRunnableStateWithDebounce;
  readonly getDebounce: (action: Action) => number | undefined;
  readonly scheduleWithDebounce: (action: Action) => void;
  readonly getActionId: (action: Action) => string;
}

export function markEffectConditionallyScheduled(
  state: ConditionalEffectState,
  effect: Action,
): void {
  if (!state.conditionallyScheduledEffects.has(effect)) {
    state.conditionallyScheduledEffects.set(
      effect,
      state.changedWritesHistory.length,
    );
  }
}

export function conditionalEffectHasChangedInputs(
  state: ConditionalEffectState,
  effect: Action,
): boolean {
  const changedWritesStart = state.conditionallyScheduledEffects.get(effect);
  if (changedWritesStart === undefined) return true;

  const changedWrites = state.changedWritesHistory.slice(changedWritesStart);
  if (changedWrites.length === 0) return false;

  const log = state.dependencies.get(effect);
  if (!log) return false;

  return readsOverlapWrites(log.reads, log.shallowReads, changedWrites);
}

/**
 * In pull mode, only effects are runnable seeds by default.
 *
 * Inline idempotency mode intentionally does not widen this to computations:
 * it rechecks computations that already run due to explicit demand or an
 * effect pull, rather than turning pull mode back into eager push mode.
 */
export function collectPullIterationSeeds(
  state: PullSchedulingState,
  workSet: Set<Action>,
): void {
  const initialSize = workSet.size;
  for (const action of state.pending) {
    if (isPendingPullActionRunnable(state.pendingPullRunnableState, action)) {
      workSet.add(action);
    }
  }

  for (const action of state.dirty) {
    if (isDirtyPullActionRunnable(state.dirtyPullRunnableState, action)) {
      state.pending.add(action);
      workSet.add(action);
    }
  }

  if (workSet.size > initialSize || initialSize > 0) {
    return;
  }

  for (const action of state.pending) {
    if (
      state.isMaterializer(action) &&
      isMaterializerRunnable(state, action)
    ) {
      workSet.add(action);
    }
  }

  for (const action of state.dirty) {
    if (
      state.isMaterializer(action) &&
      isMaterializerRunnable(state, action)
    ) {
      state.pending.add(action);
      workSet.add(action);
    }
  }
}

export function hasRunnablePullWork(state: PullSchedulingState): boolean {
  for (const action of state.pending) {
    if (
      isPendingPullActionRunnable(state.pendingPullRunnableState, action) ||
      (state.isMaterializer(action) && isMaterializerRunnable(state, action))
    ) {
      return true;
    }
  }

  for (const action of state.dirty) {
    if (
      isDirtyPullActionRunnable(
        state.dirtyPullRunnableStateWithDebounce,
        action,
      ) ||
      (state.isMaterializer(action) && isMaterializerRunnable(state, action))
    ) {
      return true;
    }
  }

  return false;
}

function isMaterializerRunnable(
  state: PullSchedulingState,
  action: Action,
): boolean {
  return !state.effects.has(action) &&
    !state.dirtyPullRunnableStateWithDebounce.isThrottled(action) &&
    state.dirtyPullRunnableStateWithDebounce
        .isDebouncedComputationWaiting(action) !== true;
}

export function hasDeferredDirtyEffectWork(
  state: PullSchedulingState,
): boolean {
  for (const action of state.dirty) {
    if (state.effects.has(action)) return true;
  }
  return false;
}

/**
 * Finds and schedules all effects that transitively depend on the given computation.
 */
export function scheduleAffectedEffects(
  state: PullSchedulingState,
  computation: Action,
): TriggerTraceScheduledEffect[] {
  const start = performance.now();
  const scheduledEffects: TriggerTraceScheduledEffect[] = [];

  try {
    for (
      const effect of collectTransitiveEffects(
        { dependents: state.dependents, effects: state.effects },
        computation,
      )
    ) {
      const pendingBefore = state.pending.has(effect);
      const dirtyBefore = state.dirty.has(effect);
      const debounceMs = state.getDebounce(effect);
      if (
        !pendingBefore && !dirtyBefore &&
        !state.conditionallyScheduledEffects.has(effect)
      ) {
        markEffectConditionallyScheduled(state, effect);
      }
      state.scheduleWithDebounce(effect);
      scheduledEffects.push({
        actionId: state.getActionId(effect),
        pendingBefore,
        dirtyBefore,
        debounceMs,
      });
    }
  } finally {
    logger.time(start, "scheduler", "scheduleAffectedEffects");
  }
  return scheduledEffects;
}
