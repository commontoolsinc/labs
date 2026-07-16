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
import {
  isConflictRejection,
  isExecutionLeaseFenceRejection,
  isPermanentRejection,
  isTerminalRejection,
} from "../storage/rejection.ts";
import { isReadIgnoredForScheduling } from "../storage/reactivity-log.ts";
import { getTransactionReadActivities } from "../storage/transaction-inspection.ts";
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
import {
  buildSchedulerActionObservation,
  type CompleteActionScopeSummary,
  type SchedulerActionObservation,
} from "./persistent-observation.ts";
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
import {
  builtinImplementationHash,
  isServerComputationBuiltinId,
  isServerMaterializerBuiltinId,
  type ServerBuiltinComputationDescriptor,
  serverBuiltinImplementationHash,
  type ServerBuiltinMaterializerDescriptor,
} from "../builtins/server-execution.ts";

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
  readonly onCommitRejected?: (
    error: unknown,
    disposition: ActionCommitRejectionDisposition,
  ) => ActionCommitRejectionDirective;
}): void {
  state.commitPromise.then(async ({ error }) => {
    if (!error) {
      // Clear retries after successful commit.
      state.retries.delete(state.action);
      return;
    }

    logger.info(
      "schedule-run-error",
      "Error committing transaction",
      error,
    );
    const reportRejection = (
      disposition: ActionCommitRejectionDisposition,
    ): boolean => {
      try {
        return state.onCommitRejected?.(error, disposition) ===
          "suppress-retry";
      } catch (callbackError) {
        logger.warn(
          "action-commit-rejection-callback",
          "Action commit rejection callback failed",
          callbackError,
        );
        return false;
      }
    };

    // A reactive compute is not a transactional retrier. A CONFLICT (stale read)
    // means one of its inputs moved: the authoritative version is ahead of this
    // replica, and the action's read set is stale until the replica catches up
    // (the conflict's `readyToRetry` gates exactly that catch-up). Re-arm the
    // subscription, wait for the catch-up, then re-run the action against the
    // fresh state. A conflict is a WAIT, not a failure, so it does NOT consume
    // the retry budget — otherwise sustained contention would exhaust the budget
    // and strand the compute as a zombie against rolled-back data.
    //
    // Reader-dirty propagation also re-triggers the action when the catch-up
    // write lands as a fresh notification, but that does not cover every
    // conflict: when the write that caused the conflict has already been
    // delivered (it is what triggered this run), no further dirty arrives, and
    // relying on reader-dirty alone would leave the action stranded with its
    // stale committed value. So the re-queue here is the recovery mechanism;
    // reader-dirty is a redundant fast path (the re-dirty/pending/queue calls
    // coalesce). Restore the consumed trigger reads (§8.9.2) so the re-run's
    // transaction still carries their flow labels.
    if (isConflictRejection(error)) {
      if (reportRejection("retrying")) {
        state.retries.delete(state.action);
        return;
      }
      // Re-arm immediately (restore the consumed trigger reads §8.9.2, then
      // resubscribe) so the subscription stays fresh and a concurrent
      // reader-dirty can re-trigger the action while we wait for the catch-up.
      state.restoreInvalidCauses();
      state.resubscribe(state.action, state.log);
      const readyToRetry =
        (error as { readyToRetry?: () => unknown }).readyToRetry;
      if (typeof readyToRetry === "function") {
        // The readiness gate rejects by design when the session is closed,
        // revoked, or replaced while we wait — an expected control-flow signal,
        // not an error. Swallow it and re-queue anyway: the action stays live
        // and re-runs on the next input change or pull. A `readyToRetry` that
        // throws synchronously is handled the same way.
        try {
          await readyToRetry();
        } catch (readyError) {
          logger.debug(
            "conflict-retry-readiness-aborted",
            "conflict catch-up readiness aborted; re-queuing action anyway",
            readyError,
          );
        }
      }
      state.markInvalid(state.action);
      state.pending.add(state.action);
      state.queueExecution();
      return;
    }

    // Permanent (precondition), terminal (deterministic commit-rule refusal —
    // `isTerminalRejection`), and exact execution-authority fence rejections are
    // never retried. The first two would recompute the identical refused write;
    // the fence names a lease/claim incarnation that can never become current
    // again. Doomed re-runs would only starve concurrent siblings. This
    // definitively ENDS the current retry sequence, so clear the counter —
    // exactly like the success path above — before returning: a later re-run
    // triggered by changed inputs is a fresh sequence that must keep its full
    // bounded budget for a genuinely transient failure, not inherit a count
    // accumulated by earlier transient attempts or the terminal one. Resubscribe
    // still happens (finalizeReactiveActionCommit), so a real input change
    // re-triggers and may receive a fresh claim.
    if (
      isPermanentRejection(error) || isTerminalRejection(error) ||
      isExecutionLeaseFenceRejection(error)
    ) {
      reportRejection("abandoned");
      state.retries.delete(state.action);
      return;
    }

    // Non-conflict failures are NOT re-triggered by reader-dirty — a transient
    // transport error, or the path-blind local StorageTransactionInconsistent
    // guard that fires before the engine's granular matcher — so they still
    // warrant a bounded retry. On every attempt we still resubscribe, so even
    // after the budget is exhausted the action is re-triggered when its input
    // data changes.
    const retries = (state.retries.get(state.action) ?? 0) + 1;
    state.retries.set(state.action, retries);
    if (retries < MAX_RETRIES_FOR_REACTIVE) {
      if (reportRejection("retrying")) {
        state.retries.delete(state.action);
        return;
      }
      // Resubscribe sets up dependencies/triggers from the log so the action
      // re-runs when its inputs change. The run still exists only because of the
      // consumed trigger reads (§8.9.2), so restore them for its tx.
      state.restoreInvalidCauses();
      state.resubscribe(state.action, state.log);
      state.markInvalid(state.action);
      state.pending.add(state.action);
      state.queueExecution();
    } else {
      reportRejection("abandoned");
      // WATCH(scheduler-v2): exhausted retries can leave a piece registered
      // against rolled-back data (accepted zombie — spec §15 decision 9).
    }
  }).catch((error) => {
    logger.error(
      "schedule-error",
      "Commit promise rejected in finalizeAction:",
      error,
    );
  });
}

