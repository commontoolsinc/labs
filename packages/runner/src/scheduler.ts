import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import { type Frame } from "./builder/types.ts";
import type { Cancel } from "./cancel.ts";
import { ConsoleEvent } from "./harness/console.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  Runtime,
} from "./runtime.ts";
import { type NormalizedFullLink, toMemorySpaceAddress } from "./link-utils.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageSubscription,
  IStorageTransaction,
} from "./storage/interface.ts";
import {
  sortAndCompactPaths,
  type SortedAndCompactPaths,
} from "./reactive-dependencies.ts";
import { getTransactionWriteDetails } from "./storage/transaction-inspection.ts";
import {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  markReadAsPotentialWrite,
} from "./storage/reactivity-log.ts";
import type {
  ActionStats,
  NonIdempotentReport,
  SchedulerActionInfo,
  SchedulerDiagnosisResult,
  SchedulerEventPreflightActionSummary,
  SchedulerEventPreflightStats,
  SchedulerGraphSnapshot,
} from "./telemetry.ts";
import {
  DEFAULT_RETRIES_FOR_EVENTS,
  MAX_ITERATIONS_PER_RUN,
  MAX_SETTLE_STATS_HISTORY,
} from "./scheduler/constants.ts";
import {
  getPieceMetadataFromFrame,
  getSchedulerActionId,
  getSchedulerActionTelemetryInfo,
  handleSchedulerError,
  queueTask,
  recordTriggerTrace as recordTriggerTraceState,
  type SchedulerActionIdentityState,
} from "./scheduler/diagnostics.ts";
import {
  captureDiagnosisRecord as captureDiagnosisRecordState,
  detectCausalCycles,
  type DiagnosisRecord,
  runIdempotencyRecheck as runIdempotencyRecheckState,
} from "./scheduler/diagnosis.ts";
import {
  collectDirectWritersForLog,
  collectReadersForWrite,
  type DependencyGraphState,
  type DependencyUpdateState,
  pendingDependencyCollectionMightAffect
    as pendingDependencyCollectionMightAffectState,
  readsOverlapWrites,
  replaceActionTriggerPaths,
  setCancelForTriggerEntities,
  setSchedulerDependencies,
  type TriggerSubscriptionState,
  updateDependentEdgesForLog,
} from "./scheduler/dependency-index.ts";
import {
  addInFlightSource as addInFlightSourceState,
  appendActionRunTrace,
  type InFlightSourceState,
  invokeReactiveAction,
  removeInFlightSource as removeInFlightSourceState,
  startReactiveActionCommit,
  watchReactiveActionCommit,
} from "./scheduler/action-run.ts";
import {
  buildIterationWorkSet,
  buildPullInitialSeeds,
  collectPendingDependencyActions,
  createSettlingTracker,
  isDirtyPullActionRunnable,
  isPendingPullActionRunnable,
  markExecuteStart,
  planAdaptiveCycleDebounce,
  planCycleBreak,
  planExecuteContinuation,
  pushBoundedHistory,
  recordEarlyIterationComputations,
  recordExecuteEnd,
  type SettlingTracker,
  summarizeSettleIteration,
  summarizeSettleRun,
} from "./scheduler/execution.ts";
import {
  canAutomaticallyDebounce as canAutomaticallyDebounceState,
  cancelDebounceTimer as cancelDebounceTimerState,
  clearActiveDebounceTimers,
  clearComputationDebounceState as clearComputationDebounceStateFromDelay,
  clearDebounce as clearDebounceState,
  clearThrottle as clearThrottleState,
  getDebounce as getDebounceState,
  getNextDebounceRunTime as getNextDebounceRunTimeState,
  getNextEligibleRunTime as getNextEligibleRunTimeState,
  getThrottle as getThrottleState,
  isDebouncedComputationWaiting as isDebouncedComputationWaitingState,
  isThrottled as isThrottledState,
  maybeAutoDebounce as maybeAutoDebounceState,
  scheduleComputationDebounce,
  type SchedulerDelayState,
  scheduleWithDebounce as scheduleWithDebounceState,
  setDebounce as setDebounceState,
  setNoDebounce as setNoDebounceState,
  setThrottle as setThrottleState,
  shouldDebouncePullComputation,
} from "./scheduler/delays.ts";
import { processStorageNotification } from "./scheduler/notifications.ts";
import {
  clearSchedulerDirectDirty,
  clearSchedulerDirty,
  type DirtySchedulingState,
  forceClearStale as forceClearStaleState,
  getUpstreamStaleCount as getUpstreamStaleCountFromState,
  isActionStale,
  markDirectDirty as markDirectDirtyState,
  markSchedulerDirty,
  setStaleFromInputs,
  type StalenessState,
} from "./scheduler/staleness.ts";
import {
  registerParentChildAction,
  type SchedulerSubscriptionState,
  unsubscribeSchedulerAction,
  updateSchedulerActionChangeGroup,
  updateSchedulerActionType,
} from "./scheduler/subscriptions.ts";
import {
  type ActionTimingState,
  getActionStats as getActionStatsFromState,
  recordActionTime as recordActionTimeState,
} from "./scheduler/timing.ts";
import { txToReactivityLog } from "./scheduler/reactivity.ts";
import {
  addSchedulerEventHandler,
  cancelEventQueueWake as cancelEventQueueWakeState,
  type EventQueueWakeState,
  hasEventQueueWakeTimer,
  isHeadEventParked as isHeadEventParkedState,
  processQueuedEventDuringExecute,
  queueSchedulerEvent,
  scheduleEventQueueWake as scheduleEventQueueWakeState,
} from "./scheduler/events.ts";
import { buildSchedulerGraphSnapshot } from "./scheduler/graph-snapshot.ts";
import { entityKey } from "./scheduler/keys.ts";
import {
  collectTransitiveEffects,
  topologicalSort,
} from "./scheduler/topology.ts";
import type {
  Action,
  ActionRunTraceEntry,
  DirtyDependencyTraceContext,
  EventHandler,
  PopulateDependencies,
  PopulateDependenciesEntry,
  QueuedEvent,
  ReactivityLog,
  SettleIterationStats,
  SettleStats,
  SettleStatsHistoryEntry,
  SpaceScopeAndURI,
  TelemetryAnnotations,
  TriggerTraceEntry,
  TriggerTraceScheduledEffect,
} from "./scheduler/types.ts";
import { ensureNotRenderThread } from "@commonfabric/utils/env";
ensureNotRenderThread();

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

// Re-export types that tests expect from scheduler
export type { ErrorWithContext };
export type {
  Action,
  ActionRunTraceAddress,
  ActionRunTraceEntry,
  AnnotatedAction,
  AnnotatedEventHandler,
  EventHandler,
  PopulateDependencies,
  ReactivityLog,
  SettleIterationStats,
  SettleStats,
  SettleStatsHistoryEntry,
  SpaceScopeAndURI,
  SpaceScopeURIAndType,
  TelemetryAnnotations,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
  TriggerTraceScheduledEffect,
  TriggerTraceValueKind,
  TriggerTraceValueSummary,
} from "./scheduler/types.ts";
export { txToReactivityLog } from "./scheduler/reactivity.ts";

export {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  markReadAsPotentialWrite,
};

export class Scheduler {
  private eventQueue: QueuedEvent[] = [];
  private eventHandlers: [NormalizedFullLink, EventHandler][] = [];

  private pending = new Set<Action>();
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private cancels = new WeakMap<Action, Cancel>();
  private triggers = new Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >();
  private nonRecursiveTriggers = new Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >();
  private actionChangeGroups = new WeakMap<Action, ChangeGroup>();
  private retries = new WeakMap<Action, number>();

  // Effect/computation tracking for pull-based scheduling
  private effects = new Set<Action>();
  private computations = new Set<Action>();
  private dependents = new WeakMap<Action, Set<Action>>();
  private reverseDependencies = new WeakMap<Action, Set<Action>>();
  private activePullDemandActions = new WeakSet<Action>();
  private pullDemandedFirstRunComputations = new WeakSet<Action>();
  // Track which actions are effects persistently (survives unsubscribe/re-subscribe)
  private isEffectAction = new WeakMap<Action, boolean>();
  // In pull mode, `dirty` means direct dirty. `stale` additionally includes
  // actions with dirty upstream computations.
  private dirty = new Set<Action>();
  private stale = new Set<Action>();
  private upstreamStaleWriters = new WeakMap<Action, Set<Action>>();
  private upstreamStaleCount = new WeakMap<Action, number>();
  private stalenessState: StalenessState = {
    dirty: this.dirty,
    stale: this.stale,
    dependents: this.dependents,
    upstreamStaleWriters: this.upstreamStaleWriters,
    upstreamStaleCount: this.upstreamStaleCount,
  };
  private pullMode = true;

  // Debugger breakpoints: action IDs that should trigger `debugger` before execution
  private breakpoints = new Set<string>();

  // Compute time tracking for cycle-aware scheduling
  // Keyed by action ID (source location) to persist stats across action recreation
  private actionStats = new Map<string, ActionStats>();
  private actionTimingState: ActionTimingState = {
    actionStats: this.actionStats,
    getActionId: (action) => this.getActionId(action),
  };
  private actionIdentityState: SchedulerActionIdentityState = {
    anonymousActionIds: new WeakMap<Action | EventHandler, string>(),
    anonymousActionCounter: 0,
  };
  // Cycle detection during dependency collection
  private collectStack = new Set<Action>();
  private dirtyDependencyTraceContext?: DirtyDependencyTraceContext;

  // Cycle-aware debounce: track runs per action within current execute() call
  private runsThisExecute = new Map<Action, number>();
  private executeStartTime = 0;
  private rerunAfterCurrentExecute = false;

  // Non-settling heuristic (Phase 1): detects when the system is churning
  private settlingTracker: SettlingTracker = createSettlingTracker();
  private autoTriggerDiagnosis = false;

  // Idempotency diagnosis (Phase 2): captures read/write values per action run
  private diagnosisEnabled = false;
  private diagnosisTimeout: ReturnType<typeof setTimeout> | null = null;
  private diagnosisStartTime = 0;
  private diagnosisBusyTime = 0;
  private diagnosisResolve:
    | ((result: SchedulerDiagnosisResult) => void)
    | null = null;
  private diagnosisHistory = new Map<string, DiagnosisRecord[]>();
  private diagnosisNonIdempotent: NonIdempotentReport[] = [];

  // Inline idempotency check mode: when enabled, every computation re-run
  // in run() is followed by a second synchronous run for comparison.
  private idempotencyCheckMode = false;
  private idempotencyViolations: NonIdempotentReport[] = [];

  // Cycle detection (Phase 3): tracks causal edges between actions
  private causalEdges: {
    writer: string;
    cell: string;
    triggered: string;
    timestamp: number;
  }[] = [];
  private changeGroupToActionId = new Map<ChangeGroup, string>();

  // Debounce infrastructure for throttling slow actions
  private debounceTimers = new WeakMap<
    Action,
    ReturnType<typeof setTimeout>
  >();
  // Track all active debounce timers for cleanup during dispose
  private activeDebounceTimers = new Set<ReturnType<typeof setTimeout>>();
  private pendingQueueTaskTimer: ReturnType<typeof setTimeout> | null = null;
  private eventQueueWakeState: EventQueueWakeState = {
    timer: null,
    wakeAt: null,
    eventQueue: this.eventQueue,
    isDisposed: () => this.disposed,
    queueExecution: () => this.queueExecution(),
  };
  private actionDebounce = new WeakMap<Action, number>();
  private actionHasRun = new WeakSet<Action>();
  private computationDebounceReady = new WeakSet<Action>();
  private computationDebounceReadyAt = new WeakMap<Action, number>();
  private computationDebounceFlushSeeds = new Set<Action>();
  // Actions that opt out of auto-debounce (inverted: true means NO auto-debounce)
  private noDebounce = new WeakMap<Action, boolean>();

  // Throttle infrastructure - "value can be stale by T ms"
  private actionThrottle = new WeakMap<Action, number>();
  private delayState: SchedulerDelayState = {
    actionDebounce: this.actionDebounce,
    actionThrottle: this.actionThrottle,
    actionStats: this.actionStats,
    actionHasRun: this.actionHasRun,
    computationDebounceReady: this.computationDebounceReady,
    computationDebounceReadyAt: this.computationDebounceReadyAt,
    computationDebounceFlushSeeds: this.computationDebounceFlushSeeds,
    noDebounce: this.noDebounce,
    debounceTimers: this.debounceTimers,
    activeDebounceTimers: this.activeDebounceTimers,
    getActionId: (action) => this.getActionId(action),
  };
  private inFlightSources = new WeakMap<Action, Set<IStorageTransaction>>();
  private inFlightSourceState: InFlightSourceState = {
    inFlightSources: this.inFlightSources,
  };

