import { getLogger } from "@commonfabric/utils/logger";
import {
  dispatchQueuedEvent,
  preflightQueuedEventDependencies,
  type SchedulerEventExecutionState,
} from "./events.ts";
import type { Action } from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export async function processPullQueuedEventDuringExecute(
  state: SchedulerEventExecutionState,
  eventBlockingDeps: Set<Action>,
): Promise<void> {
  // Process next event from the event queue.
  const queuedEvent = state.eventQueue[0];
  if (!queuedEvent) return;

  if (queuedEvent.originTx !== undefined) {
    const originStatus = state.lineageStatus(queuedEvent.originTx);
    const sameSpace = state.getOriginLocalSeq(
      queuedEvent.originTx,
      queuedEvent.eventLink.space,
    ) !== undefined;
    if (originStatus === "failed") {
      state.eventQueue.shift();
      state.releaseLineageEvent(queuedEvent.originTx, queuedEvent);
      logger.debug("scheduler-lineage", () => [
        "Dropping event from failed lineage origin",
        { eventId: queuedEvent.id },
      ]);
      return;
    }
    if (!sameSpace && originStatus === "pending") {
      return;
    }
  }

  if (
    queuedEvent.notBefore !== undefined &&
    queuedEvent.notBefore > performance.now()
  ) {
    state.scheduleEventQueueWake(queuedEvent.notBefore);
    return;
  }

  delete queuedEvent.notBefore;

  const { handler } = queuedEvent;
  const handlerId = state.getActionId(handler);

  // Ensure handler dependencies are computed before running.
  let shouldSkipEvent = false;
  if (handler.populateDependencies) {
    const preflight = preflightQueuedEventDependencies({
      runtime: state.runtime,
      eventQueue: state.eventQueue,
      dirty: state.dirty,
      pending: state.pending,
      pendingActions: state.pending,
      eventBlockingDeps,
      handleError: (error, target) => state.handleError(error, target),
      setDirtyDependencyTraceContext: (trace) => {
        state.setDirtyDependencyTraceContext(trace);
      },
      collectDirtyDependenciesForLog: (deps, dirtyDeps, dirtyDepMemo) =>
        state.collectDirtyDependenciesForLog(
          deps,
          dirtyDeps,
          dirtyDepMemo,
        ),
      isDebouncedComputationWaiting: (dep) =>
        state.isDebouncedComputationWaiting(dep),
      getNextDebounceRunTime: (dep) => state.getNextDebounceRunTime(dep),
      getNextEligibleRunTime: (dep) => state.getNextEligibleRunTime(dep),
      scheduleEventQueueWake: (notBefore) =>
        state.scheduleEventQueueWake(notBefore),
    }, queuedEvent);
    shouldSkipEvent = preflight.shouldSkipEvent;

    if (state.eventPreflightTelemetryEnabled) {
      state.runtime.telemetry.submit({
        type: "scheduler.event.preflight",
        handlerId,
        handlerInfo: state.getActionTelemetryInfo(handler),
        readCount: preflight.deps.reads.length,
        shallowReadCount: preflight.deps.shallowReads.length,
        dirtySizeBefore: preflight.dirtySizeBefore,
        pendingSizeBefore: preflight.pendingSizeBefore,
        dirtyDependencyCount: preflight.dirtyDeps.size,
        hasDirtyDependencies: preflight.hasDirtyDependencies,
        skipped: shouldSkipEvent,
        populateMs: preflight.populateMs,
        txToLogMs: preflight.txToLogMs,
        depCommitMs: preflight.depCommitMs,
        collectMs: preflight.collectMs,
        scheduleMs: preflight.scheduleMs,
        stats: state.snapshotDirtyDependencyTraceContext(
          preflight.preflightStats,
        ),
      });
    }
  }

  if (shouldSkipEvent) return;

  await dispatchQueuedEvent({
    runtime: state.runtime,
    eventQueue: state.eventQueue,
    backpressure: state.backpressure,
    setRunningPromise: (promise) => {
      state.setRunningPromise(promise);
    },
    getActionId: (target) => state.getActionId(target),
    getActionTelemetryInfo: (target) => state.getActionTelemetryInfo(target),
    handleError: (error, target) => state.handleError(error, target),
    queueExecution: () => state.queueExecution(),
    lineageStatus: (originTx) => state.lineageStatus(originTx),
    releaseLineageEvent: (originTx, event) =>
      state.releaseLineageEvent(originTx, event),
    recordLineageEvent: (originTx, event) =>
      state.recordLineageEvent(originTx, event),
    getOriginLocalSeq: (originTx, space) =>
      state.getOriginLocalSeq(originTx, space),
    onEventCommitWrites: (sourceAction, writes) =>
      state.onEventCommitWrites?.(sourceAction, writes),
  }, queuedEvent);
}
