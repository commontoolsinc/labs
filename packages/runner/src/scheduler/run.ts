import { getLogger } from "@commonfabric/utils/logger";
import type { Runtime } from "../runtime.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import {
  isConflictRejection,
  isPermanentRejection,
  isStorageTransactionInconsistent,
  isTerminalRejection,
} from "../storage/rejection.ts";
import { createDuplicateWorkTransaction } from "../storage/extended-storage-transaction.ts";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import {
  MAX_ACTION_RUN_TRACE_HISTORY,
  MAX_RETRIES_FOR_REACTIVE,
  OFF_BUDGET_RETRY_WARN_INTERVAL,
} from "./constants.ts";
import {
  captureDiagnosisRecord,
  type DiagnosisRecord,
  runIdempotencyRecheck,
} from "./diagnosis.ts";
import { RetryImmediately } from "./retry-immediately.ts";
import { toActionRunTraceAddress } from "./diagnostics.ts";
import { txToReactivityLog } from "./reactivity.ts";
import { type ActionTimingState, recordActionTime } from "./timing.ts";
import type { NodeRegistry } from "./node-record.ts";
import { restoreInvalidCauses, takeInvalidCauses } from "./invalidation.ts";
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
  readonly offBudgetRetries: WeakMap<Action, number>;
  readonly pending: Set<Action>;
  readonly commitPromise: ReturnType<IExtendedStorageTransaction["commit"]>;
  readonly resubscribe: (action: Action, log: ReactivityLog) => void;
  readonly markInvalid: (action: Action) => void;
  readonly queueExecution: () => void;
  readonly restoreInvalidCauses: () => void;
  readonly getActionId: (action: Action) => string;
}): Promise<void> {
  const handleResult = async (error: unknown): Promise<void> => {
    if (!error) {
      // Clear retries after successful commit.
      state.retries.delete(state.action);
      state.offBudgetRetries.delete(state.action);
      return;
    }

    logger.info(
      "schedule-run-error",
      "Error committing transaction",
      error,
    );

    // A reactive compute is not a transactional retrier. A stale-basis rejection
    // means the value the action read is no longer current, so re-running against
    // fresh state and committing again converges. Two rejections are stale-basis.
    // A CONFLICT is an upstream stale read: the authoritative version is ahead of
    // this replica, and the action's read set is stale until the replica catches
    // up (the conflict's `readyToRetry` gates exactly that catch-up). A
    // STORAGE-TRANSACTION-INCONSISTENT is the local analogue: a value the
    // transaction read changed on this replica between the read and the commit,
    // which re-running against the settled replica resolves. It carries no
    // `readyToRetry`, so the re-queue below runs it afresh once the local write
    // completes. Wait for any catch-up, then re-queue the action to re-run
    // against fresh state; its subscription is already live, so the steps below
    // refresh it and restore the trigger reads the run consumed rather than
    // establishing a subscription that was torn down. Both are a WAIT, not a
    // failure, so neither consumes the retry budget —
    // otherwise sustained contention would exhaust the budget and strand the
    // compute as a zombie against rolled-back data. Only a rejection that
    // re-running cannot resolve (transport, malformed store) takes the bounded
    // budget below.
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
    if (isConflictRejection(error) || isStorageTransactionInconsistent(error)) {
      // This retry rides off the bounded budget on the assumption that the
      // subscription eventually delivers the awaited value — true for
      // pattern-created reactive functions, which go through the cell machinery.
      // A bug that never closes the loop (historically a serialization
      // round-trip that dropped a value) would re-queue forever, so surface a
      // non-fatal diagnostic every OFF_BUDGET_RETRY_WARN_INTERVAL re-queues
      // rather than spinning silently. The count clears on the next successful,
      // permanent, or terminal commit.
      const offBudgetRetries = (state.offBudgetRetries.get(state.action) ?? 0) +
        1;
      state.offBudgetRetries.set(state.action, offBudgetRetries);
      if (offBudgetRetries % OFF_BUDGET_RETRY_WARN_INTERVAL === 0) {
        logger.error(
          "reactive-retry-not-converging",
          () => [
            `reactive action ${state.getActionId(state.action)} re-queued ` +
            `${offBudgetRetries} times on a stale-basis rejection without ` +
            `converging; its subscription may never deliver the awaited value`,
          ],
        );
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

    // Permanent (precondition) and terminal (deterministic commit-rule refusal —
    // `isTerminalRejection`) rejections are never retried: re-running recomputes
    // the identical refused write, and the doomed re-runs would starve
    // concurrent siblings. This definitively ENDS the current retry sequence, so
    // clear the counter — exactly like the success path above — before returning:
    // a later re-run triggered by changed inputs is a fresh sequence that must
    // keep its full bounded budget for a genuinely transient failure, not inherit
    // a count accumulated by earlier transient attempts or the terminal one.
    // Resubscribe still happens (finalizeReactiveActionCommit), so a real input
    // change re-triggers.
    if (isPermanentRejection(error) || isTerminalRejection(error)) {
      state.retries.delete(state.action);
      state.offBudgetRetries.delete(state.action);
      return;
    }

    // Non-conflict failures are NOT re-triggered by reader-dirty — a transient
    // transport or malformed-store error — so they still warrant a bounded
    // retry to make progress. Unlike a stale basis (a conflict or the local
    // same-replica-race guard, both handled off-budget above), re-running does
    // not resolve them, so the budget bounds the wasted attempts. On every
    // attempt we still resubscribe, so even after the budget is exhausted the
    // action is re-triggered when its input data changes.
    const retries = (state.retries.get(state.action) ?? 0) + 1;
    state.retries.set(state.action, retries);
    if (retries < MAX_RETRIES_FOR_REACTIVE) {
      // Resubscribe sets up dependencies/triggers from the log so the action
      // re-runs when its inputs change. The run still exists only because of the
      // consumed trigger reads (§8.9.2), so restore them for its tx.
      state.restoreInvalidCauses();
      state.resubscribe(state.action, state.log);
      state.markInvalid(state.action);
      state.pending.add(state.action);
      state.queueExecution();
    } else {
      // WATCH(scheduler-v2): exhausted retries can leave a piece registered
      // against rolled-back data (accepted zombie — spec §15 decision 9).
    }
  };
  return state.commitPromise.then(
    ({ error }) => handleResult(error),
    (reason) =>
      handleResult(
        reason || new Error("Storage commit promise rejected without a reason"),
      ),
  ).catch((error) => {
    logger.error(
      "schedule-error",
      "Commit result handling failed in finalizeAction:",
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
  readonly offBudgetRetries: WeakMap<Action, number>;
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
  // Server-execution v2 stage F (serving-loop.md §3d): a serving
  // runtime's installed stamper attaches the wave run context here — the
  // reactive-action choke point — so every scheduler-driven derivation
  // seals stamped. A no-op everywhere else (one undefined check).
  state.runtime.stampServerRun(tx, { actionId, kind: "derivation" });
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
      hasPostCommitEffects = args.tx.hasPendingPostCommitEffects();
    },
  });
  if (!log) {
    throw new Error("scheduler action commit did not build a reactivity log");
  }
  // Track the effect layer as in-flight async builtin work so
  // `runtime.settled()` waits for the post-commit outbox flush (the sqlite
  // query RPC + writeback; also the barrier that guarantees a
  // fire-and-forget builtin's flush has registered its own network/LLM
  // work). The effect layer, not the commit promise: effects run at the
  // verdict, while the promise additionally waits for the subscribed view
  // to cover the write — an incoming-frame wait quiescence must not depend
  // on. Registered before this run's running promise resolves, so a reader
  // observes the settled result rather than racing the flush. `idle()`
  // deliberately stays free of this. Commits with no post-commit effects
  // keep the fire-and-forget fast path.
  if (hasPostCommitEffects) {
    state.runtime.trackAsyncWork(args.tx.postCommitEffectsSettled());
  }
  const committedLog = log;
  const handled = watchReactiveActionCommit({
    action: args.action,
    tx: args.tx,
    log: committedLog,
    retries: state.retries,
    offBudgetRetries: state.offBudgetRetries,
    pending: state.pending,
    commitPromise,
    resubscribe: state.resubscribe,
    markInvalid: state.markInvalid,
    queueExecution: state.queueExecution,
    getActionId: state.getActionId,
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
  // The barrier entry commit() registered settles with the commit promise,
  // but the disposition above — a conflict's catch-up-then-requeue in
  // particular — runs afterwards. Register the handled chain too, so
  // idleWithPendingCommits cannot release in the window between a
  // rejection settling and its retry being requeued (the event path in
  // events.ts registers the same way).
  state.runtime.storageManager.trackPendingCommit(handled);

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
  const telemetryId = [
    telemetry?.patternName,
    telemetry?.moduleName,
  ].filter((part): part is string => !!part).join(":") || `action:${actionId}`;
  return `action:${telemetryId}:${actionId}`;
}

export function schedulerRuntimeFingerprint(): string {
  return "runner:scheduler:v3";
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
          // The recheck re-runs the action only to compare its writes with the
          // run that already happened, then throws the transaction away.
          createTx: () => createDuplicateWorkTransaction(state.runtime.edit()),
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
