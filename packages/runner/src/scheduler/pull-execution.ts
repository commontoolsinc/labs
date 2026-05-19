import { getLogger } from "@commonfabric/utils/logger";
import { topologicalSort } from "./topology.ts";
import type { Action, SettleIterationStats } from "./types.ts";
import {
  collectPendingDependencyActions,
  recordEarlyIterationComputations,
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

function buildPullIterationWorkSet(state: {
  readonly initialSeeds: ReadonlySet<Action>;
  readonly settleIter: number;
  readonly collectPullIterationSeeds: (iterationSeeds: Set<Action>) => void;
  readonly collectDirtyDependencies: (
    seed: Action,
    workSet: Set<Action>,
    memo: Map<Action, boolean>,
  ) => boolean;
}): {
  workSet: Set<Action>;
  iterationSeeds: Set<Action>;
  dirtyDependencyCount: number;
} {
  const workSet = new Set<Action>();
  const iterationSeeds = new Set<Action>();

  // On first iteration, add special-case seeds discovered before settle.
  if (state.settleIter === 0) {
    for (const seed of state.initialSeeds) {
      iterationSeeds.add(seed);
    }
  }

  // Every iteration needs to consider newly created pending effects.
  // Without this, nested/recursive patterns can stall after creating
  // new demand-root effects in an earlier iteration.
  state.collectPullIterationSeeds(iterationSeeds);

  for (const seed of iterationSeeds) {
    workSet.add(seed);
  }

  // Pull in dirty computations that feed the currently runnable seeds.
  const dirtyDependencyMemo = new Map<Action, boolean>();
  for (const seed of iterationSeeds) {
    state.collectDirtyDependencies(seed, workSet, dirtyDependencyMemo);
  }

  return {
    workSet,
    iterationSeeds,
    dirtyDependencyCount: workSet.size - iterationSeeds.size,
  };
}

export async function runPullSchedulerSettleLoop(
  state: SchedulerSettleLoopState,
  initialSeeds: ReadonlySet<Action>,
): Promise<SchedulerSettleResult> {
  // Pull mode settles demand roots plus the dirty computations they observe.
  // First iteration processes initial seeds + their dirty deps.
  // Subsequent iterations process new subscriptions and re-collect dirty deps.
  logger.timeStart("scheduler", "execute", "settle");
  const maxSettleIterations = 10;
  const EARLY_ITERATION_THRESHOLD = 5;
  const earlyIterationComputations = new Set<Action>(); // Track computations in first N iterations
  let lastWorkSet: Set<Action> = new Set();
  let settledEarly = false;
  const collectSettleStats = state.getCollectSettleStats();
  const settleIterStats: SettleIterationStats[] | undefined = collectSettleStats
    ? []
    : undefined;
  const settleStartTime = collectSettleStats ? performance.now() : 0;

  for (let settleIter = 0; settleIter < maxSettleIterations; settleIter++) {
    const iterStart = settleIterStats ? performance.now() : 0;

    collectPullSettlePreRunDependencies(state);
    const iteration = preparePullSettleIteration(
      state,
      initialSeeds,
      settleIter,
      EARLY_ITERATION_THRESHOLD,
      earlyIterationComputations,
    );

    if (iteration.settled) {
      settledEarly = true;
      break;
    }

    lastWorkSet = iteration.workSet;
    const iterationWorkSetSize = iteration.workSet.size;
    const iterActionsRun = await runPullSettleOrder(state, iteration.order);

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
      initialSeedCount: initialSeeds.size,
    })
    : undefined;

  logger.timeEnd("scheduler", "execute", "settle");

  return {
    settledEarly,
    lastWorkSet,
    earlyIterationComputations,
    maxSettleIterations,
    ...(settleStats ? { settleStats } : {}),
  };
}

function collectPullSettlePreRunDependencies(
  state: SchedulerSettleLoopState,
): void {
  // Process any newly subscribed actions from previous iteration.
  // This sets up their dependencies so collectDirtyDependencies can find them.
  if (state.pendingDependencyCollection.size === 0) {
    return;
  }

  collectPendingDependencyActions({
    pendingDependencyCollection: state.pendingDependencyCollection,
    populateDependenciesCallbacks: state.populateDependenciesCallbacks,
    effects: state.effects,
    getSchedulingWrites: state.getSchedulingWrites,
    collectDependenciesForAction: (action, populateDependencies) =>
      state.collectDependenciesForAction(action, populateDependencies, {
        errorLogLabel: "schedule-dep-error-pre-run",
        errorMessage: (target, error) =>
          `Error collecting deps for ${state.getActionId(target)}: ${error}`,
        useRawReadsForTriggers: true,
      }),
  });
}

