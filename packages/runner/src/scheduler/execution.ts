import { getLogger } from "@commonfabric/utils/logger";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  PASS_RUN_BUDGET,
} from "./constants.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
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

export function markNonSettlingEpisode(
  tracker: SettlingTracker,
  now = performance.now(),
): ExecuteEndUpdate["nonSettlingTelemetry"] | undefined {
  if (tracker.nonSettlingDetected) return undefined;

  const windowStart = tracker.windowStart || now;
  const inFlightBusyTime = tracker.isExecuting
    ? Math.max(0, now - tracker.lastExecuteStart)
    : 0;
  const busyTime = tracker.busyTime + inFlightBusyTime;
  const windowDuration = Math.max(1, now - windowStart);
  tracker.nonSettlingDetected = true;

  return {
    busyTime,
    windowDuration,
    busyRatio: Math.min(1, busyTime / windowDuration),
  };
}

export function buildPullInitialSeeds(state: {
  readonly eventBlockingDeps: Iterable<Action>;
  readonly computationDebounceFlushSeeds: Iterable<Action>;
}): Set<Action> {
  const initialSeeds = new Set<Action>();

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
    });
  } finally {
    logger.timeEnd("scheduler", "execute", "depCollect");
  }
}

export function collectPostEventDependencies(
  state: ExecuteDependencyCollectionState,
): {
  collectedActions: Action[];
  newActionsWithoutDependencies: Action[];
} {
  // Process any newly subscribed actions that were added during event handling.
  // This handles cases like event handlers that create sub-patterns whose
  // computations need their dependencies discovered before we build the workSet.
  if (state.pendingDependencyCollection.size === 0) {
    return { collectedActions: [], newActionsWithoutDependencies: [] };
  }

  return collectPendingDependencyActions({
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
  maxSettleIterations: number;
  backoffApplied: boolean;
  backoffActionCount: number;
  backoffUntil?: number;
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
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly nodes: NodeRegistry;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly filterStats: { filtered: number; executed: number };
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
  readonly getActionId: (action: Action) => string;
  readonly isThrottled: (action: Action) => boolean;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly clearComputationDebounceState: (action: Action) => void;
  readonly isLiveAction: (action: Action) => boolean;
  readonly runAction: (action: Action) => Promise<unknown>;
}

export function recordSettleActionRun(
  state: SchedulerSettleLoopState,
  fn: Action,
): void {
  const record = state.nodes.get(fn);
  if (record) {
    record.passRuns++;
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

export interface BudgetBackoffPlan {
  readonly actions: Action[];
  readonly backoffUntil?: number;
}

export function planBudgetBackoff(state: {
  readonly workSet: ReadonlySet<Action>;
  readonly nodes: NodeRegistry;
  readonly pending: ReadonlySet<Action>;
  readonly isLiveAction: (action: Action) => boolean;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly reason: "iteration-cap" | "pass-budget";
  readonly requirePassRunBudget?: boolean;
  readonly now?: number;
}): BudgetBackoffPlan {
  const now = state.now ?? performance.now();
  const actions: Action[] = [];
  let backoffUntil: number | undefined;

  for (const action of state.workSet) {
    const record = state.nodes.get(action);
    if (!record || !isBudgetBackoffCandidate(state, record, now)) {
      continue;
    }

    const delayMs = nextBackoffDelayMs(record);
    record.backoffFailures++;
    record.backoffUntil = now + delayMs;
    actions.push(action);
    backoffUntil = minDefined(backoffUntil, record.backoffUntil);
  }

  return {
    actions,
    ...(backoffUntil !== undefined ? { backoffUntil } : {}),
  };
}

function isBudgetBackoffCandidate(
  state: {
    readonly pending: ReadonlySet<Action>;
    readonly isLiveAction: (action: Action) => boolean;
    readonly getNextEligibleRunTime: (action: Action) => number | undefined;
    readonly isDebouncedComputationWaiting: (action: Action) => boolean;
    readonly reason: "iteration-cap" | "pass-budget";
    readonly requirePassRunBudget?: boolean;
  },
  record: SchedulerNode,
  now: number,
): boolean {
  if (!isInvalidActionRecord(record)) return false;
  if (!state.isLiveAction(record.action) && !state.pending.has(record.action)) {
    return false;
  }
  // NOTE(scheduler-v2): the iteration-cap backoff is NOT merely a perf pause
  // for deep chains — it is the escape valve that lets idle() resolve when a
  // live subgraph has not settled within MAX_ITERS. `backoffUntil` feeds
  // getNextEligibleRunTime, which defers the action out of hasDirtyPullWork
  // (idle resolves) and schedules a retry wake. Gating iteration-cap backoff
  // on cycle evidence (as Codex P2 #4103 suggested) removes that valve for
  // any sub-budget chain that repeatedly hits the cap under load — idle then
  // never resolves (observed: rapid-notebook-create + reload integration
  // tests timed out on `runtime:idle`). Kept as-is; the pass-budget gate only
  // applies to the pass-budget reason.
  if (
    state.reason === "pass-budget" &&
    state.requirePassRunBudget !== false &&
    record.passRuns < PASS_RUN_BUDGET
  ) {
    return false;
  }
  if (state.isDebouncedComputationWaiting(record.action)) return false;

  const nextEligibleAt = state.getNextEligibleRunTime(record.action);
  if (nextEligibleAt !== undefined && nextEligibleAt > now) {
    return false;
  }
  return true;
}

function nextBackoffDelayMs(record: SchedulerNode): number {
  return Math.min(
    BACKOFF_BASE_MS * 2 ** record.backoffFailures,
    BACKOFF_MAX_MS,
  );
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

export function planEventInvalidDependencyScheduling(state: {
  readonly invalidDeps: Iterable<Action>;
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

  for (const dep of state.invalidDeps) {
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
  readonly nodes: NodeRegistry;
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
  let nextDirtyPullRunAt: number | undefined;
  let nextDirtyPullRunWaitsForIdle = false;
  // A deferred run keeps idle() blocked when its eventual run is something an
  // idle waiter expects to observe: effects and materializers (side effects),
  // and a never-ran demanded computation whose FIRST run is still awaited
  // (e.g. a debounced child created under a live parent's provisional demand).
  // Deferring such an action removes it from hasPendingPullWork, so its future
  // run must be tracked here or idle() returns before the gate opens. Limited
  // to the first run: once the computation has produced output, subsequent
  // debounce/throttle-deferred reruns are not awaited (idle must not block
  // through a throttle window and re-run a recently-run action).
  const futureRunWaitsForIdle = (action: Action): boolean =>
    state.effects.has(action) ||
    state.materializerIndex.isMaterializer(action) ||
    state.shouldRunFirstPullComputationInDemandContext(action);
  const noteFutureEligibility = (action: Action) => {
    if (state.isDebouncedComputationWaiting(action)) {
      const nextDebounceAt = state.getNextDebounceRunTime(action);
      if (nextDebounceAt !== undefined) {
        nextDirtyPullRunAt = minDefined(
          nextDirtyPullRunAt,
          nextDebounceAt,
        );
        nextDirtyPullRunWaitsForIdle ||= futureRunWaitsForIdle(action);
        return true;
      }
    }

    const nextEligibleAt = state.getNextEligibleRunTime(action);
    if (nextEligibleAt !== undefined && nextEligibleAt > now) {
      nextDirtyPullRunAt = minDefined(nextDirtyPullRunAt, nextEligibleAt);
      nextDirtyPullRunWaitsForIdle ||= futureRunWaitsForIdle(action);
      return true;
    }

    return false;
  };

  const pendingPullWork = [...state.pending].filter((action) =>
    state.effects.has(action) ||
    state.materializerIndex.isMaterializer(action) ||
    state.isDemandedPullComputation(action) ||
    state.shouldRunFirstPullComputationInDemandContext(action)
  );
  const hasPendingPullWork = pendingPullWork.some((action) =>
    !noteFutureEligibility(action)
  );

  // Dirty pull work is by definition invalid — scan the invalid-node index
  // rather than every registered node.
  const hasDirtyPullWork = [...state.nodes.getInvalidNodes()].some((action) => {
    if (!isInvalidAction(state.nodes, action)) {
      return false;
    }
    if (
      !state.effects.has(action) &&
      !state.isDemandedPullComputation(action) &&
      !state.materializerIndex.isMaterializer(action)
    ) {
      return false;
    }

    if (noteFutureEligibility(action)) {
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

function isInvalidAction(nodes: NodeRegistry, action: Action): boolean {
  const record = nodes.get(action);
  return record !== undefined && isInvalidActionRecord(record);
}

function isInvalidActionRecord(record: SchedulerNode): boolean {
  return record.status === "invalid" || record.status === "never-ran";
}

function minDefined(
  current: number | undefined,
  next: number,
): number {
  return current === undefined ? next : Math.min(current, next);
}