  // Current-known writes are rebuilt on each dependency update from actual
  // writes plus declared/potential writes. This is the default scheduling view.
  private currentKnownWrites = new WeakMap<Action, IMemorySpaceAddress[]>();
  // Historical writes preserve the legacy cumulative union and are only used
  // when the experimental historical-write mode is enabled.
  private historicalMightWrite = new WeakMap<Action, IMemorySpaceAddress[]>();
  // Index: entity -> actions that write to it (for fast dependency lookup).
  // Updated from the active scheduling write set.
  private writersByEntity = new Map<SpaceScopeAndURI, Set<Action>>();
  // Reverse index: action -> entities it writes to (for cleanup)
  private actionWriteEntities = new WeakMap<Action, Set<SpaceScopeAndURI>>();
  // Track actions scheduled for first time (bypass filter)
  private scheduledFirstTime = new Set<Action>();
  // Filter stats for diagnostics
  private filterStats = { filtered: 0, executed: 0 };

  // Settle stats for performance analysis (opt-in via enableSettleStats())
  private collectSettleStats = false;
  private lastSettleStats: SettleStats | null = null;
  private settleStatsHistory: SettleStatsHistoryEntry[] = [];
  private collectActionRunTrace = false;
  private actionRunTrace: ActionRunTraceEntry[] = [];
  private collectTriggerTrace = false;
  private triggerTrace: TriggerTraceEntry[] = [];
  private eventPreflightTelemetryEnabled = false;
  private changedWritesHistory: IMemorySpaceAddress[] = [];
  private conditionallyScheduledEffects = new Map<Action, number>();

  // Parent-child action tracking for proper execution ordering
  // When a child action is created during parent execution, parent must run first
  private executingAction: Action | null = null;
  currentActionId?: string;
  private actionParent = new WeakMap<Action, Action>();
  private actionChildren = new WeakMap<Action, Set<Action>>();
  private dependencyGraphState: DependencyGraphState = {
    triggers: this.triggers,
    nonRecursiveTriggers: this.nonRecursiveTriggers,
    writersByEntity: this.writersByEntity,
    dependencies: this.dependencies,
    dependents: this.dependents,
    reverseDependencies: this.reverseDependencies,
    stalenessState: this.stalenessState,
    getSchedulingWrites: (action) => this.getSchedulingWrites(action),
    isStale: (action) => this.isStale(action),
    isDemandedPullComputation: (action) =>
      this.isDemandedPullComputation(action),
    queueExecution: () => this.queueExecution(),
  };
  private dependencyUpdateState: DependencyUpdateState = {
    writersByEntity: this.writersByEntity,
    actionWriteEntities: this.actionWriteEntities,
    dependencies: this.dependencies,
    currentKnownWrites: this.currentKnownWrites,
    historicalMightWrite: this.historicalMightWrite,
    dependencyGraph: this.dependencyGraphState,
    useHistoricalMightWrite: () => this.useHistoricalMightWrite(),
    isPullMode: () => this.pullMode,
  };
  private triggerSubscriptionState: TriggerSubscriptionState = {
    triggers: this.triggers,
    nonRecursiveTriggers: this.nonRecursiveTriggers,
    cancels: this.cancels,
    getActionId: (action) => this.getActionId(action),
    onTriggerUnsubscribe: (actionId, entityCount) => {
      logger.debug("schedule-unsubscribe", () => [
        `Action: ${actionId}`,
        `Entities: ${entityCount}`,
      ]);
    },
  };
  private dirtySchedulingState: DirtySchedulingState = {
    stalenessState: this.stalenessState,
    computations: this.computations,
    scheduleComputationDebounce: (action) =>
      this.scheduleComputationDebounce(action),
    clearComputationDebounceState: (action) =>
      this.clearComputationDebounceState(action),
    isDemandedPullComputation: (action) =>
      this.isDemandedPullComputation(action),
    queueExecution: () => this.queueExecution(),
  };
  private subscriptionState: SchedulerSubscriptionState = {
    actionChangeGroups: this.actionChangeGroups,
    changeGroupToActionId: this.changeGroupToActionId,
    isEffectAction: this.isEffectAction,
    effects: this.effects,
    computations: this.computations,
    getPullMode: () => this.pullMode,
    getIdempotencyCheckMode: () => this.idempotencyCheckMode,
    queueExecution: () => this.queueExecution(),
    getActionId: (target) => this.getActionId(target),
    getExecutingAction: () => this.executingAction,
    actionParent: this.actionParent,
    actionChildren: this.actionChildren,
  };

  /**
   * Temporarily set the executing action so that any child actions created
   * during `fn` are registered as children of `action`. Restores the previous
   * executing action afterwards (stack-like nesting).
   */
  withExecutingAction<T>(action: Action, fn: () => T): T {
    const prev = this.executingAction;
    this.executingAction = action;
    try {
      return fn();
    } finally {
      this.executingAction = prev;
    }
  }

  // Dependency population callbacks for first-time subscriptions
  // Called in execute() to discover what cells the action will read
  private populateDependenciesCallbacks = new WeakMap<
    Action,
    PopulateDependenciesEntry
  >();
  // Actions that need dependency population before first run
  private pendingDependencyCollection = new Set<Action>();

  private idlePromises: (() => void)[] = [];
  private backgroundTasks = new Set<Promise<unknown>>();
  private loopCounter = new WeakMap<Action, number>();
  private errorHandlers = new Set<ErrorHandler>();
  private consoleHandler: ConsoleHandler;
  private _running: Promise<unknown> | undefined = undefined;
  private scheduled = false;
  private disposed = false;

  get runningPromise(): Promise<unknown> | undefined {
    return this._running;
  }

  set runningPromise(promise: Promise<unknown> | undefined) {
    if (this._running !== undefined) {
      throw new Error(
        "Cannot set running while another promise is in progress",
      );
    }
    if (promise !== undefined) {
      this._running = promise.finally(() => {
        this._running = undefined;
      });
    }
  }

  constructor(
    readonly runtime: Runtime,
    consoleHandler?: ConsoleHandler,
    errorHandlers?: ErrorHandler[],
  ) {
    this.consoleHandler = consoleHandler ||
      function (data) {
        // Default console handler returns arguments unaffected.
        return data.args;
      };

    if (errorHandlers) {
      errorHandlers.forEach((handler) => this.errorHandlers.add(handler));
    }

    // Subscribe to storage notifications
    this.runtime.storageManager.subscribe(this.createStorageSubscription());

    // Set up harness event listeners
    this.runtime.harness.addEventListener("console", (e: Event) => {
      // Called synchronously when `console` methods are
      // called within the runtime.
      const { method, args } = e as ConsoleEvent;
      const metadata = getPieceMetadataFromFrame();
      const result = this.consoleHandler({ metadata, method, args });
      console[method].apply(console, result);
    });
  }

  /**
   * Gets a stable identifier for an action based on its source location.
   * Prefers .src (set as backup) over .name, falls back to a generated ID.
   * This ID is used for stats tracking to persist across action recreation.
   */
  private getActionId(action: Action | EventHandler): string {
    return getSchedulerActionId(this.actionIdentityState, action);
  }

  private getActionTelemetryInfo(
    action: Action | EventHandler,
  ): SchedulerActionInfo | undefined {
    return getSchedulerActionTelemetryInfo(action);
  }

  private recordTriggerTrace(entry: TriggerTraceEntry): void {
    recordTriggerTraceState({ triggerTrace: this.triggerTrace }, entry);
  }

  // ── Inline idempotency check mode ──────────────────────────────────

  enableIdempotencyCheck(): void {
    this.idempotencyCheckMode = true;
    this.idempotencyViolations = [];
    if (this.pullMode) {
      this.queueExecution();
    }
  }

  disableIdempotencyCheck(): void {
    this.idempotencyCheckMode = false;
  }

  getIdempotencyViolations(): NonIdempotentReport[] {
    return [...this.idempotencyViolations];
  }

  private runIdempotencyRecheck(
    action: Action,
    tx: IExtendedStorageTransaction,
    log: ReactivityLog,
  ): void {
    runIdempotencyRecheckState(
      {
        idempotencyViolations: this.idempotencyViolations,
        createTx: () => this.runtime.edit(),
        invoke: (fn) => this.runtime.harness.invoke(fn),
        getActionId: (target) => this.getActionId(target),
        getActionTelemetryInfo: (target) => this.getActionTelemetryInfo(target),
      },
      action,
      tx,
      log,
    );
  }

  /**
   * Subscribes an action to run when its dependencies change.
   *
   * The action will be scheduled to run immediately. Before running, the
   * populateDependencies callback will be called to discover what cells the
   * action will read. After running, the scheduler automatically re-subscribes
   * using the reactivity log from the run.
   *
   * @param action The action to subscribe
   * @param populateDependencies Callback to discover the action's read dependencies,
   *   or a ReactivityLog for backwards compatibility (deprecated)
   * @param options Configuration options for the subscription
   * @returns A cancel function to unsubscribe
   */
  subscribe(
    action: Action,
    populateDependencies: PopulateDependencies | ReactivityLog,
    options: {
      isEffect?: boolean;
      debounce?: number;
      noDebounce?: boolean;
      throttle?: number;
      changeGroup?: ChangeGroup;
    } = {},
  ): Cancel {
    // Handle backwards-compatible ReactivityLog argument
    let populateDependenciesEntry: PopulateDependenciesEntry;
    let immediateLog: ReactivityLog | undefined;
    if (typeof populateDependencies === "function") {
      populateDependenciesEntry = populateDependencies;
    } else {
      // ReactivityLog provided directly - set up dependencies immediately
      // (for backwards compatibility with code that passes reads/writes)
      immediateLog = populateDependencies;
      populateDependenciesEntry = immediateLog;
    }
    const {
      isEffect = false,
      debounce,
      noDebounce,
      throttle,
    } = options;

    updateSchedulerActionChangeGroup(this.subscriptionState, action, options);

    // Apply debounce settings if provided
    if (debounce !== undefined) {
      this.setDebounce(action, debounce);
    }
    if (noDebounce !== undefined) {
      this.setNoDebounce(action, noDebounce);
    }
    // Apply throttle setting if provided
    if (throttle !== undefined) {
      this.setThrottle(action, throttle);
    }

    const actionIsEffect = updateSchedulerActionType(
      this.subscriptionState,
      action,
      isEffect,
      {
        queueExecution: true,
      },
    );

    // Track parent-child relationship if action is created during another action's execution
    registerParentChildAction(this.subscriptionState, action);
    const parent = this.actionParent.get(action);
    if (
      this.pullMode &&
      !actionIsEffect &&
      parent &&
      this.activePullDemandActions.has(parent)
    ) {
      this.pullDemandedFirstRunComputations.add(action);
      this.queueExecution();
    }

    logger.debug(
      "schedule",
      () => [
        "Subscribing to action:",
        action,
        actionIsEffect ? "effect" : "computation",
      ],
    );

    // Store the populateDependencies callback for use in execute()
    this.populateDependenciesCallbacks.set(action, populateDependenciesEntry);

    // In pull mode, newly subscribed computations can be the replacement for an
    // already-running child graph (for example after a $TYPE change). Seed any
    // statically declared writes immediately so existing effects can discover
    // the new writer before the first execute() cycle.
    if (
      this.pullMode &&
      !actionIsEffect &&
      !immediateLog
    ) {
      const declaredWrites = (action as Partial<TelemetryAnnotations>).writes;
      if (declaredWrites && declaredWrites.length > 0) {
        this.setDependencies(action, {
          reads: [],
          shallowReads: [],
          writes: declaredWrites.map(toMemorySpaceAddress),
        });
      }
    }

    // If a ReactivityLog was provided directly, set up dependencies immediately.
    // This ensures writes are tracked right away for reverse dependency graph.
    if (immediateLog) {
      const { reads, shallowReads, log: schedulingLog } = this.setDependencies(
        action,
        immediateLog,
      );
      this.updateDependents(action, schedulingLog);
      const { entities } = replaceActionTriggerPaths(
        this.triggerSubscriptionState,
        action,
        reads,
        shallowReads,
      );

      // Register the cancel function for the latest trigger set.
      setCancelForTriggerEntities(
        this.triggerSubscriptionState,
        action,
        entities,
      );
    } else {
      // Mark action for dependency collection before first run
      this.pendingDependencyCollection.add(action);
    }

    // Mark as dirty and pending for first-time execution
    // In pull mode this still doesn't mean execution: There needs to be an effect to trigger it.
    this.markDirectDirty(action);
    this.pending.add(action);
    this.scheduledFirstTime.add(action);

    if (
      this.pullMode &&
      !actionIsEffect &&
      this.getSchedulingWrites(action)?.length
    ) {
      this.scheduleAffectedEffects(action);
    }

    // Emit telemetry for new subscription
    const actionId = this.getActionId(action);
    this.runtime.telemetry.submit({
      type: "scheduler.subscribe",
      actionId,
      isEffect: actionIsEffect,
    });

    return () => this.unsubscribe(action);
  }

