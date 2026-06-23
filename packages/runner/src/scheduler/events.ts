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
  IMemorySpaceAddress,
  IPreconditionFailedError,
  MemorySpace,
} from "../storage/interface.ts";
import {
  isConflictRejection,
  isPermanentRejection,
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
import { createDirtyDependencyTraceContext } from "./diagnostics.ts";
import { mintEventId } from "./event-identity.ts";
import { planEventDirtyDependencyScheduling } from "./execution.ts";
import type { OriginStatus } from "./lineage.ts";
import { RetryImmediately } from "./retry-immediately.ts";
import {
  hasAnnotatedWrites,
  trustedEventWriteCandidatesFromTransaction,
  txToReactivityLog,
} from "./reactivity.ts";
import { collectChangedWritesForTransaction } from "./write-propagation.ts";
import type {
  Action,
  DirtyDependencyTraceContext,
  EventHandler,
  QueuedEvent,
  ReactivityLog,
} from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});
const EVENT_COMMIT_TELEMETRY_WRITE_LIMIT = 25;

export interface EventQueueWakeState {
  timer: ReturnType<typeof setTimeout> | null;
  wakeAt: number | null;
  readonly eventQueue: readonly QueuedEvent[];
  readonly isDisposed: () => boolean;
  readonly queueExecution: () => void;
}

export function scheduleEventQueueWake(
  state: EventQueueWakeState,
  notBefore: number,
): void {
  if (state.isDisposed()) return;
  if (
    state.wakeAt !== null && state.wakeAt <= notBefore &&
    state.timer !== null
  ) {
    return;
  }

  cancelEventQueueWake(state);

  const delay = Math.max(0, notBefore - performance.now());
  state.wakeAt = notBefore;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.wakeAt = null;
    state.queueExecution();
  }, delay);
}

export function cancelEventQueueWake(state: EventQueueWakeState): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.wakeAt = null;
}

export function hasEventQueueWakeTimer(state: EventQueueWakeState): boolean {
  return state.timer !== null;
}

export function isHeadEventParked(
  state: Pick<EventQueueWakeState, "eventQueue">,
  now: number = performance.now(),
): boolean {
  const headEvent = state.eventQueue[0];
  return headEvent?.notBefore !== undefined && headEvent.notBefore > now;
}

export interface EventDependencyPreflightResult {
  shouldSkipEvent: boolean;
  deps: ReactivityLog;
  dirtyDeps: Set<Action>;
  hasDirtyDependencies: boolean;
  dirtySizeBefore: number;
  pendingSizeBefore: number;
  populateMs: number;
  txToLogMs: number;
  depCommitMs: number;
  collectMs: number;
  scheduleMs: number;
  preflightStats: DirtyDependencyTraceContext;
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
  readonly dirty: ReadonlySet<Action>;
  readonly pending: Set<Action>;
  readonly backpressure: CommitBackpressurePolicy;
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
  readonly setDirtyDependencyTraceContext: (
    trace: DirtyDependencyTraceContext | undefined,
  ) => void;
  readonly collectDirtyDependenciesForLog: (
    deps: ReactivityLog,
    dirtyDeps: Set<Action>,
    memo: Map<Action, boolean>,
  ) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly scheduleEventQueueWake: (notBefore: number) => void;
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
  readonly snapshotDirtyDependencyTraceContext: (
    trace: DirtyDependencyTraceContext,
  ) => SchedulerEventPreflightStats;
  readonly onEventCommitWrites?: (
    sourceAction: Action,
    writes: readonly IMemorySpaceAddress[],
  ) => void;
}

