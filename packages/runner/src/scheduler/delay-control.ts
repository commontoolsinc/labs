import type { SchedulerDelays } from "./delays.ts";
import type { Action } from "./types.ts";

export interface SchedulerDelayControlState {
  readonly delays: SchedulerDelays;
  readonly computations: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly pending: Set<Action>;
  readonly queueExecution: () => void;
  readonly logDebounce: (message: string) => void;
  readonly shouldDebounceFirstRun?: (action: Action) => boolean;
}

export function canAutomaticallyDebounce(
  state: SchedulerDelayControlState,
  action: Action,
): boolean {
  return state.delays.canAutomaticallyDebounce(action, {
    effects: state.effects,
  });
}

export function getNextDebounceRunTime(
  state: SchedulerDelayControlState,
  action: Action,
): number | undefined {
  return state.delays.getNextDebounceRunTime(
    action,
    {
      computations: state.computations,
      effects: state.effects,
      dirty: state.dirty,
    },
  );
}

export function isDebouncedComputationWaiting(
  state: SchedulerDelayControlState,
  action: Action,
): boolean {
  return state.delays.isDebouncedComputationWaiting(
    action,
    debouncedComputationContext(state),
  );
}

export function scheduleComputationDebounce(
  state: SchedulerDelayControlState,
  action: Action,
): void {
  state.delays.scheduleComputationDebounce(
    action,
    debouncedComputationContext(state),
  );
}

export function scheduleWithDebounce(
  state: SchedulerDelayControlState,
  action: Action,
): void {
  state.delays.scheduleWithDebounce(
    action,
    {
      pending: state.pending,
      queueExecution: state.queueExecution,
      logDebounce: state.logDebounce,
    },
  );
}

export function maybeAutoDebounce(
  state: SchedulerDelayControlState,
  action: Action,
):
  | {
    actionId: string;
    averageTime: number;
    delayMs: number;
    thresholdMs: number;
  }
  | undefined {
  return state.delays.maybeAutoDebounce(action, {
    canAutomaticallyDebounce: (candidate) =>
      canAutomaticallyDebounce(state, candidate),
  });
}

function debouncedComputationContext(state: SchedulerDelayControlState) {
  return {
    computations: state.computations,
    effects: state.effects,
    dirty: state.dirty,
    pending: state.pending,
    queueExecution: state.queueExecution,
    logDebounce: state.logDebounce,
    shouldDebounceFirstRun: state.shouldDebounceFirstRun,
  };
}
