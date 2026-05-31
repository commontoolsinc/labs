import { getLogger } from "@commonfabric/utils/logger";
import { getPersistentSchedulerStateConfig } from "@commonfabric/memory/v2";
import type { Runtime } from "../runtime.ts";
import { toMemorySpaceAddress } from "../link-utils.ts";
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
import { buildSchedulerActionObservation } from "./persistent-observation.ts";
import { filterIgnoredAddresses, txToReactivityLog } from "./reactivity.ts";
import {
  buildKnownSchedulingWrites,
  pruneStructuralAncestorWrites,
} from "./scheduling-writes.ts";
import { type ActionTimingState, recordActionTime } from "./timing.ts";
import type {
  Action,
  ActionRunTraceEntry,
  EventHandler,
  ReactivityLog,
  TelemetryAnnotations,
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
}, options: {
  readonly beforeCommit?: () => void;
} = {}): ReturnType<IExtendedStorageTransaction["commit"]> {
  logger.timeStart("scheduler", "run", "commit");
  state.runtime.prepareTxForCommit(state.tx);
  options.beforeCommit?.();
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
  readonly getCurrentKnownSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getHistoricalMightWrite: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getMaterializerWriteEnvelopes: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getDebounce: (action: Action) => number | undefined;
  readonly getNoDebounce: (action: Action) => boolean | undefined;
  readonly getThrottle: (action: Action) => number | undefined;
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
  let log: ReactivityLog | undefined;
  const commitPromise = startReactiveActionCommit({
    runtime: state.runtime,
    tx: args.tx,
  }, {
    beforeCommit: () => {
      log = txToReactivityLog(args.tx);
      attachSchedulerActionObservation(state, args, log);
    },
  });
  if (!log) {
    throw new Error("scheduler action commit did not build a reactivity log");
  }
  const committedLog = log;
  const changedComputationWrites = state.recordChangedComputationWrites(
    args.action,
    args.tx,
    committedLog,
  );
  watchReactiveActionCommit({
    action: args.action,
    tx: args.tx,
    log: committedLog,
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

  logger.debug("schedule-run-complete", () => [
    `[RUN] Action completed: ${args.actionId}`,
    `Reads: ${committedLog.reads.length}`,
    `Writes: ${committedLog.writes.length}`,
    `Elapsed: ${elapsed.toFixed(2)}ms`,
  ]);

  recordOptionalActionRunDiagnostics(state, args, committedLog, elapsed);

  logger.timeStart("scheduler", "run", "resubscribe");
  try {
    state.resubscribe(args.action, committedLog);
  } finally {
    logger.timeEnd("scheduler", "run", "resubscribe");
  }
  state.markReadersDirtyForChangedWrites(
    args.action,
    changedComputationWrites,
  );
  args.resolve(args.result);
}

function attachSchedulerActionObservation(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
    readonly tx: IExtendedStorageTransaction;
    readonly error?: unknown;
  },
  log: ReactivityLog,
): void {
  if (!getPersistentSchedulerStateConfig()) {
    return;
  }

  const observationTarget = args.tx.setSchedulerObservation
    ? args.tx
    : args.tx.tx;
  if (!observationTarget.setSchedulerObservation) {
    return;
  }

  const annotated = args.action as Partial<TelemetryAnnotations>;
  const ignoredSchedulingWrites = annotated.ignoredSchedulingWrites ?? [];
  const declaredWrites = sortAndCompactPaths(filterIgnoredAddresses(
    (annotated.writes ?? []).map(toMemorySpaceAddress),
    ignoredSchedulingWrites,
  ));
  const { newCurrentKnownWrites } = buildKnownSchedulingWrites({
    writes: pruneStructuralAncestorWrites(
      sortAndCompactPaths(
        filterIgnoredAddresses(log.writes, ignoredSchedulingWrites),
        false,
      ),
    ),
    declaredWrites,
    existingCurrentWrites: filterIgnoredAddresses(
      state.getCurrentKnownSchedulingWrites(args.action) ?? [],
      ignoredSchedulingWrites,
    ),
    existingHistoricalWrites: filterIgnoredAddresses(
      state.getHistoricalMightWrite(args.action) ?? [],
      ignoredSchedulingWrites,
    ),
  });
  const telemetry = state.getActionTelemetryInfo(args.action);
  const actionOptions = schedulerActionOptions(state, args.action);
  const observationIdentity = annotated.schedulerObservationIdentity;
  const observation = buildSchedulerActionObservation({
    ...(observationIdentity?.ownerSpace !== undefined
      ? { ownerSpace: observationIdentity.ownerSpace }
      : {}),
    branch: observationIdentity?.branch ?? "",
    pieceId: observationIdentity?.pieceId ??
      schedulerObservationPieceId(args.actionId, telemetry),
    processGeneration: observationIdentity?.processGeneration ?? 0,
    actionId: args.actionId,
    actionKind: state.isEffectAction.get(args.action)
      ? "effect"
      : "computation",
    implementationFingerprint: schedulerImplementationFingerprint(
      args.action,
      args.actionId,
      telemetry,
    ),
    runtimeFingerprint: schedulerRuntimeFingerprint(state.modeLabel()),
    // The memory engine overwrites this with the accepting head/commit seq.
    observedAtSeq: 0,
    transactionKind: "action-run",
    transactionLog: log,
    currentKnownWrites: newCurrentKnownWrites,
    declaredWrites,
    materializerWriteEnvelopes:
      state.getMaterializerWriteEnvelopes(args.action) ?? [],
    ignoredSchedulingWrites: filterIgnoredAddresses(
      (annotated.ignoredSchedulingWrites ?? []).map(toMemorySpaceAddress),
      [],
    ),
    ...(actionOptions ? { actionOptions } : {}),
    status: args.error ? "failed" : "success",
    ...(args.error
      ? { errorFingerprint: schedulerErrorFingerprint(args.error) }
      : {}),
  });

  try {
    observationTarget.setSchedulerObservation(observation);
  } catch (error) {
    if (isInactiveObservationTargetError(error)) {
      logger.debug("scheduler-observation-skipped", () => [
        `Action observation skipped for inactive transaction: ${args.actionId}`,
      ]);
      return;
    }
    throw error;
  }
}

function isInactiveObservationTargetError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error &&
    (
      error.name === "StorageTransactionAborted" ||
      error.name === "StorageTransactionCompleteError"
    );
}

