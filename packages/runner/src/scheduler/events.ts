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
  SchedulerActionInfo,
  SchedulerEventPreflightStats,
} from "../telemetry.ts";
import { createDirtyDependencyTraceContext } from "./diagnostics.ts";
import { planEventDirtyDependencyScheduling } from "./execution.ts";
import {
  hasAnnotatedWrites,
  trustedEventWriteCandidatesFromTransaction,
  txToReactivityLog,
} from "./reactivity.ts";
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

export function queueSchedulerEvent(state: {
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
  ) => void;
}, args: {
  readonly eventLink: NormalizedFullLink;
  readonly event: unknown;
  readonly retries: number;
  readonly onCommit?: QueuedEvent["onCommit"];
  readonly doNotLoadPieceIfNotRunning: boolean;
}): void {
  let handlerFound = false;

  for (const [link, handler] of state.eventHandlers) {
    if (areNormalizedLinksSame(link, args.eventLink)) {
      handlerFound = true;
      state.queueExecution();
      state.eventQueue.push({
        eventLink: args.eventLink,
        action: (tx) => handler(tx, args.event),
        handler,
        event: args.event,
        retriesLeft: args.retries,
        onCommit: args.onCommit,
      });
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
  state.eventHandlers.push([args.ref, args.handler]);
  return () => {
    const index = state.eventHandlers.findIndex(([r, h]) =>
      r === args.ref && h === args.handler
    );
    if (index !== -1) state.eventHandlers.splice(index, 1);
  };
}

export async function processQueuedEventDuringExecute(state: {
  readonly runtime: Runtime;
  readonly eventQueue: QueuedEvent[];
  readonly pullMode: boolean;
  readonly dirty: ReadonlySet<Action>;
  readonly pending: Set<Action>;
  readonly eventBlockingDeps: Set<Action>;
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
  readonly snapshotDirtyDependencyTraceContext: (
    trace: DirtyDependencyTraceContext,
  ) => SchedulerEventPreflightStats;
}): Promise<void> {
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

  const { handler } = queuedEvent;
  const handlerId = state.getActionId(handler);

  // In pull mode, ensure handler dependencies are computed before running.
  let shouldSkipEvent = false;
  if (state.pullMode && handler.populateDependencies) {
    const preflight = preflightQueuedEventDependencies({
      runtime: state.runtime,
      eventQueue: state.eventQueue,
      dirty: state.dirty,
      pending: state.pending,
      pendingActions: state.pending,
      eventBlockingDeps: state.eventBlockingDeps,
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
    setRunningPromise: (promise) => {
      state.setRunningPromise(promise);
    },
    getActionId: (target) => state.getActionId(target),
    getActionTelemetryInfo: (target) => state.getActionTelemetryInfo(target),
    handleError: (error, target) => state.handleError(error, target),
    queueExecution: () => state.queueExecution(),
  }, queuedEvent);
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
  readonly setRunningPromise: (promise: Promise<unknown>) => void;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getActionTelemetryInfo: (
    handler: EventHandler,
  ) => SchedulerActionInfo | undefined;
  readonly handleError: (error: Error, action: Action) => void;
  readonly queueExecution: () => void;
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

  const tx = state.runtime.edit();
  tx.tx.immediate = true;
  const actionId = state.getActionId(action);
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

  const finalize = (error?: unknown) => {
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
    tx.commit().then((result) => {
      if (result.error && retriesLeft > 0) {
        logger.warn(
          "scheduler",
          `Event handler transaction failed, retrying (${retriesLeft} retries left)`,
          { error: result.error, handlerId },
        );
        state.eventQueue.unshift({
          action,
          eventLink: queuedEvent.eventLink,
          handler,
          event: eventValue,
          retriesLeft: retriesLeft - 1,
          onCommit,
        });
        state.queueExecution();
        return;
      }
      runFinalCommitCallback();
      if (result.error) {
        logger.error(
          "schedule-error",
          "Event handler transaction failed after exhausting all retries",
          { error: result.error, handlerId },
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
