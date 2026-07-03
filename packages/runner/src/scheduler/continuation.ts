import { queueTask } from "./diagnostics.ts";
import { isHeadEventParked } from "./events.ts";
import { planPullExecuteContinuation } from "./execution.ts";
import type { PullSchedulingState } from "./work-oracle.ts";
import type { Action, QueuedEvent } from "./types.ts";

export interface ExecuteContinuationState {
  readonly pullScheduling: PullSchedulingState;
  readonly eventQueue: readonly QueuedEvent[];
  readonly idlePromises: (() => void)[];
  readonly consumeRerunAfterCurrentExecute: () => boolean;
  readonly hasPendingLineageHeadEvent: () => boolean;
  readonly scheduleWake: (at: number) => void;
  readonly hasWakeTimer: () => boolean;
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
    state.scheduleWake(continuation.nextDirtyPullRunAt);
    if (
      !continuation.hasParkedHeadEvent &&
      !continuation.nextDirtyPullRunWaitsForIdle
    ) {
      resolveIdlePromises(state.idlePromises);
    }
    markNotScheduled(state);
    return;
  }

  if (state.hasWakeTimer()) {
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
  state.setScheduled(false);
}

function resolveIdlePromises(promises: (() => void)[]): void {
  for (const resolve of promises) resolve();
  promises.length = 0;
}

export function applyPullExecuteContinuation(
  state: ExecuteContinuationState,
): void {
  // In pull mode, we consider ourselves done when there are no effects or
  // effect-demanded computations to execute.
  const hasPendingLineageHeadEvent = state.hasPendingLineageHeadEvent();
  const hasQueuedEventReadyNow = state.eventQueue.length > 0 &&
    !isHeadEventParked(state) &&
    !hasPendingLineageHeadEvent;
  const hasParkedHeadEvent = state.eventQueue.length > 0 &&
    (isHeadEventParked(state) || hasPendingLineageHeadEvent);
  const shouldRerunAfterCurrentExecute = state
    .consumeRerunAfterCurrentExecute();

  const continuation = planPullExecuteContinuation({
    pull: state.pullScheduling,
    shouldRerunAfterCurrentExecute,
    hasQueuedEventReadyNow,
    hasParkedHeadEvent,
  });

  if (!continuation.shouldQueueAnotherTick) {
    applyQuiescentContinuation(state, continuation);
    return;
  }

  queueAnotherExecutionTick(state);
}