  /**
   * Re-subscribes an action after it has already run, using the reactivity log
   * from the completed run. This sets up triggers for future changes without
   * scheduling the action to run immediately.
   *
   * Use this method when:
   * - An action has just completed running and you have its reactivity log
   * - You want to register triggers for future changes
   *
   * @param action The action to re-subscribe
   * @param log The reactivity log from the action's previous run
   * @param options Optional configuration (e.g., isEffect to mark as side-effectful)
   */
  resubscribe(
    action: Action,
    log: ReactivityLog,
    options: {
      isEffect?: boolean;
      changeGroup?: ChangeGroup;
    } = {},
  ): void {
    const { isEffect } = options;

    updateSchedulerActionChangeGroup(this.subscriptionState, action, options);

    const { reads, shallowReads, log: schedulingLog } = this.setDependencies(
      action,
      log,
    );

    // Track action type for pull-based scheduling
    // Once an action is marked as an effect, it stays an effect
    const actionIsEffect = updateSchedulerActionType(
      this.subscriptionState,
      action,
      isEffect,
    );
    const actionId = this.getActionId(action);

    // Update reverse dependency graph after the action type is restored. In
    // pull mode, registering a new edge to a live effect can be the moment a
    // stale upstream computation becomes demanded.
    if (this.pullMode) this.updateDependents(action, schedulingLog);

    // Track parent-child relationship if action is created during another action's execution
    // Only set if not already set (resubscribe can be called multiple times)
    registerParentChildAction(this.subscriptionState, action, {
      allowExisting: false,
    });

    const { entities, triggerPathsByEntity } = replaceActionTriggerPaths(
      this.triggerSubscriptionState,
      action,
      reads,
      shallowReads,
    );

    logger.debug("schedule-resubscribe", () => [
      `Action: ${actionId}`,
      `Entities: ${triggerPathsByEntity.size}`,
      `Reads: ${reads.length}`,
    ]);

    setCancelForTriggerEntities(
      this.triggerSubscriptionState,
      action,
      entities,
    );

    // In pull mode: When an effect resubscribes, check if any non-throttled dirty
    // computations write to what it reads. If so, mark the effect dirty so it can
    // pull those computations and see fresh data.
    // Skip throttled computations - they'll trigger via storage changes when unthrottled.
    // Use isEffectAction instead of effects because unsubscribe() clears effects before run()
    if (this.pullMode && actionIsEffect && this.stale.size > 0) {
      const effectReads = reads;
      const effectShallowReads = shallowReads;
      let shouldMarkDirty = false;

      // If there are pending computations whose dependencies haven't been
      // collected yet, only fall back to conservatism for unknown writes or
      // known writes that overlap what this effect reads.
      if (
        this.pendingDependencyCollectionMightAffect(
          action,
          effectReads,
          effectShallowReads,
        )
      ) {
        shouldMarkDirty = true;
      }

      // Use writersByEntity index for efficient lookup
      if (!shouldMarkDirty) {
        const entities = new Set<SpaceScopeAndURI>();
        for (const read of effectReads) {
          entities.add(entityKey(read));
        }
        for (const read of effectShallowReads) {
          entities.add(entityKey(read));
        }

        for (const entity of entities) {
          const writers = this.writersByEntity.get(entity);
          if (!writers) continue;

          for (const writer of writers) {
            if (writer === action) continue;
            if (!this.isStale(writer)) continue;
            if (this.effects.has(writer)) continue; // Only check computations
            if (this.isThrottled(writer)) continue; // Skip throttled - they trigger via storage

            // Check path overlap
            const writerWrites = this.getSchedulingWrites(writer) ?? [];
            if (
              readsOverlapWrites(
                effectReads,
                effectShallowReads,
                writerWrites,
              )
            ) {
              shouldMarkDirty = true;
              break;
            }
            if (shouldMarkDirty) break;
          }
          if (shouldMarkDirty) break;
        }
      }

      if (shouldMarkDirty && !this.dirty.has(action)) {
        this.markEffectConditionallyScheduled(action);
        this.markDirectDirty(action);
        this.pending.add(action);
        this.queueExecution();
      }
    }
  }

  unsubscribe(
    action: Action,
    options: { preserveChangeGroup?: boolean } = {},
  ): void {
    unsubscribeSchedulerAction(
      {
        cancels: this.cancels,
        dependencies: this.dependencies,
        actionChangeGroups: this.actionChangeGroups,
        changeGroupToActionId: this.changeGroupToActionId,
        pending: this.pending,
        conditionallyScheduledEffects: this.conditionallyScheduledEffects,
        reverseDependencies: this.reverseDependencies,
        dependents: this.dependents,
        effects: this.effects,
        computations: this.computations,
        pullDemandedFirstRunComputations: this.pullDemandedFirstRunComputations,
        actionWriteEntities: this.actionWriteEntities,
        writersByEntity: this.writersByEntity,
        populateDependenciesCallbacks: this.populateDependenciesCallbacks,
        pendingDependencyCollection: this.pendingDependencyCollection,
        getActionId: (target) => this.getActionId(target),
        clearDirectDirty: (target) => this.clearDirectDirty(target),
        forceClearStale: (target) => this.forceClearStale(target),
        cancelDebounceTimer: (target) => this.cancelDebounceTimer(target),
        clearComputationDebounceState: (target, targetOptions) =>
          this.clearComputationDebounceState(target, targetOptions),
      },
      action,
      options,
    );
  }

