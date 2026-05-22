import { getLogger } from "@commonfabric/utils/logger";
import { topologicalSort } from "./topology.ts";
import type { Action, SettleIterationStats } from "./types.ts";
import {
  recordSettleActionRun,
  type SchedulerSettleLoopState,
  type SchedulerSettleResult,
  summarizeSettleIteration,
  summarizeSettleRun,
} from "./execution.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export async function runPushSchedulerSettleLoop(
  state: SchedulerSettleLoopState,
): Promise<SchedulerSettleResult> {
  // Settle loop: runs until no more dirty work is found.
  logger.timeStart("scheduler", "execute", "settle");
  const maxSettleIterations = 10;
  let lastWorkSet: Set<Action> = new Set();
  let settledEarly = false;
  const collectSettleStats = state.getCollectSettleStats();
  const settleIterStats: SettleIterationStats[] | undefined = collectSettleStats
    ? []
    : undefined;
  const settleStartTime = collectSettleStats ? performance.now() : 0;

  for (let settleIter = 0; settleIter < maxSettleIterations; settleIter++) {
    const iterStart = settleIterStats ? performance.now() : 0;

    const iteration = preparePushSettleIteration(state, settleIter);

    if (iteration.settled) {
      settledEarly = true;
      break;
    }

    lastWorkSet = iteration.workSet;
    const iterationWorkSetSize = iteration.workSet.size;
    const iterActionsRun = await runPushSettleOrder(state, iteration.order);

    if (settleIterStats) {
      settleIterStats.push(summarizeSettleIteration({
        workSetSize: iterationWorkSetSize,
        order: iteration.order,
        actionsRun: iterActionsRun,
        durationMs: performance.now() - iterStart,
        effects: state.effects,
        getActionId: (action) => state.getActionId(action),
      }));
    }
  }

  const settleStats = settleIterStats
    ? summarizeSettleRun({
      iterations: settleIterStats,
      totalDurationMs: performance.now() - settleStartTime,
      settledEarly,
      initialSeedCount: 0,
    })
    : undefined;

  logger.timeEnd("scheduler", "execute", "settle");

  return {
    settledEarly,
    lastWorkSet,
    earlyIterationComputations: new Set(),
    maxSettleIterations,
    ...(settleStats ? { settleStats } : {}),
  };
}

function preparePushSettleIteration(
  state: SchedulerSettleLoopState,
  settleIter: number,
): { settled: true } | {
  settled: false;
  workSet: Set<Action>;
  order: Action[];
} {
  // Push mode mutates pending while executing, preserving existing behavior.
  const workSet = state.pending;
  if (workSet.size === 0) {
    return { settled: true };
  }

  const topologicalSortStart = performance.now();
  const order = topologicalSort(
    workSet,
    state.dependencies,
    state.getSchedulingWritesMap(),
    state.actionParent,
  );
  logger.time(
    topologicalSortStart,
    "scheduler",
    "execute",
    "topologicalSort",
  );

  logger.debug("schedule-execute", () => [
    `Running ${order.length} actions (settle iteration ${settleIter})`,
  ]);

  return { settled: false, workSet, order };
}

async function runPushSettleOrder(
  state: SchedulerSettleLoopState,
  order: readonly Action[],
): Promise<number> {
  let actionsRun = 0;
  for (const fn of order) {
    actionsRun += await runPushSettleAction(state, fn);
  }
  return actionsRun;
}

async function runPushSettleAction(
  state: SchedulerSettleLoopState,
  fn: Action,
): Promise<number> {
  // Check if action is still scheduled (not unsubscribed during this tick).
  // Running an action might unsubscribe other actions in the workSet.
  const isStillScheduled = state.computations.has(fn) || state.effects.has(fn);
  if (!isStillScheduled) return 0;

  if (!isPushSettleActionStillRunnable(state, fn)) return 0;
  if (skipPushDelayedSettleAction(state, fn)) return 0;

  // Clean up from pending before running.
  state.pending.delete(fn);
  state.conditionallyScheduledEffects.delete(fn);
  if (state.computations.has(fn)) {
    state.clearComputationDebounceState(fn);
  }

  state.filterStats.executed++;
  if (!recordSettleActionRun(state, fn)) return 1;

  await state.runAction(fn);
  return 1;
}

function isPushSettleActionStillRunnable(
  state: SchedulerSettleLoopState,
  fn: Action,
): boolean {
  return state.pending.has(fn);
}

function skipPushDelayedSettleAction(
  state: SchedulerSettleLoopState,
  fn: Action,
): boolean {
  if (state.isDebouncedComputationWaiting(fn)) {
    logger.debug("schedule-debounce", () => [
      `[DEBOUNCE] Skipping debounced computation: ${state.getActionId(fn)}`,
    ]);
    state.filterStats.filtered++;
    state.pending.delete(fn);
    return true;
  }

  if (state.isThrottled(fn)) {
    logger.debug("schedule-throttle", () => [
      `[THROTTLE] Skipping throttled action: ${state.getActionId(fn)}`,
    ]);
    state.filterStats.filtered++;
    state.pending.delete(fn);
    return true;
  }

  return false;
}
