import { getLogger } from "@commonfabric/utils/logger";
import { topologicalSort } from "./topology.ts";
import type { Action, SettleIterationStats } from "./types.ts";
import { collectMaterializerWritersForLog } from "./materializers.ts";
import {
  collectPendingDependencyActions,
  recordEarlyIterationComputations,
  recordSettleActionRun,
  type SchedulerSettleLoopState,
  type SchedulerSettleResult,
  summarizeSettleIteration,
  summarizeSettleRun,
} from "./execution.ts";
import { PASS_RUN_BUDGET } from "./constants.ts";
import { isInvalidOrNeverRan } from "./pull-scheduling.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

type PullSettleIteration = { settled: true } | {
  settled: false;
  workSet: Set<Action>;
  order: Action[];
};

function buildPullIterationWorkSet(state: {
  readonly initialSeeds: ReadonlySet<Action>;
  readonly nodes: SchedulerSettleLoopState["nodes"];
  readonly dependencies: SchedulerSettleLoopState["dependencies"];
  readonly materializerIndex: SchedulerSettleLoopState["materializerIndex"];
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly isLiveAction: (action: Action) => boolean;
  readonly collectPullIterationSeeds: (iterationSeeds: Set<Action>) => void;
}): {
  workSet: Set<Action>;
  iterationSeeds: Set<Action>;
  materializerPromotionCount: number;
} {
  const workSet = new Set<Action>();
  const iterationSeeds = new Set<Action>();

  for (const seed of state.initialSeeds) {
    iterationSeeds.add(seed);
  }

  // Every iteration needs to consider newly created pending effects.
  // Without this, nested/recursive patterns can stall after creating
  // new demand-root effects in an earlier iteration.
  state.collectPullIterationSeeds(iterationSeeds);

  for (const seed of iterationSeeds) {
    workSet.add(seed);
  }

  const beforePromotions = workSet.size;
  addInvalidMaterializerPromotions(state, iterationSeeds, workSet);
  const materializerPromotionCount = workSet.size - beforePromotions;
  addLiveDownstreamClosure(state, workSet);

  return {
    workSet,
    iterationSeeds,
    materializerPromotionCount,
  };
}

function addInvalidMaterializerPromotions(
  state: {
    readonly nodes: SchedulerSettleLoopState["nodes"];
    readonly dependencies: SchedulerSettleLoopState["dependencies"];
    readonly materializerIndex: SchedulerSettleLoopState["materializerIndex"];
  },
  seeds: ReadonlySet<Action>,
  workSet: Set<Action>,
): void {
  for (const seed of seeds) {
    const log = state.dependencies.get(seed);
    if (!log) continue;

    for (
      const materializer of collectMaterializerWritersForLog(
        state.materializerIndex,
        log,
        { exclude: seed },
      )
    ) {
      const record = state.nodes.get(materializer);
      if (record && isInvalidOrNeverRan(record)) {
        workSet.add(materializer);
      }
    }
  }
}

function addLiveDownstreamClosure(state: {
  readonly nodes: SchedulerSettleLoopState["nodes"];
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly isLiveAction: (action: Action) => boolean;
}, workSet: Set<Action>): void {
  const visited = new Set<Action>();
  const dirtyRoots = [...workSet].filter((action) => {
    const record = state.nodes.get(action);
    return record !== undefined && isInvalidOrNeverRan(record);
  });

  const visit = (action: Action): void => {
    if (visited.has(action)) return;
    visited.add(action);

    const dependents = state.dependents.get(action);
    if (!dependents) return;

    for (const dependent of dependents) {
      if (!state.isLiveAction(dependent)) continue;
      workSet.add(dependent);
      visit(dependent);
    }
  };

  for (const action of dirtyRoots) {
    visit(action);
  }
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
  // This sets up their dependencies before work-set construction.
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
): PullSettleIteration {
  const { workSet } = buildAndLogPullIterationWorkSet(
    state,
    initialSeeds,
    settleIter,
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

  const order = orderPullWorkSet(state, workSet, settleIter);

  return { settled: false, workSet, order };
}

function buildAndLogPullIterationWorkSet(
  state: SchedulerSettleLoopState,
  initialSeeds: ReadonlySet<Action>,
  settleIter: number,
): {
  workSet: Set<Action>;
  iterationSeeds: Set<Action>;
  materializerPromotionCount: number;
} {
  const buildPullWorkSetStart = performance.now();
  const result = buildPullIterationWorkSet({
    initialSeeds,
    nodes: state.nodes,
    dependencies: state.dependencies,
    materializerIndex: state.materializerIndex,
    dependents: state.dependents,
    isLiveAction: state.isLiveAction,
    collectPullIterationSeeds: state.collectPullIterationSeeds,
  });

  if (settleIter === 0) {
    logger.debug("schedule-execute-pull", () => [
      `Pull mode: Seeds: ${result.iterationSeeds.size}, Materializers promoted: ${result.materializerPromotionCount}`,
    ]);
  }
  logger.time(
    buildPullWorkSetStart,
    "scheduler",
    "execute",
    "buildPullWorkSet",
  );

  return result;
}

function orderPullWorkSet(
  state: SchedulerSettleLoopState,
  workSet: Set<Action>,
  settleIter: number,
): Action[] {
  const topologicalSortStart = performance.now();
  const order = topologicalSort(
    workSet,
    state.dependencies,
    state.getSchedulingWritesMap(),
    state.nodes,
    state.dependents,
    (action) => state.materializerIndex.getMaterializerWriteEnvelopes(action),
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

  return order;
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
  if (skipPullDelayedSettleAction(state, fn)) return 0;

  // Clean up explicit scheduling state before running. The node status is
  // set clean inside runSchedulerAction before invoking the action body.
  state.pending.delete(fn);
  if (state.computations.has(fn)) {
    state.clearComputationDebounceState(fn);
  }

  state.filterStats.executed++;
  if (!recordSettleActionRun(state, fn)) {
    clearInvalidSettleAction(state, fn);
    return 1;
  }

  await state.runAction(fn);
  return 1;
}

function clearInvalidSettleAction(
  state: SchedulerSettleLoopState,
  fn: Action,
): void {
  const record = state.nodes.get(fn);
  if (!record) return;
  if (record.status === "invalid") {
    record.status = "clean";
  }
  record.invalidCauses = [];
}

function isPullSettleActionStillRunnable(
  state: SchedulerSettleLoopState,
  fn: Action,
): boolean {
  const record = state.nodes.get(fn);
  return record !== undefined &&
    isInvalidOrNeverRan(record) &&
    (state.isLiveAction(fn) || state.pending.has(fn)) &&
    record.passRuns < PASS_RUN_BUDGET;
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
    return true;
  }

  return false;
}
