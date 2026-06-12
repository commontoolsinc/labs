import {
  applyQuiescentContinuation,
  type ExecuteContinuationState,
  queueAnotherExecutionTick,
} from "./continuation.ts";
import { planPullExecuteContinuation } from "./execution.ts";
import { isHeadEventParked } from "./events.ts";

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
    pending: state.pending,
    nodes: state.nodes,
    effects: state.effects,
    shouldRerunAfterCurrentExecute,
    hasQueuedEventReadyNow,
    hasParkedHeadEvent,
    isDemandedPullComputation: state.isDemandedPullComputation,
    materializerIndex: state.materializerIndex,
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
