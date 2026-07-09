import { getLogger } from "@commonfabric/utils/logger";
import { recordTrustedEventPolicyInputs } from "../cfc/ui-contract.ts";
import type { Cancel } from "../cancel.ts";
import { ensurePieceRunning } from "../ensure-piece-running.ts";
import {
  areNormalizedLinksSame,
  type NormalizedFullLink,
} from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IPreconditionFailedError,
  MemorySpace,
} from "../storage/interface.ts";
import {
  isConflictRejection,
  isPermanentRejection,
  isStorageTransactionInconsistent,
  isTerminalRejection,
} from "../storage/rejection.ts";
import {
  type CommitBackpressurePolicy,
  CommitConvergenceError,
  computeBackoffDelayMs,
} from "./backpressure.ts";
import type {
  SchedulerActionInfo,
  SchedulerEventPreflightStats,
} from "../telemetry.ts";
import { createEventPreflightTraceContext } from "./diagnostics.ts";
import { mintEventId } from "./event-identity.ts";
import { planEventInvalidDependencyScheduling } from "./execution.ts";
import type { OriginStatus } from "./lineage.ts";
import type { NodeRegistry } from "./node-record.ts";
import { RetryImmediately } from "./retry-immediately.ts";
import {
  hasAnnotatedWrites,
  trustedEventWriteCandidatesFromTransaction,
  txToReactivityLog,
} from "./reactivity.ts";
import type {
  Action,
  EventHandler,
  EventPreflightTraceContext,
  QueuedEvent,
  ReactivityLog,
} from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});
const EVENT_COMMIT_TELEMETRY_WRITE_LIMIT = 25;

export function isHeadEventParked(
  state: { readonly eventQueue: readonly QueuedEvent[] },
  now: number = performance.now(),
): boolean {
  const headEvent = state.eventQueue[0];
  return headEvent?.notBefore !== undefined && headEvent.notBefore > now;
}

export interface EventDependencyPreflightResult {
  shouldSkipEvent: boolean;
  deps: ReactivityLog;
  invalidDeps: Set<Action>;
  hasInvalidDependencies: boolean;
  dirtySizeBefore: number;
  pendingSizeBefore: number;
  populateMs: number;
  txToLogMs: number;
  depCommitMs: number;
  collectMs: number;
  scheduleMs: number;
  preflightStats: EventPreflightTraceContext;
}

export interface SchedulerEventQueueState {
  readonly runtime: Runtime;
  readonly eventHandlers: readonly [NormalizedFullLink, EventHandler][];
  readonly eventQueue: QueuedEvent[];
  readonly backgroundTasks: Set<Promise<unknown>>;
  readonly queueExecution: () => void;
  readonly queueEvent: (
    eventLink: NormalizedFullLink,
    event: unknown,
    retries: boolean,
    onCommit: QueuedEvent["onCommit"] | undefined,
    doNotLoadPieceIfNotRunning: boolean,
    opts?: { eventId?: string; originTx?: IExtendedStorageTransaction },
  ) => void;
  readonly recordLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
}

/**
 * Settle an event that will never be dispatched. The onCommit contract is that
 * it runs after the final outcome of the event, including failure — a dropped
 * event is such an outcome. Callers awaiting onCommit (e.g. stream.send with a
 * commit callback) would otherwise wait forever; that is how a space whose
 * default pattern fails to instantiate turned `cf piece new` into an
 * indefinite hang. The callback receives an aborted transaction so
 * `tx.status()` reports `error` with the drop reason.
 */
function notifyEventDropped(
  state: Pick<SchedulerEventQueueState, "runtime">,
  args: {
    readonly eventLink: NormalizedFullLink;
    readonly onCommit?: QueuedEvent["onCommit"];
  },
  reason: string,
): void {
  logger.warn("scheduler", reason, { eventLink: args.eventLink });
  if (!args.onCommit) return;
  const tx = state.runtime.edit();
  tx.abort(new Error(reason));
  try {
    args.onCommit(tx);
  } catch (callbackError) {
    logger.error(
      "schedule-error",
      "Error in event commit callback:",
      callbackError,
    );
  }
}

