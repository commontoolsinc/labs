import { getLogger } from "@commonfabric/utils/logger";
import type { Runtime } from "../runtime.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageTransaction,
} from "../storage/interface.ts";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import {
  MAX_ACTION_RUN_TRACE_HISTORY,
  MAX_RETRIES_FOR_REACTIVE,
} from "./constants.ts";
import {
  captureDiagnosisRecord,
  type DiagnosisRecord,
  runIdempotencyRecheck,
} from "./diagnosis.ts";
import { toActionRunTraceAddress } from "./diagnostics.ts";
import { txToReactivityLog } from "./reactivity.ts";
import { type ActionTimingState, recordActionTime } from "./timing.ts";
import type {
  Action,
  ActionRunTraceEntry,
  EventHandler,
  ReactivityLog,
} from "./types.ts";
import type { NonIdempotentReport, SchedulerActionInfo } from "../telemetry.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export type ActionInvocationResult =
  | { ok: true; result: any }
  | { ok: false; error: unknown };

export interface InFlightSourceState {
  readonly inFlightSources: WeakMap<Action, Set<IStorageTransaction>>;
}

export function addInFlightSource(
  state: InFlightSourceState,
  action: Action,
  source: IStorageTransaction,
): void {
  let sources = state.inFlightSources.get(action);
  if (!sources) {
    sources = new Set<IStorageTransaction>();
    state.inFlightSources.set(action, sources);
  }
  sources.add(source);
}

export function removeInFlightSource(
  state: InFlightSourceState,
  action: Action,
  source: IStorageTransaction,
): void {
  const sources = state.inFlightSources.get(action);
  if (!sources) return;
  sources.delete(source);
  if (sources.size === 0) {
    state.inFlightSources.delete(action);
  }
}

export function invokeReactiveAction(state: {
  readonly runtime: Runtime;
  readonly setExecutingAction: (action: Action, actionId: string) => void;
  readonly clearExecutingAction: () => void;
}, args: {
  readonly action: Action;
  readonly actionId: string;
  readonly tx: IExtendedStorageTransaction;
  readonly actionStartTime: number;
}): Promise<ActionInvocationResult> {
  try {
    // Track executing action for parent-child relationship tracking.
    state.setExecutingAction(args.action, args.actionId);
    logger.timeStart("scheduler", "run", "action");
    return Promise.resolve(
      state.runtime.harness.invoke(() => args.action(args.tx)),
    )
      .then((actionResult) => {
        logger.timeEnd("scheduler", "run", "action");
        state.clearExecutingAction();
        logger.debug("schedule-action-timing", () => {
          const duration = ((performance.now() - args.actionStartTime) / 1000)
            .toFixed(3);
          return [
            `Action ${args.actionId} completed in ${duration}s`,
          ];
        });
        return { ok: true as const, result: actionResult };
      })
      .catch((error) => {
        logger.timeEnd("scheduler", "run", "action");
        state.clearExecutingAction();
        return { ok: false as const, error };
      });
  } catch (error) {
    logger.timeEnd("scheduler", "run", "action");
    state.clearExecutingAction();
    return Promise.resolve({ ok: false as const, error });
  }
}

export function startReactiveActionCommit(state: {
  readonly runtime: Runtime;
  readonly tx: IExtendedStorageTransaction;
}): ReturnType<IExtendedStorageTransaction["commit"]> {
  logger.timeStart("scheduler", "run", "commit");
  state.runtime.prepareTxForCommit(state.tx);
  const commitPromise = state.tx.commit();
  logger.timeEnd("scheduler", "run", "commit");
  return commitPromise;
}