  async run(action: Action): Promise<any> {
    logger.timeStart("scheduler", "run");
    const actionId = this.getActionId(action);
    this.runtime.telemetry.submit({
      type: "scheduler.run",
      actionId,
      actionInfo: this.getActionTelemetryInfo(action),
    });

    logger.debug("schedule-run-start", () => [
      `[RUN] Starting action: ${actionId}`,
      `Pull mode: ${this.pullMode}`,
    ]);

    if (this.runningPromise) await this.runningPromise;

    const tx = this.runtime.edit({
      changeGroup: this.actionChangeGroups.get(action),
    });
    (tx.tx as { debugActionId?: string }).debugActionId = actionId;
    this.addInFlightSource(action, tx.tx);
    const actionStartTime = performance.now();

    let result: any;
    this.runningPromise = new Promise((resolve) => {
      const finalizeAction = (error?: unknown) => {
        // Record action execution time for cycle-aware scheduling
        const elapsed = performance.now() - actionStartTime;
        this.recordActionTime(action, elapsed);
        this.actionHasRun.add(action);
        this.pullDemandedFirstRunComputations.delete(action);

        try {
          if (error) {
            logger.error("schedule-error", () => [
              `[RUN] Action failed: ${actionId}`,
              `Error: ${error}`,
            ]);
            this.handleError(error as Error, action);
          }
        } finally {
          // Set up new reactive subscriptions after the action runs

          // Commit the transaction. The code continues synchronously after
          // kicking off the commit, i.e. it assumes the commit will be
          // successful. If it isn't, the data will be rolled back and all other
          // reactive functions based on it will be retriggered. But also, the
          // retry logic below will have re-scheduled this action, so
          // topological sorting should move it before the dependencies.
          const commitPromise = startReactiveActionCommit({
            runtime: this.runtime,
            tx,
          });
          const log = txToReactivityLog(tx);
          watchReactiveActionCommit({
            action,
            tx,
            log,
            retries: this.retries,
            pending: this.pending,
            commitPromise,
            resubscribe: (target, targetLog) =>
              this.resubscribe(target, targetLog),
            markDirectDirty: (target) => this.markDirectDirty(target),
            queueExecution: () => this.queueExecution(),
            removeInFlightSource: (target, source) =>
              this.removeInFlightSource(target, source),
          });
          const changedComputationWrites = this.recordChangedComputationWrites(
            action,
            tx,
            log,
          );

          logger.debug("schedule-run-complete", () => [
            `[RUN] Action completed: ${actionId}`,
            `Reads: ${log.reads.length}`,
            `Writes: ${log.writes.length}`,
            `Elapsed: ${elapsed.toFixed(2)}ms`,
          ]);

          if (this.collectActionRunTrace) {
            appendActionRunTrace({
              actionRunTrace: this.actionRunTrace,
              actionParent: this.actionParent,
              isEffectAction: this.isEffectAction,
              getActionId: (target) => this.getActionId(target),
              getSchedulingWrites: (target) => this.getSchedulingWrites(target),
            }, {
              action,
              actionId,
              durationMs: elapsed,
              log,
            });
          }

          // Diagnosis capture: record read/write values for idempotency checking
          if (this.diagnosisEnabled) {
            this.captureDiagnosisRecord(actionId, action, tx, log);
          }

          // Inline idempotency re-run: when the mode is on, every
          // computation gets a second synchronous run against post-commit
          // state. An idempotent computation produces the same writes
          // both times. Uses isEffectAction (persists past unsubscribe)
          // since execute() calls unsubscribe() before run().
          if (
            this.idempotencyCheckMode &&
            !this.isEffectAction.get(action)
          ) {
            logger.timeStart("scheduler", "run", "idempotencyRecheck");
            try {
              this.runIdempotencyRecheck(action, tx, log);
            } finally {
              logger.timeEnd("scheduler", "run", "idempotencyRecheck");
            }
          }

          logger.timeStart("scheduler", "run", "resubscribe");
          try {
            this.resubscribe(action, log);
          } finally {
            logger.timeEnd("scheduler", "run", "resubscribe");
          }
          if (this.pullMode && this.computations.has(action)) {
            this.clearDirectDirty(action);
            this.markReadersDirtyForChangedWrites(
              action,
              changedComputationWrites,
            );
          }
          resolve(result);
        }
      };

      invokeReactiveAction({
        runtime: this.runtime,
        setExecutingAction: (target, targetActionId) => {
          this.executingAction = target;
          this.currentActionId = targetActionId;
        },
        clearExecutingAction: () => {
          this.executingAction = null;
          this.currentActionId = undefined;
        },
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

    return this.runningPromise.then((result) => {
      logger.timeEnd("scheduler", "run");
      return result;
    });
  }

  idle(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.runningPromise) {
        // Something is currently running - wait for it then check again
        this.runningPromise.then(() => this.idle().then(resolve));
      } else if (this.backgroundTasks.size > 0) {
        // Async scheduler work, such as event-triggered auto-start, is still in
        // flight. Wait for it to settle and then re-check the scheduler state.
        Promise.allSettled([...this.backgroundTasks]).then(() =>
          this.idle().then(resolve)
        );
      } else if (
        hasEventQueueWakeTimer(this.eventQueueWakeState) &&
        ((this.eventQueue.length > 0 && this.isHeadEventParked()) ||
          this.hasDeferredDirtyEffectWork())
      ) {
        // A queued event is parked behind a throttled dependency. Wait for the
        // wake timer to re-schedule the queue and then re-check.
        this.idlePromises.push(resolve);
      } else if (!this.scheduled) {
        if (this.pullMode && this.hasRunnablePullWork()) {
          this.queueExecution();
          this.idlePromises.push(resolve);
          return;
        }
        // Nothing is scheduled to run - we're idle.
        // In pull mode, pending computations won't run without an effect to pull them,
        // so we don't wait for them.
        resolve();
      } else {
        // Execution is scheduled - wait for it to complete
        this.idlePromises.push(resolve);
      }
    });
  }

  queueEvent(
    eventLink: NormalizedFullLink,
    event: any,
    retries: number = DEFAULT_RETRIES_FOR_EVENTS,
    // Internal-only commit callback. This runs after the final commit result,
    // including exhausted failure, so it must not perform external side
    // effects. Use the post-commit outbox for success-only effect release.
    onCommit?: (tx: IExtendedStorageTransaction) => void,
    doNotLoadPieceIfNotRunning: boolean = false,
  ): void {
    queueSchedulerEvent({
      runtime: this.runtime,
      eventHandlers: this.eventHandlers,
      eventQueue: this.eventQueue,
      backgroundTasks: this.backgroundTasks,
      queueExecution: () => this.queueExecution(),
      queueEvent: (
        targetEventLink,
        targetEvent,
        targetRetries,
        targetOnCommit,
        targetDoNotLoad,
      ) =>
        this.queueEvent(
          targetEventLink,
          targetEvent,
          targetRetries,
          targetOnCommit,
          targetDoNotLoad,
        ),
    }, {
      eventLink,
      event,
      retries,
      onCommit,
      doNotLoadPieceIfNotRunning,
    });
  }

  addEventHandler(
    handler: EventHandler,
    ref: NormalizedFullLink,
    populateDependencies?: (
      tx: IExtendedStorageTransaction,
      event: any,
    ) => void,
  ): Cancel {
    return addSchedulerEventHandler({
      eventHandlers: this.eventHandlers,
    }, {
      handler,
      ref,
      populateDependencies,
    });
  }

  onConsole(fn: ConsoleHandler): void {
    this.consoleHandler = fn;
  }

  onError(fn: ErrorHandler): void {
    this.errorHandlers.add(fn);
  }

  /**
   * Creates and returns a new storage subscription that can be used to receive storage notifications.
   *
   * @returns A new IStorageSubscription instance
   */
  private createStorageSubscription(): IStorageSubscription {
    return {
      next: (notification) => {
        processStorageNotification({
          triggers: this.triggers,
          nonRecursiveTriggers: this.nonRecursiveTriggers,
          pullMode: this.pullMode,
          diagnosisEnabled: this.diagnosisEnabled,
          collectTriggerTrace: this.collectTriggerTrace,
          changeGroupToActionId: this.changeGroupToActionId,
          causalEdges: this.causalEdges,
          actionChangeGroups: this.actionChangeGroups,
          effects: this.effects,
          pending: this.pending,
          dirty: this.dirty,
          inFlightSources: this.inFlightSources,
          conditionallyScheduledEffects: this.conditionallyScheduledEffects,
          getActionId: (target) => this.getActionId(target),
          recordCellUpdate: (change) =>
            this.runtime.telemetry.submit({
              type: "cell.update",
              change,
            }),
          recordTriggerTrace: (entry) => this.recordTriggerTrace(entry),
          scheduleWithDebounce: (target) => this.scheduleWithDebounce(target),
          markDirty: (target) => this.markDirty(target),
          scheduleAffectedEffects: (target) =>
            this.scheduleAffectedEffects(target),
        }, notification);
        return { done: false };
      },
    } satisfies IStorageSubscription;
  }

  queueExecution(): void {
    if (this.disposed) return;
    if (this.scheduled) {
      if (this.pendingQueueTaskTimer === null) {
        this.rerunAfterCurrentExecute = true;
      }
      return;
    }
    this.pendingQueueTaskTimer = queueTask(() => {
      this.pendingQueueTaskTimer = null;
      this.execute();
    });
    this.scheduled = true;
  }

  private useHistoricalMightWrite(): boolean {
    return this.runtime.experimental.schedulerHistoricalMightWrite === true;
  }

  private getSchedulingWrites(
    action: Action,
  ): IMemorySpaceAddress[] | undefined {
    return this.useHistoricalMightWrite()
      ? this.historicalMightWrite.get(action)
      : this.currentKnownWrites.get(action);
  }

  private getSchedulingWritesMap(): WeakMap<Action, IMemorySpaceAddress[]> {
    return this.useHistoricalMightWrite()
      ? this.historicalMightWrite
      : this.currentKnownWrites;
  }

  private setDependencies(
    action: Action,
    log: ReactivityLog,
  ): {
    reads: IMemorySpaceAddress[];
    shallowReads: IMemorySpaceAddress[];
    log: ReactivityLog;
  } {
    return setSchedulerDependencies(
      this.dependencyUpdateState,
      action,
      log,
    );
  }

  private collectDependenciesForAction(
    action: Action,
    populateDependencies: PopulateDependenciesEntry,
    options: {
      errorLogLabel: string;
      errorMessage: (action: Action, error: unknown) => string;
      updateDependents?: boolean;
      useRawReadsForTriggers?: boolean;
    },
  ): { log: ReactivityLog; entities: Set<SpaceScopeAndURI> } {
    let log: ReactivityLog;
    if (typeof populateDependencies === "function") {
      const depTx = this.runtime.edit();
      try {
        logger.timeStart("collectDependencies", "populate");
        try {
          populateDependencies(depTx);
        } finally {
          logger.timeEnd("collectDependencies", "populate");
        }
      } catch (error) {
        logger.debug(options.errorLogLabel, () => [
          options.errorMessage(action, error),
        ]);
      }
      log = txToReactivityLog(depTx);
      depTx.abort();
    } else {
      log = populateDependencies;
    }

    const { reads, shallowReads, log: schedulingLog } = this.setDependencies(
      action,
      log,
    );
    if (options.updateDependents ?? true) {
      this.updateDependents(action, schedulingLog);
    }

    const readsForTriggers = options.useRawReadsForTriggers ? log.reads : reads;
    const shallowReadsForTriggers = options.useRawReadsForTriggers
      ? log.shallowReads
      : shallowReads;
    const { entities } = replaceActionTriggerPaths(
      this.triggerSubscriptionState,
      action,
      readsForTriggers,
      shallowReadsForTriggers,
    );
    setCancelForTriggerEntities(
      this.triggerSubscriptionState,
      action,
      entities,
    );

    return { log, entities };
  }

  /**
   * Updates the reverse dependency graph (dependents map).
   * For each action that writes to paths this action reads, add this action as a dependent.
   */
  private updateDependents(action: Action, log: ReactivityLog): void {
    const actionId = this.getActionId(action);
    updateDependentEdgesForLog(this.dependencyGraphState, action, log);

    // Emit telemetry for dependency updates
    this.runtime.telemetry.submit({
      type: "scheduler.dependencies.update",
      actionId,
      reads: [...log.reads, ...log.shallowReads].map((r) =>
        `${r.space}/${r.id}/${r.path.join("/")}`
      ),
      writes: log.writes.map((w) => `${w.space}/${w.id}/${w.path.join("/")}`),
    });
  }

  /**
   * Returns diagnostic statistics about the scheduler state.
   * Useful for debugging and monitoring pull-based scheduling behavior.
   */
  getStats(): { effects: number; computations: number; pending: number } {
    return {
      effects: this.effects.size,
      computations: this.computations.size,
      pending: this.pending.size,
    };
  }

  /**
   * Set action IDs that should trigger a debugger breakpoint before execution.
   */
  setBreakpoints(actionIds: string[]): void {
    this.breakpoints.clear();
    for (const id of actionIds) {
      this.breakpoints.add(id);
    }
  }

  /**
   * Get currently set breakpoint action IDs.
   */
  getBreakpoints(): string[] {
    return Array.from(this.breakpoints);
  }

  /**
   * Check if an action ID has a breakpoint set.
   */
  hasBreakpoint(actionId: string): boolean {
    return this.breakpoints.has(actionId);
  }

  /**
   * Returns a snapshot of the current dependency graph for visualization.
   * Uses getActionId for the identifier (includes code location).
   */
  getGraphSnapshot(): SchedulerGraphSnapshot {
    return buildSchedulerGraphSnapshot({
      pullMode: this.pullMode,
      effects: this.effects,
      computations: this.computations,
      pending: this.pending,
      dirty: this.dirty,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      dependencies: this.dependencies,
      dependents: this.dependents,
      actionParent: this.actionParent,
      actionChildren: this.actionChildren,
      actionStats: this.actionStats,
      actionDebounce: this.actionDebounce,
      actionThrottle: this.actionThrottle,
      debounceTimers: this.debounceTimers,
      getActionId: (action) => this.getActionId(action),
      getSchedulingWrites: (action) => this.getSchedulingWrites(action),
      getNextDebounceRunTime: (action) => this.getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) => this.getNextEligibleRunTime(action),
      isDemandedPullComputation: (action) =>
        this.isDemandedPullComputation(action),
      isLiveEffect: (action) => this.isLiveEffect(action),
      isPullDemandRootEffect: (action) => this.isPullDemandRootEffect(action),
      getPatternId: (action) => {
        const annotated = action as Partial<TelemetryAnnotations>;
        return annotated.pattern
          ? this.runtime.patternManager.getPatternId(annotated.pattern)
          : undefined;
      },
    });
  }

  /**
   * Returns whether an action is registered as an effect.
   */
  isEffect(action: Action): boolean {
    return this.effects.has(action);
  }

  /**
   * Returns whether an action is registered as a computation.
   */
  isComputation(action: Action): boolean {
    return this.computations.has(action);
  }

  /**
   * Returns the set of actions that depend on this action's output.
   */
  getDependents(action: Action): Set<Action> {
    return this.dependents.get(action) ?? new Set();
  }

  private resetUpstreamStaleState(): void {
    this.upstreamStaleWriters = new WeakMap();
    this.upstreamStaleCount = new WeakMap();
    // Keep the state object identity stable; helper state objects hold it.
    this.stalenessState.upstreamStaleWriters = this.upstreamStaleWriters;
    this.stalenessState.upstreamStaleCount = this.upstreamStaleCount;
  }

  // ============================================================
  // Pull-based scheduling methods
  // ============================================================

  /**
   * Enables pull-based scheduling mode.
   * In pull mode, only effects are scheduled; computations are marked dirty
   * and pulled on demand when effects need their values.
   */
  enablePullMode(): void {
    this.pullMode = true;
    this.stale.clear();
    this.resetUpstreamStaleState();

    // Rebuild reverse dependency graph (dependents map) from current dependencies.
    // In push mode, processRun() doesn't update dependents, so the map may be stale.
    // We need accurate dependents for markDirty() propagation and scheduleAffectedEffects().
    for (const action of [...this.effects, ...this.computations]) {
      const log = this.dependencies.get(action);
      if (log) {
        this.updateDependents(action, log);
      }
    }
    for (const action of this.dirty) {
      setStaleFromInputs(this.stalenessState, action);
    }

    this.runtime.telemetry.submit({
      type: "scheduler.mode.change",
      pullMode: true,
    });
    this.queueExecution();
  }

  /**
   * Disables pull-based scheduling mode (returns to push mode).
   */
  disablePullMode(): void {
    this.pullMode = false;
    // Clear dirty set when switching back to push mode
    this.dirty.clear();
    this.stale.clear();
    this.resetUpstreamStaleState();
    this.runtime.telemetry.submit({
      type: "scheduler.mode.change",
      pullMode: false,
    });
    this.queueExecution();
  }

  /**
   * Returns whether pull mode is enabled.
   */
  isPullModeEnabled(): boolean {
    return this.pullMode;
  }

  setEventPreflightTelemetryEnabled(enabled: boolean): void {
    this.eventPreflightTelemetryEnabled = enabled;
  }

  isEventPreflightTelemetryEnabled(): boolean {
    return this.eventPreflightTelemetryEnabled;
  }

  /**
   * Marks an action as dirty.
   *
   * In pull mode, downstream effects are scheduled separately via
   * scheduleAffectedEffects(), and dependent computations are discovered
   * on-demand by collectDirtyDependencies().
   */
  private markDirty(action: Action): void {
    markSchedulerDirty(this.dirtySchedulingState, action);
  }

  private markDirectDirty(action: Action): boolean {
    return markDirectDirtyState(this.stalenessState, action);
  }

  private clearDirectDirty(action: Action): boolean {
    return clearSchedulerDirectDirty(this.dirtySchedulingState, action);
  }

  private forceClearStale(action: Action): void {
    forceClearStaleState(this.stalenessState, action);
  }

  private getTraceActionSummary(
    trace: DirtyDependencyTraceContext,
    action: Action,
  ): SchedulerEventPreflightActionSummary {
    let summary = trace.actionSummaries.get(action);
    if (!summary) {
      const log = this.dependencies.get(action);
      const writes = this.getSchedulingWrites(action) ?? [];
      summary = {
        actionId: this.getActionId(action),
        actionType: this.effects.has(action)
          ? "effect"
          : this.computations.has(action)
          ? "computation"
          : "unknown",
        visitCount: 0,
        memoHitCount: 0,
        dirtyInputCount: 0,
        resultTrueCount: 0,
        reverseDependencyEdgeCount: 0,
        maxDirectWriterCount: 0,
        dirty: this.dirty.has(action),
        pending: this.pending.has(action),
        readCount: log?.reads.length ?? 0,
        shallowReadCount: log?.shallowReads.length ?? 0,
        writeCount: writes.length,
      };
      trace.actionSummaries.set(action, summary);
    } else {
      summary.dirty ||= this.dirty.has(action);
      summary.pending ||= this.pending.has(action);
    }
    return summary;
  }

