import {
  dispatchQueuedEvent,
  type SchedulerEventExecutionState,
} from "./events.ts";
import type { Action } from "./types.ts";

export async function processPushQueuedEventDuringExecute(
  state: SchedulerEventExecutionState,
  _eventBlockingDeps: Set<Action>,
): Promise<void> {
  // Process next event from the event queue.
  const queuedEvent = state.eventQueue[0];
  if (!queuedEvent) return;

  if (
    queuedEvent.notBefore !== undefined &&
    queuedEvent.notBefore > performance.now()
  ) {
    state.scheduleEventQueueWake(queuedEvent.notBefore);
    return;
  }

  delete queuedEvent.notBefore;

  await dispatchQueuedEvent({
    runtime: state.runtime,
    eventQueue: state.eventQueue,
    setRunningPromise: (promise) => {
      state.setRunningPromise(promise);
    },
    getActionId: (target) => state.getActionId(target),
    getActionTelemetryInfo: (target) => state.getActionTelemetryInfo(target),
    handleError: (error, target) => state.handleError(error, target),
    queueExecution: () => state.queueExecution(),
  }, queuedEvent);
}
