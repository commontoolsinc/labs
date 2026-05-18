import { queueTask } from "./diagnostics.ts";
import { planPullExecuteContinuation } from "./execution.ts";
import {
  type EventQueueWakeState,
  hasEventQueueWakeTimer,
  isHeadEventParked,
  scheduleEventQueueWake,
} from "./events.ts";
import type { Action, QueuedEvent } from "./types.ts";

export interface ExecuteContinuationState {
  readonly getPullMode: () => boolean;
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
  readonly shouldRunFirstPullComputationInDemandContext: (
    action: Action,
  ) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly resetLoopCounter: () => void;
  readonly setScheduled: (scheduled: boolean) => void;
  readonly resetSettlingTracker: () => void;
  readonly setPendingQueueTaskTimer: (
    timer: ReturnType<typeof setTimeout> | null,
  ) => void;
  readonly execute: () => void;
}

export function applyExecuteContinuation(
  state: ExecuteContinuationState,
): void {
  if (state.getPullMode()) {
    applyPullExecuteContinuation(state);
    return;
  }
  applyPushExecuteContinuation(state);
}

function applyPushExecuteContinuation(
  state: ExecuteContinuationState,
): void {
  const hasQueuedEventReadyNow = state.eventQueue.length > 0 &&
    !isHeadEventParked(state.eventQueueWakeState);
  const hasParkedHeadEvent = state.eventQueue.length > 0 &&
    isHeadEventParked(state.eventQueueWakeState);
  const shouldRerunAfterCurrentExecute = state
    .consumeRerunAfterCurrentExecute();

  if (
    shouldRerunAfterCurrentExecute ||
    state.pending.size > 0 ||
    hasQueuedEventReadyNow
  ) {
    queueAnotherExecutionTick(state);
    return;
  }

  applyQuiescentContinuation(state, { hasParkedHeadEvent });
}

function applyPullExecuteContinuation(
  state: ExecuteContinuationState,
): void {
  // In pull mode, we consider ourselves done when there are no effects or
  // effect-demanded computations to execute.
  const hasQueuedEventReadyNow = state.eventQueue.length > 0 &&
    !isHeadEventParked(state.eventQueueWakeState);
  const hasParkedHeadEvent = state.eventQueue.length > 0 &&
    isHeadEventParked(state.eventQueueWakeState);
  const shouldRerunAfterCurrentExecute = state
    .consumeRerunAfterCurrentExecute();

  const continuation = planPullExecuteContinuation({
    pending: state.pending,
    dirty: state.dirty,
    effects: state.effects,
    shouldRerunAfterCurrentExecute,
    hasQueuedEventReadyNow,
    hasParkedHeadEvent,
    isDemandedPullComputation: state.isDemandedPullComputation,
    shouldRunFirstPullComputationInDemandContext:
      state.shouldRunFirstPullComputationInDemandContext,
    isDebouncedComputationWaiting: state.isDebouncedComputationWaiting,
    getNextDebounceRunTime: state.getNextDebounceRunTime,
    getNextEligibleRunTime: state.getNextEligibleRunTime,
  });

  if (!continuation.shouldQueueAnotherTick) {
    applyQuiescentContinuation(state, continuation);
    return;
  }

  queueAnotherExecutionTick(state);
}

interface QuiescentContinuation {
  readonly hasParkedHeadEvent: boolean;
  readonly nextDirtyPullRunAt?: number;
  readonly nextDirtyPullRunWaitsForIdle?: boolean;
}

function applyQuiescentContinuation(
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

  resolveIdlePromises(state.idlePromises);
  markNotScheduled(state);

  // Reset settling tracker on idle.
  state.resetSettlingTracker();

  state.scheduledFirstTime.clear();
  if (state.conditionallyScheduledEffects.size === 0) {
    state.changedWritesHistory.length = 0;
  }
}

function queueAnotherExecutionTick(state: ExecuteContinuationState): void {
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