  private snapshotDirtyDependencyTraceContext(
    context: DirtyDependencyTraceContext,
  ): SchedulerEventPreflightStats {
    const {
      depth: _depth,
      actionSummaries,
      rootDirectWriterActions,
      ...stats
    } = context;
    const actionRows = [...actionSummaries.values()];
    const topBy = (
      rows: SchedulerEventPreflightActionSummary[],
      key: "visitCount" | "reverseDependencyEdgeCount",
    ) =>
      rows
        .filter((row) => row[key] > 0)
        .sort((a, b) =>
          b[key] - a[key] ||
          b.visitCount - a.visitCount ||
          a.actionId.localeCompare(b.actionId)
        )
        .slice(0, 12);

    const rootDirectWriterRows = [...rootDirectWriterActions].map((action) =>
      this.getTraceActionSummary(context, action)
    );

    return {
      ...stats,
      hotActions: topBy(actionRows, "visitCount"),
      hotFanoutActions: topBy(actionRows, "reverseDependencyEdgeCount"),
      rootDirectWriters: topBy(rootDirectWriterRows, "visitCount"),
    };
  }

  /**
   * Returns whether an action is marked as dirty.
   */
  isDirty(action: Action): boolean {
    return this.dirty.has(action);
  }

  private isStale(action: Action): boolean {
    return isActionStale(this.stalenessState, action);
  }

  private getUpstreamStaleCount(action: Action): number {
    return getUpstreamStaleCountFromState(this.stalenessState, action);
  }

  /**
   * Clears the dirty flag for an action.
   */
  private clearDirty(action: Action): void {
    clearSchedulerDirty(this.dirtySchedulingState, action);
  }

  /**
   * Collects computations that must run before `action` can observe up-to-date
   * values. This includes explicitly dirty computations and clean intermediates
   * whose own inputs flow from dirty upstream computations.
   *
   * Returns whether `action` itself is stale with respect to the current dirty
   * set.
   */
  private collectDirtyDependencies(
    action: Action,
    workSet: Set<Action>,
    memo = new Map<Action, boolean>(),
  ): boolean {
    const collectStart = performance.now();
    let addedToStack = false;
    const trace = this.dirtyDependencyTraceContext;

    try {
      if (trace) {
        trace.visitCount++;
        trace.maxDepth = Math.max(trace.maxDepth, trace.depth);
        const actionSummary = this.getTraceActionSummary(trace, action);
        actionSummary.visitCount++;
        if (this.dirty.has(action)) {
          trace.dirtyInputCount++;
          actionSummary.dirtyInputCount++;
        }
      }

      const cached = memo.get(action);
      if (cached !== undefined) {
        if (trace) {
          trace.memoHitCount++;
          this.getTraceActionSummary(trace, action).memoHitCount++;
        }
        if (cached && this.dirty.has(action) && this.computations.has(action)) {
          if (!workSet.has(action) && trace) trace.workSetAddCount++;
          workSet.add(action);
        }
        return cached;
      }

      if (!this.isStale(action)) {
        memo.set(action, false);
        return false;
      }

      if (this.collectStack.has(action)) {
        if (trace) trace.cycleHitCount++;
        const cycleResult = this.isStale(action) || workSet.has(action);
        memo.set(action, cycleResult);
        return cycleResult;
      }

      this.collectStack.add(action);
      addedToStack = true;

      let actionNeedsRun = this.isStale(action);
      const directWriters = this.reverseDependencies.get(action);
      if (directWriters) {
        if (trace) {
          trace.reverseDependencyActionCount++;
          trace.reverseDependencyEdgeCount += directWriters.size;
          const actionSummary = this.getTraceActionSummary(trace, action);
          actionSummary.reverseDependencyEdgeCount += directWriters.size;
          actionSummary.maxDirectWriterCount = Math.max(
            actionSummary.maxDirectWriterCount,
            directWriters.size,
          );
        }
        for (const writer of directWriters) {
          if (!this.isStale(writer)) {
            memo.set(writer, false);
            continue;
          }
          if (trace) trace.depth++;
          let writerNeedsRun: boolean;
          try {
            writerNeedsRun = this.collectDirtyDependencies(
              writer,
              workSet,
              memo,
            );
          } finally {
            if (trace) trace.depth--;
          }
          if (writerNeedsRun) {
            actionNeedsRun = true;
          }
        }
      } else {
        if (trace) trace.logFallbackCount++;
        const log = this.dependencies.get(action);
        if (log) {
          if (this.collectDirtyDependenciesForLog(log, workSet, memo)) {
            actionNeedsRun = true;
          }
        }
      }

      if (this.dirty.has(action) && this.computations.has(action)) {
        if (!workSet.has(action) && trace) trace.workSetAddCount++;
        workSet.add(action);
      }

      if (actionNeedsRun && trace) {
        trace.resultTrueCount++;
        this.getTraceActionSummary(trace, action).resultTrueCount++;
      }
      memo.set(action, actionNeedsRun);
      return actionNeedsRun;
    } finally {
      if (addedToStack) {
        this.collectStack.delete(action);
      }
      logger.time(
        collectStart,
        "scheduler",
        "execute",
        "collectDirtyDependencies",
      );
    }
  }

  private pendingDependencyCollectionMightAffect(
    action: Action,
    reads: IMemorySpaceAddress[],
    shallowReads: IMemorySpaceAddress[],
  ): boolean {
    return pendingDependencyCollectionMightAffectState(
      {
        pendingDependencyCollection: this.pendingDependencyCollection,
        effects: this.effects,
        isThrottled: (pendingAction) => this.isThrottled(pendingAction),
        getSchedulingWrites: (pendingAction) =>
          this.getSchedulingWrites(pendingAction),
        hasDependentPath: (from, to) => this.hasDependentPath(from, to),
      },
      action,
      reads,
      shallowReads,
    );
  }

  private hasDependentPath(
    from: Action,
    to: Action,
    visited = new Set<Action>(),
  ): boolean {
    if (from === to) return true;
    if (visited.has(from)) return false;
    visited.add(from);

    const dependents = this.dependents.get(from);
    if (!dependents) return false;

    for (const dependent of dependents) {
      if (this.hasDependentPath(dependent, to, visited)) {
        return true;
      }
    }

    return false;
  }

  private hasTransitiveEffectDependent(
    action: Action,
    visited = new Set<Action>(),
  ): boolean {
    if (visited.has(action)) return false;
    visited.add(action);

    const dependents = this.dependents.get(action);
    if (!dependents) return false;

    for (const dependent of dependents) {
      if (this.isLiveEffect(dependent)) return true;
      if (this.hasTransitiveEffectDependent(dependent, visited)) {
        return true;
      }
    }

    return false;
  }

  private isDemandedPullComputation(
    action: Action,
    visited = new Set<Action>(),
  ): boolean {
    if (
      !this.pullMode ||
      !this.computations.has(action) ||
      this.isLiveEffect(action)
    ) {
      return false;
    }
    if (visited.has(action)) return false;
    visited.add(action);

    return this.hasTransitiveEffectDependent(action) ||
      this.hasDemandedParentContext(action, visited);
  }

  private hasDemandedParentContext(
    action: Action,
    visited = new Set<Action>(),
  ): boolean {
    const parent = this.actionParent.get(action);
    if (!parent) return false;

    if (this.isLiveEffect(parent)) {
      return (this.getSchedulingWrites(parent)?.length ?? 0) === 0;
    }

    return this.isDemandedPullComputation(parent, visited);
  }

  private isLiveEffect(action: Action): boolean {
    if (this.effects.has(action)) return true;

    // During resubscribe, dependencies can be registered before all effect
    // bookkeeping is restored. Treat only dependency-bearing historical effects
    // as live so unsubscribed effects do not keep old pull graphs demanded.
    return (this.isEffectAction.get(action) ?? false) &&
      this.dependencies.has(action);
  }

  private isPullDemandRootEffect(action: Action): boolean {
    return this.pullMode &&
      this.effects.has(action) &&
      (this.getSchedulingWrites(action)?.length ?? 0) === 0;
  }

  private canAutomaticallyDebounce(action: Action): boolean {
    return canAutomaticallyDebounceState({
      noDebounce: this.noDebounce,
      effects: this.effects,
      isPullDemandRootEffect: (candidate) =>
        this.isPullDemandRootEffect(candidate),
    }, action);
  }

  private shouldRunFirstPullComputationInDemandContext(
    action: Action,
  ): boolean {
    if (
      !this.pullMode ||
      !this.computations.has(action) ||
      this.effects.has(action) ||
      this.actionHasRun.has(action)
    ) {
      return false;
    }

    return this.pullDemandedFirstRunComputations.has(action);
  }

  private markEffectConditionallyScheduled(effect: Action): void {
    if (!this.conditionallyScheduledEffects.has(effect)) {
      this.conditionallyScheduledEffects.set(
        effect,
        this.changedWritesHistory.length,
      );
    }
  }

  private recordChangedComputationWrites(
    action: Action,
    tx: IExtendedStorageTransaction,
    log: ReactivityLog,
  ): IMemorySpaceAddress[] {
    if (!this.pullMode || !this.computations.has(action)) return [];
    if (log.writes.length === 0) return [];

    const spaces = new Set(log.writes.map((write) => write.space));
    const changedWrites: IMemorySpaceAddress[] = [];

    for (const space of spaces) {
      for (const detail of getTransactionWriteDetails(tx, space)) {
        if (!deepEqual(detail.previousValue, detail.value)) {
          changedWrites.push(detail.address);
        }
      }
    }

    if (changedWrites.length > 0) {
      this.changedWritesHistory.push(...sortAndCompactPaths(changedWrites));
    }
    return changedWrites;
  }

  private conditionalEffectHasChangedInputs(effect: Action): boolean {
    const changedWritesStart = this.conditionallyScheduledEffects.get(effect);
    if (changedWritesStart === undefined) return true;

    const changedWrites = this.changedWritesHistory.slice(changedWritesStart);
    if (changedWrites.length === 0) return false;

    const log = this.dependencies.get(effect);
    if (!log) return false;

    return readsOverlapWrites(log.reads, log.shallowReads, changedWrites);
  }

  private markReadersDirtyForChangedWrites(
    sourceAction: Action,
    changedWrites: IMemorySpaceAddress[],
  ): void {
    if (!this.pullMode || changedWrites.length === 0) return;

    const readers = new Set<Action>();
    for (const write of sortAndCompactPaths(changedWrites)) {
      for (
        const reader of collectReadersForWrite(
          {
            triggers: this.triggers,
            nonRecursiveTriggers: this.nonRecursiveTriggers,
          },
          write,
        )
      ) {
        if (reader !== sourceAction) {
          readers.add(reader);
        }
      }
    }

    for (const reader of readers) {
      if (this.effects.has(reader)) {
        this.conditionallyScheduledEffects.delete(reader);
        this.scheduleWithDebounce(reader);
      } else if (this.computations.has(reader)) {
        this.markDirty(reader);
        this.scheduleAffectedEffects(reader);
      }
    }
  }

  private collectDirtyDependenciesForLog(
    log: ReactivityLog,
    workSet: Set<Action>,
    memo = new Map<Action, boolean>(),
  ): boolean {
    const lookupStart = performance.now();
    const trace = this.dirtyDependencyTraceContext;
    let directWriters: Set<Action>;
    try {
      directWriters = collectDirectWritersForLog({
        writersByEntity: this.writersByEntity,
        effects: this.effects,
        getSchedulingWrites: (writer) => this.getSchedulingWrites(writer),
        trace,
      }, log);
    } finally {
      logger.time(
        lookupStart,
        "scheduler",
        "execute",
        "collectDirtyDependencies",
        "writerLookup",
      );
    }

    if (trace) trace.directWriterCount += directWriters.size;
    if (trace && trace.depth === 0) {
      for (const writer of directWriters) {
        trace.rootDirectWriterActions.add(writer);
        this.getTraceActionSummary(trace, writer);
      }
    }

    let hasDirtyDependencies = false;
    for (const writer of directWriters) {
      if (!this.isStale(writer)) {
        memo.set(writer, false);
        continue;
      }

      if (trace) trace.depth++;
      let writerNeedsRun: boolean;
      try {
        writerNeedsRun = this.collectDirtyDependencies(
          writer,
          workSet,
          memo,
        );
      } finally {
        if (trace) trace.depth--;
      }
      if (writerNeedsRun) {
        hasDirtyDependencies = true;
        if (this.dirty.has(writer) && this.computations.has(writer)) {
          if (!workSet.has(writer) && trace) trace.workSetAddCount++;
          workSet.add(writer);
        }
      }
    }

    return hasDirtyDependencies;
  }

