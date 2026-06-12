import { getLogger } from "@commonfabric/utils/logger";
import { getPersistentSchedulerStateConfig } from "@commonfabric/memory/v2";
import type { Runtime } from "../runtime.ts";
import { toMemorySpaceAddress } from "../link-utils.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { isPermanentRejection } from "../storage/rejection.ts";
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
import { RetryImmediately } from "./retry-immediately.ts";
import { toActionRunTraceAddress } from "./diagnostics.ts";
import { buildSchedulerActionObservation } from "./persistent-observation.ts";
import { filterIgnoredAddresses, txToReactivityLog } from "./reactivity.ts";
import { type ActionTimingState, recordActionTime } from "./timing.ts";
import type { NodeRegistry } from "./node-record.ts";
import { restoreInvalidCauses, takeInvalidCauses } from "./invalidation.ts";
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
  readonly markInvalid: (action: Action) => void;
  readonly queueExecution: () => void;
  readonly restoreInvalidCauses: () => void;
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
      if (
        retries < MAX_RETRIES_FOR_REACTIVE && !isPermanentRejection(error)
      ) {
        // Re-schedule the action to run again on conflict failure.
        // Use resubscribe to set up dependencies/triggers from the log,
        // then mark as invalid/pending to ensure it runs again.
        // The retry run still exists only because of the consumed trigger
        // reads (§8.9.2), so restore them for its transaction.
        state.restoreInvalidCauses();
        state.resubscribe(state.action, state.log);
        state.markInvalid(state.action);
        state.pending.add(state.action);
        state.queueExecution();
      } else {
        // WATCH(scheduler-v2): exhausted retries can leave a piece registered
        // against rolled-back data (accepted zombie — spec §15 decision 9).
      }
    } else {
      // Clear retries after successful commit.
      state.retries.delete(state.action);
    }
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
  readonly nodes: NodeRegistry;
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
  const parentAction = state.nodes.parentActionOf(args.action);
  const declaredWrites = (state.getSchedulingWrites(args.action) ?? []).map(
    toActionRunTraceAddress,
  );
  const actualWrites = sortAndCompactPaths(args.log.writes).map(
    toActionRunTraceAddress,
  );

  state.actionRunTrace.push({
    recordedAt: args.recordedAt ?? performance.now(),
    actionId: args.actionId,
    actionType: state.nodes.isKnownEffect(args.action)
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
  readonly actionTimingState: ActionTimingState;
  readonly retries: WeakMap<Action, number>;
  readonly pending: Set<Action>;
  readonly actionRunTrace: ActionRunTraceEntry[];
  readonly nodes: NodeRegistry;
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
  readonly getMaterializerWriteEnvelopes: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getDebounce: (action: Action) => number | undefined;
  readonly getNoDebounce: (action: Action) => boolean | undefined;
  readonly getThrottle: (action: Action) => number | undefined;
  readonly maybeAutoDebounce: (action: Action) => void;
  readonly markActionHasRun: (action: Action) => void;
  readonly markNodeHasRun: (action: Action) => void;
  readonly handleError: (error: Error, action: Action) => void;
  readonly resubscribe: (action: Action, log: ReactivityLog) => void;
  readonly markInvalid: (action: Action) => void;
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
  const record = state.nodes.get(action);
  const invalidCauses = record ? takeInvalidCauses(record) : undefined;
  if (record) {
    state.nodes.setStatus(action, "clean");
  }
  // §8.9.2 trigger reads: hand the addresses whose changes scheduled this
  // run to the transaction so flow-label derivation can taint its writes
  // even when this run's branch never re-reads them. Consumed once; if the
  // run aborts and is retried (RetryImmediately, commit conflict) the
  // consumed addresses are restored below so the retry inherits them.
  if (invalidCauses !== undefined && invalidCauses.length > 0) {
    tx.addCfcTriggerReads(invalidCauses);
  }
  (tx.tx as { debugActionId?: string }).debugActionId = actionId;
  tx.tx.sourceAction = action;
  const actionStartTime = performance.now();

  let result: any;
  const nextRunningPromise = new Promise((resolve) => {
    const finalizeAction = (error?: unknown) => {
      finalizeSchedulerAction(state, {
        action,
        actionId,
        tx,
        actionStartTime,
        invalidCauses,
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
    readonly invalidCauses: readonly IMemorySpaceAddress[] | undefined;
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
  state.markNodeHasRun(args.action);

  // A RetryImmediately signal means the action referenced an inSpace("name")
  // target that has now been resolved into the runtime cache. Abort this run's
  // transaction and re-run the action so it resolves the name synchronously.
  if (args.error instanceof RetryImmediately) {
    rescheduleActionForImmediateRetry(state, args);
    return;
  }

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

function rescheduleActionForImmediateRetry(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
    readonly tx: IExtendedStorageTransaction;
    readonly invalidCauses: readonly IMemorySpaceAddress[] | undefined;
    readonly error?: unknown;
    readonly resolve: (value: unknown) => void;
  },
): void {
  if (args.tx.status().status === "ready") args.tx.abort(args.error);
  const retries = (state.retries.get(args.action) ?? 0) + 1;
  state.retries.set(args.action, retries);
  if (retries < MAX_RETRIES_FOR_REACTIVE) {
    // The retry run still exists only because of the consumed trigger
    // reads (§8.9.2); restore them so its transaction joins their labels.
    const record = state.nodes.get(args.action);
    if (
      record &&
      args.invalidCauses !== undefined &&
      args.invalidCauses.length > 0
    ) {
      restoreInvalidCauses(state.nodes, args.action, args.invalidCauses);
    }
    state.markInvalid(args.action);
    state.pending.add(args.action);
    state.queueExecution();
  } else {
    // WATCH(scheduler-v2): exhausted retries can leave a piece registered
    // against rolled-back data (accepted zombie — spec §15 decision 9).
    state.retries.delete(args.action);
    logger.error(
      "schedule-error",
      `Action ${args.actionId} exhausted retries resolving inSpace names`,
    );
  }
  args.resolve(undefined);
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
    readonly invalidCauses: readonly IMemorySpaceAddress[] | undefined;
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
      warnOnWriteSurfaceViolations(state, args, log);
      attachSchedulerActionObservation(state, args, log);
    },
  });
  if (!log) {
    throw new Error("scheduler action commit did not build a reactivity log");
  }
  const committedLog = log;
  watchReactiveActionCommit({
    action: args.action,
    tx: args.tx,
    log: committedLog,
    retries: state.retries,
    pending: state.pending,
    commitPromise,
    resubscribe: state.resubscribe,
    markInvalid: state.markInvalid,
    queueExecution: state.queueExecution,
    restoreInvalidCauses: () => {
      const record = state.nodes.get(args.action);
      if (
        record &&
        args.invalidCauses !== undefined &&
        args.invalidCauses.length > 0
      ) {
        restoreInvalidCauses(state.nodes, args.action, args.invalidCauses);
      }
    },
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
  args.resolve(args.result);
}

function warnOnWriteSurfaceViolations(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
  },
  log: ReactivityLog,
): void {
  if (state.nodes.isKnownEffect(args.action)) return;
  if ((state.getMaterializerWriteEnvelopes(args.action) ?? []).length > 0) {
    return;
  }

  const surface = state.getSchedulingWrites(args.action) ?? [];
  for (const write of log.writes) {
    // Per-user/per-session slots are runtime-mediated writes (scope-default
    // initialization, UI state) that authored surfaces do not declare —
    // exempt them so this declaration-gap diagnostic tracks authored
    // space-scoped writes only.
    // WATCH(scheduler-v2): re-include once scoped-slot writes are declared.
    if (normalizeCellScope(write.scope) !== "space") {
      continue;
    }
    if (
      surface.some((surfaceWrite) => surfaceCoversWrite(surfaceWrite, write))
    ) {
      continue;
    }
    // Declaration-gap diagnostics, not enforcement (work order 05 step 5) —
    // debug level because known gaps remain (builtins minting cause-keyed
    // internal docs inside their run, e.g. ifElse/unless/fetchData) and
    // cf test fails tests on console warnings. Counted regardless of level:
    // assert via getLoggerCountsBreakdown().scheduler["write-surface-violation"].
    logger.debug("write-surface-violation", () => [
      `Action ${args.actionId} wrote outside its declared surface`,
      write,
    ]);
  }
}

function surfaceCoversWrite(
  surface: IMemorySpaceAddress,
  write: IMemorySpaceAddress,
): boolean {
  return surface.space === write.space &&
    surface.id === write.id &&
    normalizeCellScope(surface.scope) === normalizeCellScope(write.scope) &&
    surface.path.length <= write.path.length &&
    surface.path.every((segment, index) => segment === write.path[index]);
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
    actionKind: state.nodes.isKnownEffect(args.action)
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
    // The live registered surface — for actions without a `.writes` annotation
    // it came from subscribe's ReactivityLog. Persisted so rehydration can
    // restore the surface (the log is gone after a restart). `declaredWrites`
    // (annotation-only) is slimmed out; the annotation is still available live.
    currentKnownWrites: state.getSchedulingWrites(args.action) ?? [],
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

export function schedulerRuntimeFingerprint(_mode?: "pull" | "push"): string {
  return "runner:scheduler:v2";
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
      nodes: state.nodes,
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
  // both times. Uses the registry's known kind (persists past unsubscribe)
  // since execute() calls unsubscribe() before run().
  if (
    state.getIdempotencyCheckMode() &&
    !state.nodes.isKnownEffect(args.action)
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
