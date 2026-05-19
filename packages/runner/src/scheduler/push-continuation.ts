import {
  applyQuiescentContinuation,
  type ExecuteContinuationState,
  queueAnotherExecutionTick,
} from "./continuation.ts";
import { isHeadEventParked } from "./events.ts";

export function applyPushExecuteContinuation(
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