export type ActionCommitRejectionDisposition = "retrying" | "abandoned";

/** Host-only control can end the generic scheduler retry sequence after it
 * synchronously revokes attempt-specific authority. Ordinary runtimes install
 * no handler and retain the existing bounded retry behavior. */
export type ActionCommitRejectionDirective = "suppress-retry" | undefined;

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
  readonly handleActionCommitRejected: (
    action: Action,
    error: unknown,
    disposition: ActionCommitRejectionDisposition,
  ) => ActionCommitRejectionDirective;
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
  state.runtime.telemetry.submit({
    type: "scheduler.run.complete",
    actionId: args.actionId,
    actionInfo: state.getActionTelemetryInfo(args.action),
    durationMs: elapsed,
    ...(args.error !== undefined
      ? { error: args.error instanceof Error ? args.error.message : "error" }
      : {}),
  });
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
  // Captured at commit kickoff (after prepareTxForCommit populates the CFC
  // outbox, before the async flush clears it): does this commit have
  // asynchronous post-commit work that `settled()` must wait on?
  let hasPostCommitEffects = false;
  const commitPromise = startReactiveActionCommit({
    runtime: state.runtime,
    tx: args.tx,
  }, {
    beforeCommit: () => {
      log = txToReactivityLog(args.tx);
      warnOnWriteSurfaceViolations(state, args, log);
      attachSchedulerActionObservation(state, args, log);
      hasPostCommitEffects = args.tx.hasPendingPostCommitEffects();
    },
  });
  if (!log) {
    throw new Error("scheduler action commit did not build a reactivity log");
  }
  // Track the commit as in-flight async builtin work so `runtime.settled()`
  // waits for its post-commit outbox flush (the sqlite query RPC + writeback;
  // also the barrier that guarantees a fire-and-forget builtin's flush has
  // registered its own network/LLM work). Registered before this run's running
  // promise resolves, so a reader observes the settled result rather than racing
  // the flush. `idle()` deliberately stays free of this. Commits with no
  // post-commit effects keep the fire-and-forget fast path.
  if (hasPostCommitEffects) {
    state.runtime.trackAsyncWork(commitPromise);
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
    onCommitRejected: (error, disposition) =>
      state.handleActionCommitRejected(args.action, error, disposition),
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
    // internal docs inside their run, e.g. ifElse/unless/fetchJson) and
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
  const observationIdentity = annotated.schedulerObservationIdentity;
  if (!observationIdentity) {
    // Only doc-keyed observations persist. An action registered without
    // rehydration identity (session-scoped effects: cell sinks, pull, the
    // wish resolver) can never be rehydrated — its registration carries no
    // identity to match on — and a fallback pieceId would violate the
    // doc→deriver keying the per-doc restore lists by
    // (docs/specs/scheduler-v2/per-doc-rehydration.md §2).
    return;
  }
  const telemetry = state.getActionTelemetryInfo(args.action);
  const actionOptions = schedulerActionOptions(state, args.action);
  const implementationFingerprint = schedulerImplementationFingerprint(
    args.action,
    args.actionId,
    telemetry,
  );
  const runtimeFingerprint = schedulerRuntimeFingerprint();
  const completeScopeSummary = annotated.completeSchedulerScopeSummary;
  const baseObservation = buildSchedulerActionObservation({
    ...(observationIdentity.ownerSpace !== undefined
      ? { ownerSpace: observationIdentity.ownerSpace }
      : {}),
    branch: observationIdentity.branch ?? "",
    pieceId: observationIdentity.pieceId,
    processGeneration: observationIdentity.processGeneration ?? 0,
    actionId: args.actionId,
    actionKind: state.nodes.isKnownEffect(args.action)
      ? "effect"
      : "computation",
    implementationFingerprint,
    runtimeFingerprint,
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
    ...(completeScopeSummary && implementationFingerprint.startsWith("impl:")
      ? {
        completeActionScopeSummary: {
          version: 1 as const,
          complete: true as const,
          piece: toMemorySpaceAddress(completeScopeSummary.piece),
          // CFC preparation reads the raw document-level label envelope beside
          // statically declared value inputs and outputs. Normalized cell links can
          // only express paths below ["value"], so add these structurally
          // fixed sibling reads after converting the complete transformer
          // certificate to raw memory addresses.
          reads: sortAndCompactPaths([
            ...completeScopeSummary.reads.map(toMemorySpaceAddress),
            ...[
              ...completeScopeSummary.reads,
              ...completeScopeSummary.writes,
              ...completeScopeSummary.materializerWriteEnvelopes,
              ...completeScopeSummary.directOutputs,
            ].map(toMemorySpaceAddress).map((address) => ({
              ...address,
              path: ["cfc"],
            })),
          ]),
          writes: completeScopeSummary.writes.map(toMemorySpaceAddress),
          materializerWriteEnvelopes: completeScopeSummary
            .materializerWriteEnvelopes.map(
              toMemorySpaceAddress,
            ),
          directOutputs: completeScopeSummary.directOutputs.map(
            toMemorySpaceAddress,
          ),
        },
      }
      : {}),
    ...(actionOptions ? { actionOptions } : {}),
    status: args.error ? "failed" : "success",
    ...(args.error
      ? { errorFingerprint: schedulerErrorFingerprint(args.error) }
      : {}),
  });
  const serverBuiltin = annotated.serverBuiltin;
  const previousBuiltinSummary =
    annotated.serverBuiltinPreviousScopeSummary?.implementationFingerprint ===
        implementationFingerprint &&
      annotated.serverBuiltinPreviousScopeSummary?.runtimeFingerprint ===
        runtimeFingerprint
      ? annotated.serverBuiltinPreviousScopeSummary
      : undefined;
  const observation = serverBuiltin !== undefined &&
      baseObservation.actionKind === "effect" &&
      implementationFingerprint ===
        `impl:${serverBuiltinImplementationHash(serverBuiltin.id)}`
    ? {
      ...baseObservation,
      completeActionScopeSummary: {
        version: 1 as const,
        complete: true as const,
        implementationFingerprint,
        runtimeFingerprint,
        piece: toMemorySpaceAddress(serverBuiltin.piece),
        reads: sortAndCompactPaths([
          ...serverBuiltin.reads.map(toMemorySpaceAddress),
          ...serverBuiltin.runtimeWrites.map(toMemorySpaceAddress),
          ...serverBuiltin.runtimeWrites.map((link) => ({
            ...toMemorySpaceAddress(link),
            path: [],
          })),
          ...(previousBuiltinSummary?.reads ?? []),
          ...baseObservation.reads,
          ...baseObservation.shallowReads,
        ]),
        writes: sortAndCompactPaths([
          ...serverBuiltin.writes.map(toMemorySpaceAddress),
          ...serverBuiltin.runtimeWrites.map(toMemorySpaceAddress),
          ...serverBuiltin.runtimeWrites.map((link) => ({
            ...toMemorySpaceAddress(link),
            path: [],
          })),
          ...serverBuiltin.directOutputs.map(toMemorySpaceAddress),
          ...(previousBuiltinSummary?.writes ?? []),
          ...(previousBuiltinSummary?.materializerWriteEnvelopes ?? []),
          ...(previousBuiltinSummary?.directOutputs ?? []),
          ...baseObservation.actualChangedWrites,
          ...baseObservation.currentKnownWrites,
          ...(baseObservation.declaredWrites ?? []),
          ...baseObservation.materializerWriteEnvelopes,
          ...(baseObservation.ignoredSchedulingWrites ?? []),
        ]),
        materializerWriteEnvelopes: sortAndCompactPaths(
          [
            ...(previousBuiltinSummary?.materializerWriteEnvelopes ?? []),
            ...baseObservation.materializerWriteEnvelopes,
          ],
        ),
        directOutputs: serverBuiltin.directOutputs.map(toMemorySpaceAddress),
      },
    }
    : withRuntimeComputationScopeSummary(
      baseObservation,
      annotated.serverBuiltinComputation,
      annotated.serverBuiltinMaterializer,
      schedulerIgnoredReadAddresses(args.tx),
    );

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
  // The implementation FINGERPRINT is the per-module content-addressed identity
  // `cf:module/<hash>:<symbol>` — stable across reloads, entry points, and TCB
  // upgrades (see docs/specs/content-addressed-action-identity.md). It is
  // deliberately per-SYMBOL (it identifies the implementation code), with NO
  // per-instance key — unlike the action id (`getSchedulerActionId`). It is
  // read from the stamp set at action creation (`applyImplementationHash`) —
  // the single identity channel; no re-derivation here, and `.src` is never
  // consulted (the prior `src:` fallback depended on the source-map path).
  const implementationHash = (action as { implementationHash?: unknown })
    .implementationHash;
  if (typeof implementationHash === "string" && implementationHash.length > 0) {
    return `impl:${implementationHash}`;
  }
  const telemetryId = schedulerObservationPieceId(actionId, telemetry);
  return `action:${telemetryId}:${actionId}`;
}