export function queueSchedulerEvent(state: SchedulerEventQueueState, args: {
  readonly eventLink: NormalizedFullLink;
  readonly event: unknown;
  readonly retries: boolean;
  readonly onCommit?: QueuedEvent["onCommit"];
  readonly doNotLoadPieceIfNotRunning: boolean;
  readonly eventId?: string;
  readonly originTx?: IExtendedStorageTransaction;
}): void {
  const id = args.eventId ?? mintEventId(args.eventLink, args.originTx);
  let handlerFound = false;

  for (const [link, handler] of state.eventHandlers) {
    if (areNormalizedLinksSame(link, args.eventLink)) {
      handlerFound = true;
      state.queueExecution();
      const queuedEvent: QueuedEvent = {
        id,
        originTx: args.originTx,
        eventLink: args.eventLink,
        action: (tx) => handler(tx, args.event),
        handler,
        event: args.event,
        retry: args.retries,
        onCommit: args.onCommit,
      };
      state.eventQueue.push(queuedEvent);
      if (args.originTx !== undefined) {
        state.recordLineageEvent(args.originTx, queuedEvent);
      }
      // Exactly one handler per event (spec scheduler-v2 decision 12).
      break;
    }
  }

  // If no handler was found, try to start the piece that should handle this event.
  if (!handlerFound && !args.doNotLoadPieceIfNotRunning) {
    const startTask = (async () => {
      const started = await ensurePieceRunning(state.runtime, args.eventLink);
      if (started) {
        // Piece was started, re-queue the event. Don't trigger loading again
        // if this didn't result in registering a handler, as trying again
        // won't change this.
        state.queueEvent(
          args.eventLink,
          args.event,
          args.retries,
          args.onCommit,
          true,
          { eventId: id, originTx: args.originTx },
        );
      } else {
        notifyEventDropped(
          state,
          args,
          `Event dropped: no handler registered for ${args.eventLink.id} ` +
            `and its piece could not be started`,
        );
      }
    })();
    state.backgroundTasks.add(startTask);
    startTask.finally(() => {
      state.backgroundTasks.delete(startTask);
    });
  } else if (!handlerFound) {
    // Second pass after a piece start that still registered no handler for
    // this stream (e.g. the piece "started" but its nodes failed to
    // instantiate). Trying again won't change this, so settle the event now.
    notifyEventDropped(
      state,
      args,
      `Event dropped: no handler registered for ${args.eventLink.id} ` +
        `after starting its piece`,
    );
  }
}

export function addSchedulerEventHandler(state: {
  readonly eventHandlers: [NormalizedFullLink, EventHandler][];
}, args: {
  readonly handler: EventHandler;
  readonly ref: NormalizedFullLink;
  readonly populateDependencies?: (
    tx: Parameters<EventHandler>[0],
    event: Parameters<EventHandler>[1],
  ) => void;
}): Cancel {
  if (args.populateDependencies) {
    args.handler.populateDependencies = args.populateDependencies;
  }
  const existingIndex = state.eventHandlers.findIndex(([existing]) =>
    areNormalizedLinksSame(existing, args.ref)
  );
  if (existingIndex !== -1) {
    state.eventHandlers.splice(existingIndex, 1);
    logger.warn("event-handler-replaced", () => [
      "Replacing existing event handler for link",
      { linkId: args.ref.id },
    ]);
  }
  state.eventHandlers.push([args.ref, args.handler]);
  return () => {
    const index = state.eventHandlers.findIndex(([r, h]) =>
      r === args.ref && h === args.handler
    );
    if (index !== -1) state.eventHandlers.splice(index, 1);
  };
}

export interface SchedulerEventExecutionState {
  readonly runtime: Runtime;
  readonly eventQueue: QueuedEvent[];
  readonly backpressure: CommitBackpressurePolicy;
  readonly collectPendingLoadParkKeys: (
    event: QueuedEvent,
    deps: ReactivityLog,
  ) => string[];
  readonly parkHeadEventForLoads: (
    event: QueuedEvent,
    keys: readonly string[],
  ) => void;
  readonly isHeadEventLoadParked: (event: QueuedEvent) => boolean;
  readonly nodes: NodeRegistry;
  readonly pending: Set<Action>;
  readonly eventPreflightTelemetryEnabled: boolean;
  readonly setRunningPromise: (promise: Promise<unknown>) => void;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getActionTelemetryInfo: (
    handler: EventHandler,
  ) => SchedulerActionInfo | undefined;
  readonly handleError: (
    error: Error,
    action: Action | EventHandler,
  ) => void;
  readonly queueExecution: () => void;
  readonly setEventPreflightTraceContext: (
    trace: EventPreflightTraceContext | undefined,
  ) => void;
  readonly collectInvalidUpstreamForLog: (
    deps: ReactivityLog,
    invalidDeps: Set<Action>,
  ) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly scheduleWake: (notBefore: number) => void;
  readonly lineageStatus: (
    originTx: IExtendedStorageTransaction,
  ) => OriginStatus;
  readonly releaseLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
  readonly recordLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
  readonly getOriginLocalSeq: (
    originTx: IExtendedStorageTransaction,
    space: MemorySpace,
  ) => number | undefined;
  readonly snapshotEventPreflightTraceContext: (
    trace: EventPreflightTraceContext,
  ) => SchedulerEventPreflightStats;
}

