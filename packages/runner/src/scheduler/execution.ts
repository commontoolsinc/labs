import { getLogger } from "@commonfabric/utils/logger";
import { type Frame } from "../builder/types.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import {
  CYCLE_DEBOUNCE_MIN_RUNS,
  CYCLE_DEBOUNCE_MULTIPLIER,
  CYCLE_DEBOUNCE_THRESHOLD_MS,
  MAX_ITERATIONS_PER_RUN,
} from "./constants.ts";
import { topologicalSort } from "./topology.ts";
import type {
  Action,
  PopulateDependenciesEntry,
  ReactivityLog,
  SettleIterationStats,
  SettleStats,
  SpaceScopeAndURI,
} from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export interface SettlingTracker {
  windowStart: number;
  busyTime: number;
  lastExecuteStart: number;
  isExecuting: boolean;
  nonSettlingDetected: boolean;
}

export function createSettlingTracker(): SettlingTracker {
  return {
    windowStart: 0,
    busyTime: 0,
    lastExecuteStart: 0,
    isExecuting: false,
    nonSettlingDetected: false,
  };
}

export function markExecuteStart(
  tracker: SettlingTracker,
  now = performance.now(),
): void {
  tracker.lastExecuteStart = now;
  tracker.isExecuting = true;
  if (tracker.windowStart === 0) {
    tracker.windowStart = now;
  }
}

export interface ExecuteEndUpdate {
  diagnosisBusyTimeMs: number;
  nonSettlingTelemetry?: {
    busyTime: number;
    windowDuration: number;
    busyRatio: number;
  };
}

export function recordExecuteEnd(
  tracker: SettlingTracker,
  now = performance.now(),
): ExecuteEndUpdate {
  const elapsed = now - tracker.lastExecuteStart;
  tracker.busyTime += elapsed;
  tracker.isExecuting = false;

  let nonSettlingTelemetry: ExecuteEndUpdate["nonSettlingTelemetry"];
  const windowDuration = now - tracker.windowStart;
  if (windowDuration > 5000) {
    const busyRatio = tracker.busyTime / windowDuration;
    if (
      busyRatio > 0.3 &&
      tracker.busyTime > 1000 &&
      !tracker.nonSettlingDetected
    ) {
      tracker.nonSettlingDetected = true;
      nonSettlingTelemetry = {
        busyTime: tracker.busyTime,
        windowDuration,
        busyRatio,
      };
    }
  }

  // Slide the window if it exceeds 10s without idle.
  if (windowDuration > 10000) {
    tracker.windowStart = now;
    tracker.busyTime = tracker.busyTime / 2; // Rolling average
  }

  return {
    diagnosisBusyTimeMs: elapsed,
    ...(nonSettlingTelemetry ? { nonSettlingTelemetry } : {}),
  };
}

export function buildPullInitialSeeds(state: {
  readonly pending: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly newActionsWithoutDependencies: Iterable<Action>;
  readonly eventBlockingDeps: Iterable<Action>;
  readonly computationDebounceFlushSeeds: Iterable<Action>;
}): Set<Action> {
  const initialSeeds = new Set<Action>();

  // Pending effects are demand roots. Computations stay lazy unless pulled.
  for (const action of state.pending) {
    if (state.effects.has(action)) {
      initialSeeds.add(action);
    }
  }

  // Dirty effects may have been skipped by throttling or cycle detection.
  for (const action of state.dirty) {
    if (state.effects.has(action)) {
      initialSeeds.add(action);
    }
  }

  for (const action of state.newActionsWithoutDependencies) {
    initialSeeds.add(action);
  }
  for (const action of state.eventBlockingDeps) {
    initialSeeds.add(action);
  }
  for (const action of state.computationDebounceFlushSeeds) {
    initialSeeds.add(action);
  }

  return initialSeeds;
}