function preparePullSettleIteration(
  state: SchedulerSettleLoopState,
  initialSeeds: ReadonlySet<Action>,
  settleIter: number,
  earlyIterationThreshold: number,
  earlyIterationComputations: Set<Action>,
): { settled: true } | {
  settled: false;
  workSet: Set<Action>;
  order: Action[];
} {
  // Build the work set for this iteration
  const buildPullWorkSetStart = performance.now();
  const { workSet, iterationSeeds, dirtyDependencyCount } =
    buildPullIterationWorkSet({
      initialSeeds,
      settleIter,
      collectPullIterationSeeds: state.collectPullIterationSeeds,
      collectDirtyDependencies: state.collectDirtyDependencies,
    });

  if (settleIter === 0) {
    logger.debug("schedule-execute-pull", () => [
      `Pull mode: Seeds: ${iterationSeeds.size}, Dirty deps added: ${dirtyDependencyCount}`,
    ]);
  }
  logger.time(
    buildPullWorkSetStart,
    "scheduler",
    "execute",
    "buildPullWorkSet",
  );

  if (workSet.size === 0) {
    return { settled: true };
  }

  recordEarlyIterationComputations({
    settleIter,
    threshold: earlyIterationThreshold,
    workSet,
    effects: state.effects,
    earlyIterationComputations,
  });

  const topologicalSortStart = performance.now();
  const order = topologicalSort(
    workSet,
    state.dependencies,
    state.getSchedulingWritesMap(),
    state.actionParent,
    state.dependents,
    state.getMaterializerWriteEnvelopes,
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

  // Implicit cycle detection for effects:
  // Clear dirty flags for all effects upfront. If an effect becomes dirty again
  // by the time we run it, something in the execution re-dirtied it -> cycle.
  for (const fn of order) {
    if (state.effects.has(fn)) {
      state.clearDirty(fn);
    }
  }

  return { settled: false, workSet, order };
}

async function runPullSettleOrder(
  state: SchedulerSettleLoopState,
  order: readonly Action[],
): Promise<number> {
  let actionsRun = 0;
  for (const fn of order) {
    actionsRun += await runPullSettleAction(state, fn);
  }
  return actionsRun;
}

async function runPullSettleAction(
  state: SchedulerSettleLoopState,
  fn: Action,
): Promise<number> {
  // Check if action is still scheduled (not unsubscribed during this tick).
  // Running an action might unsubscribe other actions in the workSet.
  const isStillScheduled = state.computations.has(fn) || state.effects.has(fn);
  if (!isStillScheduled) return 0;

  if (!isPullSettleActionStillRunnable(state, fn)) return 0;
  if (deferEffectForLateMaterializerDependency(state, fn)) return 0;
  if (skipPullDelayedSettleAction(state, fn)) return 0;
  if (skipUnchangedConditionalEffect(state, fn)) return 0;

  // Clean up from pending/dirty before running
  state.pending.delete(fn);
  state.conditionallyScheduledEffects.delete(fn);
  if (state.computations.has(fn)) {
    state.clearComputationDebounceState(fn);
  }
  if (state.effects.has(fn)) {
    state.clearDirty(fn);
  }

  state.filterStats.executed++;
  if (!recordSettleActionRun(state, fn)) return 1;

  const activePullDemand = state.computations.has(fn) ||
    state.isPullDemandRootEffect(fn);
  if (activePullDemand) {
    state.activePullDemandActions.add(fn);
  }
  try {
    await state.runAction(fn);
  } finally {
    if (activePullDemand) {
      state.activePullDemandActions.delete(fn);
    }
  }
  return 1;
}

function isPullSettleActionStillRunnable(
  state: SchedulerSettleLoopState,
  fn: Action,
): boolean {
  const isInPending = state.pending.has(fn);
  const isInDirty = state.dirty.has(fn);

  // For effects: we cleared dirty upfront, so check if re-dirtied (cycle)
  if (state.effects.has(fn)) {
    if (state.dirty.has(fn)) {
      // Effect was re-dirtied during this tick -> cycle detected
      logger.debug("schedule-cycle", () => [
        `[CYCLE] Effect ${
          state.getActionId(fn)
        } re-dirtied, skipping (cycle detected)`,
      ]);
      // Skip this effect - it will run on a future tick after cycle settles
      state.pending.delete(fn);
      return false;
    }
    return isInPending;
  }

  // For computations: must be pending or dirty
  return isInPending || isInDirty;
}

function deferEffectForLateMaterializerDependency(
  state: SchedulerSettleLoopState,
  fn: Action,
): boolean {
  if (!state.effects.has(fn)) return false;

  const dirtyDeps = new Set<Action>();
  state.collectDirtyDependencies(fn, dirtyDeps, new Map());
  const materializers = [...dirtyDeps].filter((dep) =>
    state.isMaterializer(dep) && state.dirty.has(dep)
  );
  if (materializers.length === 0) return false;

  for (const materializer of materializers) {
    state.pending.add(materializer);
  }
  state.pending.add(fn);
  return true;
}

function skipPullDelayedSettleAction(
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

  // Check throttle: skip recently-run actions but keep them dirty
  // They'll be pulled next time an effect needs them (if throttle expired)
  if (state.isThrottled(fn)) {
    logger.debug("schedule-throttle", () => [
      `[THROTTLE] Skipping throttled action: ${state.getActionId(fn)}`,
    ]);
    state.filterStats.filtered++;
    // Don't clear from pending or dirty - action stays in its current state
    // but we remove from pending so it doesn't run this cycle
    state.pending.delete(fn);
    // Keep pull-mode effects dirty so they wake when the throttle expires.
    if (state.effects.has(fn)) {
      state.markDirectDirty(fn);
    }
    return true;
  }

  return false;
}

function skipUnchangedConditionalEffect(
  state: SchedulerSettleLoopState,
  fn: Action,
): boolean {
  if (
    !state.effects.has(fn) ||
    !state.conditionallyScheduledEffects.has(fn) ||
    state.conditionalEffectHasChangedInputs(fn)
  ) {
    return false;
  }

  state.conditionallyScheduledEffects.delete(fn);
  state.pending.delete(fn);
  state.clearDirty(fn);
  state.filterStats.filtered++;
  return true;
}
