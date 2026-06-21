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
import { isPermanentRejection } from "../storage/rejection.ts";
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
    retries: number,
    onCommit: QueuedEvent["onCommit"] | undefined,
    doNotLoadPieceIfNotRunning: boolean,
    opts?: { eventId?: string; originTx?: IExtendedStorageTransaction },
  ) => void;
  readonly recordLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
}

export function queueSchedulerEvent(state: SchedulerEventQueueState, args: {
  readonly eventLink: NormalizedFullLink;
  readonly event: unknown;
  readonly retries: number;
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
        retriesLeft: args.retries,
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
      }
    })();
    state.backgroundTasks.add(startTask);
    startTask.finally(() => {
      state.backgroundTasks.delete(startTask);
    });
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
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly scheduleWake: (notBefore: number) => void;
}, queuedEvent: QueuedEvent): EventDependencyPreflightResult {
  const { handler, event: eventValue } = queuedEvent;
  const preflightStats = createEventPreflightTraceContext();
  const dirtySizeBefore = countInvalidNodes(state.nodes);
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

function countInvalidNodes(nodes: NodeRegistry): number {
  let count = 0;
  for (const record of nodes.nodes()) {
    if (record.status === "invalid" || record.status === "never-ran") {
      count++;
    }
  }
  return count;
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
  const { action, handler, event: eventValue, retriesLeft, onCommit } =
    queuedEvent;
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

  // Requeue a retry of this event. Dispatch released the lineage
  // registration above, so the fresh QueuedEvent object must be re-recorded:
  // otherwise an origin that fails while the retry is queued cannot remove
  // it, and the post-settlement originStatus() fallback ("confirmed") would
  // let a descendant of a failed origin run.
  const requeueForRetry = () => {
    const retry: QueuedEvent = {
      id: queuedEvent.id,
      originTx: queuedEvent.originTx,
      action,
      eventLink: queuedEvent.eventLink,
      handler,
      event: eventValue,
      retriesLeft: retriesLeft - 1,
      onCommit,
    };
    state.eventQueue.unshift(retry);
    if (retry.originTx !== undefined) {
      state.recordLineageEvent(retry.originTx, retry);
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
      if (retriesLeft > 0) {
        requeueForRetry();
      } else {
        logger.error(
          "scheduler",
          "Event handler exhausted retries resolving inSpace names",
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
    // the normal retry path reruns the event.
    tx.commit().then((result) => {
      const permanentRejection =
        result.error && isPermanentRejection(result.error)
          ? (result.error as IPreconditionFailedError).precondition
          : undefined;
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
      });
      if (
        result.error && retriesLeft > 0 &&
        !isPermanentRejection(result.error)
      ) {
        logger.warn(
          "scheduler",
          `Event handler transaction failed, retrying (${retriesLeft} retries left)`,
          { error: result.error, handlerId },
        );
        requeueForRetry();
        return;
      }
      runFinalCommitCallback();
      if (result.error) {
        if (permanentRejection === "receipt-exists") {
          logger.warn(
            "event-lost-race",
            () => [
              "Event handling lost the receipt race",
              { eventId: queuedEvent.id, handlerId },
            ],
          );
        }
        logger.error(
          "schedule-error",
          "Event handler transaction failed after exhausting all retries",
          {
            error: result.error,
            handlerId,
            permanent: isPermanentRejection(result.error),
          },
        );
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
