import { getLogger } from "@commonfabric/utils/logger";
import type { Runtime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageTransaction,
} from "../storage/interface.ts";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import {
  MAX_ACTION_RUN_TRACE_HISTORY,
  MAX_RETRIES_FOR_REACTIVE,
} from "./constants.ts";
import { toActionRunTraceAddress } from "./diagnostics.ts";
import type {
  Action,
  ActionRunTraceEntry,
  EventHandler,
  ReactivityLog,
} from "./types.ts";

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