export function schedulerRuntimeFingerprint(): string {
  return "runner:scheduler:v3";
}

/**
 * W2.14 (RC-3b): assemble a runtime write-empty `completeActionScopeSummary`
 * for a computation whose registered write surface is empty beyond its single
 * direct root output. This covers trusted `impl:` computations the transformer
 * cannot certify — e.g. backlinks-index's `computeMentionable`, a recursive
 * read-only `lift()` that is statically unprovable but provably write-free.
 *
 * The summary declares NO side writes: only the single direct output, echoed
 * into `writes` to satisfy the classifier's directOutput ∈ writes invariant.
 * Reads come from the observed log and are admitted dynamically at the firewall
 * (C0), so they carry no static envelope obligation. Soundness is fail-closed
 * by construction: the engine firewall bounds every claimed commit's writes to
 * this envelope (`dynamic-write-outside-static-surface`,
 * `servability.ts`), so a wrong write-empty belief de-claims the action rather
 * than corrupting state — it never trusts the belief.
 *
 * "Empty registered write surface" is the runner's own registration-time
 * knowledge (`currentKnownWrites`/materializer envelopes/`declaredWrites`), not
 * a static claim: exactly one registered write that is a same-space,
 * space-scoped root value address, with no materializer or declared writes
 * beyond it. Effects are excluded (they keep `unknown-effect-surface`), and a
 * present certificate or effect-descriptor summary is never overridden.
 *
 * `ignoredReads` is this run's scheduler-ignored (framework-owned) read set —
 * argument/piece/internal resolution reads deliberately excluded from the
 * reactive log. The engine's claimed-commit admission requires every commit
 * read to be covered by observation ∪ summary reads, and the certified path
 * covers these via its exhaustive static certificate; the runtime summary must
 * fold them in the same way or every claimed run rejects `unobserved-read`.
 * Only same-space, space-scoped addresses are folded — anything else stays
 * uncovered and fails closed.
 */