export interface ExecuteDependencyCollectionState {
  readonly pendingDependencyCollection: Set<Action>;
  readonly populateDependenciesCallbacks: WeakMap<
    Action,
    PopulateDependenciesEntry
  >;
  readonly effects: ReadonlySet<Action>;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly unknown[] | undefined;
  readonly collectDependenciesForAction: (
    action: Action,
    populateDependencies: PopulateDependenciesEntry,
    options: {
      readonly errorLogLabel: string;
      readonly errorMessage: (target: Action, error: unknown) => string;
      readonly useRawReadsForTriggers?: boolean;
    },
  ) => { log: ReactivityLog; entities: Set<SpaceScopeAndURI> };
  readonly getActionId: (action: Action) => string;
  readonly scheduleAffectedEffects?: (action: Action) => void;
}

export function collectInitialExecuteDependencies(
  state: ExecuteDependencyCollectionState,
): {
  collectedActions: Action[];
  newActionsWithoutDependencies: Action[];
} {
  logger.timeStart("scheduler", "execute", "depCollect");
  try {
    // Find computation actions whose writes are still unknown. We run them on
    // the first cycle to capture writes that cannot be inferred from declared
    // outputs or populateDependencies() potential writes.
    //
    // TODO(seefeld): Once we more reliably capture what they can write via
    // WriteableCell or so, then we can treat this more deliberately via the
    // dependency collection process above. We'll have to re-run it whenever
    // inputs change, as they might change what they can write to. We hope that
    // for now this will be sufficiently captured in mightWrite.
    return collectPendingDependencyActions({
      pendingDependencyCollection: state.pendingDependencyCollection,
      populateDependenciesCallbacks: state.populateDependenciesCallbacks,
      effects: state.effects,
      getSchedulingWrites: state.getSchedulingWrites,
      collectDependenciesForAction: (action, populateDependencies) =>
        state.collectDependenciesForAction(action, populateDependencies, {
          errorLogLabel: "schedule-dep-error",
          errorMessage: (target, error) =>
            `Error populating dependencies for ${
              state.getActionId(target)
            }: ${error}`,
        }),
      onCollected: (action, { log, entities }) =>
        logger.debug("schedule-dep-collect", () => [
          `Collected dependencies for ${
            state.getActionId(action)
          }: ${log.reads.length} reads, ${log.writes.length} writes, ${entities.size} entities`,
        ]),
      scheduleAffectedEffects: state.scheduleAffectedEffects,
    });
  } finally {
    logger.timeEnd("scheduler", "execute", "depCollect");
  }
}

export function collectPostEventDependencies(
  state: ExecuteDependencyCollectionState,
): void {
  // Process any newly subscribed actions that were added during event handling.
  // This handles cases like event handlers that create sub-patterns whose
  // computations need their dependencies discovered before we build the workSet.
  if (state.pendingDependencyCollection.size === 0) return;

  collectPendingDependencyActions({
    pendingDependencyCollection: state.pendingDependencyCollection,
    populateDependenciesCallbacks: state.populateDependenciesCallbacks,
    effects: state.effects,
    getSchedulingWrites: state.getSchedulingWrites,
    collectDependenciesForAction: (action, populateDependencies) =>
      state.collectDependenciesForAction(action, populateDependencies, {
        errorLogLabel: "schedule-dep-error-post-event",
        errorMessage: (target, error) =>
          `Error populating dependencies for ${
            state.getActionId(target)
          }: ${error}`,
      }),
    onCollected: (action) =>
      logger.debug("schedule-dep-collect-post-event", () => [
        `Collected dependencies for ${state.getActionId(action)}`,
      ]),
  });
}

