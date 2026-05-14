import {
  CYCLE_DEBOUNCE_MIN_RUNS,
  CYCLE_DEBOUNCE_MULTIPLIER,
  CYCLE_DEBOUNCE_THRESHOLD_MS,
} from "./constants.ts";
import type { Action, SettleIterationStats, SettleStats } from "./types.ts";

export interface SettlingTracker {
  windowStart: number;
  busyTime: number;
  lastExecuteStart: number;
  isExecuting: boolean;
  nonSettlingDetected: boolean;
}

export function createSettlingTracker(): SettlingTracker {
  return {
    windowStart: 0,
    busyTime: 0,
    lastExecuteStart: 0,
    isExecuting: false,
    nonSettlingDetected: false,
  };
}

export function markExecuteStart(
  tracker: SettlingTracker,
  now = performance.now(),
): void {
  tracker.lastExecuteStart = now;
  tracker.isExecuting = true;
  if (tracker.windowStart === 0) {
    tracker.windowStart = now;
  }
}

export interface ExecuteEndUpdate {
  diagnosisBusyTimeMs: number;
  nonSettlingTelemetry?: {
    busyTime: number;
    windowDuration: number;
    busyRatio: number;
  };
}

export function recordExecuteEnd(
  tracker: SettlingTracker,
  now = performance.now(),
): ExecuteEndUpdate {
  const elapsed = now - tracker.lastExecuteStart;
  tracker.busyTime += elapsed;
  tracker.isExecuting = false;

  let nonSettlingTelemetry: ExecuteEndUpdate["nonSettlingTelemetry"];
  const windowDuration = now - tracker.windowStart;
  if (windowDuration > 5000) {
    const busyRatio = tracker.busyTime / windowDuration;
    if (
      busyRatio > 0.3 &&
      tracker.busyTime > 1000 &&
      !tracker.nonSettlingDetected
    ) {
      tracker.nonSettlingDetected = true;
      nonSettlingTelemetry = {
        busyTime: tracker.busyTime,
        windowDuration,
        busyRatio,
      };
    }
  }

  // Slide the window if it exceeds 10s without idle.
  if (windowDuration > 10000) {
    tracker.windowStart = now;
    tracker.busyTime = tracker.busyTime / 2; // Rolling average
  }

  return {
    diagnosisBusyTimeMs: elapsed,
    ...(nonSettlingTelemetry ? { nonSettlingTelemetry } : {}),
  };
}

export function buildPullInitialSeeds(state: {
  readonly pullMode: boolean;
  readonly pending: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly newActionsWithoutDependencies: Iterable<Action>;
  readonly eventBlockingDeps: Iterable<Action>;
  readonly computationDebounceFlushSeeds: Iterable<Action>;
}): Set<Action> {
  const initialSeeds = new Set<Action>();
  if (!state.pullMode) return initialSeeds;

  // Pending effects are demand roots. Computations stay lazy unless pulled.
  for (const action of state.pending) {
    if (state.effects.has(action)) {
      initialSeeds.add(action);
    }
  }

  // Dirty effects may have been skipped by throttling or cycle detection.
  for (const action of state.dirty) {
    if (state.effects.has(action)) {
      initialSeeds.add(action);
    }
  }

  for (const action of state.newActionsWithoutDependencies) {
    initialSeeds.add(action);
  }
  for (const action of state.eventBlockingDeps) {
    initialSeeds.add(action);
  }
  for (const action of state.computationDebounceFlushSeeds) {
    initialSeeds.add(action);
  }

  return initialSeeds;
}

export function recordEarlyIterationComputations(state: {
  readonly pullMode: boolean;
  readonly settleIter: number;
  readonly threshold: number;
  readonly workSet: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly earlyIterationComputations: Set<Action>;
}): void {
  if (!state.pullMode || state.settleIter >= state.threshold) return;
  for (const action of state.workSet) {
    if (!state.effects.has(action)) {
      state.earlyIterationComputations.add(action);
    }
  }
}

export function isPendingPullActionRunnable(state: {
  readonly effects: ReadonlySet<Action>;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly shouldRunFirstPullComputationInDemandContext: (
    action: Action,
  ) => boolean;
}, action: Action): boolean {
  return state.effects.has(action) ||
    state.isDemandedPullComputation(action) ||
    state.shouldRunFirstPullComputationInDemandContext(action);
}