export function runtimeWriteEmptyComputationScopeSummary(
  observation: SchedulerActionObservation,
  ignoredReads: readonly IMemorySpaceAddress[] = [],
): CompleteActionScopeSummary | undefined {
  if (observation.actionKind !== "computation") return undefined;
  // Never override a transformer certificate or an effect-descriptor summary.
  if (observation.completeActionScopeSummary !== undefined) return undefined;
  // Trusted identity only: an `action:…` fingerprint is untrusted-implementation.
  if (!observation.implementationFingerprint.startsWith("impl:")) {
    return undefined;
  }
  // Canonical builtins (`impl:cf:builtin/<id>…`, per `builtinImplementationHash`)
  // are covered ONLY by explicit, individually vetted per-builtin descriptors
  // (W2.15+), never this blanket heuristic. Their write surfaces are not simply
  // "one direct output": map/filter/flatMap carry output-collection envelopes
  // and wish is a resolver, so a generic write-empty belief must never bless
  // them. The target class here is authored `cf:module` computeds the
  // transformer cannot certify (recursion), e.g. `computeMentionable`.
  if (observation.implementationFingerprint.startsWith("impl:cf:builtin/")) {
    return undefined;
  }
  const ownerSpace = observation.ownerSpace;
  if (ownerSpace === undefined || ownerSpace.length === 0) return undefined;

  // The registered write surface must be empty beyond the single direct output.
  if (observation.materializerWriteEnvelopes.length > 0) return undefined;
  if ((observation.declaredWrites?.length ?? 0) > 0) return undefined;
  if (observation.currentKnownWrites.length !== 1) return undefined;
  const directOutput = observation.currentKnownWrites[0]!;
  if (!isSameSpaceRootValueAddress(directOutput, ownerSpace)) return undefined;

  // Reconstruct the space piece root the pieceId was keyed from (`space:<uri>`):
  // the definitional inverse of the runner's `${scope}:${id}` pieceId keying.
  // Reuse the direct output's `space` (already proven equal to `ownerSpace`) so
  // the piece carries the branded `MemorySpace`, not a bare observation string.
  const piece = spacePieceRootFromPieceId(
    observation.pieceId,
    directOutput.space,
  );
  if (piece === undefined) return undefined;

  return {
    version: 1,
    complete: true,
    implementationFingerprint: observation.implementationFingerprint,
    runtimeFingerprint: observation.runtimeFingerprint,
    piece,
    // Observed-log reads; C0 admits them dynamically at the firewall. A scoped
    // or foreign read still trips the classifier's same-space check, so pass
    // them through rather than suppressing the evidence.
    reads: claimedCommitAdmissionReads(
      [
        ...observation.reads,
        ...observation.shallowReads,
        ...sameSpaceSpaceScopedReads(ignoredReads, ownerSpace),
      ],
      [directOutput],
    ),
    writes: [cloneMemoryAddress(directOutput)],
    materializerWriteEnvelopes: [],
    directOutputs: [cloneMemoryAddress(directOutput)],
  };
}