  /**
   * In pull mode, only effects are runnable seeds by default.
   *
   * Inline idempotency mode intentionally does not widen this to computations:
   * it rechecks computations that already run due to explicit demand or an
   * effect pull, rather than turning pull mode back into eager push mode.
   */
  private collectPullIterationSeeds(workSet: Set<Action>): void {
    for (const action of this.pending) {
      if (this.isPendingPullActionRunnable(action)) {
        workSet.add(action);
      }
    }

    for (const action of this.dirty) {
      if (this.isDirtyPullActionRunnable(action)) {
        this.pending.add(action);
        workSet.add(action);
      }
    }
  }

  private hasRunnablePullWork(): boolean {
    for (const action of this.pending) {
      if (this.isPendingPullActionRunnable(action)) {
        return true;
      }
    }

    for (const action of this.dirty) {
      if (
        this.isDirtyPullActionRunnable(action, {
          considerDebounce: true,
        })
      ) {
        return true;
      }
    }

    return false;
  }

  private isPendingPullActionRunnable(action: Action): boolean {
    return isPendingPullActionRunnable({
      effects: this.effects,
      isDemandedPullComputation: (candidate) =>
        this.isDemandedPullComputation(candidate),
      shouldRunFirstPullComputationInDemandContext: (candidate) =>
        this.shouldRunFirstPullComputationInDemandContext(candidate),
    }, action);
  }

  private isDirtyPullActionRunnable(
    action: Action,
    options: { considerDebounce?: boolean } = {},
  ): boolean {
    return isDirtyPullActionRunnable({
      effects: this.effects,
      isDemandedPullComputation: (candidate) =>
        this.isDemandedPullComputation(candidate),
      isThrottled: (candidate) => this.isThrottled(candidate),
      ...(options.considerDebounce
        ? {
          isDebouncedComputationWaiting: (candidate: Action) =>
            this.isDebouncedComputationWaiting(candidate),
        }
        : {}),
    }, action);
  }

  private hasDeferredDirtyEffectWork(): boolean {
    for (const action of this.dirty) {
      if (this.effects.has(action)) return true;
    }
    return false;
  }

  /**
   * Finds and schedules all effects that transitively depend on the given computation.
   */
  private scheduleAffectedEffects(
    computation: Action,
  ): TriggerTraceScheduledEffect[] {
    const start = performance.now();
    const scheduledEffects: TriggerTraceScheduledEffect[] = [];

    try {
      for (
        const effect of collectTransitiveEffects(
          { dependents: this.dependents, effects: this.effects },
          computation,
        )
      ) {
        const pendingBefore = this.pending.has(effect);
        const dirtyBefore = this.dirty.has(effect);
        const debounceMs = this.actionDebounce.get(effect);
        if (
          !pendingBefore && !dirtyBefore &&
          !this.conditionallyScheduledEffects.has(effect)
        ) {
          this.markEffectConditionallyScheduled(effect);
        }
        this.scheduleWithDebounce(effect);
        scheduledEffects.push({
          actionId: this.getActionId(effect),
          pendingBefore,
          dirtyBefore,
          debounceMs,
        });
      }
    } finally {
      logger.time(start, "scheduler", "scheduleAffectedEffects");
    }
    return scheduledEffects;
  }

  // ============================================================
  // Compute time tracking for cycle-aware scheduling
  // ============================================================

  /**
   * Records the execution time for an action.
   * Updates running statistics including run count, total time, and average time.
   * Stats are keyed by action ID (source location) to persist across action recreation.
   */
  private recordActionTime(action: Action, elapsed: number): void {
    recordActionTimeState(this.actionTimingState, action, elapsed);
    // Check if action should be auto-debounced based on performance
    this.maybeAutoDebounce(action);
  }

  /**
   * Returns the execution statistics for an action, if available.
   * Useful for diagnostics and determining cycle convergence strategy.
   * Accepts either an Action or an action ID string.
   */
  getActionStats(action: Action | string): ActionStats | undefined {
    return getActionStatsFromState(this.actionTimingState, action);
  }

  // ============================================================
  // Debounce infrastructure for throttling slow actions
  // ============================================================

  /**
   * Sets a debounce delay for an action.
   * When the action is triggered, it will wait for the specified delay before running.
   * If triggered again during the delay, the timer resets.
   */
  setDebounce(action: Action, ms: number): void {
    setDebounceState(this.delayState, action, ms);
  }

  /**
   * Gets the current debounce delay for an action, if set.
   */
  getDebounce(action: Action): number | undefined {
    return getDebounceState(this.delayState, action);
  }

  /**
   * Clears the debounce setting for an action.
   */
  clearDebounce(action: Action): void {
    clearDebounceState(this.delayState, action);
  }

  private clearComputationDebounceState(
    action: Action,
    options: { cancelTimer?: boolean } = {},
  ): void {
    clearComputationDebounceStateFromDelay(
      this.delayState,
      action,
      options,
    );
  }

  /**
   * Enables or disables auto-debounce detection for an action.
   * When set to true, this action opts OUT of auto-debounce.
   * By default, slow actions (> 50ms avg after 3 runs) will automatically get debounced.
   */
  setNoDebounce(action: Action, optOut: boolean): void {
    setNoDebounceState(this.delayState, action, optOut);
  }

  /**
   * Cancels any pending debounce timer for an action.
   */
  private cancelDebounceTimer(action: Action): void {
    cancelDebounceTimerState(this.delayState, action);
  }

  private shouldDebouncePullComputation(action: Action): boolean {
    return shouldDebouncePullComputation(
      this.delayState,
      action,
      {
        pullMode: this.pullMode,
        computations: this.computations,
        effects: this.effects,
      },
    );
  }

  private getNextDebounceRunTime(action: Action): number | undefined {
    return getNextDebounceRunTimeState(
      this.delayState,
      action,
      {
        pullMode: this.pullMode,
        computations: this.computations,
        effects: this.effects,
        dirty: this.dirty,
      },
    );
  }

  private isDebouncedComputationWaiting(action: Action): boolean {
    return isDebouncedComputationWaitingState(
      this.delayState,
      action,
      {
        pullMode: this.pullMode,
        computations: this.computations,
        effects: this.effects,
        dirty: this.dirty,
        pending: this.pending,
        queueExecution: () => this.queueExecution(),
        logDebounce: (message) =>
          logger.debug("schedule-debounce", () => [message]),
      },
    );
  }

  private scheduleComputationDebounce(action: Action): void {
    scheduleComputationDebounce(
      this.delayState,
      action,
      {
        pullMode: this.pullMode,
        computations: this.computations,
        effects: this.effects,
        dirty: this.dirty,
        pending: this.pending,
        queueExecution: () => this.queueExecution(),
        logDebounce: (message) =>
          logger.debug("schedule-debounce", () => [message]),
      },
    );
  }

  /**
   * Schedules an action with debounce support.
   * If the action has a debounce delay, it will wait before being added to pending.
   * Otherwise, it's added immediately.
   */
  private scheduleWithDebounce(action: Action): void {
    scheduleWithDebounceState(
      this.delayState,
      action,
      {
        pending: this.pending,
        queueExecution: () => this.queueExecution(),
        logDebounce: (message) =>
          logger.debug("schedule-debounce", () => [message]),
      },
    );
  }

  /**
   * Checks if an action should be auto-debounced based on its performance stats.
   * Called after recording action time to potentially enable debouncing for slow actions.
   * Auto-debounce is enabled by default; use noDebounce to opt out.
   */
  private maybeAutoDebounce(action: Action): void {
    const update = maybeAutoDebounceState(this.delayState, action, {
      canAutomaticallyDebounce: (candidate) =>
        this.canAutomaticallyDebounce(candidate),
    });
    if (update) {
      logger.debug("schedule-debounce", () => [
        `[AUTO-DEBOUNCE] Action ${update.actionId} ` +
        `auto-debounced (avg ${
          update.averageTime.toFixed(1)
        }ms >= ${update.thresholdMs}ms)`,
      ]);
    }
  }

  // ============================================================
  // Throttle infrastructure - "value can be stale by T ms"
  // ============================================================

  /**
   * Sets a throttle period for an action.
   * The action won't run if it ran within the last `ms` milliseconds.
   * Unlike debounce, throttled actions stay dirty and will be pulled
   * by effects when the throttle period expires. Event handlers whose head
   * dependencies are throttled are parked until the earliest eligible wake time.
   */
  setThrottle(action: Action, ms: number): void {
    setThrottleState(this.delayState, action, ms);
  }

  /**
   * Gets the current throttle period for an action, if set.
   */
  getThrottle(action: Action): number | undefined {
    return getThrottleState(this.delayState, action);
  }

  /**
   * Clears the throttle setting for an action.
   */
  clearThrottle(action: Action): void {
    clearThrottleState(this.delayState, action);
  }

  /**
   * Checks if an action is currently throttled (ran too recently).
   * Returns true if the action should be skipped this execution cycle.
   */
  private isThrottled(action: Action): boolean {
    return isThrottledState(this.delayState, action);
  }

  private getNextEligibleRunTime(action: Action): number | undefined {
    return getNextEligibleRunTimeState(this.delayState, action);
  }

  private scheduleEventQueueWake(notBefore: number): void {
    scheduleEventQueueWakeState(this.eventQueueWakeState, notBefore);
  }

  private cancelEventQueueWake(): void {
    cancelEventQueueWakeState(this.eventQueueWakeState);
  }

  private isHeadEventParked(now: number = performance.now()): boolean {
    return isHeadEventParkedState(this.eventQueueWakeState, now);
  }

  // ============================================================
  // Push-triggered filtering
  // ============================================================

  /**
   * Returns the active scheduling write set for an action. By default this is
   * the current-known write set; experimental historical mode returns the
   * cumulative legacy view instead.
   */
  getMightWrite(action: Action): IMemorySpaceAddress[] | undefined {
    return this.getSchedulingWrites(action);
  }

  /**
   * Returns filter statistics for the current/last execution cycle.
   */
  getFilterStats(): { filtered: number; executed: number } {
    return { ...this.filterStats };
  }

  /**
   * Resets filter statistics.
   */
  resetFilterStats(): void {
    this.filterStats = { filtered: 0, executed: 0 };
  }

  /**
   * Enables collection of per-iteration settle stats during execute().
   * Call this once before running patterns to opt in to the overhead.
   */
  enableSettleStats(): void {
    this.setSettleStatsEnabled(true);
  }

  /**
   * Enables or disables collection of per-iteration settle stats during execute().
   * Disabling also clears the last collected stats to avoid stale reads.
   */
  setSettleStatsEnabled(enabled: boolean): void {
    this.collectSettleStats = enabled;
    if (!enabled) {
      this.lastSettleStats = null;
      this.settleStatsHistory = [];
    }
  }

  /**
   * Returns settle stats from the last execute() call, or null if not enabled/collected.
   */
  getSettleStats(): SettleStats | null {
    return this.lastSettleStats;
  }

  /**
   * Returns recent settle stats history from execute() calls, oldest first.
   */
  getSettleStatsHistory(): SettleStatsHistoryEntry[] {
    return [...this.settleStatsHistory];
  }

  /**
   * Enables or disables collection of exact action-run history.
   * Disabling clears the current ring buffer to avoid stale reads.
   */
  setActionRunTraceEnabled(enabled: boolean): void {
    this.collectActionRunTrace = enabled;
    if (!enabled) {
      this.actionRunTrace = [];
    }
  }

  /**
   * Returns recent exact action-run history, oldest first.
   */
  getActionRunTrace(): ActionRunTraceEntry[] {
    return [...this.actionRunTrace];
  }

  /**
   * Enables or disables collection of structured trigger-trace entries.
   * Disabling clears the current ring buffer to avoid stale reads.
   */
  setTriggerTraceEnabled(enabled: boolean): void {
    this.collectTriggerTrace = enabled;
    if (!enabled) {
      this.triggerTrace = [];
    }
  }