export function preflightQueuedEventDependencies(state: {
  readonly runtime: Runtime;
  readonly eventQueue: QueuedEvent[];
  readonly nodes: NodeRegistry;
  readonly pending: ReadonlySet<Action>;
  readonly pendingActions: Set<Action>;
  readonly eventBlockingDeps: Set<Action>;
  readonly handleError: (error: Error, handler: EventHandler) => void;
  readonly setEventPreflightTraceContext: (
    trace: EventPreflightTraceContext | undefined,
  ) => void;
  readonly collectInvalidUpstreamForLog: (
    deps: ReactivityLog,
    invalidDeps: Set<Action>,
  ) => boolean;
  readonly collectPendingLoadParkKeys: (
    event: QueuedEvent,
    deps: ReactivityLog,
  ) => string[];
  readonly parkHeadEventForLoads: (
    event: QueuedEvent,
    keys: readonly string[],
  ) => void;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly scheduleWake: (notBefore: number) => void;
}, queuedEvent: QueuedEvent): EventDependencyPreflightResult {
  const { handler, event: eventValue } = queuedEvent;
  const preflightStats = createEventPreflightTraceContext();
  // Diagnostic-only stat: read the maintained invalid-node index (O(1)) rather
  // than scanning every node per queued event (was O(N) on a hot path).
  const dirtySizeBefore = state.nodes.getInvalidNodes().size;
  const pendingSizeBefore = state.pending.size;
  let populateMs = 0;
  let txToLogMs = 0;
  let depCommitMs = 0;
  let collectMs = 0;
  let scheduleMs = 0;
  let shouldSkipEvent = false;

  // Get the handler's dependencies (read-only, just capturing what will be read)
  const depTx = state.runtime.edit();
  depTx.setReadOnly?.("scheduler.populateDependencies()");
  let stepStart = performance.now();
  logger.timeStart(
    "scheduler",
    "execute",
    "event",
    "pullPopulateDependencies",
  );
  try {
    handler.populateDependencies?.(depTx, eventValue);
  } catch (error) {
    state.eventQueue.shift();
    state.handleError(error as Error, handler);
    // Dropping the event here is its final outcome — settle the commit
    // callback like the other drop paths instead of leaving callers that
    // await it hanging.
    notifyEventDropped(
      state,
      queuedEvent,
      `Event dropped: populateDependencies threw during dependency ` +
        `preflight for ${queuedEvent.eventLink.id}`,
    );
    shouldSkipEvent = true;
  } finally {
    logger.timeEnd(
      "scheduler",
      "execute",
      "event",
      "pullPopulateDependencies",
    );
  }
  populateMs = performance.now() - stepStart;

  stepStart = performance.now();
  logger.timeStart(
    "scheduler",
    "execute",
    "event",
    "pullTxToReactivityLog",
  );
  const deps: ReactivityLog = shouldSkipEvent
    ? { reads: [], shallowReads: [], writes: [] }
    : txToReactivityLog(depTx);
  logger.timeEnd(
    "scheduler",
    "execute",
    "event",
    "pullTxToReactivityLog",
  );
  txToLogMs = performance.now() - stepStart;

  // Commit the read-only inspection tx as a no-op so dependency discovery
  // does not participate in CFC prepare or commit gating. Do this even
  // after populateDependencies errors so the transaction is closed.
  stepStart = performance.now();
  logger.timeStart(
    "scheduler",
    "execute",
    "event",
    "pullDepCommitStart",
  );
  depTx.commit();
  logger.timeEnd(
    "scheduler",
    "execute",
    "event",
    "pullDepCommitStart",
  );
  depCommitMs = performance.now() - stepStart;

  const invalidDeps = new Set<Action>();
  stepStart = performance.now();
  logger.timeStart(
    "scheduler",
    "execute",
    "event",
    "pullCollectInvalidUpstream",
  );
  let hasInvalidDependencies = false;
  state.setEventPreflightTraceContext(preflightStats);
  try {
    hasInvalidDependencies = state.collectInvalidUpstreamForLog(
      deps,
      invalidDeps,
    );
  } finally {
    state.setEventPreflightTraceContext(undefined);
    logger.timeEnd(
      "scheduler",
      "execute",
      "event",
      "pullCollectInvalidUpstream",
    );
  }
  collectMs = performance.now() - stepStart;

  if (!shouldSkipEvent && hasInvalidDependencies) {
    stepStart = performance.now();
    logger.timeStart(
      "scheduler",
      "execute",
      "event",
      "pullScheduleInvalidUpstream",
    );
    try {
      const eventDirtyPlan = planEventInvalidDependencyScheduling({
        invalidDeps,
        isDebouncedComputationWaiting: (dep) =>
          state.isDebouncedComputationWaiting(dep),
        getNextDebounceRunTime: (dep) => state.getNextDebounceRunTime(dep),
        getNextEligibleRunTime: (dep) => state.getNextEligibleRunTime(dep),
      });
      for (const dep of eventDirtyPlan.runnableDeps) {
        state.pendingActions.add(dep);
        state.eventBlockingDeps.add(dep);
      }
      if (eventDirtyPlan.runnableDeps.length > 0) {
        shouldSkipEvent = true;
      } else if (eventDirtyPlan.nextEligibleAt !== undefined) {
        queuedEvent.notBefore = eventDirtyPlan.nextEligibleAt;
        state.scheduleWake(eventDirtyPlan.nextEligibleAt);
        shouldSkipEvent = true;
      }
    } finally {
      logger.timeEnd(
        "scheduler",
        "execute",
        "event",
        "pullScheduleInvalidUpstream",
      );
    }
    scheduleMs = performance.now() - stepStart;
  }

  // Replica-staleness gate (CT-1795): with no invalid upstream left, an
  // address the closure depends on may still have a load in flight — the
  // wish shape, where a computation settles CLEAN on a provisional value
  // while its fire-and-forget pull is outstanding. Handlers are at-most-once
  // (D7), so park the head until those loads complete (absent counts as
  // complete); load completion is the wake source, mirroring the lineage
  // park.
  if (!shouldSkipEvent && !hasInvalidDependencies) {
    const parkKeys = state.collectPendingLoadParkKeys(queuedEvent, deps);
    if (parkKeys.length > 0) {
      state.parkHeadEventForLoads(queuedEvent, parkKeys);
      shouldSkipEvent = true;
    }
  }

  return {
    shouldSkipEvent,
    deps,
    invalidDeps,
    hasInvalidDependencies,
    dirtySizeBefore,
    pendingSizeBefore,
    populateMs,
    txToLogMs,
    depCommitMs,
    collectMs,
    scheduleMs,
    preflightStats,
  };
}