/**
 * Attach a runtime-assembled computation `completeActionScopeSummary` when one
 * of the alternative certificate sources applies. Certified computations and
 * server-builtin effects already carry a summary before reaching here. The
 * explicit per-builtin descriptors take precedence over the generic runtime
 * heuristics; the four sources are mutually exclusive by identity/surface (each
 * returns `undefined` outside its class), so the order is a stable priority, not
 * a conflict resolution:
 *
 * 1. pure selector descriptor (W2.15a) — `cf:builtin` ifElse/when/unless;
 * 2. list-builtin materializer descriptor (W2.16) — `cf:builtin`
 *    map/filter/flatMap with an envelope write surface;
 * 3. runtime materializer summary (W2.16) — authored `cf:module` writers that
 *    carry registered materializer envelopes but no certificate (computeIndex);
 * 4. write-empty heuristic (W2.14) — authored `cf:module` computeds the
 *    transformer cannot certify but that provably write nothing beyond one
 *    direct output (computeMentionable).
 *
 * The two `cf:builtin` descriptors never overlap the two `cf:module` heuristics
 * (the heuristics reject `cf:builtin` identities); the materializer heuristic
 * requires registered envelopes and the write-empty heuristic requires none, so
 * they never both apply either.
 */
function withRuntimeComputationScopeSummary(
  observation: SchedulerActionObservation,
  computationDescriptor: ServerBuiltinComputationDescriptor | undefined,
  materializerDescriptor: ServerBuiltinMaterializerDescriptor | undefined,
  ignoredReads: readonly IMemorySpaceAddress[] = [],
): SchedulerActionObservation {
  const summary = serverBuiltinComputationScopeSummary(
    observation,
    computationDescriptor,
    ignoredReads,
  ) ??
    serverBuiltinMaterializerScopeSummary(
      observation,
      materializerDescriptor,
      ignoredReads,
    ) ??
    runtimeMaterializerComputationScopeSummary(observation, ignoredReads) ??
    runtimeWriteEmptyComputationScopeSummary(observation, ignoredReads);
  return summary === undefined
    ? observation
    : { ...observation, completeActionScopeSummary: summary };
}

