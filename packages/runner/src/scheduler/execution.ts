import { getLogger } from "@commonfabric/utils/logger";
import { type Frame } from "../builder/types.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import {
  CYCLE_DEBOUNCE_MIN_RUNS,
  CYCLE_DEBOUNCE_MULTIPLIER,
  CYCLE_DEBOUNCE_THRESHOLD_MS,
  MAX_ITERATIONS_PER_RUN,
} from "./constants.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry } from "./node-record.ts";
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
    // outputs.
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

export type SchedulerSettleResult = {
  settledEarly: boolean;
  lastWorkSet: Set<Action>;
  earlyIterationComputations: Set<Action>;
  maxSettleIterations: number;
  settleStats?: SettleStats;
};

export interface SchedulerSettleLoopState {
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
  readonly nodes: NodeRegistry;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly conditionallyScheduledEffects: Map<Action, number>;
  readonly filterStats: { filtered: number; executed: number };
  readonly getLoopCounter: () => WeakMap<Action, number>;
  readonly runsThisExecute: Map<Action, number>;
  readonly materializerIndex: MaterializerIndexState;
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
  readonly collectDirtyDependenciesFromTraversalRoot: (
    seed: Action,
    targetWorkSet: Set<Action>,
    memo: Map<Action, boolean>,
  ) => boolean;
  readonly getActionId: (action: Action) => string;
  readonly getDirectDirtySeq: (action: Action) => number | undefined;
  readonly clearDirty: (action: Action, expectedSeq?: number) => void;
  readonly markDirectDirty: (action: Action) => void;
  readonly isThrottled: (action: Action) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly clearComputationDebounceState: (action: Action) => void;
  readonly conditionalEffectHasChangedInputs: (action: Action) => boolean;
  readonly handleError: (error: Error, action: Action) => void;
  readonly runAction: (action: Action) => Promise<unknown>;
}

export function recordSettleActionRun(
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

export function planPullCycleBreak(state: {
  readonly settledEarly: boolean;
  readonly lastWorkSet: ReadonlySet<Action>;
  readonly earlyIterationComputations: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly runsThisExecute: ReadonlyMap<Action, number>;
  readonly isThrottled: (action: Action) => boolean;
}): CycleBreakPlan {
  const shouldBreak = !state.settledEarly && state.lastWorkSet.size > 0;
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

export function planPullAdaptiveCycleDebounce(state: {
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
  if (elapsedMs < CYCLE_DEBOUNCE_THRESHOLD_MS) {
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

export function planPullExecuteContinuation(state: {
  readonly pending: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly materializerIndex: MaterializerIndexState;
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
  const hasPendingPullWork = [...state.pending].some((action) =>
    state.effects.has(action) ||
    state.materializerIndex.isMaterializer(action) ||
    state.isDemandedPullComputation(action) ||
    state.shouldRunFirstPullComputationInDemandContext(action)
  );

  let nextDirtyPullRunAt: number | undefined;
  let nextDirtyPullRunWaitsForIdle = false;
  const hasDirtyPullWork = [...state.dirty].some((action) => {
    if (
      !state.effects.has(action) &&
      !state.isDemandedPullComputation(action) &&
      !state.materializerIndex.isMaterializer(action)
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
        nextDirtyPullRunWaitsForIdle ||= state.effects.has(action) ||
          state.materializerIndex.isMaterializer(action);
      }
      return false;
    }

    const nextEligibleAt = state.getNextEligibleRunTime(action);
    if (nextEligibleAt !== undefined && nextEligibleAt > now) {
      nextDirtyPullRunAt = minDefined(nextDirtyPullRunAt, nextEligibleAt);
      nextDirtyPullRunWaitsForIdle ||= state.effects.has(action) ||
        state.materializerIndex.isMaterializer(action);
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
