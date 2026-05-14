import type { ActionStats } from "../telemetry.ts";
import {
  AUTO_DEBOUNCE_DELAY_MS,
  AUTO_DEBOUNCE_MIN_RUNS,
  AUTO_DEBOUNCE_THRESHOLD_MS,
} from "./constants.ts";
import type { Action } from "./types.ts";

export interface SchedulerDelayState {
  readonly actionDebounce: WeakMap<Action, number>;
  readonly actionThrottle: WeakMap<Action, number>;
  readonly actionStats: ReadonlyMap<string, ActionStats>;
  readonly actionHasRun: WeakSet<Action>;
  readonly computationDebounceReady: WeakSet<Action>;
  readonly computationDebounceReadyAt: WeakMap<Action, number>;
  readonly computationDebounceFlushSeeds: Set<Action>;
  readonly noDebounce: WeakMap<Action, boolean>;
  readonly debounceTimers: WeakMap<Action, ReturnType<typeof setTimeout>>;
  readonly activeDebounceTimers: Set<ReturnType<typeof setTimeout>>;
  readonly getActionId: (action: Action) => string;
}

export function setDebounce(
  state: SchedulerDelayState,
  action: Action,
  ms: number,
): void {
  if (ms <= 0) {
    state.actionDebounce.delete(action);
    clearComputationDebounceState(state, action);
  } else {
    state.actionDebounce.set(action, ms);
  }
}

export function getDebounce(
  state: SchedulerDelayState,
  action: Action,
): number | undefined {
  return state.actionDebounce.get(action);
}

export function clearDebounce(
  state: SchedulerDelayState,
  action: Action,
): void {
  state.actionDebounce.delete(action);
  cancelDebounceTimer(state, action);
  clearComputationDebounceState(state, action, { cancelTimer: false });
}

export function setNoDebounce(
  state: SchedulerDelayState,
  action: Action,
  optOut: boolean,
): void {
  if (optOut) {
    state.noDebounce.set(action, true);
  } else {
    state.noDebounce.delete(action);
  }
}

export function canAutomaticallyDebounce(state: {
  readonly noDebounce: WeakMap<Action, boolean>;
  readonly effects: ReadonlySet<Action>;
  readonly isPullDemandRootEffect: (action: Action) => boolean;
}, action: Action): boolean {
  if (state.noDebounce.get(action)) return false;
  if (!state.effects.has(action)) return false;
  return !state.isPullDemandRootEffect(action);
}

export function maybeAutoDebounce(
  state: SchedulerDelayState,
  action: Action,
  context: {
    readonly canAutomaticallyDebounce: (action: Action) => boolean;
  },
):
  | {
    actionId: string;
    averageTime: number;
    delayMs: number;
    thresholdMs: number;
  }
  | undefined {
  // Auto-debouncing computations in push mode makes observable derived state
  // lag behind writes. Pull-mode demand roots are effects, but delaying them
  // can leave a live renderer observing stale materialized data.
  if (!context.canAutomaticallyDebounce(action)) return undefined;

  // Check if already has a manual debounce set.
  if (state.actionDebounce.has(action)) return undefined;

  const actionId = state.getActionId(action);
  const stats = state.actionStats.get(actionId);
  if (!stats) return undefined;

  // Need minimum runs before auto-detecting.
  if (stats.runCount < AUTO_DEBOUNCE_MIN_RUNS) return undefined;

  // Check if action is slow enough to warrant debouncing.
  if (stats.averageTime < AUTO_DEBOUNCE_THRESHOLD_MS) return undefined;

  state.actionDebounce.set(action, AUTO_DEBOUNCE_DELAY_MS);
  return {
    actionId,
    averageTime: stats.averageTime,
    delayMs: AUTO_DEBOUNCE_DELAY_MS,
    thresholdMs: AUTO_DEBOUNCE_THRESHOLD_MS,
  };
}

export function clearComputationDebounceState(
  state: SchedulerDelayState,
  action: Action,
  options: { cancelTimer?: boolean } = {},
): void {
  state.computationDebounceReady.delete(action);
  state.computationDebounceReadyAt.delete(action);
  state.computationDebounceFlushSeeds.delete(action);
  if (options.cancelTimer ?? true) {
    cancelDebounceTimer(state, action);
  }
}

export function cancelDebounceTimer(
  state: SchedulerDelayState,
  action: Action,
): void {
  const timer = state.debounceTimers.get(action);
  if (timer) {
    clearTimeout(timer);
    state.debounceTimers.delete(action);
    state.activeDebounceTimers.delete(timer);
  }
}

export function shouldDebouncePullComputation(
  state: SchedulerDelayState,
  action: Action,
  context: {
    readonly pullMode: boolean;
    readonly computations: ReadonlySet<Action>;
    readonly effects: ReadonlySet<Action>;
  },
): boolean {
  const debounceMs = state.actionDebounce.get(action);
  return context.pullMode &&
    context.computations.has(action) &&
    !context.effects.has(action) &&
    state.actionHasRun.has(action) &&
    debounceMs !== undefined &&
    debounceMs > 0;
}