/**
 * This run's scheduler-ignored (framework-owned) reads: argument/piece/internal
 * resolution reads deliberately kept out of the reactive log so they never
 * drive wakes. Claimed-commit admission still requires them covered by the
 * summary, so the runtime summary assemblers fold them in per run.
 */
function schedulerIgnoredReadAddresses(
  tx: IExtendedStorageTransaction,
): IMemorySpaceAddress[] {
  const reads: IMemorySpaceAddress[] = [];
  for (const activity of getTransactionReadActivities(tx)) {
    if (!isReadIgnoredForScheduling(activity.meta)) continue;
    reads.push({
      space: activity.space,
      scope: normalizeCellScope(activity.scope),
      id: activity.id,
      path: [...activity.path],
    });
  }
  return reads;
}

function sameSpaceSpaceScopedReads(
  reads: readonly IMemorySpaceAddress[],
  space: string,
): IMemorySpaceAddress[] {
  return reads.filter((address) =>
    address.space === space &&
    normalizeCellScope(address.scope) === "space"
  ).map(cloneMemoryAddress);
}

/**
 * The read set the engine's claimed-commit admission is checked against.
 * Mirrors the certified path's structural addition: CFC preparation reads the
 * raw document-level label envelope beside the value reads, so every summary
 * doc gets a `["cfc"]` sibling read.
 */
function claimedCommitAdmissionReads(
  reads: readonly IMemorySpaceAddress[],
  writesAndOutputs: readonly IMemorySpaceAddress[],
): IMemorySpaceAddress[] {
  return sortAndCompactPaths([
    ...reads,
    ...[...reads, ...writesAndOutputs].map((address) => ({
      ...address,
      path: ["cfc"],
    })),
  ]);
}

/**
 * W2.15a: assemble a claim-ready `completeActionScopeSummary` from a trusted
 * per-builtin COMPUTATION descriptor for the pure structural selectors
 * (ifElse/when/unless), keyed on the exact `impl:cf:builtin/<id>:v1` fingerprint
 * (W2.11). Mirrors the effect-descriptor path but is fail-closed: the write
 * envelope is EXACTLY the descriptor's declared surface plus the single direct
 * output — observed runtime writes are never folded in — so a selector that
 * ever writes outside its declared output de-claims at the firewall. Reads come
 * from the descriptor's registered inputs plus the observed log; C0 admits reads
 * dynamically, so they carry no envelope obligation.
 */
export function serverBuiltinComputationScopeSummary(
  observation: SchedulerActionObservation,
  descriptor: ServerBuiltinComputationDescriptor | undefined,
  ignoredReads: readonly IMemorySpaceAddress[] = [],
): CompleteActionScopeSummary | undefined {
  if (descriptor === undefined || descriptor.version !== 1) return undefined;
  if (observation.actionKind !== "computation") return undefined;
  // Never override a transformer certificate already present.
  if (observation.completeActionScopeSummary !== undefined) return undefined;
  // Identity must be the exact canonical builtin the descriptor names.
  if (!isServerComputationBuiltinId(descriptor.id)) return undefined;
  if (
    observation.implementationFingerprint !==
      `impl:${builtinImplementationHash(descriptor.id)}`
  ) {
    return undefined;
  }
  if (descriptor.directOutputs.length !== 1) return undefined;

  const piece = toMemorySpaceAddress(descriptor.piece);
  const writes = sortAndCompactPaths([
    ...descriptor.writes.map(toMemorySpaceAddress),
    ...descriptor.directOutputs.map(toMemorySpaceAddress),
  ]);
  return {
    version: 1,
    complete: true,
    implementationFingerprint: observation.implementationFingerprint,
    runtimeFingerprint: observation.runtimeFingerprint,
    piece,
    reads: claimedCommitAdmissionReads(
      [
        ...descriptor.reads.map(toMemorySpaceAddress),
        ...observation.reads,
        ...observation.shallowReads,
        ...sameSpaceSpaceScopedReads(ignoredReads, piece.space),
      ],
      writes,
    ),
    writes,
    materializerWriteEnvelopes: [],
    directOutputs: descriptor.directOutputs.map(toMemorySpaceAddress),
  };
}