export function preflightQueuedEventDependencies(state: {
  readonly runtime: Runtime;
  readonly eventQueue: QueuedEvent[];
  readonly dirty: ReadonlySet<Action>;
  readonly pending: ReadonlySet<Action>;
  readonly pendingActions: Set<Action>;
  readonly eventBlockingDeps: Set<Action>;
  readonly handleError: (error: Error, handler: EventHandler) => void;
  readonly setDirtyDependencyTraceContext: (
    trace: DirtyDependencyTraceContext | undefined,
  ) => void;
  readonly collectDirtyDependenciesForLog: (
    deps: ReactivityLog,
    dirtyDeps: Set<Action>,
    memo: Map<Action, boolean>,
  ) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly scheduleEventQueueWake: (notBefore: number) => void;
}, queuedEvent: QueuedEvent): EventDependencyPreflightResult {
  const { handler, event: eventValue } = queuedEvent;
  const preflightStats = createDirtyDependencyTraceContext();
  const dirtySizeBefore = state.dirty.size;
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

  const dirtyDeps = new Set<Action>();
  const dirtyDepMemo = new Map<Action, boolean>();
  stepStart = performance.now();
  logger.timeStart(
    "scheduler",
    "execute",
    "event",
    "pullCollectDirtyDependencies",
  );
  let hasDirtyDependencies = false;
  state.setDirtyDependencyTraceContext(preflightStats);
  try {
    hasDirtyDependencies = state.collectDirtyDependenciesForLog(
      deps,
      dirtyDeps,
      dirtyDepMemo,
    );
  } finally {
    state.setDirtyDependencyTraceContext(undefined);
    logger.timeEnd(
      "scheduler",
      "execute",
      "event",
      "pullCollectDirtyDependencies",
    );
  }
  collectMs = performance.now() - stepStart;

  if (!shouldSkipEvent && hasDirtyDependencies) {
    stepStart = performance.now();
    logger.timeStart(
      "scheduler",
      "execute",
      "event",
      "pullScheduleDirtyDependencies",
    );
    try {
      const eventDirtyPlan = planEventDirtyDependencyScheduling({
        dirtyDeps,
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
        state.scheduleEventQueueWake(eventDirtyPlan.nextEligibleAt);
        shouldSkipEvent = true;
      }
    } finally {
      logger.timeEnd(
        "scheduler",
        "execute",
        "event",
        "pullScheduleDirtyDependencies",
      );
    }
    scheduleMs = performance.now() - stepStart;
  }

  return {
    shouldSkipEvent,
    deps,
    dirtyDeps,
    hasDirtyDependencies,
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
  readonly onEventCommitWrites?: (
    sourceAction: Action,
    writes: readonly IMemorySpaceAddress[],
  ) => void;
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

  // Re-queue a transient commit conflict for a later retry. The retry is parked
  // via notBefore so the scheduler backs off (capped exponential delay) instead
  // of busy-looping; idle()/settled() wait for the parked head, so a converging
  // write still completes within a settle. The conflict attempt count and
  // deadline are carried forward; retriesLeft is preserved untouched because it
  // is the separate budget for inSpace-name resolution (RetryImmediately), not
  // for conflicts.
  const requeueForBackoff = (
    attempts: number,
    deadline: number,
    runAt: number,
    delayMs: number,
  ) => {
    const retry: QueuedEvent = {
      id: queuedEvent.id,
      originTx: queuedEvent.originTx,
      action,
      eventLink: queuedEvent.eventLink,
      handler,
      event: eventValue,
      retriesLeft,
      onCommit,
      conflictAttempts: attempts,
      conflictDeadline: deadline,
      // An immediate retry (delayMs 0) is not parked: it re-runs on the next
      // execute cycle like the pre-backpressure fast path. Only a delayed retry
      // sets notBefore to hold the head until its timer fires.
      ...(delayMs > 0 ? { notBefore: runAt } : {}),
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
    const changedWrites = collectChangedWritesForTransaction(tx, log);
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
      if (!result.error && changedWrites.length > 0) {
        state.onEventCommitWrites?.(action, changedWrites);
      }

      // Classify the commit outcome. A committed write that represents user
      // intent must converge or fail loudly: a transient conflict backs off and
      // retries within a bounded window rather than being dropped after a fixed
      // budget; a permanent rejection is never retried; an unconverged write
      // surfaces a terminal error.
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
        changedWriteCount: changedWrites.length,
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
      });

      switch (disposition.kind) {
        case "success":
          runFinalCommitCallback();
          return;
        case "bounded-retry":
          logger.warn(
            "scheduler",
            `Event handler transaction failed, retrying ` +
              `(${retriesLeft} retries left)`,
            { error: result.error, handlerId },
          );
          requeueForRetry();
          return;
        case "give-up":
          runFinalCommitCallback();
          logger.error(
            "schedule-error",
            "Event handler transaction failed after exhausting all retries",
            { error: result.error, handlerId, permanent: false },
          );
          return;
        case "backoff":
          logger.warn(
            "scheduler",
            disposition.delayMs > 0
              ? `Event handler commit conflicted; backing off ` +
                `${Math.round(disposition.delayMs)}ms ` +
                `(attempt ${disposition.attempts})`
              : `Event handler commit conflicted; retrying immediately ` +
                `(attempt ${disposition.attempts})`,
            { handlerId },
          );
          requeueForBackoff(
            disposition.attempts,
            disposition.deadline,
            disposition.runAt,
            disposition.delayMs,
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
  | {
    kind: "backoff";
    attempts: number;
    deadline: number;
    delayMs: number;
    runAt: number;
  }
  | { kind: "convergence-failed"; attempts: number; elapsedMs: number }
  | { kind: "bounded-retry" }
  | { kind: "give-up" };

/**
 * Decides what to do with an event-handler commit result.
 *
 *  - success: nothing more to do.
 *  - permanent: a precondition failure; never retried.
 *  - backoff / convergence-failed: a stale-basis ConflictError under
 *    contention. It backs off and retries until it lands or the retry window
 *    elapses, after which it fails terminally rather than being silently
 *    dropped. This is the backpressure path.
 *  - bounded-retry / give-up: any other transient error (a handler-initiated
 *    abort, a system error). These are not contention, so backpressure would
 *    not help; they keep the fixed retriesLeft budget and stop after it.
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
  if (!isConflictRejection(error)) {
    return queuedEvent.retriesLeft > 0
      ? { kind: "bounded-retry" }
      : { kind: "give-up" };
  }
  // A caller that sent with retries:0 (a speculative lineage origin, an internal
  // one-shot) opted out of retrying; honor that so a descendant of a failed
  // origin drops deterministically. Any positive budget opts into retry-on-
  // conflict, which the retry window then governs — the exact count no longer
  // bounds conflict retries, the window does.
  if (queuedEvent.retriesLeft <= 0) {
    return { kind: "give-up" };
  }
  const attempts = (queuedEvent.conflictAttempts ?? 0) + 1;
  const now = performance.now();
  const deadline = queuedEvent.conflictDeadline ?? (now + policy.retryWindowMs);
  if (now >= deadline) {
    // The window is measured from the first conflict (deadline minus window);
    // elapsed time is at least the full window.
    const elapsedMs = policy.retryWindowMs + (now - deadline);
    return { kind: "convergence-failed", attempts, elapsedMs };
  }
  // A stale-basis conflict usually clears the moment the fresh confirmed state
  // arrives, so the first `immediateRetries` retries fire with no delay — the
  // fast path that lets a transient conflict converge without stretching the
  // wall-clock. Only once those are exhausted (sustained contention) does
  // backoff begin, with its exponent counted from the first delayed retry.
  const delayMs = attempts <= policy.immediateRetries
    ? 0
    : computeBackoffDelayMs(attempts - policy.immediateRetries, policy);
  return { kind: "backoff", attempts, deadline, delayMs, runAt: now + delayMs };
}