export function watchReactiveActionCommit(state: {
  readonly action: Action;
  readonly tx: IExtendedStorageTransaction;
  readonly log: ReactivityLog;
  readonly retries: WeakMap<Action, number>;
  readonly pending: Set<Action>;
  readonly commitPromise: ReturnType<IExtendedStorageTransaction["commit"]>;
  readonly resubscribe: (action: Action, log: ReactivityLog) => void;
  readonly markDirectDirty: (action: Action) => void;
  readonly queueExecution: () => void;
  readonly removeInFlightSource: (
    action: Action,
    tx: IExtendedStorageTransaction["tx"],
  ) => void;
}): void {
  state.commitPromise.then(({ error }) => {
    // On error, retry up to MAX_RETRIES_FOR_REACTIVE times. Note that
    // on every attempt we still call the re-subscribe below, so that
    // even after we run out of retries, this will be re-triggered when
    // input data changes.
    if (error) {
      logger.info(
        "schedule-run-error",
        "Error committing transaction",
        error,
      );

      const retries = (state.retries.get(state.action) ?? 0) + 1;
      state.retries.set(state.action, retries);
      if (retries < MAX_RETRIES_FOR_REACTIVE) {
        // Re-schedule the action to run again on conflict failure.
        // Use resubscribe to set up dependencies/triggers from the log,
        // then mark as dirty/pending to ensure it runs again.
        state.resubscribe(state.action, state.log);
        state.markDirectDirty(state.action);
        state.pending.add(state.action);
        state.queueExecution();
      }
    } else {
      // Clear retries after successful commit.
      state.retries.delete(state.action);
    }
  }).finally(() => {
    state.removeInFlightSource(state.action, state.tx.tx);
  }).catch((error) => {
    logger.error(
      "schedule-error",
      "Commit promise rejected in finalizeAction:",
      error,
    );
  });
}

export function appendActionRunTrace(state: {
  readonly actionRunTrace: ActionRunTraceEntry[];
  readonly actionParent: WeakMap<Action, Action>;
  readonly isEffectAction: WeakMap<Action, boolean>;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
}, args: {
  readonly action: Action;
  readonly actionId: string;
  readonly durationMs: number;
  readonly log: ReactivityLog;
  readonly recordedAt?: number;
  readonly maxHistory?: number;
}): void {
  const parentAction = state.actionParent.get(args.action);
  const declaredWrites = (state.getSchedulingWrites(args.action) ?? []).map(
    toActionRunTraceAddress,
  );
  const actualWrites = sortAndCompactPaths(args.log.writes).map(
    toActionRunTraceAddress,
  );

  state.actionRunTrace.push({
    recordedAt: args.recordedAt ?? performance.now(),
    actionId: args.actionId,
    actionType: state.isEffectAction.get(args.action)
      ? "effect"
      : "computation",
    parentActionId: parentAction ? state.getActionId(parentAction) : undefined,
    durationMs: args.durationMs,
    declaredWrites,
    actualWrites,
  });
  if (
    state.actionRunTrace.length >
      (args.maxHistory ?? MAX_ACTION_RUN_TRACE_HISTORY)
  ) {
    state.actionRunTrace.shift();
  }
}

export interface SchedulerActionRunState {
  readonly runtime: Runtime;
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly inFlightSourceState: InFlightSourceState;
  readonly actionTimingState: ActionTimingState;
  readonly pullDemandedFirstRunComputations: WeakSet<Action>;
  readonly pullDemandedContinuationComputations: WeakSet<Action>;
  readonly retries: WeakMap<Action, number>;
  readonly pending: Set<Action>;
  readonly actionRunTrace: ActionRunTraceEntry[];
  readonly actionParent: WeakMap<Action, Action>;
  readonly isEffectAction: WeakMap<Action, boolean>;
  readonly diagnosisHistory: Map<string, DiagnosisRecord[]>;
  readonly diagnosisNonIdempotent: NonIdempotentReport[];
  readonly idempotencyViolations: NonIdempotentReport[];
  readonly getRunningPromise: () => Promise<unknown> | undefined;
  readonly setRunningPromise: (promise: Promise<unknown>) => void;
  readonly modeLabel: () => "pull" | "push";
  readonly getCollectActionRunTrace: () => boolean;
  readonly getDiagnosisEnabled: () => boolean;
  readonly getIdempotencyCheckMode: () => boolean;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getActionTelemetryInfo: (
    action: Action | EventHandler,
  ) => SchedulerActionInfo | undefined;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly maybeAutoDebounce: (action: Action) => void;
  readonly markActionHasRun: (action: Action) => void;
  readonly handleError: (error: Error, action: Action) => void;
  readonly resubscribe: (action: Action, log: ReactivityLog) => void;
  readonly markDirectDirty: (action: Action) => void;
  readonly recordChangedComputationWrites: (
    action: Action,
    tx: IExtendedStorageTransaction,
    log: ReactivityLog,
  ) => IMemorySpaceAddress[];
  readonly markReadersDirtyForChangedWrites: (
    sourceAction: Action,
    changedWrites: readonly IMemorySpaceAddress[],
  ) => void;
  readonly queueExecution: () => void;
  readonly setExecutingAction: (action: Action, actionId: string) => void;
  readonly clearExecutingAction: () => void;
}