export function isDirtyPullActionRunnable(state: {
  readonly effects: ReadonlySet<Action>;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly isThrottled: (action: Action) => boolean;
  readonly isDebouncedComputationWaiting?: (action: Action) => boolean;
}, action: Action): boolean {
  return (
    state.effects.has(action) ||
    state.isDemandedPullComputation(action)
  ) &&
    !state.isThrottled(action) &&
    state.isDebouncedComputationWaiting?.(action) !== true;
}

export function summarizeSettleIteration(state: {
  readonly workSetSize: number;
  readonly order: readonly Action[];
  readonly actionsRun: number;
  readonly durationMs: number;
  readonly effects: ReadonlySet<Action>;
  readonly getActionId: (action: Action) => string;
  readonly maxActions?: number;
}): SettleIterationStats {
  const maxActions = state.maxActions ?? 30;
  const actions: SettleIterationStats["actions"] = [];
  for (const action of state.order) {
    actions.push({
      id: state.getActionId(action),
      type: state.effects.has(action) ? "effect" : "computation",
    });
    if (actions.length >= maxActions) break;
  }

  return {
    workSetSize: state.workSetSize,
    orderSize: state.order.length,
    actionsRun: state.actionsRun,
    actions,
    durationMs: state.durationMs,
  };
}

export function summarizeSettleRun(state: {
  readonly iterations: SettleIterationStats[];
  readonly totalDurationMs: number;
  readonly settledEarly: boolean;
  readonly initialSeedCount: number;
}): SettleStats {
  return {
    iterations: state.iterations,
    totalDurationMs: state.totalDurationMs,
    settledEarly: state.settledEarly,
    initialSeedCount: state.initialSeedCount,
  };
}

export function pushBoundedHistory<T>(
  history: T[],
  entry: T,
  maxLength: number,
): void {
  history.push(entry);
  if (history.length > maxLength) {
    history.shift();
  }
}

export interface CycleBreakPlan {
  shouldBreak: boolean;
  computationsToClear: Action[];
  dirtyEffectsToRun: Action[];
}

export function planCycleBreak(state: {
  readonly pullMode: boolean;
  readonly settledEarly: boolean;
  readonly lastWorkSet: ReadonlySet<Action>;
  readonly earlyIterationComputations: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly runsThisExecute: ReadonlyMap<Action, number>;
  readonly isThrottled: (action: Action) => boolean;
}): CycleBreakPlan {
  const shouldBreak = state.pullMode &&
    !state.settledEarly &&
    state.lastWorkSet.size > 0;
  if (!shouldBreak) {
    return { shouldBreak, computationsToClear: [], dirtyEffectsToRun: [] };
  }

  const computationsToClear: Action[] = [];
  for (const computation of state.earlyIterationComputations) {
    if (
      state.lastWorkSet.has(computation) &&
      state.dirty.has(computation) &&
      !state.isThrottled(computation) &&
      (state.runsThisExecute.get(computation) ?? 0) > 1
    ) {
      computationsToClear.push(computation);
    }
  }

  const dirtyEffectsToRun = [...state.effects].filter((effect) =>
    state.dirty.has(effect) && !state.isThrottled(effect)
  );

  return { shouldBreak, computationsToClear, dirtyEffectsToRun };
}

export interface CycleDebounceUpdate {
  action: Action;
  runs: number;
  delayMs: number;
}

export function planAdaptiveCycleDebounce(state: {
  readonly pullMode: boolean;
  readonly executeStartTime: number;
  readonly runsThisExecute: ReadonlyMap<Action, number>;
  readonly canAutomaticallyDebounce: (action: Action) => boolean;
  readonly getCurrentDebounce: (action: Action) => number | undefined;
  readonly now?: number;
}): {
  elapsedMs: number;
  updates: CycleDebounceUpdate[];
} {
  const now = state.now ?? performance.now();
  const elapsedMs = now - state.executeStartTime;
  if (!state.pullMode || elapsedMs < CYCLE_DEBOUNCE_THRESHOLD_MS) {
    return { elapsedMs, updates: [] };
  }

  const updates: CycleDebounceUpdate[] = [];
  for (const [action, runs] of state.runsThisExecute) {
    if (
      !state.canAutomaticallyDebounce(action) ||
      runs < CYCLE_DEBOUNCE_MIN_RUNS
    ) {
      continue;
    }
    const delayMs = Math.round(CYCLE_DEBOUNCE_MULTIPLIER * elapsedMs);
    const currentDebounce = state.getCurrentDebounce(action) ?? 0;
    if (delayMs > currentDebounce) {
      updates.push({ action, runs, delayMs });
    }
  }

  return { elapsedMs, updates };
}

