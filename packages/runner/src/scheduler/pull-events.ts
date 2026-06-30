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

// CT-1795: upper bound on how many times one event may park waiting for a
// cross-space load (kicked by its own handler state) to settle. Each park costs
// one settle cycle; the common case resolves in 1. The bound guarantees forward
// progress if loads churn or a value legitimately never resolves.
const MAX_CROSS_SPACE_LOAD_PARKS = 8;

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

  // CT-1795: record the cross-space load count before this event's handler
  // chain runs, so the park below only fires for loads THIS event kicked (not
  // pre-existing / unrelated in-flight loads). Set once; preserved across
  // re-processing while the event stays parked at the queue head.
  if (queuedEvent.crossSpaceLoadBaseline === undefined) {
    queuedEvent.crossSpaceLoadBaseline =
      state.runtime.storageManager.pendingCrossSpacePromiseCount?.() ?? 0;
  }

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

  // CT-1795: the preflight above pulled this handler's bound state, but a value
  // derived from an async cross-space read (e.g. a #profileName wish behind a
  // plain-value computed arg, read by the handler only) resolves to its
  // un-loaded default on the first pass: the wish node runs and settles while
  // its cross-space load is still in flight, so it is not a dirty dependency and
  // nothing keeps the event parked. If pulling the state pushed the cross-space
  // load count above this event's baseline, park until those loads settle and
  // the producing chain re-runs — so the FIRST handler invocation observes the
  // resolved value instead of the empty default. Bounded and baseline-scoped:
  // unrelated in-flight loads do not delay this event, and a value that stays
  // empty still dispatches once the bound is reached.
  const storage = state.runtime.storageManager;
  const pendingLoads = storage.pendingCrossSpacePromiseCount?.() ?? 0;
  const loadBaseline = queuedEvent.crossSpaceLoadBaseline ?? 0;
  if (
    pendingLoads > loadBaseline &&
    (queuedEvent.crossSpaceLoadParks ?? 0) < MAX_CROSS_SPACE_LOAD_PARKS
  ) {
    // Only park if we obtain a settle promise to wake on — never park without a
    // wake (a backend lacking cross-space tracking already reports 0 pending).
    const settled = storage.crossSpaceSettled?.();
    if (settled) {
      queuedEvent.crossSpaceLoadParks = (queuedEvent.crossSpaceLoadParks ?? 0) +
        1;
      void settled.then(() => state.queueExecution());
      return;
    }
  }

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