export async function runSchedulerAction(
  state: SchedulerActionRunState,
  action: Action,
): Promise<any> {
  logger.timeStart("scheduler", "run");
  const actionId = state.getActionId(action);
  state.runtime.telemetry.submit({
    type: "scheduler.run",
    actionId,
    actionInfo: state.getActionTelemetryInfo(action),
  });

  logger.debug("schedule-run-start", () => [
    `[RUN] Starting action: ${actionId}`,
    `Scheduler mode: ${state.modeLabel()}`,
  ]);

  const runningPromise = state.getRunningPromise();
  if (runningPromise) await runningPromise;

  const tx = state.runtime.edit({
    changeGroup: state.actionChangeGroups.get(action),
  });
  (tx.tx as { debugActionId?: string }).debugActionId = actionId;
  addInFlightSource(state.inFlightSourceState, action, tx.tx);
  const actionStartTime = performance.now();

  let result: any;
  const nextRunningPromise = new Promise((resolve) => {
    const finalizeAction = (error?: unknown) => {
      finalizeSchedulerAction(state, {
        action,
        actionId,
        tx,
        actionStartTime,
        result,
        error,
        resolve,
      });
    };

    invokeReactiveAction({
      runtime: state.runtime,
      setExecutingAction: state.setExecutingAction,
      clearExecutingAction: state.clearExecutingAction,
    }, {
      action,
      actionId,
      tx,
      actionStartTime,
    })
      .then((invocation) => {
        if (invocation.ok) {
          result = invocation.result;
          finalizeAction();
        } else {
          finalizeAction(invocation.error);
        }
      })
      .catch((error) => {
        finalizeAction(error);
      });
  });
  state.setRunningPromise(nextRunningPromise);

  return nextRunningPromise.then((result) => {
    logger.timeEnd("scheduler", "run");
    return result;
  });
}

function finalizeSchedulerAction(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
    readonly tx: IExtendedStorageTransaction;
    readonly actionStartTime: number;
    readonly result: unknown;
    readonly error?: unknown;
    readonly resolve: (value: unknown) => void;
  },
): void {
  // Record action execution time for cycle-aware scheduling
  const elapsed = performance.now() - args.actionStartTime;
  recordActionTime(state.actionTimingState, args.action, elapsed);
  state.maybeAutoDebounce(args.action);
  state.markActionHasRun(args.action);
  state.pullDemandedFirstRunComputations.delete(args.action);
  state.pullDemandedContinuationComputations.delete(args.action);

  try {
    if (args.error) {
      logger.error("schedule-error", () => [
        `[RUN] Action failed: ${args.actionId}`,
        `Error: ${args.error}`,
      ]);
      state.handleError(normalizeThrownError(args.error), args.action);
    }
  } finally {
    finalizeReactiveActionCommit(state, args, elapsed);
  }
}

function normalizeThrownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function finalizeReactiveActionCommit(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
    readonly tx: IExtendedStorageTransaction;
    readonly result: unknown;
    readonly resolve: (value: unknown) => void;
  },
  elapsed: number,
): void {
  // Set up new reactive subscriptions after the action runs

  // Commit the transaction. The code continues synchronously after
  // kicking off the commit, i.e. it assumes the commit will be
  // successful. If it isn't, the data will be rolled back and all other
  // reactive functions based on it will be retriggered. But also, the
  // retry logic below will have re-scheduled this action, so
  // topological sorting should move it before the dependencies.
  const commitPromise = startReactiveActionCommit({
    runtime: state.runtime,
    tx: args.tx,
  });
  const log = txToReactivityLog(args.tx);
  watchReactiveActionCommit({
    action: args.action,
    tx: args.tx,
    log,
    retries: state.retries,
    pending: state.pending,
    commitPromise,
    resubscribe: state.resubscribe,
    markDirectDirty: state.markDirectDirty,
    queueExecution: state.queueExecution,
    removeInFlightSource: (target, source) =>
      removeInFlightSource(
        state.inFlightSourceState,
        target,
        source,
      ),
  });
  const changedComputationWrites = state.recordChangedComputationWrites(
    args.action,
    args.tx,
    log,
  );

  logger.debug("schedule-run-complete", () => [
    `[RUN] Action completed: ${args.actionId}`,
    `Reads: ${log.reads.length}`,
    `Writes: ${log.writes.length}`,
    `Elapsed: ${elapsed.toFixed(2)}ms`,
  ]);

  recordOptionalActionRunDiagnostics(state, args, log, elapsed);

  logger.timeStart("scheduler", "run", "resubscribe");
  try {
    state.resubscribe(args.action, log);
  } finally {
    logger.timeEnd("scheduler", "run", "resubscribe");
  }
  state.markReadersDirtyForChangedWrites(
    args.action,
    changedComputationWrites,
  );
  args.resolve(args.result);
}

function recordOptionalActionRunDiagnostics(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
    readonly tx: IExtendedStorageTransaction;
  },
  log: ReactivityLog,
  elapsed: number,
): void {
  if (state.getCollectActionRunTrace()) {
    appendActionRunTrace({
      actionRunTrace: state.actionRunTrace,
      actionParent: state.actionParent,
      isEffectAction: state.isEffectAction,
      getActionId: state.getActionId,
      getSchedulingWrites: state.getSchedulingWrites,
    }, {
      action: args.action,
      actionId: args.actionId,
      durationMs: elapsed,
      log,
    });
  }

  // Diagnosis capture: record read/write values for idempotency checking
  if (state.getDiagnosisEnabled()) {
    captureDiagnosisRecord({
      diagnosisHistory: state.diagnosisHistory,
      diagnosisNonIdempotent: state.diagnosisNonIdempotent,
      createReadTx: () => state.runtime.edit(),
      getActionTelemetryInfo: state.getActionTelemetryInfo,
    }, {
      actionId: args.actionId,
      action: args.action,
      tx: args.tx,
      log,
    });
  }

  // Inline idempotency re-run: when the mode is on, every
  // computation gets a second synchronous run against post-commit
  // state. An idempotent computation produces the same writes
  // both times. Uses isEffectAction (persists past unsubscribe)
  // since execute() calls unsubscribe() before run().
  if (
    state.getIdempotencyCheckMode() &&
    !state.isEffectAction.get(args.action)
  ) {
    logger.timeStart("scheduler", "run", "idempotencyRecheck");
    try {
      runIdempotencyRecheck(
        {
          idempotencyViolations: state.idempotencyViolations,
          createTx: () => state.runtime.edit(),
          invoke: (fn) => state.runtime.harness.invoke(fn),
          getActionId: state.getActionId,
          getActionTelemetryInfo: state.getActionTelemetryInfo,
        },
        args.action,
        args.tx,
        log,
      );
    } finally {
      logger.timeEnd("scheduler", "run", "idempotencyRecheck");
    }
  }
}