export interface ExecuteContinuationPlan {
  hasPendingPullWork: boolean;
  hasDirtyPullWork: boolean;
  hasImmediateRerunRequest: boolean;
  hasQueuedEventReadyNow: boolean;
  hasParkedHeadEvent: boolean;
  nextDirtyPullRunAt?: number;
  nextDirtyPullRunWaitsForIdle: boolean;
  shouldQueueAnotherTick: boolean;
}

export function planEventDirtyDependencyScheduling(state: {
  readonly dirtyDeps: Iterable<Action>;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly now?: number;
}): {
  runnableDeps: Action[];
  nextEligibleAt?: number;
} {
  let nextEligibleAt: number | undefined;
  const runnableDeps: Action[] = [];

  for (const dep of state.dirtyDeps) {
    if (state.isDebouncedComputationWaiting(dep)) {
      const depNextDebounceAt = state.getNextDebounceRunTime(dep);
      if (depNextDebounceAt !== undefined) {
        nextEligibleAt = minDefined(nextEligibleAt, depNextDebounceAt);
        continue;
      }
    }

    const depNextEligibleAt = state.getNextEligibleRunTime(dep);
    if (
      depNextEligibleAt !== undefined &&
      depNextEligibleAt > (state.now ?? performance.now())
    ) {
      nextEligibleAt = minDefined(nextEligibleAt, depNextEligibleAt);
      continue;
    }

    runnableDeps.push(dep);
  }

  return {
    runnableDeps,
    ...(nextEligibleAt !== undefined ? { nextEligibleAt } : {}),
  };
}

export function planExecuteContinuation(state: {
  readonly pullMode: boolean;
  readonly pending: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly shouldRerunAfterCurrentExecute: boolean;
  readonly hasQueuedEventReadyNow: boolean;
  readonly hasParkedHeadEvent: boolean;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly shouldRunFirstPullComputationInDemandContext: (
    action: Action,
  ) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly now?: number;
}): ExecuteContinuationPlan {
  const now = state.now ?? performance.now();
  const hasPendingPullWork = state.pullMode
    ? [...state.pending].some((action) =>
      state.effects.has(action) ||
      state.isDemandedPullComputation(action) ||
      state.shouldRunFirstPullComputationInDemandContext(action)
    )
    : state.pending.size > 0;

  let nextDirtyPullRunAt: number | undefined;
  let nextDirtyPullRunWaitsForIdle = false;
  const hasDirtyPullWork = state.pullMode &&
    [...state.dirty].some((action) => {
      if (
        !state.effects.has(action) &&
        !state.isDemandedPullComputation(action)
      ) {
        return false;
      }

      if (state.isDebouncedComputationWaiting(action)) {
        const nextDebounceAt = state.getNextDebounceRunTime(action);
        if (nextDebounceAt !== undefined) {
          nextDirtyPullRunAt = minDefined(
            nextDirtyPullRunAt,
            nextDebounceAt,
          );
          nextDirtyPullRunWaitsForIdle ||= state.effects.has(action);
        }
        return false;
      }

      const nextEligibleAt = state.getNextEligibleRunTime(action);
      if (nextEligibleAt !== undefined && nextEligibleAt > now) {
        nextDirtyPullRunAt = minDefined(nextDirtyPullRunAt, nextEligibleAt);
        nextDirtyPullRunWaitsForIdle ||= state.effects.has(action);
        return false;
      }

      return true;
    });

  const hasImmediateRerunRequest = state.shouldRerunAfterCurrentExecute &&
    nextDirtyPullRunAt === undefined;
  const shouldQueueAnotherTick = hasImmediateRerunRequest ||
    hasPendingPullWork ||
    hasDirtyPullWork ||
    state.hasQueuedEventReadyNow;

  return {
    hasPendingPullWork,
    hasDirtyPullWork,
    hasImmediateRerunRequest,
    hasQueuedEventReadyNow: state.hasQueuedEventReadyNow,
    hasParkedHeadEvent: state.hasParkedHeadEvent,
    ...(nextDirtyPullRunAt !== undefined ? { nextDirtyPullRunAt } : {}),
    nextDirtyPullRunWaitsForIdle,
    shouldQueueAnotherTick,
  };
}

function minDefined(
  current: number | undefined,
  next: number,
): number {
  return current === undefined ? next : Math.min(current, next);
}