export function collectPendingDependencyActions(state: {
  readonly pendingDependencyCollection: Set<Action>;
  readonly populateDependenciesCallbacks: WeakMap<
    Action,
    PopulateDependenciesEntry
  >;
  readonly effects: ReadonlySet<Action>;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly unknown[] | undefined;
  readonly collectDependenciesForAction: (
    action: Action,
    populateDependencies: PopulateDependenciesEntry,
  ) => { log: ReactivityLog; entities: Set<SpaceScopeAndURI> };
  readonly onCollected?: (
    action: Action,
    result: { log: ReactivityLog; entities: Set<SpaceScopeAndURI> },
  ) => void;
  readonly scheduleAffectedEffects?: (action: Action) => void;
  readonly clearAfterCollect?: boolean;
}): {
  collectedActions: Action[];
  newActionsWithoutDependencies: Action[];
} {
  const collectedActions: Action[] = [];

  // Snapshot the collection before any callbacks can mutate the underlying set.
  for (const action of [...state.pendingDependencyCollection]) {
    const populateDependencies = state.populateDependenciesCallbacks.get(
      action,
    );
    if (!populateDependencies) continue;

    const result = state.collectDependenciesForAction(
      action,
      populateDependencies,
    );
    state.onCollected?.(action, result);
    collectedActions.push(action);
  }

  // Now mark downstream nodes as dirty if we introduced new dependencies for them.
  if (state.scheduleAffectedEffects) {
    for (const action of collectedActions) {
      state.scheduleAffectedEffects(action);
    }
  }

  const newActionsWithoutDependencies = [...state.pendingDependencyCollection]
    .filter((action) =>
      !state.effects.has(action) &&
      (state.getSchedulingWrites(action)?.length ?? 0) === 0
    );

  if (state.clearAfterCollect ?? true) {
    state.pendingDependencyCollection.clear();
  }

  return { collectedActions, newActionsWithoutDependencies };
}

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

  // Every iteration needs to consider newly created pending effects.
  // Without this, nested/recursive patterns can stall after creating
  // new demand-root effects in an earlier iteration.
  state.collectPullIterationSeeds(iterationSeeds);

  // On first iteration, add special-case seeds discovered before settle.
  if (state.settleIter === 0) {
    for (const seed of state.initialSeeds) {
      iterationSeeds.add(seed);
    }
  }

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

export type SchedulerSettleResult = {
  settledEarly: boolean;
  lastWorkSet: Set<Action>;
  earlyIterationComputations: Set<Action>;
  maxSettleIterations: number;
  settleStats?: SettleStats;
};

export interface SchedulerSettleLoopState {
  readonly getPullMode: () => boolean;
  readonly getCollectSettleStats: () => boolean;
  readonly pendingDependencyCollection: Set<Action>;
  readonly populateDependenciesCallbacks: WeakMap<
    Action,
    PopulateDependenciesEntry
  >;
  readonly effects: ReadonlySet<Action>;
  readonly computations: ReadonlySet<Action>;
  readonly pending: Set<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly actionParent: WeakMap<Action, Action>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly conditionallyScheduledEffects: Map<Action, number>;
  readonly filterStats: { filtered: number; executed: number };
  readonly getLoopCounter: () => WeakMap<Action, number>;
  readonly runsThisExecute: Map<Action, number>;
  readonly activePullDemandActions: WeakSet<Action>;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getSchedulingWritesMap: () => WeakMap<
    Action,
    IMemorySpaceAddress[]
  >;
  readonly collectDependenciesForAction: (
    action: Action,
    populateDependencies: PopulateDependenciesEntry,
    options: {
      readonly errorLogLabel: string;
      readonly errorMessage: (target: Action, error: unknown) => string;
      readonly useRawReadsForTriggers?: boolean;
    },
  ) => { log: ReactivityLog; entities: Set<SpaceScopeAndURI> };
  readonly collectPullIterationSeeds: (seeds: Set<Action>) => void;
  readonly collectDirtyDependencies: (
    seed: Action,
    targetWorkSet: Set<Action>,
    memo: Map<Action, boolean>,
  ) => boolean;
  readonly getActionId: (action: Action) => string;
  readonly clearDirty: (action: Action) => void;
  readonly markDirectDirty: (action: Action) => void;
  readonly isThrottled: (action: Action) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly clearComputationDebounceState: (action: Action) => void;
  readonly conditionalEffectHasChangedInputs: (action: Action) => boolean;
  readonly isPullDemandRootEffect: (action: Action) => boolean;
  readonly handleError: (error: Error, action: Action) => void;
  readonly runAction: (action: Action) => Promise<unknown>;
}