  /**
   * Returns recent structured trigger-trace entries, oldest first.
   */
  getTriggerTrace(): TriggerTraceEntry[] {
    return [...this.triggerTrace];
  }

  // ============================================================
  // Non-settling detection API
  // ============================================================

  /**
   * Returns whether the scheduler has detected a non-settling condition.
   * This means execute() is consuming a high fraction of wall-clock time,
   * indicating the system is churning.
   */
  isNonSettling(): boolean {
    return this.settlingTracker.nonSettlingDetected;
  }

  /**
   * Enables or disables automatic triggering of diagnosis when non-settling
   * is detected. Off by default.
   */
  setAutoTriggerDiagnosis(enabled: boolean): void {
    this.autoTriggerDiagnosis = enabled;
  }

  // ============================================================
  // Idempotency diagnosis API (Phase 2 + 3)
  // ============================================================

  /**
   * Starts diagnosis mode: captures read/write values and causal edges.
   * Automatically stops after durationMs.
   */
  private startDiagnosis(durationMs = 5000): void {
    if (this.diagnosisEnabled) return;

    this.diagnosisEnabled = true;
    this.diagnosisStartTime = performance.now();
    this.diagnosisBusyTime = 0;
    this.diagnosisHistory.clear();
    this.diagnosisNonIdempotent = [];
    this.causalEdges = [];

    this.diagnosisTimeout = setTimeout(() => {
      this.stopDiagnosis();
    }, durationMs);
  }

  /**
   * Stops diagnosis mode and finalizes results.
   */
  private stopDiagnosis(): void {
    if (!this.diagnosisEnabled) return;

    this.diagnosisEnabled = false;
    if (this.diagnosisTimeout) {
      clearTimeout(this.diagnosisTimeout);
      this.diagnosisTimeout = null;
    }

    const duration = performance.now() - this.diagnosisStartTime;

    // Detect cycles from causal edges
    const cycles = detectCausalCycles(this.causalEdges);

    const result: SchedulerDiagnosisResult = {
      nonIdempotent: this.diagnosisNonIdempotent,
      cycles,
      duration,
      busyTime: this.diagnosisBusyTime,
    };

    // Clean up
    this.diagnosisHistory.clear();
    this.causalEdges = [];

    // Resolve the promise if someone is waiting
    if (this.diagnosisResolve) {
      this.diagnosisResolve(result);
      this.diagnosisResolve = null;
    }
  }

  /**
   * Runs a diagnosis for the specified duration and returns the result.
   * This is the main entry point for external callers (IPC, console).
   */
  runDiagnosis(durationMs = 5000): Promise<SchedulerDiagnosisResult> {
    // If already running, stop and start fresh
    if (this.diagnosisEnabled) {
      this.stopDiagnosis();
    }

    return new Promise<SchedulerDiagnosisResult>((resolve) => {
      this.diagnosisResolve = resolve;
      this.startDiagnosis(durationMs);
    });
  }

  /**
   * Checks all computations for idempotency by enabling inline mode
   * and force-running each computation through run(). Each run()
   * automatically gets a second synchronous run for comparison.
   */
  async runIdempotencyCheck(): Promise<SchedulerDiagnosisResult> {
    this.idempotencyViolations = [];
    this.idempotencyCheckMode = true;

    try {
      // Snapshot computations to avoid iterating a live Set
      const computationsSnapshot = [...this.computations];
      for (const action of computationsSnapshot) {
        await this.run(action);
      }
    } finally {
      this.idempotencyCheckMode = false;
    }

    return {
      nonIdempotent: [...this.idempotencyViolations],
      cycles: [],
      duration: 0,
      busyTime: 0,
    };
  }

  /**
   * Captures a diagnosis record for a single action run.
   * Called from run() when diagnosisEnabled is true.
   */
  private captureDiagnosisRecord(
    actionId: string,
    action: Action,
    tx: IExtendedStorageTransaction,
    log: ReactivityLog,
  ): void {
    captureDiagnosisRecordState({
      diagnosisHistory: this.diagnosisHistory,
      diagnosisNonIdempotent: this.diagnosisNonIdempotent,
      createReadTx: () => this.runtime.edit(),
      getActionTelemetryInfo: (target) => this.getActionTelemetryInfo(target),
    }, {
      actionId,
      action,
      tx,
      log,
    });
  }

  private handleError(error: Error, action: any) {
    handleSchedulerError(
      {
        errorHandlers: this.errorHandlers,
        parseStack: (stack) => this.runtime.harness.parseStack(stack),
      },
      error,
      action,
    );
  }

