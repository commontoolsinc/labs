import type { SchedulerGates } from "./gates.ts";
import type { Action } from "./types.ts";

export interface SchedulerDelayControlState {
  readonly gates: SchedulerGates;
  readonly computations: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly isInvalid: (action: Action) => boolean;
  readonly pending: Set<Action>;
  readonly queueExecution: () => void;
  readonly logDebounce: (message: string) => void;
  readonly shouldDebounceFirstRun?: (action: Action) => boolean;
}

export function canAutomaticallyDebounce(
  state: SchedulerDelayControlState,
  action: Action,
): boolean {
  return state.gates.canAutomaticallyDebounce(action, {
    effects: state.effects,
  });
}

export function getNextDebounceRunTime(
  state: SchedulerDelayControlState,
  action: Action,
): number | undefined {
  // Same context as the waiting/schedule paths — the planner must agree
  // with them on the first-run debounce gate, or a scheduled debounce has
  // no wake time.
  return state.gates.getNextDebounceRunTime(
    action,
    debouncedComputationContext(state),
  );
}

export function isDebouncedComputationWaiting(
  state: SchedulerDelayControlState,
  action: Action,
): boolean {
  return state.gates.isDebouncedComputationWaiting(
    action,
    debouncedComputationContext(state),
  );
}

export function scheduleComputationDebounce(
  state: SchedulerDelayControlState,
  action: Action,
): void {
  state.gates.scheduleComputationDebounce(
    action,
    debouncedComputationContext(state),
  );
}

export function scheduleWithDebounce(
  state: SchedulerDelayControlState,
  action: Action,
): void {
  state.gates.scheduleWithDebounce(
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
  return state.gates.maybeAutoDebounce(action, {
    canAutomaticallyDebounce: (candidate) =>
      canAutomaticallyDebounce(state, candidate),
  });
}

function debouncedComputationContext(state: SchedulerDelayControlState) {
  return {
    computations: state.computations,
    effects: state.effects,
    isInvalid: state.isInvalid,
    pending: state.pending,
    queueExecution: state.queueExecution,
    logDebounce: state.logDebounce,
    shouldDebounceFirstRun: state.shouldDebounceFirstRun,
  };
}