export async function processPullQueuedEventDuringExecute(
  state: SchedulerEventExecutionState,
  eventBlockingDeps: Set<Action>,
): Promise<void> {
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

  // Head is parked on in-flight closure loads; the loadsSettled callback (or
  // the timeout backstop) re-queues execution.
  if (state.isHeadEventLoadParked(queuedEvent)) {
    return;
  }

  if (
    queuedEvent.notBefore !== undefined &&
    queuedEvent.notBefore > performance.now()
  ) {
    state.scheduleWake(queuedEvent.notBefore);
    return;
  }

  delete queuedEvent.notBefore;

  const { handler } = queuedEvent;
  const handlerId = state.getActionId(handler);

  let shouldSkipEvent = false;
  if (handler.populateDependencies) {
    const preflight = preflightQueuedEventDependencies({
      runtime: state.runtime,
      eventQueue: state.eventQueue,
      nodes: state.nodes,
      pending: state.pending,
      pendingActions: state.pending,
      eventBlockingDeps,
      handleError: (error, target) => state.handleError(error, target),
      setEventPreflightTraceContext: (trace) => {
        state.setEventPreflightTraceContext(trace);
      },
      collectInvalidUpstreamForLog: (deps, invalidDeps) =>
        state.collectInvalidUpstreamForLog(
          deps,
          invalidDeps,
        ),
      collectPendingLoadParkKeys: (event, deps) =>
        state.collectPendingLoadParkKeys(event, deps),
      parkHeadEventForLoads: (event, keys) =>
        state.parkHeadEventForLoads(event, keys),
      isDebouncedComputationWaiting: (dep) =>
        state.isDebouncedComputationWaiting(dep),
      getNextDebounceRunTime: (dep) => state.getNextDebounceRunTime(dep),
      getNextEligibleRunTime: (dep) => state.getNextEligibleRunTime(dep),
      scheduleWake: (notBefore) => state.scheduleWake(notBefore),
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
        dirtyDependencyCount: preflight.invalidDeps.size,
        hasDirtyDependencies: preflight.hasInvalidDependencies,
        skipped: shouldSkipEvent,
        populateMs: preflight.populateMs,
        txToLogMs: preflight.txToLogMs,
        depCommitMs: preflight.depCommitMs,
        collectMs: preflight.collectMs,
        scheduleMs: preflight.scheduleMs,
        stats: state.snapshotEventPreflightTraceContext(
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
  }, queuedEvent);
}

export async function dispatchQueuedEvent(state: {
  readonly runtime: Runtime;
  readonly eventQueue: QueuedEvent[];
  readonly backpressure: CommitBackpressurePolicy;
  readonly setRunningPromise: (promise: Promise<unknown>) => void;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getActionTelemetryInfo: (
    handler: EventHandler,
  ) => SchedulerActionInfo | undefined;
  readonly handleError: (error: Error, action: Action) => void;
  readonly queueExecution: () => void;
  readonly lineageStatus: (
    originTx: IExtendedStorageTransaction,
  ) => OriginStatus;
  readonly releaseLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
  readonly recordLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
  readonly getOriginLocalSeq: (
    originTx: IExtendedStorageTransaction,
    space: MemorySpace,
  ) => number | undefined;
}, queuedEvent: QueuedEvent): Promise<void> {
  const { action, handler, event: eventValue, retry, onCommit } = queuedEvent;
  const handlerId = state.getActionId(handler);

  state.runtime.telemetry.submit({
    type: "scheduler.invocation",
    handlerId,
    handlerInfo: state.getActionTelemetryInfo(handler),
  });
  state.eventQueue.shift();

  // Ensure the handler's input docs are locally available before the body
  // runs (see EventHandler.presyncInputs). Fail open: a presync error should
  // surface as the handler's own read failure, not silently drop the event.
  if (typeof handler.presyncInputs === "function") {
    try {
      await handler.presyncInputs(eventValue);
    } catch (error) {
      logger.warn(
        "scheduler",
        "handler input presync failed; dispatching anyway",
        { error, handlerId },
      );
    }
  }

  const tx = state.runtime.edit();
  tx.dispatchedEventId = queuedEvent.id;
  tx.tx.immediate = true;
  tx.tx.sourceAction = action;
  if (queuedEvent.originTx !== undefined) {
    const originLocalSeq = state.getOriginLocalSeq(
      queuedEvent.originTx,
      queuedEvent.eventLink.space,
    );
    if (
      originLocalSeq !== undefined &&
      state.lineageStatus(queuedEvent.originTx) === "pending" &&
      state.runtime.experimental.commitPreconditions === true
    ) {
      tx.addCommitPrecondition?.(queuedEvent.eventLink.space, {
        kind: "origin-committed",
        originLocalSeq,
      });
    }
    state.releaseLineageEvent(queuedEvent.originTx, queuedEvent);
  }
  const actionId = state.getActionId(action);

  // Re-queue this event for an immediate re-run. This is the inSpace-name
  // resolution path (RetryImmediately): the run referenced a pattern space by
  // name that has now been resolved, so re-running resolves it synchronously from
  // the cache. No count guards this loop — name resolution is monotonic (each
  // re-run resolves at least one previously-unresolved name, and a resolved name
  // never becomes pending again), so a handler with finitely many distinct
  // inSpace names terminates. Dispatch released the lineage registration above,
  // so the fresh QueuedEvent must be re-recorded: otherwise an origin that fails
  // while the retry is queued cannot remove it, and the post-settlement
  // originStatus() fallback ("confirmed") would let a descendant of a failed
  // origin run.
  const requeueForNameResolution = () => {
    const requeued: QueuedEvent = {
      id: queuedEvent.id,
      originTx: queuedEvent.originTx,
      action,
      eventLink: queuedEvent.eventLink,
      handler,
      event: eventValue,
      retry,
      onCommit,
    };
    state.eventQueue.unshift(requeued);
    if (requeued.originTx !== undefined) {
      state.recordLineageEvent(requeued.originTx, requeued);
    }
    state.queueExecution();
  };

  // Re-queue a transient commit failure for a later retry. The retry is parked
  // via notBefore so the scheduler backs off (capped exponential delay) instead
  // of busy-looping; idle()/settled() wait for the parked head, so a converging
  // write still completes within a settle. The retry attempt count and deadline
  // are carried forward; `retry` is preserved untouched (it gates whether this
  // event retries at all, which a windowed re-queue does not change).
  const requeueForBackoff = (
    attempts: number,
    deadline: number,
    runAt: number,
  ) => {
    const requeued: QueuedEvent = {
      id: queuedEvent.id,
      originTx: queuedEvent.originTx,
      action,
      eventLink: queuedEvent.eventLink,
      handler,
      event: eventValue,
      retry,
      onCommit,
      retryAttempts: attempts,
      retryDeadline: deadline,
      notBefore: runAt,
    };
    state.eventQueue.unshift(requeued);
    if (requeued.originTx !== undefined) {
      state.recordLineageEvent(requeued.originTx, requeued);
    }
    state.queueExecution();
  };

  const runFinalCommitCallback = () => {
    if (!onCommit) {
      return;
    }
    try {
      onCommit(tx);
    } catch (callbackError) {
      logger.error(
        "schedule-error",
        "Error in event commit callback:",
        callbackError,
      );
    }
  };

  const finalize = (error?: unknown): void => {
    // A RetryImmediately signal means the handler referenced an inSpace("name")
    // target that has now been resolved into the runtime cache. Abort this run's
    // transaction and re-queue the event so the handler re-runs and resolves the
    // name synchronously.
    if (error instanceof RetryImmediately) {
      if (tx.status().status === "ready") {
        tx.abort(error);
      }
      if (retry) {
        requeueForNameResolution();
      } else {
        // retries: false is a one-shot; it does not re-run to resolve names.
        logger.warn(
          "scheduler",
          "Event handler needed inSpace-name resolution but opted out of " +
            "retry (retries: false); dropping",
          { handlerId },
        );
        runFinalCommitCallback();
      }
      return;
    }

    if (error) {
      try {
        state.handleError(error as Error, action);
      } finally {
        if (tx.status().status === "ready") {
          tx.abort(error);
        }
        // A throwing handler is a final outcome for this event — settle the
        // commit callback (with the aborted tx) instead of leaving callers
        // that await it hanging.
        runFinalCommitCallback();
      }
      return;
    }

    state.runtime.prepareTxForCommit(tx);
    const log = txToReactivityLog(tx);
    const telemetryWrites = log.writes
      .slice(0, EVENT_COMMIT_TELEMETRY_WRITE_LIMIT)
      .map(formatEventCommitAddress);
    // Do not await event commits here. commit() applies the transaction
    // locally before returning, and the scheduler must let later client work
    // continue against that speculative state while server confirmation is in
    // flight. Downstream dirtying below is based on those locally applied
    // changed writes, not server-confirmed durability. If the server rejects
    // the commit, dependent speculative transactions are rejected as well and
    // the normal retry path reruns the event. Durability is still observable:
    // commit() registers itself with the storage manager's pending-commit
    // barrier, which the client-facing idle (Scheduler.idleWithPendingCommits)
    // waits on without blocking the scheduler loop here.
    tx.commit().then((result) => {
      const permanentRejection =
        result.error && isPermanentRejection(result.error)
          ? (result.error as IPreconditionFailedError).precondition
          : undefined;
      // Classify the commit outcome. A committed write that represents user
      // intent must converge or fail loudly: a stale-basis rejection backs off
      // and retries within a bounded window rather than being dropped; a
      // permanent or non-stale-basis rejection is not retried; an unconverged
      // write surfaces a terminal error.
      const disposition = classifyCommitDisposition(
        result.error,
        queuedEvent,
        state.backpressure,
      );

      state.runtime.telemetry.submit({
        type: "scheduler.event.commit",
        handlerId,
        handlerInfo: state.getActionTelemetryInfo(handler),
        readCount: log.reads.length + log.shallowReads.length,
        writeCount: log.writes.length,
        changedWriteCount: log.writes.length,
        writes: telemetryWrites,
        ...(log.writes.length > EVENT_COMMIT_TELEMETRY_WRITE_LIMIT
          ? { writesTruncated: true }
          : {}),
        ...(result.error ? { error: result.error.message } : {}),
        ...(permanentRejection !== undefined ? { permanentRejection } : {}),
        ...(disposition.kind === "backoff"
          ? {
            retryAttempt: disposition.attempts,
            backoffMs: disposition.delayMs,
          }
          : {}),
        ...(disposition.kind === "convergence-failed"
          ? { retryAttempt: disposition.attempts, terminal: "convergence" }
          : {}),
        ...(disposition.kind === "permanent" ? { terminal: "permanent" } : {}),
        ...(disposition.kind === "terminal" ? { terminal: "rule" } : {}),
      });

      switch (disposition.kind) {
        case "success":
          runFinalCommitCallback();
          return;
        case "give-up":
          runFinalCommitCallback();
          logger.warn(
            "scheduler",
            disposition.reason === "non-retryable"
              ? "Event handler commit failed with a non-stale-basis rejection " +
                "that re-running cannot resolve; dropping the write without retry"
              : "Event handler commit failed and the caller opted out of " +
                "retry (retries: false); dropping the write",
            { error: result.error, handlerId },
          );
          return;
        case "backoff":
          logger.warn(
            "scheduler",
            `Event handler commit failed transiently; backing off ` +
              `${Math.round(disposition.delayMs)}ms ` +
              `(attempt ${disposition.attempts})`,
            { handlerId },
          );
          requeueForBackoff(
            disposition.attempts,
            disposition.deadline,
            disposition.runAt,
          );
          return;
        case "terminal":
          // A deterministic commit-rule refusal: run the final callback and
          // stop. No retry (would recompute the identical refused write) and no
          // handleError — the rejection is observable via the commit telemetry
          // marker (`terminal: "rule"`), mirroring the permanent path; surfacing
          // a scheduler error here is reserved for non-deterministic failures.
          runFinalCommitCallback();
          logger.warn(
            "scheduler",
            "Event handler commit terminally rejected (deterministic refusal); " +
              "not retrying",
            { error: result.error, handlerId },
          );
          return;
        case "permanent":
          runFinalCommitCallback();
          if (permanentRejection === "receipt-exists") {
            logger.warn(
              "event-lost-race",
              () => [
                "Event handling lost the receipt race",
                { eventId: queuedEvent.id, handlerId },
              ],
            );
          }
          logger.warn(
            "scheduler",
            "Event handler commit permanently rejected; not retrying",
            { error: result.error, handlerId, permanentRejection },
          );
          return;
        case "convergence-failed": {
          runFinalCommitCallback();
          logger.error(
            "commit-convergence-failed",
            () => [
              "Committed write did not converge within the retry window",
              { handlerId, attempts: disposition.attempts },
            ],
          );
          state.handleError(
            new CommitConvergenceError({
              handlerId,
              attempts: disposition.attempts,
              elapsedMs: disposition.elapsedMs,
              cause: result.error,
            }),
            action,
          );
          return;
        }
      }
    }).catch((error) => {
      logger.error(
        "schedule-error",
        "Event handler commit promise rejected:",
        error,
      );
    });
  };

  try {
    if (hasAnnotatedWrites(handler)) {
      recordTrustedEventPolicyInputs(tx, handler.writes, eventValue);
    }
    const actionStartTime = performance.now();
    logger.timeStart(
      "scheduler",
      "execute",
      "event",
      "handlerAction",
    );
    try {
      const runningPromise = Promise.resolve(
        state.runtime.harness.invoke(() => action(tx)),
      ).then(() => {
        const trustedEventCandidates =
          trustedEventWriteCandidatesFromTransaction(tx, handler, [
            queuedEvent.eventLink.space,
          ]);
        recordTrustedEventPolicyInputs(
          tx,
          trustedEventCandidates,
          eventValue,
        );
        const duration = (performance.now() - actionStartTime) / 1000;
        if (duration > 10) {
          console.warn(`Slow action: ${duration.toFixed(3)}s`, action);
        }
        logger.debug("action-timing", () => {
          return [
            `Action ${actionId} completed in ${duration.toFixed(3)}s`,
          ];
        });
        finalize();
      }).catch((error) => finalize(error));
      state.setRunningPromise(runningPromise);
      await runningPromise;
    } finally {
      logger.timeEnd(
        "scheduler",
        "execute",
        "event",
        "handlerAction",
      );
    }
  } catch (error) {
    finalize(error);
  }
}

function formatEventCommitAddress(address: {
  space: string;
  id: string;
  path: readonly string[];
}): string {
  return `${address.space}/${address.id}/${address.path.join("/")}`;
}

type CommitDisposition =
  | { kind: "success" }
  | { kind: "permanent" }
  | { kind: "terminal" }
  | {
    kind: "backoff";
    attempts: number;
    deadline: number;
    delayMs: number;
    runAt: number;
  }
  | { kind: "convergence-failed"; attempts: number; elapsedMs: number }
  | { kind: "give-up"; reason: "non-retryable" | "opt-out" };

/**
 * Decides what to do with an event-handler commit result.
 *
 *  - success: nothing more to do.
 *  - permanent: a commit-time precondition failure (receipt-exists,
 *    origin-committed). Re-running can never succeed and would double-handle the
 *    event, so it is never retried.
 *  - terminal: a deterministic server-side refusal of the committed data (a CFC
 *    row-label commit-rule violation, `isTerminalRejection`); never retried —
 *    re-running recomputes the identical refused write, and the doomed re-runs'
 *    speculative rev bumps would starve concurrent siblings. Surfaced as a
 *    terminal outcome (telemetry `terminal: "rule"`) rather than a silent drop.
 *  - give-up (reason "non-retryable"): a non-permanent rejection that is neither
 *    a stale basis nor a terminal commit-rule refusal — an authorization denial,
 *    a malformed store operation, a transport error, a handler `tx.abort()`.
 *    Re-running against fresher confirmed state cannot resolve it, so the write
 *    drops fast rather than burning the retry window on a rejection that will
 *    recur identically.
 *  - give-up (reason "opt-out"): the caller sent with `retries: false` (a
 *    speculative lineage origin, an internal one-shot) and opted out of retrying.
 *    The failed write drops deterministically so a descendant of a failed origin
 *    does not run.
 *  - backoff / convergence-failed: a stale-basis rejection — a server-side
 *    ConflictError under contention, or the local StorageTransactionInconsistent
 *    guard (the same-replica race the rehydration storm produces). Re-running the
 *    handler against fresh confirmed state and committing again can succeed, so a
 *    committed write that represents user intent backs off with capped
 *    exponential delay and retries until it lands or the retry window elapses,
 *    after which it surfaces a terminal CommitConvergenceError rather than being
 *    silently dropped. This is the backpressure path.
 *
 * Only a stale basis is windowed, because only a stale basis converges by
 * re-running: the confirmed timeline moved on, and reading it fresh resolves the
 * commit. StorageTransactionInconsistent is windowed unconditionally — the
 * generalization of an earlier version that windowed it only when the commit
 * carried a mergeable op, which made the mergeable-op gate unnecessary. Every
 * other non-permanent rejection is deterministic with respect to confirmed
 * state: retrying it would waste the whole window arriving at the same refusal
 * (and, for an authorization denial, retry a security denial), so it fails fast
 * with the permanent precondition failures. There is no fixed retry count either
 * way — a stale basis is bounded by the retry window, and a non-stale-basis
 * rejection drops on the first attempt.
 */
function classifyCommitDisposition(
  error: { name?: string } | undefined,
  queuedEvent: QueuedEvent,
  policy: CommitBackpressurePolicy,
): CommitDisposition {
  if (!error) {
    return { kind: "success" };
  }
  if (isPermanentRejection(error)) {
    return { kind: "permanent" };
  }
  // A deterministic commit-rule refusal is terminal, and distinct from the
  // fast-drop below: re-running recomputes the identical refused write (and the
  // doomed re-runs' speculative rev bumps would starve concurrent siblings), so
  // it must not back off, and it is surfaced as a terminal outcome (telemetry
  // `terminal: "rule"`) rather than a silent drop. Checked before the stale-basis
  // split because it is not a stale basis.
  if (isTerminalRejection(error)) {
    return { kind: "terminal" };
  }
  // Only a stale-basis rejection — a server-side ConflictError, or the local
  // StorageTransactionInconsistent guard — converges by re-running against
  // fresher confirmed state. Any other non-permanent rejection (authorization,
  // malformed store op, transport, handler abort) will recur identically, so it
  // drops fast rather than burning the retry window.
  const staleBasis = isConflictRejection(error) ||
    isStorageTransactionInconsistent(error);
  if (!staleBasis) {
    return { kind: "give-up", reason: "non-retryable" };
  }
  // A caller that sent with retries: false (a speculative lineage origin, an
  // internal one-shot) opted out of retrying; honor that so a descendant of a
  // failed origin drops deterministically. retries: true opts into the retry
  // window, which bounds the retries by time rather than by a count.
  if (!queuedEvent.retry) {
    return { kind: "give-up", reason: "opt-out" };
  }
  const attempts = (queuedEvent.retryAttempts ?? 0) + 1;
  const now = performance.now();
  const deadline = queuedEvent.retryDeadline ?? (now + policy.retryWindowMs);
  if (now >= deadline) {
    // The window is measured from the first failure (deadline minus window);
    // elapsed time is at least the full window.
    const elapsedMs = policy.retryWindowMs + (now - deadline);
    return { kind: "convergence-failed", attempts, elapsedMs };
  }
  // Exponential backoff from the first failure. The early steps are sub-5ms
  // (near-immediate), so a transient failure that clears once fresh state
  // arrives converges fast; the delay only grows into real spacing once the
  // failure persists.
  const delayMs = computeBackoffDelayMs(attempts, policy);
  return { kind: "backoff", attempts, deadline, delayMs, runAt: now + delayMs };
}