function schedulerObservationPieceId(
  actionId: string,
  telemetry: SchedulerActionInfo | undefined,
): string {
  return [
    telemetry?.patternName,
    telemetry?.moduleName,
  ].filter((part): part is string => !!part).join(":") || `action:${actionId}`;
}

export function schedulerImplementationFingerprint(
  action: Action,
  actionId: string,
  telemetry: SchedulerActionInfo | undefined,
): string {
  // Prefer the per-module content-addressed identity when available: it is
  // stable across reloads, entry points, and TCB upgrades (see
  // docs/specs/module-loading.md). The `src` source location is only stable
  // within a single bundle layout, so it is the fallback.
  const implementationHash = (action as { implementationHash?: unknown })
    .implementationHash;
  if (typeof implementationHash === "string" && implementationHash.length > 0) {
    return `impl:${implementationHash}`;
  }
  const sourceId = (action as { src?: unknown }).src;
  if (typeof sourceId === "string" && sourceId.length > 0) {
    return `src:${sourceId}`;
  }
  const telemetryId = schedulerObservationPieceId(actionId, telemetry);
  return `action:${telemetryId}:${actionId}`;
}

export function schedulerRuntimeFingerprint(mode: "pull" | "push"): string {
  return `runner:scheduler:${mode}`;
}

function schedulerActionOptions(
  state: SchedulerActionRunState,
  action: Action,
) {
  const debounceMs = state.getDebounce(action);
  const noDebounce = state.getNoDebounce(action);
  const throttleMs = state.getThrottle(action);
  const options = {
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    ...(noDebounce !== undefined ? { noDebounce } : {}),
    ...(throttleMs !== undefined ? { throttleMs } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

function schedulerErrorFingerprint(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}:${error.message}`;
  }
  return String(error);
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