export async function runSchedulerSettleLoop(
  state: SchedulerSettleLoopState,
  initialSeeds: ReadonlySet<Action>,
): Promise<SchedulerSettleResult> {
  if (state.getPullMode()) {
    return await runPullSchedulerSettleLoop(state, initialSeeds);
  }
  return await runPushSchedulerSettleLoop(state);
}

async function runPushSchedulerSettleLoop(
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

async function runPullSchedulerSettleLoop(
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
  // by the time we run it, something in the execution re-dirtied it → cycle.
  for (const fn of order) {
    if (state.effects.has(fn)) {
      state.clearDirty(fn);
    }
  }

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

function recordSettleActionRun(
  state: SchedulerSettleLoopState,
  fn: Action,
): boolean {
  const loopCounter = state.getLoopCounter();
  loopCounter.set(fn, (loopCounter.get(fn) || 0) + 1);
  // Track runs for cycle-aware debounce
  state.runsThisExecute.set(fn, (state.runsThisExecute.get(fn) ?? 0) + 1);
  if (loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN) {
    const error = new Error(
      `Too many iterations: ${loopCounter.get(fn)} ${state.getActionId(fn)}`,
    );
    // Attach the last frame from the action so handleError can
    // extract piece/spell metadata (CT-1316: fixes message:null).
    const lastFrame = (fn as Action & { lastFrame?: Frame }).lastFrame;
    if (lastFrame) {
      (error as Error & { frame?: Frame }).frame = lastFrame;
    }
    state.handleError(error, fn);
    return false;
  }

  return true;
}

function isPushSettleActionStillRunnable(
  state: SchedulerSettleLoopState,
  fn: Action,
): boolean {
  return state.pending.has(fn);
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
      // Effect was re-dirtied during this tick → cycle detected
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
    !state.getPullMode() ||
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

export function recordEarlyIterationComputations(state: {
  readonly settleIter: number;
  readonly threshold: number;
  readonly workSet: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly earlyIterationComputations: Set<Action>;
}): void {
  if (state.settleIter >= state.threshold) return;
  for (const action of state.workSet) {
    if (!state.effects.has(action)) {
      state.earlyIterationComputations.add(action);
    }
  }
}

export function isPendingPullActionRunnable(state: {
  readonly effects: ReadonlySet<Action>;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly shouldRunFirstPullComputationInDemandContext: (
    action: Action,
  ) => boolean;
}, action: Action): boolean {
  return state.effects.has(action) ||
    state.isDemandedPullComputation(action) ||
    state.shouldRunFirstPullComputationInDemandContext(action);
}

export function isDirtyPullActionRunnable(state: {
  readonly effects: ReadonlySet<Action>;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly isThrottled: (action: Action) => boolean;
  readonly isDebouncedComputationWaiting?: (action: Action) => boolean;
}, action: Action): boolean {
  return (
    state.effects.has(action) ||
    state.isDemandedPullComputation(action)
  ) &&
    !state.isThrottled(action) &&
    state.isDebouncedComputationWaiting?.(action) !== true;
}

export function summarizeSettleIteration(state: {
  readonly workSetSize: number;
  readonly order: readonly Action[];
  readonly actionsRun: number;
  readonly durationMs: number;
  readonly effects: ReadonlySet<Action>;
  readonly getActionId: (action: Action) => string;
  readonly maxActions?: number;
}): SettleIterationStats {
  const maxActions = state.maxActions ?? 30;
  const actions: SettleIterationStats["actions"] = [];
  for (const action of state.order) {
    actions.push({
      id: state.getActionId(action),
      type: state.effects.has(action) ? "effect" : "computation",
    });
    if (actions.length >= maxActions) break;
  }

  return {
    workSetSize: state.workSetSize,
    orderSize: state.order.length,
    actionsRun: state.actionsRun,
    actions,
    durationMs: state.durationMs,
  };
}

export function summarizeSettleRun(state: {
  readonly iterations: SettleIterationStats[];
  readonly totalDurationMs: number;
  readonly settledEarly: boolean;
  readonly initialSeedCount: number;
}): SettleStats {
  return {
    iterations: state.iterations,
    totalDurationMs: state.totalDurationMs,
    settledEarly: state.settledEarly,
    initialSeedCount: state.initialSeedCount,
  };
}

export function pushBoundedHistory<T>(
  history: T[],
  entry: T,
  maxLength: number,
): void {
  history.push(entry);
  if (history.length > maxLength) {
    history.shift();
  }
}

export interface CycleBreakPlan {
  shouldBreak: boolean;
  computationsToClear: Action[];
  dirtyEffectsToRun: Action[];
}

export function planCycleBreak(state: {
  readonly pullMode: boolean;
  readonly settledEarly: boolean;
  readonly lastWorkSet: ReadonlySet<Action>;
  readonly earlyIterationComputations: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly runsThisExecute: ReadonlyMap<Action, number>;
  readonly isThrottled: (action: Action) => boolean;
}): CycleBreakPlan {
  const shouldBreak = state.pullMode &&
    !state.settledEarly &&
    state.lastWorkSet.size > 0;
  if (!shouldBreak) {
    return { shouldBreak, computationsToClear: [], dirtyEffectsToRun: [] };
  }

  const computationsToClear: Action[] = [];
  for (const computation of state.earlyIterationComputations) {
    if (
      state.lastWorkSet.has(computation) &&
      state.dirty.has(computation) &&
      !state.isThrottled(computation) &&
      (state.runsThisExecute.get(computation) ?? 0) > 1
    ) {
      computationsToClear.push(computation);
    }
  }

  const dirtyEffectsToRun = [...state.effects].filter((effect) =>
    state.dirty.has(effect) && !state.isThrottled(effect)
  );

  return { shouldBreak, computationsToClear, dirtyEffectsToRun };
}

export interface CycleDebounceUpdate {
  action: Action;
  runs: number;
  delayMs: number;
}

export function planAdaptiveCycleDebounce(state: {
  readonly pullMode: boolean;
  readonly executeStartTime: number;
  readonly runsThisExecute: ReadonlyMap<Action, number>;
  readonly canAutomaticallyDebounce: (action: Action) => boolean;
  readonly getCurrentDebounce: (action: Action) => number | undefined;
  readonly now?: number;
}): {
  elapsedMs: number;
  updates: CycleDebounceUpdate[];
} {
  const now = state.now ?? performance.now();
  const elapsedMs = now - state.executeStartTime;
  if (!state.pullMode || elapsedMs < CYCLE_DEBOUNCE_THRESHOLD_MS) {
    return { elapsedMs, updates: [] };
  }

  const updates: CycleDebounceUpdate[] = [];
  for (const [action, runs] of state.runsThisExecute) {
    if (
      !state.canAutomaticallyDebounce(action) ||
      runs < CYCLE_DEBOUNCE_MIN_RUNS
    ) {
      continue;
    }
    const delayMs = Math.round(CYCLE_DEBOUNCE_MULTIPLIER * elapsedMs);
    const currentDebounce = state.getCurrentDebounce(action) ?? 0;
    if (delayMs > currentDebounce) {
      updates.push({ action, runs, delayMs });
    }
  }

  return { elapsedMs, updates };
}

export interface ExecuteContinuationPlan {
  hasPendingPullWork: boolean;
  hasDirtyPullWork: boolean;
  hasImmediateRerunRequest: boolean;
  hasQueuedEventReadyNow: boolean;
  hasParkedHeadEvent: boolean;
  nextDirtyPullRunAt?: number;
  nextDirtyPullRunWaitsForIdle: boolean;
  shouldQueueAnotherTick: boolean;
}

export function planEventDirtyDependencyScheduling(state: {
  readonly dirtyDeps: Iterable<Action>;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly now?: number;
}): {
  runnableDeps: Action[];
  nextEligibleAt?: number;
} {
  let nextEligibleAt: number | undefined;
  const runnableDeps: Action[] = [];

  for (const dep of state.dirtyDeps) {
    if (state.isDebouncedComputationWaiting(dep)) {
      const depNextDebounceAt = state.getNextDebounceRunTime(dep);
      if (depNextDebounceAt !== undefined) {
        nextEligibleAt = minDefined(nextEligibleAt, depNextDebounceAt);
        continue;
      }
    }

    const depNextEligibleAt = state.getNextEligibleRunTime(dep);
    if (
      depNextEligibleAt !== undefined &&
      depNextEligibleAt > (state.now ?? performance.now())
    ) {
      nextEligibleAt = minDefined(nextEligibleAt, depNextEligibleAt);
      continue;
    }

    runnableDeps.push(dep);
  }

  return {
    runnableDeps,
    ...(nextEligibleAt !== undefined ? { nextEligibleAt } : {}),
  };
}

export function planExecuteContinuation(state: {
  readonly pullMode: boolean;
  readonly pending: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly shouldRerunAfterCurrentExecute: boolean;
  readonly hasQueuedEventReadyNow: boolean;
  readonly hasParkedHeadEvent: boolean;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly shouldRunFirstPullComputationInDemandContext: (
    action: Action,
  ) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly now?: number;
}): ExecuteContinuationPlan {
  const now = state.now ?? performance.now();
  const hasPendingPullWork = state.pullMode
    ? [...state.pending].some((action) =>
      state.effects.has(action) ||
      state.isDemandedPullComputation(action) ||
      state.shouldRunFirstPullComputationInDemandContext(action)
    )
    : state.pending.size > 0;

  let nextDirtyPullRunAt: number | undefined;
  let nextDirtyPullRunWaitsForIdle = false;
  const hasDirtyPullWork = state.pullMode &&
    [...state.dirty].some((action) => {
      if (
        !state.effects.has(action) &&
        !state.isDemandedPullComputation(action)
      ) {
        return false;
      }

      if (state.isDebouncedComputationWaiting(action)) {
        const nextDebounceAt = state.getNextDebounceRunTime(action);
        if (nextDebounceAt !== undefined) {
          nextDirtyPullRunAt = minDefined(
            nextDirtyPullRunAt,
            nextDebounceAt,
          );
          nextDirtyPullRunWaitsForIdle ||= state.effects.has(action);
        }
        return false;
      }

      const nextEligibleAt = state.getNextEligibleRunTime(action);
      if (nextEligibleAt !== undefined && nextEligibleAt > now) {
        nextDirtyPullRunAt = minDefined(nextDirtyPullRunAt, nextEligibleAt);
        nextDirtyPullRunWaitsForIdle ||= state.effects.has(action);
        return false;
      }

      return true;
    });

  const hasImmediateRerunRequest = state.shouldRerunAfterCurrentExecute &&
    nextDirtyPullRunAt === undefined;
  const shouldQueueAnotherTick = hasImmediateRerunRequest ||
    hasPendingPullWork ||
    hasDirtyPullWork ||
    state.hasQueuedEventReadyNow;

  return {
    hasPendingPullWork,
    hasDirtyPullWork,
    hasImmediateRerunRequest,
    hasQueuedEventReadyNow: state.hasQueuedEventReadyNow,
    hasParkedHeadEvent: state.hasParkedHeadEvent,
    ...(nextDirtyPullRunAt !== undefined ? { nextDirtyPullRunAt } : {}),
    nextDirtyPullRunWaitsForIdle,
    shouldQueueAnotherTick,
  };
}

function minDefined(
  current: number | undefined,
  next: number,
): number {
  return current === undefined ? next : Math.min(current, next);
}