  private async execute(): Promise<void> {
    if (this.disposed) return;
    logger.timeStart("scheduler", "execute");

    // In case a directly invoked `run` is still running, wait for it to finish.
    if (this.runningPromise) await this.runningPromise;

    // Track timing for cycle-aware debounce
    this.executeStartTime = performance.now();
    this.runsThisExecute.clear();

    // Non-settling heuristic: record execute() start
    markExecuteStart(this.settlingTracker);

    logger.timeStart("scheduler", "execute", "depCollect");
    // Find computation actions whose writes are still unknown. We run them on
    // the first cycle to capture writes that cannot be inferred from declared
    // outputs or populateDependencies() potential writes.
    //
    // TODO(seefeld): Once we more reliably capture what they can write via
    // WriteableCell or so, then we can treat this more deliberately via the
    // dependency collection process above. We'll have to re-run it whenever
    // inputs change, as they might change what they can write to. We hope that
    // for now this will be sufficiently captured in mightWrite.
    const { newActionsWithoutDependencies } = collectPendingDependencyActions({
      pendingDependencyCollection: this.pendingDependencyCollection,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      effects: this.effects,
      getSchedulingWrites: (action) => this.getSchedulingWrites(action),
      collectDependenciesForAction: (action, populateDependencies) =>
        this.collectDependenciesForAction(action, populateDependencies, {
          errorLogLabel: "schedule-dep-error",
          errorMessage: (target, error) =>
            `Error populating dependencies for ${
              this.getActionId(target)
            }: ${error}`,
        }),
      onCollected: (action, { log, entities }) =>
        logger.debug("schedule-dep-collect", () => [
          `Collected dependencies for ${
            this.getActionId(action)
          }: ${log.reads.length} reads, ${log.writes.length} writes, ${entities.size} entities`,
        ]),
      scheduleAffectedEffects: (action) => this.scheduleAffectedEffects(action),
    });
    logger.timeEnd("scheduler", "execute", "depCollect");

    // Track dirty dependencies that block events - these must be added to workSet
    const eventBlockingDeps = new Set<Action>();

    logger.timeStart("scheduler", "execute", "event");
    await processQueuedEventDuringExecute({
      runtime: this.runtime,
      eventQueue: this.eventQueue,
      pullMode: this.pullMode,
      dirty: this.dirty,
      pending: this.pending,
      eventBlockingDeps,
      eventPreflightTelemetryEnabled: this.eventPreflightTelemetryEnabled,
      setRunningPromise: (promise) => {
        this.runningPromise = promise;
      },
      getActionId: (target) => this.getActionId(target),
      getActionTelemetryInfo: (target) => this.getActionTelemetryInfo(target),
      handleError: (error, target) => this.handleError(error, target),
      queueExecution: () => this.queueExecution(),
      setDirtyDependencyTraceContext: (trace) => {
        this.dirtyDependencyTraceContext = trace;
      },
      collectDirtyDependenciesForLog: (deps, dirtyDeps, dirtyDepMemo) =>
        this.collectDirtyDependenciesForLog(
          deps,
          dirtyDeps,
          dirtyDepMemo,
        ),
      isDebouncedComputationWaiting: (dep) =>
        this.isDebouncedComputationWaiting(dep),
      getNextDebounceRunTime: (dep) => this.getNextDebounceRunTime(dep),
      getNextEligibleRunTime: (dep) => this.getNextEligibleRunTime(dep),
      scheduleEventQueueWake: (notBefore) =>
        this.scheduleEventQueueWake(notBefore),
      snapshotDirtyDependencyTraceContext: (trace) =>
        this.snapshotDirtyDependencyTraceContext(trace),
    });
    logger.timeEnd("scheduler", "execute", "event");

    // Process any newly subscribed actions that were added during event handling.
    // This handles cases like event handlers that create sub-patterns whose
    // computations need their dependencies discovered before we build the workSet.
    if (this.pendingDependencyCollection.size > 0) {
      collectPendingDependencyActions({
        pendingDependencyCollection: this.pendingDependencyCollection,
        populateDependenciesCallbacks: this.populateDependenciesCallbacks,
        effects: this.effects,
        getSchedulingWrites: (action) => this.getSchedulingWrites(action),
        collectDependenciesForAction: (action, populateDependencies) =>
          this.collectDependenciesForAction(action, populateDependencies, {
            errorLogLabel: "schedule-dep-error-post-event",
            errorMessage: (target, error) =>
              `Error populating dependencies for ${
                this.getActionId(target)
              }: ${error}`,
          }),
        onCollected: (action) =>
          logger.debug("schedule-dep-collect-post-event", () => [
            `Collected dependencies for ${this.getActionId(action)}`,
          ]),
      });
    }

    // Build initial seeds for pull mode (effects + special actions).
    const initialSeeds = buildPullInitialSeeds({
      pullMode: this.pullMode,
      pending: this.pending,
      dirty: this.dirty,
      effects: this.effects,
      newActionsWithoutDependencies,
      eventBlockingDeps,
      computationDebounceFlushSeeds: this.computationDebounceFlushSeeds,
    });

    // Settle loop: runs until no more dirty work is found.
    // First iteration processes initial seeds + their dirty deps.
    // Subsequent iterations process new subscriptions and re-collect dirty deps.
    logger.timeStart("scheduler", "execute", "settle");
    const maxSettleIterations = this.pullMode ? 10 : 10;
    const EARLY_ITERATION_THRESHOLD = 5;
    const earlyIterationComputations = new Set<Action>(); // Track computations in first N iterations
    let lastWorkSet: Set<Action> = new Set();
    let settledEarly = false;
    const settleIterStats: SettleIterationStats[] | undefined =
      this.collectSettleStats ? [] : undefined;
    const settleStartTime = this.collectSettleStats ? performance.now() : 0;

    for (let settleIter = 0; settleIter < maxSettleIterations; settleIter++) {
      const iterStart = settleIterStats ? performance.now() : 0;
      let iterActionsRun = 0;

      // Process any newly subscribed actions from previous iteration.
      // This sets up their dependencies so collectDirtyDependencies can find them.
      if (this.pullMode && this.pendingDependencyCollection.size > 0) {
        collectPendingDependencyActions({
          pendingDependencyCollection: this.pendingDependencyCollection,
          populateDependenciesCallbacks: this.populateDependenciesCallbacks,
          effects: this.effects,
          getSchedulingWrites: (action) => this.getSchedulingWrites(action),
          collectDependenciesForAction: (action, populateDependencies) =>
            this.collectDependenciesForAction(action, populateDependencies, {
              errorLogLabel: "schedule-dep-error-pre-run",
              errorMessage: (target, error) =>
                `Error collecting deps for ${
                  this.getActionId(target)
                }: ${error}`,
              useRawReadsForTriggers: true,
            }),
        });
      }

      // Build the work set for this iteration
      const buildPullWorkSetStart = this.pullMode ? performance.now() : 0;
      const { workSet, iterationSeeds, dirtyDependencyCount } =
        buildIterationWorkSet({
          pullMode: this.pullMode,
          pending: this.pending,
          initialSeeds,
          settleIter,
          collectPullIterationSeeds: (seeds) =>
            this.collectPullIterationSeeds(seeds),
          collectDirtyDependencies: (seed, targetWorkSet, memo) =>
            this.collectDirtyDependencies(seed, targetWorkSet, memo),
        });

      if (this.pullMode) {
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
      }

      if (workSet.size === 0) {
        settledEarly = true;
        break;
      }

      recordEarlyIterationComputations({
        pullMode: this.pullMode,
        settleIter,
        threshold: EARLY_ITERATION_THRESHOLD,
        workSet,
        effects: this.effects,
        earlyIterationComputations,
      });
      lastWorkSet = workSet;

      // Snapshot workSet size before topo sort (in push mode, workSet === this.pending
      // which gets mutated during execution)
      const iterWorkSetSize = workSet.size;

      const topologicalSortStart = performance.now();
      const order = topologicalSort(
        workSet,
        this.dependencies,
        this.getSchedulingWritesMap(),
        this.actionParent,
        this.pullMode ? this.dependents : undefined,
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
      if (this.pullMode) {
        for (const fn of order) {
          if (this.effects.has(fn)) {
            this.clearDirty(fn);
          }
        }
      }

      // Run all functions. This will resubscribe actions with their new dependencies.
      for (const fn of order) {
        // Check if action is still scheduled (not unsubscribed during this tick).
        // Running an action might unsubscribe other actions in the workSet.
        const isStillScheduled = this.computations.has(fn) ||
          this.effects.has(fn);
        if (!isStillScheduled) continue;

        // Check if action is still valid
        // In pull mode, check both pending (effects) and dirty (computations)
        const isInPending = this.pending.has(fn);
        const isInDirty = this.dirty.has(fn);

        if (this.pullMode) {
          // For effects: we cleared dirty upfront, so check if re-dirtied (cycle)
          if (this.effects.has(fn)) {
            if (this.dirty.has(fn)) {
              // Effect was re-dirtied during this tick → cycle detected
              logger.debug("schedule-cycle", () => [
                `[CYCLE] Effect ${
                  this.getActionId(fn)
                } re-dirtied, skipping (cycle detected)`,
              ]);
              // Skip this effect - it will run on a future tick after cycle settles
              this.pending.delete(fn);
              continue;
            }
            if (!isInPending) continue;
          } else {
            // For computations: must be pending or dirty
            if (!isInPending && !isInDirty) continue;
          }
        } else {
          // Push mode: action must be in pending
          if (!isInPending) continue;
        }

        if (this.isDebouncedComputationWaiting(fn)) {
          logger.debug("schedule-debounce", () => [
            `[DEBOUNCE] Skipping debounced computation: ${
              this.getActionId(fn)
            }`,
          ]);
          this.filterStats.filtered++;
          this.pending.delete(fn);
          continue;
        }

        // Check throttle: skip recently-run actions but keep them dirty
        // They'll be pulled next time an effect needs them (if throttle expired)
        if (this.isThrottled(fn)) {
          logger.debug("schedule-throttle", () => [
            `[THROTTLE] Skipping throttled action: ${this.getActionId(fn)}`,
          ]);
          this.filterStats.filtered++;
          // Don't clear from pending or dirty - action stays in its current state
          // but we remove from pending so it doesn't run this cycle
          this.pending.delete(fn);
          // Keep pull-mode effects dirty so they wake when the throttle expires.
          if (this.pullMode && this.effects.has(fn)) {
            this.markDirectDirty(fn);
          }
          continue;
        }

        if (
          this.pullMode &&
          this.effects.has(fn) &&
          this.conditionallyScheduledEffects.has(fn) &&
          !this.conditionalEffectHasChangedInputs(fn)
        ) {
          this.conditionallyScheduledEffects.delete(fn);
          this.pending.delete(fn);
          this.clearDirty(fn);
          this.filterStats.filtered++;
          continue;
        }

        // Clean up from pending/dirty before running
        this.pending.delete(fn);
        this.conditionallyScheduledEffects.delete(fn);
        if (this.computations.has(fn)) {
          this.clearComputationDebounceState(fn);
        }
        if (this.pullMode && this.effects.has(fn)) {
          this.clearDirty(fn);
        }

        this.filterStats.executed++;
        iterActionsRun++;
        this.loopCounter.set(fn, (this.loopCounter.get(fn) || 0) + 1);
        // Track runs for cycle-aware debounce
        this.runsThisExecute.set(fn, (this.runsThisExecute.get(fn) ?? 0) + 1);
        if (this.loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN) {
          const error = new Error(
            `Too many iterations: ${this.loopCounter.get(fn)} ${
              this.getActionId(fn)
            }`,
          );
          // Attach the last frame from the action so handleError can
          // extract piece/spell metadata (CT-1316: fixes message:null).
          const lastFrame = (fn as Action & { lastFrame?: Frame }).lastFrame;
          if (lastFrame) {
            (error as Error & { frame?: Frame }).frame = lastFrame;
          }
          this.handleError(error, fn);
        } else {
          const activePullDemand = this.pullMode &&
            (this.computations.has(fn) ||
              this.isPullDemandRootEffect(fn));
          if (activePullDemand) {
            this.activePullDemandActions.add(fn);
          }
          try {
            await this.run(fn);
          } finally {
            if (activePullDemand) {
              this.activePullDemandActions.delete(fn);
            }
          }
        }
      }

      // Capture per-iteration settle stats (only when enabled)
      if (settleIterStats) {
        settleIterStats.push(summarizeSettleIteration({
          workSetSize: iterWorkSetSize,
          order,
          actionsRun: iterActionsRun,
          durationMs: performance.now() - iterStart,
          effects: this.effects,
          getActionId: (action) => this.getActionId(action),
        }));
      }
    }

    // Store settle stats for external access (only when enabled)
    if (settleIterStats) {
      const settleStats = summarizeSettleRun({
        iterations: settleIterStats,
        totalDurationMs: performance.now() - settleStartTime,
        settledEarly,
        initialSeedCount: initialSeeds.size,
      });
      this.lastSettleStats = settleStats;
      pushBoundedHistory(
        this.settleStatsHistory,
        { recordedAt: performance.now(), stats: settleStats },
        MAX_SETTLE_STATS_HISTORY,
      );
    }

    logger.timeEnd("scheduler", "execute", "settle");

    // If we hit max iterations without settling, break the cycle:
    // 1. Clear dirty/pending for computations that were in early iterations AND still in last workSet
    // 2. Run all remaining dirty effects so they don't get lost
    const cycleBreakPlan = planCycleBreak({
      pullMode: this.pullMode,
      settledEarly,
      lastWorkSet,
      earlyIterationComputations,
      dirty: this.dirty,
      effects: this.effects,
      runsThisExecute: this.runsThisExecute,
      isThrottled: (action) => this.isThrottled(action),
    });
    if (cycleBreakPlan.shouldBreak) {
      logger.debug("schedule-cycle", () => [
        `[CYCLE-BREAK] Hit max iterations (${maxSettleIterations}), breaking cycle`,
        `Early computations: ${earlyIterationComputations.size}, Last workSet: ${lastWorkSet.size}`,
      ]);

      // Clear computations that appear to be in the cycle
      // (present in early iterations AND still in the last workSet)
      // But don't clear throttled computations - they should stay dirty
      for (const comp of cycleBreakPlan.computationsToClear) {
        logger.debug("schedule-cycle", () => [
          `[CYCLE-BREAK] Clearing cyclic computation: ${
            this.getActionId(comp)
          }`,
        ]);
        this.clearDirty(comp);
        this.pending.delete(comp);
      }

      // Run all remaining dirty effects - these shouldn't be lost
      // But skip throttled effects - they should stay dirty for later
      for (const effect of cycleBreakPlan.dirtyEffectsToRun) {
        if (this.effects.has(effect) && this.dirty.has(effect)) {
          logger.debug("schedule-cycle", () => [
            `[CYCLE-BREAK] Running dirty effect: ${this.getActionId(effect)}`,
          ]);
          this.clearDirty(effect);
          this.pending.delete(effect);
          this.unsubscribe(effect);
          this.filterStats.executed++;
          await this.run(effect);
        }
      }
    }

    // Apply cycle-aware debounce to effects that ran multiple times this execute().
    // Pull computations are already demand-gated; debouncing them can leave a
    // live renderer observing stale materialized data until an arbitrary timer
    // fires.
    const cycleDebouncePlan = planAdaptiveCycleDebounce({
      pullMode: this.pullMode,
      executeStartTime: this.executeStartTime,
      runsThisExecute: this.runsThisExecute,
      canAutomaticallyDebounce: (action) =>
        this.canAutomaticallyDebounce(
          action,
        ),
      getCurrentDebounce: (action) => this.actionDebounce.get(action),
    });
    for (
      const { action, runs, delayMs } of cycleDebouncePlan.updates
    ) {
      this.actionDebounce.set(action, delayMs);
      logger.debug("schedule-cycle-debounce", () => [
        `[CYCLE-DEBOUNCE] Action ${this.getActionId(action)} ` +
        `ran ${runs}x in ${cycleDebouncePlan.elapsedMs.toFixed(1)}ms, ` +
        `setting debounce to ${delayMs}ms`,
      ]);
    }

    // Non-settling heuristic: accumulate busy time at end of execute()
    const executeEnd = recordExecuteEnd(this.settlingTracker);
    if (this.diagnosisEnabled) {
      this.diagnosisBusyTime += executeEnd.diagnosisBusyTimeMs;
    }
    if (executeEnd.nonSettlingTelemetry) {
      this.runtime.telemetry.submit({
        type: "scheduler.non-settling",
        ...executeEnd.nonSettlingTelemetry,
      });
      // Auto-trigger diagnosis if enabled
      if (this.autoTriggerDiagnosis && !this.diagnosisEnabled) {
        this.startDiagnosis();
      }
    }

    // In pull mode, we consider ourselves done when there are no effects or
    // effect-demanded computations to execute.
    const hasQueuedEventReadyNow = this.eventQueue.length > 0 &&
      !this.isHeadEventParked();
    const hasParkedHeadEvent = this.eventQueue.length > 0 &&
      this.isHeadEventParked();
    const shouldRerunAfterCurrentExecute = this.rerunAfterCurrentExecute;
    this.rerunAfterCurrentExecute = false;

    const continuation = planExecuteContinuation({
      pullMode: this.pullMode,
      pending: this.pending,
      dirty: this.dirty,
      effects: this.effects,
      shouldRerunAfterCurrentExecute,
      hasQueuedEventReadyNow,
      hasParkedHeadEvent,
      isDemandedPullComputation: (action) =>
        this.isDemandedPullComputation(action),
      shouldRunFirstPullComputationInDemandContext: (action) =>
        this.shouldRunFirstPullComputationInDemandContext(action),
      isDebouncedComputationWaiting: (action) =>
        this.isDebouncedComputationWaiting(action),
      getNextDebounceRunTime: (action) => this.getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) => this.getNextEligibleRunTime(action),
    });

    if (!continuation.shouldQueueAnotherTick) {
      if (continuation.nextDirtyPullRunAt !== undefined) {
        this.scheduleEventQueueWake(continuation.nextDirtyPullRunAt);
        const promises = this.idlePromises;
        if (
          !continuation.hasParkedHeadEvent &&
          !continuation.nextDirtyPullRunWaitsForIdle
        ) {
          for (const resolve of promises) resolve();
          this.idlePromises.length = 0;
        }
        this.loopCounter = new WeakMap();
        this.scheduled = false;
      } else if (hasEventQueueWakeTimer(this.eventQueueWakeState)) {
        this.loopCounter = new WeakMap();
        this.scheduled = false;

        // Waiting on a future wake is quiescent from the scheduler's
        // perspective, so reset the non-settling tracker.
        this.settlingTracker = createSettlingTracker();
      } else {
        const promises = this.idlePromises;
        for (const resolve of promises) resolve();
        this.idlePromises.length = 0;
        this.loopCounter = new WeakMap();
        this.scheduled = false;

        // Reset settling tracker on idle
        this.settlingTracker = createSettlingTracker();

        this.scheduledFirstTime.clear();
        if (this.conditionallyScheduledEffects.size === 0) {
          this.changedWritesHistory = [];
        }
      }
    } else {
      // Keep scheduled = true since we're queuing another execution
      this.pendingQueueTaskTimer = queueTask(() => {
        this.pendingQueueTaskTimer = null;
        this.execute();
      });
    }
    logger.timeEnd("scheduler", "execute");
  }

  private addInFlightSource(
    action: Action,
    source: IStorageTransaction,
  ): void {
    addInFlightSourceState(this.inFlightSourceState, action, source);
  }

  private removeInFlightSource(
    action: Action,
    source: IStorageTransaction,
  ): void {
    removeInFlightSourceState(this.inFlightSourceState, action, source);
  }

  /**
   * Clean up all pending timers and resources.
   * Should be called when the scheduler is being torn down.
   */
  dispose(): void {
    this.disposed = true;
    // Clear all active debounce timers
    clearActiveDebounceTimers(this.delayState);
    if (this.pendingQueueTaskTimer !== null) {
      clearTimeout(this.pendingQueueTaskTimer);
      this.pendingQueueTaskTimer = null;
    }
    this.cancelEventQueueWake();
    // Clean up diagnosis state
    if (this.diagnosisTimeout) {
      clearTimeout(this.diagnosisTimeout);
      this.diagnosisTimeout = null;
    }
    this.diagnosisEnabled = false;
  }
}
