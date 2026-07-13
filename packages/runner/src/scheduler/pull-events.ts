import { getLogger } from "@commonfabric/utils/logger";
import {
  dispatchQueuedEvent,
  preflightQueuedEventDependencies,
  type SchedulerEventExecutionState,
} from "./events.ts";
import type { Action, QueuedEvent } from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

// CT-1795: upper bound on how many times one event may park waiting for a
// cross-space load (kicked by its own handler state) to settle. Each park costs
// one settle cycle; the common case resolves in 1. The bound guarantees forward
// progress if loads churn or a value legitimately never resolves.
const MAX_CROSS_SPACE_LOAD_PARKS = 8;

// CT-1795: backstop deadline for a single cross-space park. The settle promise
// normally wakes the event well before this; the deadline only ensures a hung
// load still dispatches (and that `idle()` has a wake timer to track the wait).
const CROSS_SPACE_LOAD_BACKSTOP_MS = 2000;

// CT-1795 per-event cross-space park bookkeeping, keyed by the queued event so it
// survives re-processing and is GC'd with the event. `baseline` is the in-flight
// cross-space load count captured before the event's handler chain ran (scopes
// the park to loads THIS event kicked); `parks` counts parks so far (bounded).
const crossSpaceParkState = new WeakMap<
  QueuedEvent,
  { baseline: number; parks: number }
>();

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
      state.clearEventInputWait(queuedEvent);
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

  if (state.isEventWaitingForInput(queuedEvent)) {
    return;
  }

  // A one-shot input watcher has fired and cleared its parked bit. Remove its
  // now-empty scheduler action before rechecking readiness or dispatching.
  state.clearEventInputWait(queuedEvent);

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
  // pre-existing / unrelated in-flight loads). Captured once; preserved across
  // re-processing while the event stays parked at the queue head.
  let parkState = crossSpaceParkState.get(queuedEvent);
  if (parkState === undefined) {
    parkState = {
      baseline:
        state.runtime.storageManager.pendingCrossSpacePromiseCount?.() ?? 0,
      parks: 0,
    };
    crossSpaceParkState.set(queuedEvent, parkState);
  }

  // Sync handler-only input cells before readiness preflight. Keeping this
  // await before the queue shift means readiness is checked again after the
  // async boundary; once preflight says ready, dispatch reaches the handler
  // body without another await in which the input could become unavailable.
  // Fail open so the readiness/read path surfaces the actual state.
  if (typeof handler.presyncInputs === "function") {
    try {
      await handler.presyncInputs(queuedEvent.event);
    } catch (error) {
      logger.warn(
        "scheduler",
        "handler input presync failed; checking readiness anyway",
        { error, handlerId },
      );
    }
  }

  // Presync is an async boundary. A speculative origin can fail while it is
  // in flight, and its lineage callback removes this exact queue object. Never
  // continue into readiness/dispatch for a removed or newly-failed event.
  if (state.eventQueue[0] !== queuedEvent) return;
  if (
    queuedEvent.originTx !== undefined &&
    state.lineageStatus(queuedEvent.originTx) === "failed"
  ) {
    state.clearEventInputWait(queuedEvent);
    state.eventQueue.shift();
    state.releaseLineageEvent(queuedEvent.originTx, queuedEvent);
    return;
  }

  // Ensure handler dependencies are computed before running.
  let shouldSkipEvent = false;
  let preflight:
    | ReturnType<typeof preflightQueuedEventDependencies>
    | undefined;
  if (handler.populateDependencies || handler.inputReadiness) {
    preflight = preflightQueuedEventDependencies({
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
        skipped: shouldSkipEvent || preflight.shouldParkForInputs,
        ...(preflight.inputUnavailableReason !== undefined && {
          inputUnavailableReason: preflight.inputUnavailableReason,
        }),
        queueDepth: state.eventQueue.length,
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
  // load count above this event's baseline, park the head event until those
  // loads settle and the producing chain re-runs — so the FIRST handler
  // invocation observes the resolved value instead of the empty default.
  // Baseline-scoped (unrelated in-flight loads do not delay this event) and
  // bounded (a value that stays empty still dispatches once the bound is hit).
  const storage = state.runtime.storageManager;
  const pendingLoads = storage.pendingCrossSpacePromiseCount?.() ?? 0;
  if (
    pendingLoads > parkState.baseline &&
    parkState.parks < MAX_CROSS_SPACE_LOAD_PARKS
  ) {
    // Only park if we obtain a settle promise to wake on — never park without a
    // wake (a backend lacking cross-space tracking already reports 0 pending).
    const settled = storage.crossSpaceSettled?.();
    if (settled) {
      parkState.parks += 1;
      // Genuinely park the head via the queue-wake deadline (the same mechanism
      // throttled deps use), so `idle()` accounts for the wait and the event is
      // skipped — not re-preflighted — on every re-entry until it wakes. The
      // settle promise wakes it early as soon as the cross-space load lands; the
      // deadline is only a backstop so a hung load still dispatches.
      const wakeAt = performance.now() + CROSS_SPACE_LOAD_BACKSTOP_MS;
      queuedEvent.notBefore = wakeAt;
      state.scheduleEventQueueWake(wakeAt);
      void settled.then(() => {
        // Wake as soon as the load settles instead of waiting out the backstop.
        // Bring the deadline forward (rather than just clearing notBefore) so
        // scheduleEventQueueWake cancels the backstop timer — leaving it armed
        // would dangle a 2s timer past the event. Guard on `wakeAt` so a later
        // re-park's deadline is left intact.
        if (queuedEvent.notBefore === wakeAt) {
          const now = performance.now();
          queuedEvent.notBefore = now;
          state.scheduleEventQueueWake(now);
        }
      });
      return;
    }
  }

  if (preflight?.shouldParkForInputs) {
    state.parkEventUntilInputChanges(queuedEvent, preflight.deps);
    return;
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
