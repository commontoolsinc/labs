import { queueTask } from "./diagnostics.ts";
import {
  type EventQueueWakeState,
  hasEventQueueWakeTimer,
  scheduleEventQueueWake,
} from "./events.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { Action, QueuedEvent } from "./types.ts";

export interface ExecuteContinuationState {
  readonly pending: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly eventQueue: readonly QueuedEvent[];
  readonly eventQueueWakeState: EventQueueWakeState;
  readonly idlePromises: (() => void)[];
  readonly scheduledFirstTime: Set<Action>;
  readonly conditionallyScheduledEffects: ReadonlyMap<Action, number>;
  readonly changedWritesHistory: unknown[];
  readonly consumeRerunAfterCurrentExecute: () => boolean;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly materializerIndex: MaterializerIndexState;
  readonly shouldRunFirstPullComputationInDemandContext: (
    action: Action,
  ) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly hasPendingLineageHeadEvent: () => boolean;
  readonly hasInputParkedHeadEvent: () => boolean;
  readonly resetLoopCounter: () => void;
  readonly setScheduled: (scheduled: boolean) => void;
  readonly resetSettlingTracker: () => void;
  readonly setPendingQueueTaskTimer: (
    timer: ReturnType<typeof setTimeout> | null,
  ) => void;
  readonly execute: () => void;
}

export interface QuiescentContinuation {
  readonly hasParkedHeadEvent: boolean;
  readonly nextDirtyPullRunAt?: number;
  readonly nextDirtyPullRunWaitsForIdle?: boolean;
}

export function applyQuiescentContinuation(
  state: ExecuteContinuationState,
  continuation: QuiescentContinuation,
): void {
  if (continuation.nextDirtyPullRunAt !== undefined) {
    scheduleEventQueueWake(
      state.eventQueueWakeState,
      continuation.nextDirtyPullRunAt,
    );
    if (
      !continuation.hasParkedHeadEvent &&
      !continuation.nextDirtyPullRunWaitsForIdle
    ) {
      resolveIdlePromises(state.idlePromises);
    }
    markNotScheduled(state);
    return;
  }

  if (hasEventQueueWakeTimer(state.eventQueueWakeState)) {
    markNotScheduled(state);

    // Waiting on a future wake is quiescent from the scheduler's perspective,
    // so reset the non-settling tracker.
    state.resetSettlingTracker();
    return;
  }

  if (continuation.hasParkedHeadEvent) {
    markNotScheduled(state);

    // A lineage-parked head has no timer; the origin transaction's commit
    // callback is the wake source.
    state.resetSettlingTracker();
    return;
  }

  resolveIdlePromises(state.idlePromises);
  markNotScheduled(state);

  // Reset settling tracker on idle.
  state.resetSettlingTracker();

  state.scheduledFirstTime.clear();
  if (state.conditionallyScheduledEffects.size === 0) {
    state.changedWritesHistory.length = 0;
  }
}

export function queueAnotherExecutionTick(
  state: ExecuteContinuationState,
): void {
  // Keep scheduled = true since we're queuing another execution.
  const timer = queueTask(() => {
    state.setPendingQueueTaskTimer(null);
    state.execute();
  });
  state.setPendingQueueTaskTimer(timer);
}

function markNotScheduled(state: ExecuteContinuationState): void {
  state.resetLoopCounter();
  state.setScheduled(false);
}

function resolveIdlePromises(promises: (() => void)[]): void {
  for (const resolve of promises) resolve();
  promises.length = 0;
}