/**
 * W2.16: assemble a claim-ready `completeActionScopeSummary` from a trusted
 * per-builtin MATERIALIZER descriptor for the container-minting list builtins
 * (map/filter/flatMap), keyed on the exact `impl:cf:builtin/<id>:v1` fingerprint
 * (W2.11). Mirrors the selector descriptor path but the write surface is
 * ENVELOPE-shaped: the container prefix rides in `materializerWriteEnvelopes`
 * (checkable and honest for a data-dependent per-slot writer), while `writes`
 * carries only the declared surface plus the direct output. Fail-closed: the
 * envelope is exactly the descriptor's container plus the direct output —
 * observed runtime writes are never folded in — so a run that writes anywhere
 * else (e.g. a first reconcile instantiating per-element children) de-claims at
 * the firewall. Reads come from the descriptor's inputs plus the observed log;
 * C0 admits reads dynamically, so they carry no envelope obligation.
 */
export function serverBuiltinMaterializerScopeSummary(
  observation: SchedulerActionObservation,
  descriptor: ServerBuiltinMaterializerDescriptor | undefined,
  ignoredReads: readonly IMemorySpaceAddress[] = [],
): CompleteActionScopeSummary | undefined {
  if (descriptor === undefined || descriptor.version !== 1) return undefined;
  if (observation.actionKind !== "computation") return undefined;
  // Never override a transformer certificate already present.
  if (observation.completeActionScopeSummary !== undefined) return undefined;
  // Identity must be the exact canonical builtin the descriptor names.
  if (!isServerMaterializerBuiltinId(descriptor.id)) return undefined;
  if (
    observation.implementationFingerprint !==
      `impl:${builtinImplementationHash(descriptor.id)}`
  ) {
    return undefined;
  }
  if (descriptor.directOutputs.length !== 1) return undefined;
  // An envelope-shaped writer with no envelope is not a materializer: refuse
  // rather than mint an exact-surface summary that would reject its own
  // container write on the first commit.
  if (descriptor.materializerWriteEnvelopes.length === 0) return undefined;

  const piece = toMemorySpaceAddress(descriptor.piece);
  const materializerWriteEnvelopes = sortAndCompactPaths(
    descriptor.materializerWriteEnvelopes.map(toMemorySpaceAddress),
  );
  const writes = sortAndCompactPaths([
    ...descriptor.writes.map(toMemorySpaceAddress),
    ...descriptor.directOutputs.map(toMemorySpaceAddress),
  ]);
  return {
    version: 1,
    complete: true,
    implementationFingerprint: observation.implementationFingerprint,
    runtimeFingerprint: observation.runtimeFingerprint,
    piece,
    reads: claimedCommitAdmissionReads(
      [
        ...descriptor.reads.map(toMemorySpaceAddress),
        ...observation.reads,
        ...observation.shallowReads,
        ...sameSpaceSpaceScopedReads(ignoredReads, piece.space),
      ],
      [...writes, ...materializerWriteEnvelopes],
    ),
    writes,
    materializerWriteEnvelopes,
    directOutputs: descriptor.directOutputs.map(toMemorySpaceAddress),
  };
}

/**
 * W2.16 (RC-3a): assemble a runtime materializer `completeActionScopeSummary`
 * for an AUTHORED (`cf:module`) computation that carries no transformer
 * certificate but HAS registered materializer write envelopes — computeIndex's
 * shape, pending its transformer certificate. The write bound is exactly those
 * envelopes plus the single direct root output; the registered surface must be
 * bounded by them (every registered write envelope- or direct-output-covered)
 * or the action stays `incomplete-static-surface`. This is the authored analog
 * of the per-builtin materializer descriptor: builtins arrive via descriptors
 * (`serverBuiltinMaterializerScopeSummary`) and are excluded here, exactly as
 * the write-empty heuristic excludes them.
 *
 * Soundness is fail-closed by construction: the firewall bounds every claimed
 * commit's writes to `envelopes ∪ directOutput`, so a run that writes outside
 * them de-claims rather than corrupting state. `ignoredReads` folds the
 * framework-owned reads exactly as the write-empty path does.
 */