export function getNextDebounceRunTime(
  state: SchedulerDelayState,
  action: Action,
  context: {
    readonly pullMode: boolean;
    readonly computations: ReadonlySet<Action>;
    readonly effects: ReadonlySet<Action>;
    readonly dirty: ReadonlySet<Action>;
  },
): number | undefined {
  if (!shouldDebouncePullComputation(state, action, context)) {
    return undefined;
  }
  if (!context.dirty.has(action)) return undefined;
  if (state.computationDebounceReady.has(action)) return undefined;
  return state.computationDebounceReadyAt.get(action);
}

export function isDebouncedComputationWaiting(
  state: SchedulerDelayState,
  action: Action,
  context: DebouncedComputationContext,
): boolean {
  if (
    shouldDebouncePullComputation(state, action, context) &&
    context.dirty.has(action) &&
    !state.computationDebounceReady.has(action) &&
    state.computationDebounceReadyAt.get(action) === undefined
  ) {
    scheduleComputationDebounce(state, action, context);
  }
  const readyAt = getNextDebounceRunTime(state, action, context);
  return readyAt !== undefined && readyAt > performance.now();
}

interface DebouncedComputationContext {
  readonly pullMode: boolean;
  readonly computations: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly pending: Set<Action>;
  readonly queueExecution: () => void;
  readonly logDebounce: (message: string) => void;
}

export function scheduleComputationDebounce(
  state: SchedulerDelayState,
  action: Action,
  context: DebouncedComputationContext,
): void {
  if (!shouldDebouncePullComputation(state, action, context)) return;
  const debounceMs = state.actionDebounce.get(action);
  if (!debounceMs || debounceMs <= 0) return;

  state.computationDebounceReady.delete(action);
  cancelDebounceTimer(state, action);

  const readyAt = performance.now() + debounceMs;
  state.computationDebounceReadyAt.set(action, readyAt);
  const timer = setTimeout(() => {
    state.debounceTimers.delete(action);
    state.activeDebounceTimers.delete(timer);
    state.computationDebounceReadyAt.delete(action);

    if (!context.computations.has(action) || !context.dirty.has(action)) {
      return;
    }

    state.computationDebounceReady.add(action);
    state.computationDebounceFlushSeeds.add(action);
    context.pending.add(action);
    context.queueExecution();
  }, debounceMs);

  state.debounceTimers.set(action, timer);
  state.activeDebounceTimers.add(timer);
  context.logDebounce(
    `[DEBOUNCE] Computation ${state.getActionId(action)} ` +
      `trailing flush scheduled for ${debounceMs}ms`,
  );
}

export function scheduleWithDebounce(
  state: SchedulerDelayState,
  action: Action,
  context: {
    readonly pending: Set<Action>;
    readonly queueExecution: () => void;
    readonly logDebounce: (message: string) => void;
  },
): void {
  const debounceMs = state.actionDebounce.get(action);

  if (!debounceMs || debounceMs <= 0) {
    // No debounce - add immediately.
    context.pending.add(action);
    context.queueExecution();
    return;
  }

  // Clear existing timer if any.
  cancelDebounceTimer(state, action);

  // Set new timer.
  const timer = setTimeout(() => {
    state.debounceTimers.delete(action);
    state.activeDebounceTimers.delete(timer);
    context.pending.add(action);
    context.queueExecution();
  }, debounceMs);

  state.debounceTimers.set(action, timer);
  state.activeDebounceTimers.add(timer);
  context.logDebounce(
    `[DEBOUNCE] Action ${state.getActionId(action)} ` +
      `debounced for ${debounceMs}ms`,
  );
}

export function setThrottle(
  state: SchedulerDelayState,
  action: Action,
  ms: number,
): void {
  if (ms <= 0) {
    state.actionThrottle.delete(action);
  } else {
    state.actionThrottle.set(action, ms);
  }
}

export function getThrottle(
  state: SchedulerDelayState,
  action: Action,
): number | undefined {
  return state.actionThrottle.get(action);
}

export function clearThrottle(
  state: SchedulerDelayState,
  action: Action,
): void {
  state.actionThrottle.delete(action);
}

export function isThrottled(
  state: SchedulerDelayState,
  action: Action,
  now = performance.now(),
): boolean {
  const nextEligibleAt = getNextEligibleRunTime(state, action);
  return nextEligibleAt !== undefined && nextEligibleAt > now;
}

export function getNextEligibleRunTime(
  state: SchedulerDelayState,
  action: Action,
): number | undefined {
  const throttleMs = state.actionThrottle.get(action);
  if (!throttleMs) return undefined;

  const stats = state.actionStats.get(state.getActionId(action));
  if (!stats) return undefined;

  return stats.lastRunTimestamp + throttleMs;
}

export function clearActiveDebounceTimers(state: SchedulerDelayState): void {
  for (const timer of state.activeDebounceTimers) {
    clearTimeout(timer);
  }
  state.activeDebounceTimers.clear();
}