export function runtimeMaterializerComputationScopeSummary(
  observation: SchedulerActionObservation,
  ignoredReads: readonly IMemorySpaceAddress[] = [],
): CompleteActionScopeSummary | undefined {
  if (observation.actionKind !== "computation") return undefined;
  // Never override a transformer certificate or an effect-descriptor summary.
  if (observation.completeActionScopeSummary !== undefined) return undefined;
  // Trusted identity only: an `action:…` fingerprint is untrusted-implementation.
  if (!observation.implementationFingerprint.startsWith("impl:")) {
    return undefined;
  }
  // Canonical builtins are served ONLY through their explicit per-builtin
  // descriptors (map/filter/flatMap via serverBuiltinMaterializerScopeSummary),
  // never this authored-writer path.
  if (observation.implementationFingerprint.startsWith("impl:cf:builtin/")) {
    return undefined;
  }
  // Materializer, not write-empty (W2.14): it must carry registered envelopes.
  if (observation.materializerWriteEnvelopes.length === 0) return undefined;
  const ownerSpace = observation.ownerSpace;
  if (ownerSpace === undefined || ownerSpace.length === 0) return undefined;

  // Exactly one direct root output, same-space and space-scoped.
  if (observation.currentKnownWrites.length !== 1) return undefined;
  const directOutput = observation.currentKnownWrites[0]!;
  if (!isSameSpaceRootValueAddress(directOutput, ownerSpace)) return undefined;

  // Every registered envelope must itself be same-space and space-scoped, else
  // this run cannot be served — refuse rather than mint a summary the firewall
  // rejects address-by-address anyway.
  const materializerWriteEnvelopes = sortAndCompactPaths(
    observation.materializerWriteEnvelopes.map(cloneMemoryAddress),
  );
  for (const envelope of materializerWriteEnvelopes) {
    if (
      envelope.space !== ownerSpace ||
      normalizeCellScope(envelope.scope) !== "space"
    ) {
      return undefined;
    }
  }

  const directOutputWrite = cloneMemoryAddress(directOutput);
  const writeEnvelopes = [directOutputWrite, ...materializerWriteEnvelopes];
  // Every registered write must be envelope- or direct-output-covered, so the
  // summary honestly bounds the registered surface. A declared side write
  // outside them means the envelopes do not describe this writer; leave it
  // incomplete-static-surface rather than assemble an unsound bound.
  for (
    const registered of [
      ...observation.currentKnownWrites,
      ...(observation.declaredWrites ?? []),
    ]
  ) {
    if (
      !writeEnvelopes.some((envelope) =>
        surfaceCoversWrite(envelope, registered)
      )
    ) {
      return undefined;
    }
  }

  const piece = spacePieceRootFromPieceId(
    observation.pieceId,
    directOutput.space,
  );
  if (piece === undefined) return undefined;

  const writes = [directOutputWrite];
  return {
    version: 1,
    complete: true,
    implementationFingerprint: observation.implementationFingerprint,
    runtimeFingerprint: observation.runtimeFingerprint,
    piece,
    reads: claimedCommitAdmissionReads(
      [
        ...observation.reads,
        ...observation.shallowReads,
        ...sameSpaceSpaceScopedReads(ignoredReads, ownerSpace),
      ],
      writeEnvelopes,
    ),
    writes,
    materializerWriteEnvelopes,
    directOutputs: [cloneMemoryAddress(directOutput)],
  };
}

function isSameSpaceRootValueAddress(
  address: IMemorySpaceAddress,
  space: string,
): boolean {
  return address.space === space &&
    (address.scope ?? "space") === "space" &&
    address.path.length === 1 && address.path[0] === "value";
}

function spacePieceRootFromPieceId(
  pieceId: string,
  space: IMemorySpaceAddress["space"],
): IMemorySpaceAddress | undefined {
  const prefix = "space:";
  if (!pieceId.startsWith(prefix)) return undefined;
  const id = pieceId.slice(prefix.length);
  if (id.length === 0) return undefined;
  return {
    space,
    scope: "space",
    id: id as IMemorySpaceAddress["id"],
    path: ["value"],
  };
}

function cloneMemoryAddress(
  address: IMemorySpaceAddress,
): IMemorySpaceAddress {
  return { ...address, path: [...address.path] };
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
